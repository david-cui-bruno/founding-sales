import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { takeOverOpportunity } from '../../crm/pipeline.ts';
import { withTransaction } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { makeStepExecution } from '../../db/testing/stepExecutions.ts';
import { applyDirectSendEffects } from '../../mail/effects.ts';
import { GmailClientError, type GmailClient } from '../../mail/gmailClient.ts';
import { mailSyncHandler } from '../../mail/handlers.ts';
import { readMailbox } from '../../mail/mailboxes.ts';
import type { ClaimedJob } from '../../jobs/jobStore.ts';
import type { MatchCandidate } from '../../mail/matching.ts';
import {
  directSendTargetOf,
  listHeldOutgoingForFirm,
  recordMatches,
  recordMatchesForImport,
  resolveAmbiguity,
} from '../../mail/matching.ts';
import type { NormalizedMetadata } from '../../mail/messages.ts';
import { readMessage } from '../../mail/messages.ts';
import { runMailSync } from '../../mail/sync.ts';
import type { MailMessageRow } from '../../mail/types.ts';
import { dispatchOutboundMessage, type SendReport } from '../../outbound/send.ts';
import { createOutboundWorld, type OutboundWorld } from '../outbound/support/outboundWorld.ts';
import { fixtureMessage } from './support/mailWorld.ts';
import {
  openExtraSession,
  pausingAtTokenRefresh,
  prepareFor,
  seedFirm,
  waitUntilBlocked,
  type ExtraSession,
  type SeededFirm,
} from '../outbound/support/dispatchFixtures.ts';

/**
 * A direct Gmail send is an update to the conversation, not a takeover (send-path v2,
 * slice S1).
 *
 * David, 30 September 2026: *"My email should update the conversation, complete any
 * fulfilled request, and prevent duplicate follow-ups. It should not automatically
 * impose permanent manual takeover. The explicit 'I will handle this myself' control
 * still pauses automation."*
 *
 * Every case calls the real `applyDirectSendEffects` on a stored outgoing message and a
 * resolved candidate, which is what the import (`mail/pipeline.ts`) and the ambiguity
 * resolution (`mail/matching.ts`) hand it; the import's own wiring — once per message,
 * ambiguous matches held — is in `scenarios.test.ts`. The race cases run the real
 * dispatch claim against the effect on two connections.
 *
 * No real person, firm or address: every address is in `example.test` (RFC 6761).
 */

let world: OutboundWorld;
let barrier: ExtraSession;
let second: ExtraSession;

beforeAll(async () => {
  world = await createOutboundWorld();
  barrier = await openExtraSession(world);
  second = await openExtraSession(world);
}, 180_000);

afterAll(async () => {
  await barrier?.close();
  await second?.close();
  await world?.stop();
});

afterEach(async () => {
  await barrier?.session.query('ROLLBACK');
  await second?.session.query('ROLLBACK');
});

const workspaceId = (): string => world.alpha.workspace.workspaceId;
const worker = (): RepositoryContext => world.systemContext(workspaceId());
const salesperson = (): RepositoryContext =>
  repositoryContext(
    workspaceScope(workspaceId(), {
      kind: 'user',
      userId: world.alpha.workspace.salesperson.userId,
      role: 'salesperson',
    }),
    world.database.session,
  );

let messages = 0;

/** The salesperson's own outgoing message, as the import stores it. */
async function storeDirectSend(input: {
  readonly to: readonly string[];
  readonly cc?: readonly string[];
  /** The unbracketed RFC Message-ID; a fence's header makes the message FSS's own send. */
  readonly rfcMessageId?: string;
}): Promise<MailMessageRow> {
  messages += 1;
  const { rows } = await world.database.session.query<{ id: string }>(
    `INSERT INTO mail_messages
       (workspace_id, mailbox_id, provider_message_id, provider_thread_id, direction,
        internal_date, header_from, header_to, header_cc, rfc_message_id, matched)
     VALUES ($1, $2, $3, $3, 'outgoing', now(), $4, $5::text[], $6::text[], $7, true)
     RETURNING id`,
    [
      workspaceId(),
      world.alpha.mailboxId,
      `direct-send-${String(messages)}`,
      world.alpha.address,
      [...input.to],
      [...(input.cc ?? [])],
      input.rfcMessageId ?? null,
    ],
  );
  const message = await readMessage(worker(), rows[0]?.id ?? '');
  if (message === null) throw new Error('the message fixture was not stored');
  return message;
}

/** The candidate a resolved match hands the effect. `contactId` is whatever matching carried. */
function candidateOf(firm: SeededFirm, contactId: string | null = firm.contactId): MatchCandidate {
  return {
    firmId: firm.firmId,
    opportunityId: firm.opportunityId,
    contactId,
    rule: 'thread',
    viaClosedOpportunity: false,
  };
}

interface FixtureEnrollment {
  readonly enrollmentId: string;
  readonly contactId: string;
  readonly address: string;
  readonly permissionId: string | null;
}

/** A live enrollment at the firm, for a contact of its own, with the given origin. */
async function enrollmentAt(
  firm: SeededFirm,
  originKind: 'prospecting' | 'follow_up',
): Promise<FixtureEnrollment> {
  const executionId = await makeStepExecution(world.database.session, {
    workspaceId: workspaceId(),
    firmId: firm.firmId,
    opportunityId: firm.opportunityId,
    userId: world.alpha.workspace.salesperson.userId,
    templateVersionId: world.alpha.templateVersionId,
    originKind,
  });
  return await enrollmentOfExecution(executionId);
}

async function enrollmentOfExecution(executionId: string): Promise<FixtureEnrollment> {
  const { rows } = await world.database.session.query<{
    id: string;
    contact_id: string;
    permission_id: string | null;
    address: string;
  }>(
    `SELECT n.id, n.contact_id, n.permission_id,
            (SELECT a.address FROM email_addresses a
              WHERE a.workspace_id = n.workspace_id AND a.contact_id = n.contact_id
              ORDER BY a.created_at, a.id LIMIT 1) AS address
       FROM step_executions e
       JOIN sequence_enrollments n ON n.workspace_id = e.workspace_id AND n.id = e.enrollment_id
      WHERE e.workspace_id = $1 AND e.id = $2`,
    [workspaceId(), executionId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('the enrollment fixture is missing');
  return { enrollmentId: row.id, contactId: row.contact_id, address: row.address, permissionId: row.permission_id };
}

/** The follow-up fixture's `agreed_sequence` permission, re-scoped to the one e-mail agreed on the call. */
async function becomeSingleEmail(permissionId: string): Promise<void> {
  const updated = await world.database.session.query(
    `UPDATE follow_up_permissions
        SET kind = 'conversation', scope = 'single_email', sequence_version_id = NULL,
            template_version_id = $3, max_steps = 1
      WHERE workspace_id = $1 AND id = $2`,
    [workspaceId(), permissionId, world.alpha.templateVersionId],
  );
  expect(updated.rowCount).toBe(1);
}

/**
 * The follow-up fixture's permission as a `contextual_reply` on real inbound evidence:
 * the message, the match a person selected, and the confirmation they made — the shape
 * `test/outbound/permissionSpend.test.ts` proves the dispatch sends on.
 */
async function becomeContextualReply(permissionId: string, firm: SeededFirm, contactId: string): Promise<void> {
  const session = world.database.session;
  messages += 1;
  const { rows: message } = await session.query<{ id: string }>(
    `INSERT INTO mail_messages
       (workspace_id, mailbox_id, provider_message_id, provider_thread_id, direction,
        internal_date, header_from, matched)
     VALUES ($1, $2, $3, $3, 'incoming', now(), 'prospect@example.test', true)
     RETURNING id`,
    [workspaceId(), world.alpha.mailboxId, `inbound-request-${String(messages)}`],
  );
  const messageId = message[0]?.id ?? '';
  await session.query(
    `INSERT INTO mail_message_matches
       (workspace_id, mail_message_id, firm_id, opportunity_id, contact_id, match_rule,
        selected, resolved_at, resolved_by_user_id)
     VALUES ($1, $2, $3, $4, $5, 'participant', true, now(), $6)`,
    [workspaceId(), messageId, firm.firmId, firm.opportunityId, contactId, world.alpha.workspace.salesperson.userId],
  );
  await session.query(
    `INSERT INTO mail_reply_confirmations
       (workspace_id, mail_message_id, firm_id, opportunity_id, disposition, suggested_disposition,
        suggested_by, corrected, confirmed_by_user_id, consequences)
     VALUES ($1, $2, $3, $4, 'interested', 'interested', 'deterministic', false, $5, $6::text[])`,
    [workspaceId(), messageId, firm.firmId, firm.opportunityId, world.alpha.workspace.salesperson.userId, ['opportunity_manual']],
  );
  const updated = await session.query(
    `UPDATE follow_up_permissions
        SET kind = 'request', scope = 'contextual_reply', call_log_id = NULL,
            mail_message_id = $3, sequence_version_id = NULL, template_version_id = NULL,
            max_steps = 1
      WHERE workspace_id = $1 AND id = $2`,
    [workspaceId(), permissionId, messageId],
  );
  expect(updated.rowCount).toBe(1);
}

async function enrollmentState(enrollmentId: string): Promise<{ state: string; end_reason: string | null }> {
  const { rows } = await world.database.session.query<{ state: string; end_reason: string | null }>(
    'SELECT state, end_reason FROM sequence_enrollments WHERE workspace_id = $1 AND id = $2',
    [workspaceId(), enrollmentId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('the enrollment disappeared');
  return row;
}

async function permissionState(permissionId: string): Promise<{ consumed: boolean; consumed_reason: string | null }> {
  const { rows } = await world.database.session.query<{ consumed: boolean; consumed_reason: string | null }>(
    `SELECT consumed_at IS NOT NULL AS consumed, consumed_reason
       FROM follow_up_permissions WHERE workspace_id = $1 AND id = $2`,
    [workspaceId(), permissionId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('the permission disappeared');
  return row;
}

async function opportunityControl(
  opportunityId: string,
): Promise<{ control_mode: string; control_mode_origin: string | null }> {
  const { rows } = await world.database.session.query<{ control_mode: string; control_mode_origin: string | null }>(
    'SELECT control_mode, control_mode_origin FROM opportunities WHERE workspace_id = $1 AND id = $2',
    [workspaceId(), opportunityId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('the opportunity disappeared');
  return row;
}

async function dispatch(fenceId: string): Promise<{ readonly report: SendReport; readonly sends: number }> {
  const gmail = world.clientWith(world.alpha, {});
  const report = await dispatchOutboundMessage(worker(), world.sendDeps(world.alpha, { gmail }), {
    outboundMessageId: fenceId,
  });
  return { report, sends: gmail.sends.length };
}

async function fenceOfEnrollment(firm: SeededFirm): Promise<{ readonly fenceId: string } & FixtureEnrollment> {
  const fenceId = await prepareFor(world, world.alpha, firm);
  const { rows } = await world.database.session.query<{ step_execution_id: string }>(
    'SELECT step_execution_id FROM outbound_messages WHERE workspace_id = $1 AND id = $2',
    [workspaceId(), fenceId],
  );
  return { fenceId, ...(await enrollmentOfExecution(rows[0]?.step_execution_id ?? '')) };
}

async function backendOf(session: ExtraSession['session'] | OutboundWorld['database']['session']): Promise<number> {
  const { rows } = await session.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  return Number(rows[0]?.pid ?? 0);
}

describe('(a) a direct send is not a takeover', () => {
  it('leaves an automated opportunity automated, writes no origin and no manual-mode signal', async () => {
    const firm = await seedFirm(world, world.alpha, 'no-takeover');
    const message = await storeDirectSend({ to: [firm.address] });

    const outcome = await applyDirectSendEffects(worker(), { message, candidate: candidateOf(firm) });
    expect(outcome.recorded).toBe(true);

    expect(await opportunityControl(firm.opportunityId)).toEqual({
      control_mode: 'automated',
      control_mode_origin: null,
    });
    const { rows } = await world.database.session.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM crm_domain_events
        WHERE workspace_id = $1 AND opportunity_id = $2 AND event_kind = 'opportunity.manual_mode'`,
      [workspaceId(), firm.opportunityId],
    );
    expect(rows[0]?.count).toBe('0');
  });

  it("leaves a person's takeover exactly as it was, and it still blocks the follow-up", async () => {
    const firm = await seedFirm(world, world.alpha, 'takeover-stands');
    const followUp = await fenceOfEnrollment(firm);
    const taken = await takeOverOpportunity(salesperson(), {
      opportunityId: firm.opportunityId,
      reason: 'I will handle this firm myself',
    });
    expect(taken.ok).toBe(true);

    const message = await storeDirectSend({ to: [followUp.address] });
    await applyDirectSendEffects(worker(), { message, candidate: candidateOf(firm) });

    expect(await opportunityControl(firm.opportunityId)).toEqual({
      control_mode: 'manual',
      control_mode_origin: 'salesperson_command',
    });
    const { report, sends } = await dispatch(followUp.fenceId);
    expect(sends).toBe(0);
    expect(`${report.refusal ?? ''}:${report.detail ?? ''}`).toContain('opportunity_manual');
  });
});

describe('(b) under the send gate, only live prospecting at the matched firm ends', () => {
  it('ends the prospecting enrollment direct_send and leaves the follow-ups and the other firm running', async () => {
    const firm = await seedFirm(world, world.alpha, 'prospecting-ends');
    const other = await seedFirm(world, world.alpha, 'prospecting-elsewhere');
    const prospecting = await enrollmentAt(firm, 'prospecting');
    const elsewhere = await enrollmentAt(other, 'prospecting');
    const agreed = await enrollmentAt(firm, 'follow_up');
    const single = await enrollmentAt(firm, 'follow_up');
    await becomeSingleEmail(single.permissionId ?? '');

    // To the firm's seeded contact only: nobody with a permission is a recipient, so
    // every follow-up here is one the prospecting rule alone must not touch.
    const message = await storeDirectSend({ to: [firm.address] });
    const outcome = await applyDirectSendEffects(worker(), { message, candidate: candidateOf(firm) });

    expect(outcome.endedEnrollmentIds).toEqual([prospecting.enrollmentId]);
    expect(await enrollmentState(prospecting.enrollmentId)).toEqual({ state: 'stopped', end_reason: 'direct_send' });
    const { rows: executions } = await world.database.session.query<{ state: string; cancel_reason: string | null }>(
      'SELECT state, cancel_reason FROM step_executions WHERE workspace_id = $1 AND enrollment_id = $2',
      [workspaceId(), prospecting.enrollmentId],
    );
    expect(executions.every(row => row.state === 'cancelled' && row.cancel_reason === 'direct_send')).toBe(true);

    for (const live of [elsewhere, agreed, single]) {
      expect((await enrollmentState(live.enrollmentId)).end_reason).toBeNull();
    }
  });

  it('takes the send gate before it touches a row, even with no prospecting to end', async () => {
    // No prospecting enrollment here, so nothing reaches `stopEnrollments` (which takes
    // the gate itself) before the permission is spent: the only thing that can make the
    // spend wait for another stop-fact writer is the effect's own gate, taken first.
    const firm = await seedFirm(world, world.alpha, 'gate-first');
    const single = await enrollmentAt(firm, 'follow_up');
    await becomeSingleEmail(single.permissionId ?? '');
    const message = await storeDirectSend({ to: [single.address] });

    await barrier.session.query('BEGIN');
    await barrier.session.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `fss.send-gate:${workspaceId()}`,
    ]);
    await second.session.query('BEGIN');
    const effect = applyDirectSendEffects(second.context(workspaceId()), { message, candidate: candidateOf(firm) });
    await waitUntilBlocked(barrier.session, second.pid, 'advisory');
    // Waiting on the gate, it holds nothing on the rows a claim locks: no permission, no
    // enrollment, no step execution has been written or locked yet.
    const { rows: held } = await barrier.session.query<{ relation: string }>(
      `SELECT relation::regclass::text AS relation FROM pg_locks
        WHERE pid = $1 AND granted AND locktype = 'relation'
          AND relation IN ('follow_up_permissions'::regclass, 'sequence_enrollments'::regclass,
                           'step_executions'::regclass)`,
      [second.pid],
    );
    expect(held).toEqual([]);
    await barrier.session.query('COMMIT');
    const outcome = await effect;
    await second.session.query('COMMIT');
    expect(outcome.consumedPermissionIds).toEqual([single.permissionId]);
  });
});

describe('(c) a request the salesperson fulfilled by hand is complete', () => {
  it('consumes the verified To/Cc recipients’ one-message permissions and ends their runs; an agreed sequence keeps running', async () => {
    const firm = await seedFirm(world, world.alpha, 'fulfilled');
    const toSingle = await enrollmentAt(firm, 'follow_up');
    await becomeSingleEmail(toSingle.permissionId ?? '');
    const ccReply = await enrollmentAt(firm, 'follow_up');
    await becomeContextualReply(ccReply.permissionId ?? '', firm, ccReply.contactId);
    const notAddressed = await enrollmentAt(firm, 'follow_up');
    await becomeSingleEmail(notAddressed.permissionId ?? '');
    const toAgreed = await enrollmentAt(firm, 'follow_up');

    const message = await storeDirectSend({ to: [toSingle.address, toAgreed.address], cc: [ccReply.address] });
    // The candidate carries the contact that is NOT addressed — as a thread match carries
    // whoever the thread first matched. It is not a recipient, and its permission stands.
    const outcome = await applyDirectSendEffects(worker(), {
      message,
      candidate: candidateOf(firm, notAddressed.contactId),
    });

    expect([...outcome.recipientContactIds].sort()).toEqual(
      [toSingle.contactId, ccReply.contactId, toAgreed.contactId].sort(),
    );
    expect([...outcome.consumedPermissionIds].sort()).toEqual(
      [toSingle.permissionId ?? '', ccReply.permissionId ?? ''].sort(),
    );
    for (const fulfilled of [toSingle, ccReply]) {
      expect(await permissionState(fulfilled.permissionId ?? '')).toEqual({
        consumed: true,
        consumed_reason: 'fulfilled_by_direct_send',
      });
      expect(await enrollmentState(fulfilled.enrollmentId)).toEqual({ state: 'stopped', end_reason: 'direct_send' });
    }
    for (const standing of [notAddressed, toAgreed]) {
      expect(await permissionState(standing.permissionId ?? '')).toEqual({ consumed: false, consumed_reason: null });
      expect((await enrollmentState(standing.enrollmentId)).end_reason).toBeNull();
    }
  });

  it('does not record a revoked or an expired permission as fulfilled', async () => {
    const firm = await seedFirm(world, world.alpha, 'dead-permissions');
    const revoked = await enrollmentAt(firm, 'follow_up');
    await becomeSingleEmail(revoked.permissionId ?? '');
    await world.database.session.query(
      'UPDATE follow_up_permissions SET revoked_at = now() WHERE workspace_id = $1 AND id = $2',
      [workspaceId(), revoked.permissionId],
    );
    const expired = await enrollmentAt(firm, 'follow_up');
    await becomeSingleEmail(expired.permissionId ?? '');
    await world.database.session.query(
      `UPDATE follow_up_permissions SET granted_at = now() - interval '2 days', expires_at = now() - interval '1 day'
        WHERE workspace_id = $1 AND id = $2`,
      [workspaceId(), expired.permissionId],
    );

    const message = await storeDirectSend({ to: [revoked.address, expired.address] });
    const outcome = await applyDirectSendEffects(worker(), { message, candidate: candidateOf(firm) });
    expect(outcome.consumedPermissionIds).toEqual([]);
    for (const dead of [revoked, expired]) {
      expect(await permissionState(dead.permissionId ?? '')).toEqual({ consumed: false, consumed_reason: null });
    }
  });
});

describe('(e) once per message, and an audit row of ids', () => {
  it('records one marker and one audit row, and a replay does nothing', async () => {
    const firm = await seedFirm(world, world.alpha, 'once');
    const prospecting = await enrollmentAt(firm, 'prospecting');
    const message = await storeDirectSend({ to: [firm.address] });

    const first = await applyDirectSendEffects(worker(), { message, candidate: candidateOf(firm) });
    const again = await applyDirectSendEffects(worker(), { message, candidate: candidateOf(firm) });
    expect(first.recorded).toBe(true);
    expect(again).toEqual({
      recorded: false,
      recipientContactIds: [],
      consumedPermissionIds: [],
      endedEnrollmentIds: [],
      deferredExecutionIds: [],
      deferredUntil: null,
    });

    const { rows: markers } = await world.database.session.query<{ effect_kind: string; target_key: string }>(
      'SELECT effect_kind, target_key FROM mail_message_effects WHERE workspace_id = $1 AND mail_message_id = $2',
      [workspaceId(), message.id],
    );
    expect(markers).toEqual([{ effect_kind: 'direct_send_conversation', target_key: `message:${message.id}` }]);

    const { rows: audits } = await world.database.session.query<{
      subject_kind: string;
      subject_id: string;
      detail: Record<string, unknown>;
    }>(
      `SELECT subject_kind, subject_id, detail FROM audit_events
        WHERE workspace_id = $1 AND action = 'mail.direct_send_conversation' AND subject_id = $2`,
      [workspaceId(), message.id],
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.subject_kind).toBe('mail_message');
    expect(audits[0]?.detail).toEqual({
      firmId: firm.firmId,
      opportunityId: firm.opportunityId,
      recipientContactIds: [firm.contactId],
      consumedPermissionIds: [],
      endedEnrollmentIds: [prospecting.enrollmentId],
      deferredExecutionIds: [],
      deferredUntil: first.deferredUntil,
    });
    // Ids only: no address, no Gmail id, no subject.
    const text = JSON.stringify(audits[0]?.detail);
    expect(text).not.toContain('@');
    expect(text).not.toContain(message.providerMessageId);
  });

  it('treats a message a historical direct_send_manual marker already processed as done', async () => {
    const firm = await seedFirm(world, world.alpha, 'historical-marker');
    const prospecting = await enrollmentAt(firm, 'prospecting');
    const message = await storeDirectSend({ to: [firm.address] });
    // What the takeover wrote before send-path v2, per opportunity.
    await world.database.session.query(
      `INSERT INTO mail_message_effects (workspace_id, mail_message_id, effect_kind, target_key, detail)
       VALUES ($1, $2, 'direct_send_manual', $3, $4::jsonb)`,
      [workspaceId(), message.id, `opportunity:${firm.opportunityId}`, JSON.stringify({ firmId: firm.firmId })],
    );

    const outcome = await applyDirectSendEffects(worker(), { message, candidate: candidateOf(firm) });
    expect(outcome.recorded).toBe(false);
    expect((await enrollmentState(prospecting.enrollmentId)).end_reason).toBeNull();
    const { rows } = await world.database.session.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM mail_message_effects
        WHERE workspace_id = $1 AND mail_message_id = $2 AND effect_kind = 'direct_send_conversation'`,
      [workspaceId(), message.id],
    );
    expect(rows[0]?.count).toBe('0');
  });
});

describe('(g) a claim racing the effect is serialized by the send gate', () => {
  it('the effect holds the gate first: the claim waits, then sees the consumed permission and the ended run', async () => {
    const firm = await seedFirm(world, world.alpha, 'effect-first');
    const followUp = await fenceOfEnrollment(firm);
    await becomeContextualReply(followUp.permissionId ?? '', firm, followUp.contactId);
    const message = await storeDirectSend({ to: [followUp.address] });

    await barrier.session.query('BEGIN');
    const effect = await applyDirectSendEffects(barrier.context(workspaceId()), {
      message,
      candidate: candidateOf(firm),
    });
    expect(effect.consumedPermissionIds).toEqual([followUp.permissionId]);

    // The claim runs its precheck (it cannot see the uncommitted effect), refreshes the
    // token, and then waits for the gate the effect holds.
    const claim = dispatch(followUp.fenceId);
    await waitUntilBlocked(barrier.session, await backendOf(world.database.session), 'advisory');
    await barrier.session.query('COMMIT');

    const { report, sends } = await claim;
    expect(sends).toBe(0);
    expect(report.outcome, JSON.stringify(report)).not.toBe('sent');
    const { rows: fence } = await world.database.session.query<{ state: string }>(
      'SELECT state FROM outbound_messages WHERE workspace_id = $1 AND id = $2',
      [workspaceId(), followUp.fenceId],
    );
    expect(['dispatching', 'sent']).not.toContain(fence[0]?.state);
    expect(await permissionState(followUp.permissionId ?? '')).toEqual({
      consumed: true,
      consumed_reason: 'fulfilled_by_direct_send',
    });
    expect(await enrollmentState(followUp.enrollmentId)).toEqual({ state: 'stopped', end_reason: 'direct_send' });
  });

  it('the claim holds the gate first: it sends, and the effect then finds the permission already spent', async () => {
    const firm = await seedFirm(world, world.alpha, 'claim-first');
    const followUp = await fenceOfEnrollment(firm);
    await becomeContextualReply(followUp.permissionId ?? '', firm, followUp.contactId);
    const message = await storeDirectSend({ to: [followUp.address] });

    // The claim takes the gate SHARED and then waits on the fence row, which the barrier
    // holds; the effect, arriving now, waits on the gate behind the claim.
    await barrier.session.query('BEGIN');
    await barrier.session.query('SELECT id FROM outbound_messages WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [
      workspaceId(),
      followUp.fenceId,
    ]);
    const claim = dispatch(followUp.fenceId);
    await waitUntilBlocked(barrier.session, await backendOf(world.database.session));

    await second.session.query('BEGIN');
    const effect = applyDirectSendEffects(second.context(workspaceId()), { message, candidate: candidateOf(firm) });
    await waitUntilBlocked(barrier.session, second.pid, 'advisory');
    await barrier.session.query('COMMIT');

    const { report, sends } = await claim;
    expect(report.outcome, JSON.stringify(report)).toBe('sent');
    expect(sends).toBe(1);
    const outcome = await effect;
    await second.session.query('COMMIT');

    expect(outcome.recorded).toBe(true);
    expect(outcome.consumedPermissionIds).toEqual([]);
    expect(await permissionState(followUp.permissionId ?? '')).toEqual({ consumed: true, consumed_reason: 'sent' });
  });
});

describe('S1 review P1-4: an agreed sequence waits a day after the salesperson’s own e-mail', () => {
  it('reschedules the due agreed e-mail, refuses its prepared fence at the claim, and sends it once the day has passed', async () => {
    const firm = await seedFirm(world, world.alpha, 'agreed-waits');
    const agreed = await fenceOfEnrollment(firm);
    const { rows: scope } = await world.database.session.query<{ scope: string }>(
      'SELECT scope FROM follow_up_permissions WHERE workspace_id = $1 AND id = $2',
      [workspaceId(), agreed.permissionId],
    );
    expect(scope[0]?.scope).toBe('agreed_sequence');
    const { rows: before } = await world.database.session.query<{ id: string; not_before: Date }>(
      `SELECT e.id, e.not_before FROM outbound_messages f
         JOIN step_executions e ON e.workspace_id = f.workspace_id AND e.id = f.step_execution_id
        WHERE f.workspace_id = $1 AND f.id = $2`,
      [workspaceId(), agreed.fenceId],
    );
    const executionId = before[0]?.id ?? '';

    const message = await storeDirectSend({ to: [agreed.address] });
    const outcome = await applyDirectSendEffects(worker(), { message, candidate: candidateOf(firm) });

    // Rescheduled, not ended: the permission and the run stand.
    expect(outcome.deferredExecutionIds).toEqual([executionId]);
    expect(outcome.deferredUntil).toBe(new Date(Date.parse(message.internalDate) + 24 * 3_600_000).toISOString());
    const { rows: after } = await world.database.session.query<{ not_before: Date }>(
      'SELECT not_before FROM step_executions WHERE workspace_id = $1 AND id = $2',
      [workspaceId(), executionId],
    );
    expect(after[0]?.not_before.toISOString()).toBe(outcome.deferredUntil);
    expect((await enrollmentState(agreed.enrollmentId)).end_reason).toBeNull();
    expect(await permissionState(agreed.permissionId ?? '')).toEqual({ consumed: false, consumed_reason: null });
    const { rows: audit } = await world.database.session.query<{ detail: Record<string, unknown> }>(
      `SELECT detail FROM audit_events
        WHERE workspace_id = $1 AND action = 'mail.direct_send_conversation' AND subject_id = $2`,
      [workspaceId(), message.id],
    );
    expect(audit[0]?.detail).toMatchObject({ deferredExecutionIds: [executionId], deferredUntil: outcome.deferredUntil });

    // The fence was prepared before the direct send; the claim re-asks under the gate.
    const first = await dispatch(agreed.fenceId);
    expect(first.sends).toBe(0);
    expect(first.report.outcome, JSON.stringify(first.report)).toBe('not_ready');
    expect(first.report.detail).toBe('direct_send_quiet_window');

    // Backdating the direct send alone does not make the step ready: its own
    // `not_before` is still a day away, and the claim reads it (S1 review P1-B).
    await world.database.session.query(
      "UPDATE mail_messages SET internal_date = internal_date - interval '25 hours' WHERE workspace_id = $1 AND id = $2",
      [workspaceId(), message.id],
    );
    const early = await dispatch(agreed.fenceId);
    expect(early.sends).toBe(0);
    expect(early.report.outcome, JSON.stringify(early.report)).toBe('not_ready');
    expect(early.report.detail).toBe('not_yet_due');

    // A day later — both the send and the step's schedule moved back — the same fence sends.
    await world.database.session.query(
      "UPDATE step_executions SET not_before = not_before - interval '25 hours' WHERE workspace_id = $1 AND id = $2",
      [workspaceId(), executionId],
    );
    const later = await dispatch(agreed.fenceId);
    expect(later.report.outcome, JSON.stringify(later.report)).toBe('sent');
    expect(later.sends).toBe(1);
  });

  it('does not delay an agreed e-mail to somebody the direct send did not address', async () => {
    const firm = await seedFirm(world, world.alpha, 'agreed-elsewhere');
    const agreed = await fenceOfEnrollment(firm);
    const message = await storeDirectSend({ to: [firm.address] });
    const outcome = await applyDirectSendEffects(worker(), { message, candidate: candidateOf(firm) });
    expect(outcome.deferredExecutionIds).toEqual([]);
    const { report, sends } = await dispatch(agreed.fenceId);
    expect(report.outcome, JSON.stringify(report)).toBe('sent');
    expect(sends).toBe(1);
  });
});

describe('resolving an ambiguous outgoing message', () => {
  /** An outgoing message matched to two firms, held by `recordMatches` as the import would. */
  async function ambiguousOutgoing(
    left: SeededFirm,
    right: SeededFirm,
    rfcMessageId?: string,
  ): Promise<MailMessageRow> {
    const message = await storeDirectSend({
      to: [left.address, right.address],
      ...(rfcMessageId === undefined ? {} : { rfcMessageId }),
    });
    const matches = await recordMatches(worker(), {
      messageId: message.id,
      candidates: [candidateOf(left), candidateOf(right)],
    });
    expect(matches.ambiguous).toBe(true);
    return message;
  }

  async function activeHoldReasons(opportunityId: string): Promise<readonly string[]> {
    const { rows } = await world.database.session.query<{ reason_code: string }>(
      `SELECT reason_code FROM active_holds
        WHERE workspace_id = $1 AND scope_kind = 'opportunity' AND scope_key = $2 AND released_at IS NULL`,
      [workspaceId(), opportunityId],
    );
    return rows.map(row => row.reason_code);
  }

  it('S1 review P1-C: is listed on each candidate firm with every candidate, until it is resolved', async () => {
    const left = await seedFirm(world, world.alpha, 'listed-left');
    const right = await seedFirm(world, world.alpha, 'listed-right');
    const message = await ambiguousOutgoing(left, right);
    for (const firm of [left, right]) {
      const listed = await listHeldOutgoingForFirm(worker(), firm.firmId);
      expect(listed.map(entry => entry.messageId)).toEqual([message.id]);
      expect(new Set(listed[0]?.candidates.map(candidate => candidate.opportunityId))).toEqual(
        new Set([left.opportunityId, right.opportunityId]),
      );
    }
    const resolved = await resolveAmbiguity(salesperson(), {
      messageId: message.id,
      selectedOpportunityId: left.opportunityId,
      human: false,
    });
    expect(resolved.ok).toBe(true);
    expect(await listHeldOutgoingForFirm(worker(), left.firmId)).toEqual([]);
    expect(await listHeldOutgoingForFirm(worker(), right.firmId)).toEqual([]);
  });

  it('S1 review P2: an FSS-fenced one releases its holds and does nothing else, even when called human', async () => {
    const left = await seedFirm(world, world.alpha, 'fenced-left');
    const right = await seedFirm(world, world.alpha, 'fenced-right');
    const own = await fenceOfEnrollment(left);
    const { rows: header } = await world.database.session.query<{ header: string }>(
      'SELECT provider_message_id_header AS header FROM outbound_messages WHERE workspace_id = $1 AND id = $2',
      [workspaceId(), own.fenceId],
    );
    const rfc = (header[0]?.header ?? '').replace(/^</, '').replace(/>$/, '');
    const message = await ambiguousOutgoing(left, right, rfc);
    const prospecting = await enrollmentAt(right, 'prospecting');

    const resolved = await resolveAmbiguity(salesperson(), {
      messageId: message.id,
      selectedOpportunityId: right.opportunityId,
      human: true,
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.value.manualOpportunityId).toBeNull();
    for (const firm of [left, right]) {
      expect(await activeHoldReasons(firm.opportunityId)).toEqual([]);
      expect(await opportunityControl(firm.opportunityId)).toEqual({ control_mode: 'automated', control_mode_origin: null });
    }
    const { rows } = await world.database.session.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM mail_message_effects WHERE workspace_id = $1 AND mail_message_id = $2`,
      [workspaceId(), message.id],
    );
    expect(rows[0]?.count).toBe('0');
    expect((await enrollmentState(prospecting.enrollmentId)).end_reason).toBeNull();
  });

  it('S1 review P1-2: two concurrent resolutions serialize on the gate, and the second is refused', async () => {
    const left = await seedFirm(world, world.alpha, 'race-left');
    const right = await seedFirm(world, world.alpha, 'race-right');
    const message = await ambiguousOutgoing(left, right);
    const asUser = (session: ExtraSession): RepositoryContext =>
      repositoryContext(
        workspaceScope(workspaceId(), {
          kind: 'user',
          userId: world.alpha.workspace.salesperson.userId,
          role: 'salesperson',
        }),
        session.session,
      );

    await barrier.session.query('BEGIN');
    const first = await resolveAmbiguity(asUser(barrier), {
      messageId: message.id,
      selectedOpportunityId: left.opportunityId,
      human: false,
    });
    expect(first.ok).toBe(true);

    await second.session.query('BEGIN');
    const racing = resolveAmbiguity(asUser(second), {
      messageId: message.id,
      selectedOpportunityId: right.opportunityId,
      human: false,
    });
    await waitUntilBlocked(barrier.session, second.pid, 'advisory');
    await barrier.session.query('COMMIT');
    const refused = await racing;
    await second.session.query('COMMIT');
    expect(refused).toEqual({ ok: false, reason: 'already_resolved' });

    const { rows: selection } = await world.database.session.query<{ opportunity_id: string; selected: boolean }>(
      `SELECT opportunity_id, selected FROM mail_message_matches
        WHERE workspace_id = $1 AND mail_message_id = $2 AND selected`,
      [workspaceId(), message.id],
    );
    expect(selection).toEqual([{ opportunity_id: left.opportunityId, selected: true }]);
    const { rows: markers } = await world.database.session.query<{ firm_id: string }>(
      `SELECT detail->>'firmId' AS firm_id FROM mail_message_effects
        WHERE workspace_id = $1 AND mail_message_id = $2 AND effect_kind = 'direct_send_conversation'`,
      [workspaceId(), message.id],
    );
    expect(markers).toEqual([{ firm_id: left.firmId }]);
  });
});

describe('S1 round-3 P2: each replay guard on its own case', () => {
  it('recordMatches: a candidate new on a replay joins the stored unresolved ambiguity, held', async () => {
    const left = await seedFirm(world, world.alpha, 'guard-left');
    const right = await seedFirm(world, world.alpha, 'guard-right');
    const late = await seedFirm(world, world.alpha, 'guard-late');
    const message = await storeDirectSend({ to: [left.address, right.address] });
    await recordMatches(worker(), { messageId: message.id, candidates: [candidateOf(left), candidateOf(right)] });

    // Today's candidates alone would say "one, certain"; the stored two say otherwise.
    const replay = await recordMatches(worker(), { messageId: message.id, candidates: [candidateOf(late)] });
    expect(replay.ambiguous).toBe(true);
    const { rows } = await world.database.session.query<{ ambiguous: boolean; held: boolean }>(
      `SELECT ambiguous, hold_id IS NOT NULL AS held FROM mail_message_matches
        WHERE workspace_id = $1 AND mail_message_id = $2 AND opportunity_id = $3`,
      [workspaceId(), message.id, late.opportunityId],
    );
    expect(rows).toEqual([{ ambiguous: true, held: true }]);
  });

  it('directSendTargetOf: a stored selection is the target, whatever else is stored', async () => {
    const left = await seedFirm(world, world.alpha, 'target-left');
    const right = await seedFirm(world, world.alpha, 'target-right');
    const message = await storeDirectSend({ to: [left.address, right.address] });
    await recordMatches(worker(), { messageId: message.id, candidates: [candidateOf(left), candidateOf(right)] });
    expect(await directSendTargetOf(worker(), message.id)).toBeUndefined();
    await world.database.session.query(
      `UPDATE mail_message_matches SET selected = (opportunity_id = $3), resolved_at = now()
        WHERE workspace_id = $1 AND mail_message_id = $2`,
      [workspaceId(), message.id, right.opportunityId],
    );
    expect((await directSendTargetOf(worker(), message.id))?.opportunityId).toBe(right.opportunityId);
  });
});

describe('S1 round-3 P2: the cold-mailbox hold comes before the not-yet-due refusal', () => {
  it('a fence prospecting by the claim, with a future not_before, is held visibly for the cold mailbox', async () => {
    const firm = await seedFirm(world, world.alpha, 'cold-before-due');
    const followUp = await fenceOfEnrollment(firm);
    const gmail = world.clientWith(world.alpha, {});
    // As S4's own claim test does: a follow-up at the precheck, prospecting by the claim
    // — and here also not due until tomorrow. The claim's recheck must hold it for the
    // cold mailbox, visibly, rather than roll back as `not_yet_due`.
    const paused = pausingAtTokenRefresh(gmail, async () => {
      await world.database.session.query(
        `UPDATE sequence_enrollments SET origin_kind = 'prospecting'
          WHERE workspace_id = $1 AND id = $2`,
        [workspaceId(), followUp.enrollmentId],
      );
      await world.database.session.query(
        `UPDATE step_executions SET not_before = now() + interval '1 day'
          WHERE workspace_id = $1 AND enrollment_id = $2 AND state IN ('pending', 'held')`,
        [workspaceId(), followUp.enrollmentId],
      );
    });
    const report = await dispatchOutboundMessage(worker(), world.sendDeps(world.alpha, { gmail: paused.client }), {
      outboundMessageId: followUp.fenceId,
    });
    expect(paused.refreshes()).toBe(1);
    expect(report.outcome, JSON.stringify(report)).toBe('held');
    expect(report.detail).toBe('cold_outreach_mailbox_required:gmail_dispatch:personal');
    expect(gmail.sends).toHaveLength(0);
  });
});

describe('S1 round-4: a replay and a resolution of the same direct send', () => {
  /** A contact at the firm that owns an address the message was already sent to. */
  async function associate(firm: SeededFirm, address: string): Promise<void> {
    await world.database.session.query(
      `INSERT INTO email_addresses (workspace_id, firm_id, contact_id, address, source, retrieved_at,
                                    association_confidence, technical_validation, eligibility, eligibility_policy_version)
       VALUES ($1, $2, $3, $4, 'research_provider', now(), 0.900, 'passed', 'usable', 'route-policy.1')`,
      [workspaceId(), firm.firmId, firm.contactId, address],
    );
  }

  /** The metadata a replay reads for the message: only its To/Cc matter here. */
  const metadataOf = (message: MailMessageRow): NormalizedMetadata =>
    ({ headerTo: message.headerTo, headerCc: message.headerCc }) as unknown as NormalizedMetadata;

  async function matchedFirms(messageId: string): Promise<readonly string[]> {
    const { rows } = await world.database.session.query<{ firm_id: string }>(
      'SELECT firm_id FROM mail_message_matches WHERE workspace_id = $1 AND mail_message_id = $2 ORDER BY firm_id',
      [workspaceId(), messageId],
    );
    return rows.map(row => row.firm_id);
  }

  it('P1-H: a replay waiting on the gate while a resolution commits the marker sees it and writes nothing', async () => {
    const left = await seedFirm(world, world.alpha, 'race-replay-left');
    const right = await seedFirm(world, world.alpha, 'race-replay-right');
    const late = await seedFirm(world, world.alpha, 'race-replay-late');
    const message = await storeDirectSend({ to: [left.address, right.address, 'newly-known@prospect.example.test'] });
    await recordMatches(worker(), { messageId: message.id, candidates: [candidateOf(left), candidateOf(right)] });
    // The third address becomes known at another firm after the first import.
    await associate(late, 'newly-known@prospect.example.test');
    const asUser = repositoryContext(
      workspaceScope(workspaceId(), {
        kind: 'user',
        userId: world.alpha.workspace.salesperson.userId,
        role: 'salesperson',
      }),
      barrier.session,
    );

    await barrier.session.query('BEGIN');
    const resolved = await resolveAmbiguity(asUser, {
      messageId: message.id,
      selectedOpportunityId: left.opportunityId,
      human: false,
    });
    expect(resolved.ok).toBe(true);

    await second.session.query('BEGIN');
    const replay = recordMatchesForImport(second.context(workspaceId()), {
      messageId: message.id,
      candidates: [candidateOf(left)],
      metadata: metadataOf(message),
      directSend: true,
    });
    await waitUntilBlocked(barrier.session, second.pid, 'advisory');
    await barrier.session.query('COMMIT');
    const recorded = await replay;
    await second.session.query('COMMIT');

    expect(recorded.frozen).toBe(true);
    expect(await matchedFirms(message.id)).toEqual([left.firmId, right.firmId].sort());
    expect(await listHeldOutgoingForFirm(worker(), late.firmId)).toEqual([]);
  });

  it('P2: a message with only a historical direct_send_manual marker is frozen too', async () => {
    const firm = await seedFirm(world, world.alpha, 'historical-freeze');
    const late = await seedFirm(world, world.alpha, 'historical-freeze-late');
    const message = await storeDirectSend({ to: [firm.address, 'known-later@prospect.example.test'] });
    await recordMatches(worker(), { messageId: message.id, candidates: [candidateOf(firm)] });
    await world.database.session.query(
      `INSERT INTO mail_message_effects (workspace_id, mail_message_id, effect_kind, target_key, detail)
       VALUES ($1, $2, 'direct_send_manual', $3, $4::jsonb)`,
      [workspaceId(), message.id, `opportunity:${firm.opportunityId}`, JSON.stringify({ firmId: firm.firmId })],
    );
    await associate(late, 'known-later@prospect.example.test');

    const recorded = await recordMatchesForImport(worker(), {
      messageId: message.id,
      candidates: [candidateOf(firm)],
      metadata: metadataOf(message),
      directSend: true,
    });
    expect(recorded.frozen).toBe(true);
    expect(await matchedFirms(message.id)).toEqual([firm.firmId]);
    const { rows: holds } = await world.database.session.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM active_holds
        WHERE workspace_id = $1 AND source_event_id = $2 AND released_at IS NULL`,
      [workspaceId(), message.id],
    );
    expect(holds[0]?.count).toBe('0');
  });
});

describe('S1 round-7: a Gmail read that fails later in the job does not undo an earlier direct send', () => {
  it('commits message 1’s effect, stands the cursor before message 2, refuses the follow-up, and reads message 2 next run', async () => {
    const firm = await seedFirm(world, world.alpha, 'read-stop');
    const followUp = await fenceOfEnrollment(firm);
    await becomeContextualReply(followUp.permissionId ?? '', firm, followUp.contactId);
    await world.database.session.query("UPDATE mailboxes SET history_id = '1100' WHERE workspace_id = $1 AND id = $2", [
      workspaceId(),
      world.alpha.mailboxId,
    ]);
    world.alpha.messages.push(
      fixtureMessage({ id: 'read-stop-1', historyId: '1101', from: world.alpha.address, to: followUp.address, labelIds: ['SENT'] }),
      fixtureMessage({ id: 'read-stop-2', historyId: '1102', from: followUp.address, to: world.alpha.address }),
    );
    const base = world.syncDeps(world.alpha);
    const failing: GmailClient = {
      ...base.gmail,
      getMetadata: async (access, messageId, headers) => {
        if (messageId === 'read-stop-2') throw new GmailClientError('unexpected_status', 'the fixture read failed', 500);
        return await base.gmail.getMetadata(access, messageId, headers);
      },
    };

    // The job runner's shape: the whole run in one transaction, committed if it returns.
    const first = await withTransaction(
      world.database.session as Parameters<typeof withTransaction>[0],
      async () => await runMailSync(worker(), { ...base, gmail: failing }, { mailboxId: world.alpha.mailboxId }),
    );
    expect(first.outcome).toBe('read_stopped');
    expect(first.directSendsRecorded).toBe(1);
    expect(first.processedMessages).toBe(1);
    expect(first.readFailure).toEqual({ providerMessageId: 'read-stop-2', read: 'metadata', detail: 'unexpected_status 500' });
    expect(first.moreToDo).toBe(true);
    expect(first.cursorTo).toBe('1101');

    // Committed: the permission, the run, the marker, and the cursor just before message 2.
    expect(await permissionState(followUp.permissionId ?? '')).toEqual({
      consumed: true,
      consumed_reason: 'fulfilled_by_direct_send',
    });
    expect(await enrollmentState(followUp.enrollmentId)).toEqual({ state: 'stopped', end_reason: 'direct_send' });
    const { rows: markers } = await world.database.session.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM mail_message_effects f
         JOIN mail_messages m ON m.workspace_id = f.workspace_id AND m.id = f.mail_message_id
        WHERE f.workspace_id = $1 AND m.provider_message_id = 'read-stop-1' AND f.effect_kind = 'direct_send_conversation'`,
      [workspaceId()],
    );
    expect(markers[0]?.count).toBe('1');
    const stopped = await readMailbox(worker(), world.alpha.mailboxId);
    expect(stopped?.historyId).toBe('1101');
    expect(stopped?.lastSyncError).toMatch(/metadata read failed/u);
    const { rows: unread } = await world.database.session.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM mail_messages WHERE workspace_id = $1 AND provider_message_id = 'read-stop-2'",
      [workspaceId()],
    );
    expect(unread[0]?.count).toBe('0');

    // The follow-up the salesperson fulfilled by hand is not sent in the gap before the retry.
    const { report, sends } = await dispatch(followUp.fenceId);
    expect(sends).toBe(0);
    expect(report.outcome, JSON.stringify(report)).not.toBe('sent');

    // Through the handler: a run the same refusal stops again records no mailbox
    // heartbeat, so a message Gmail keeps refusing is seen by the missed-check alarm.
    const session = world.database.session as Parameters<typeof withTransaction>[0];
    const job = { payload: { mailboxId: world.alpha.mailboxId } } as unknown as ClaimedJob;
    const scope = worker().scope;
    const heartbeats = async (): Promise<readonly { outcome: string }[]> =>
      (
        await world.database.session.query<{ outcome: string }>(
          `SELECT detail->>'outcome' AS outcome FROM heartbeats
            WHERE workspace_id = $1 AND component = 'mailbox' AND instance_key = $2`,
          [workspaceId(), world.alpha.mailboxId],
        )
      ).rows;
    await world.database.session.query(
      "DELETE FROM heartbeats WHERE workspace_id = $1 AND component = 'mailbox' AND instance_key = $2",
      [workspaceId(), world.alpha.mailboxId],
    );
    await withTransaction(session, async () => {
      await mailSyncHandler({ ...base, gmail: failing }).handle({ session, scope, job });
    });
    expect(await heartbeats()).toEqual([]);
    expect((await readMailbox(worker(), world.alpha.mailboxId))?.historyId).toBe('1101');

    // The next run reads message 2, and message 1 is not read again.
    const second = await withTransaction(
      session,
      async () => await runMailSync(worker(), base, { mailboxId: world.alpha.mailboxId }),
    );
    expect(second.outcome).toBe('synced');
    expect(second.readFailure).toBeNull();
    expect(second.messagesSeen).toBe(1);
    await withTransaction(session, async () => {
      await mailSyncHandler(base).handle({ session, scope, job });
    });
    expect(await heartbeats()).toEqual([{ outcome: 'synced' }]);
    const { rows: read } = await world.database.session.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM mail_messages WHERE workspace_id = $1 AND provider_message_id = 'read-stop-2'",
      [workspaceId()],
    );
    expect(read[0]?.count).toBe('1');
    expect((await readMailbox(worker(), world.alpha.mailboxId))?.lastSyncError).toBeNull();
  });
});

describe('C2B-A1 fold 2: RFC Message-ID conflicts and the direct send', () => {
  const headerOf = async (fenceId: string): Promise<string> => {
    const { rows } = await world.database.session.query<{ header: string | null }>(
      'SELECT provider_message_id_header AS header FROM outbound_messages WHERE workspace_id = $1 AND id = $2',
      [workspaceId(), fenceId],
    );
    const header = rows[0]?.header ?? null;
    if (header !== null) return header.replace(/^<|>$/gu, '');
    const made = `fss.${fenceId}@example.test`;
    await world.database.session.query(
      'UPDATE outbound_messages SET provider_message_id_header = $3 WHERE workspace_id = $1 AND id = $2',
      [workspaceId(), fenceId, `<${made}>`],
    );
    return made;
  };

  it('a manual message reusing an automated message id is a direct send: the permission is consumed, and not automated', async () => {
    const firm = await seedFirm(world, world.alpha, 'rfc-inherit');
    const followUp = await fenceOfEnrollment(firm);
    await becomeContextualReply(followUp.permissionId ?? '', firm, followUp.contactId);
    const owned = await headerOf(followUp.fenceId);
    await world.database.session.query("UPDATE mailboxes SET history_id = '1300' WHERE workspace_id = $1 AND id = $2", [
      workspaceId(),
      world.alpha.mailboxId,
    ]);
    world.alpha.messages.push(
      fixtureMessage({ id: 'rfc-auto', historyId: '1301', from: world.alpha.address, to: followUp.address, labelIds: ['SENT'], messageId: owned, subject: 'The automated note' }),
      fixtureMessage({ id: 'rfc-manual', historyId: '1302', from: world.alpha.address, to: followUp.address, labelIds: ['SENT'], messageId: owned, subject: 'My own note' }),
    );
    const session = world.database.session as Parameters<typeof withTransaction>[0];
    const report = await withTransaction(session, async () =>
      await runMailSync(worker(), world.syncDeps(world.alpha), { mailboxId: world.alpha.mailboxId }),
    );
    expect(report.rfcIdConflicts).toBe(1);
    expect(report.automatedSendsRecognised).toBe(1);
    expect(report.directSendsRecorded).toBe(1);
    expect(await permissionState(followUp.permissionId ?? '')).toEqual({
      consumed: true,
      consumed_reason: 'fulfilled_by_direct_send',
    });

    // A replay: the conflict's row holds no Message-ID and is still not looked up by one.
    await world.database.session.query("UPDATE mailboxes SET history_id = '1300' WHERE workspace_id = $1 AND id = $2", [
      workspaceId(),
      world.alpha.mailboxId,
    ]);
    const replay = await withTransaction(session, async () =>
      await runMailSync(worker(), world.syncDeps(world.alpha), { mailboxId: world.alpha.mailboxId }),
    );
    expect(replay.automatedSendsRecognised).toBe(1);
  });

  it('a failed duplicate-proof read stops at that message: the direct send before it commits', async () => {
    const firm = await seedFirm(world, world.alpha, 'proof-stop');
    const followUp = await fenceOfEnrollment(firm);
    await becomeContextualReply(followUp.permissionId ?? '', firm, followUp.contactId);
    await world.database.session.query("UPDATE mailboxes SET history_id = '1400' WHERE workspace_id = $1 AND id = $2", [
      workspaceId(),
      world.alpha.mailboxId,
    ]);
    const session = world.database.session as Parameters<typeof withTransaction>[0];
    const base = world.syncDeps(world.alpha);
    // The original is recorded by an earlier run.
    world.alpha.messages.push(
      fixtureMessage({ id: 'proof-orig', historyId: '1401', from: 'someone@elsewhere.example.test', to: world.alpha.address, messageId: 'proof@x.test', subject: 'Same' }),
    );
    await withTransaction(session, async () => await runMailSync(worker(), base, { mailboxId: world.alpha.mailboxId }));

    world.alpha.messages.push(
      fixtureMessage({ id: 'proof-direct', historyId: '1402', from: world.alpha.address, to: followUp.address, labelIds: ['SENT'] }),
      fixtureMessage({ id: 'proof-copy', historyId: '1403', from: 'someone@elsewhere.example.test', to: world.alpha.address, messageId: 'proof@x.test', subject: 'Same' }),
    );
    // Only the proof read fails: the read of the original made for the copy. (The
    // fixture's current history id is below the cursor, so the run replays the original
    // first, and that read succeeds.)
    let copyRead = false;
    const gmail: GmailClient = {
      ...base.gmail,
      getMetadata: async (access, messageId, headers) => {
        if (messageId === 'proof-copy') copyRead = true;
        if (messageId === 'proof-orig' && copyRead) throw new GmailClientError('unexpected_status', 'the fixture read failed', 429);
        return await base.gmail.getMetadata(access, messageId, headers);
      },
    };
    const report = await withTransaction(session, async () =>
      await runMailSync(worker(), { ...base, gmail }, { mailboxId: world.alpha.mailboxId }),
    );
    expect(report.outcome).toBe('read_stopped');
    expect(report.directSendsRecorded).toBe(1);
    expect(report.readFailure).toEqual({ providerMessageId: 'proof-copy', read: 'metadata', detail: 'unexpected_status 429' });
    expect(await permissionState(followUp.permissionId ?? '')).toEqual({
      consumed: true,
      consumed_reason: 'fulfilled_by_direct_send',
    });
    // The cursor stands just before the copy's record.
    expect((await readMailbox(worker(), world.alpha.mailboxId))?.historyId).toBe('1402');
  });
});

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { logCallOutcome } from '../../dial/calls.ts';
import { setAutomatedSendingEnabled } from '../../outbound/domainGuard.ts';
import { dispatchOutboundMessage } from '../../outbound/send.ts';
import { followUpPermissionSource } from '../../sequences/eligibility.ts';
import { listStepExecutions } from '../../sequences/rows.ts';
import { recordingSuppressionJournal } from '../../suppression/journal.ts';
import { SENDING_DOMAIN, createOutboundWorld, type OutboundWorld } from './support/outboundWorld.ts';
import { prepareFor, seedFirm } from './support/dispatchFixtures.ts';

/**
 * Slice 3a, lane B — B-8: consent from a reached, named person, end to end.
 *
 * "Call me back Thursday — and e-mail me the overview" is a `callback_requested` call that
 * also agreed to something. Since 3a an agreement belongs to any outcome that reached a
 * person (`REACHED_OUTCOMES`: `logCallOutcome`, `termsOfEvidence`, `verifyEvidence`, and the
 * database's `call_logs_agreement_needs_interest`, widened under its old name). So the call
 * records the agreement, the permission is granted on it, the enrolment's step verifies it
 * for the same person — and the dispatch is still refused by the sending pause: nothing
 * sends by itself. A voicemail still agrees to nothing.
 */

let world: OutboundWorld;

beforeAll(async () => {
  world = await createOutboundWorld();
}, 180_000);

afterAll(async () => {
  await world?.stop();
});

const workspaceId = (): string => world.alpha.workspace.workspaceId;
const salesperson = (): RepositoryContext =>
  repositoryContext(
    workspaceScope(workspaceId(), { kind: 'user', userId: world.alpha.workspace.salesperson.userId, role: 'salesperson' }),
    world.database.session,
  );
const admin = (): RepositoryContext =>
  repositoryContext(
    workspaceScope(workspaceId(), { kind: 'user', userId: world.alpha.workspace.admin.userId, role: 'admin' }),
    world.database.session,
  );

async function setDomainSwitch(enabled: boolean): Promise<void> {
  const outcome = await withTransaction(
    world.database.session,
    async () => await setAutomatedSendingEnabled(admin(), { domain: SENDING_DOMAIN, enabled }),
  );
  expect(outcome.ok).toBe(true);
}

afterEach(async () => {
  await setDomainSwitch(true);
  await world.clearHolds(workspaceId());
});

/** A published version from the world's own fixture enrollment at this firm. */
async function versionAt(firmId: string): Promise<string> {
  const { rows } = await world.database.session.query<{ sequence_version_id: string }>(
    'SELECT sequence_version_id FROM sequence_enrollments WHERE workspace_id = $1 AND firm_id = $2 LIMIT 1',
    [workspaceId(), firmId],
  );
  return rows[0]?.sequence_version_id ?? '';
}

describe('B-8: callback plus overview is consent; the pause still refuses dispatch', () => {
  it('records the agreement on a callback_requested call, grants and verifies it for the same person, and the paused dispatch sends nothing', async () => {
    const firm = await seedFirm(world, world.alpha, 'callback-consent');
    await prepareFor(world, world.alpha, firm);
    await world.database.session.query(
      `UPDATE firms SET time_zone = 'America/New_York', time_zone_confidence = 'high',
              time_zone_source = 'postal', time_zone_rule_version = 'firm-zone.1'
        WHERE workspace_id = $1 AND id = $2`,
      [workspaceId(), firm.firmId],
    );
    const sequenceVersionId = await versionAt(firm.firmId);
    const logged = await withTransaction(world.database.session, async () =>
      await logCallOutcome(salesperson(), {
        firmId: firm.firmId,
        contactId: firm.contactId,
        outcome: 'callback_requested',
        followUpPermission: { scope: 'agreed_sequence', sequenceVersionId },
        commandId: 'b8-callback-consent',
        journal: recordingSuppressionJournal(),
      }),
    );
    expect(logged.ok, JSON.stringify(logged)).toBe(true);
    if (!logged.ok) return;
    const enrolled = logged.value.followUps.find(entry => entry.kind === 'agreed_sequence_enrolled');
    expect(enrolled, JSON.stringify(logged.value.followUps)).toBeDefined();
    expect(logged.value.followUpPermissionId).not.toBeNull();
    const { rows: log } = await world.database.session.query<{ outcome: string; agreed_follow_up: string }>(
      'SELECT outcome, agreed_follow_up FROM call_logs WHERE workspace_id = $1 AND id = $2',
      [workspaceId(), logged.value.callLogId],
    );
    expect(log[0]).toEqual({ outcome: 'callback_requested', agreed_follow_up: 'agreed_sequence' });

    // The verification, re-read on the step: the evidence is this log, for this person.
    const system = world.systemContext(workspaceId());
    const execution = (await listStepExecutions(system, { enrollmentId: enrolled?.enrollmentId ?? '' }))[0];
    if (execution === undefined) throw new Error('no first step');
    expect(
      await followUpPermissionSource().evaluate(system, {
        execution,
        opportunityId: firm.opportunityId,
        firmId: firm.firmId,
        contactId: firm.contactId,
        ownerUserId: world.alpha.workspace.salesperson.userId,
        channel: 'email',
        actionKind: 'email_send',
        now: new Date().toISOString(),
      }),
    ).toEqual({ ok: true });

    // The step, due now, prepared and dispatched while sending is paused: held, no send.
    await world.database.session.query(
      `UPDATE step_executions SET due_at = now() - interval '1 hour', not_before = now() - interval '1 hour'
        WHERE workspace_id = $1 AND id = $2`,
      [workspaceId(), execution.id],
    );
    const fenceId = await prepareFor(world, world.alpha, firm, { stepExecutionId: execution.id });
    await setDomainSwitch(false);
    const gmail = world.clientWith(world.alpha, {});
    const report = await dispatchOutboundMessage(system, world.sendDeps(world.alpha, { gmail }), { outboundMessageId: fenceId });
    expect(`${report.outcome}:${report.refusal ?? ''}`).toBe('held:automated_sending_disabled');
    expect(gmail.sends).toHaveLength(0);
  });

  it('a voicemail agrees to nothing: refused before anything is written', async () => {
    const firm = await seedFirm(world, world.alpha, 'voicemail-consent');
    await prepareFor(world, world.alpha, firm);
    const sequenceVersionId = await versionAt(firm.firmId);
    const logged = await withTransaction(world.database.session, async () =>
      await logCallOutcome(salesperson(), {
        firmId: firm.firmId,
        contactId: firm.contactId,
        outcome: 'voicemail_left',
        followUpPermission: { scope: 'agreed_sequence', sequenceVersionId },
        commandId: 'b8-voicemail-consent',
      }),
    );
    expect(logged).toEqual({ ok: false, reason: 'invalid_input' });
  });
});

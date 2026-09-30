import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import {
  classifyControlModeOrigin,
  keepFollowingUpAfterDirectSend,
  setManualControlMode,
  takeOverOpportunity,
} from '../../crm/pipeline.ts';
import { databaseNow } from '../../policy/clock.ts';
import {
  CHANNEL_ACTION_KINDS,
  controlModeSource,
  followUpPermissionSource,
  type StepEligibilityInput,
} from '../../sequences/eligibility.ts';
import { enrollContact } from '../../sequences/enrollments.ts';
import {
  agreedSequenceExpiry,
  consumeFollowUpPermission,
  grantFollowUpPermission,
  revokeFollowUpPermission,
} from '../../sequences/followUpPermissions.ts';
import { currentHolidayCalendar } from '../../sequences/calendars.ts';
import { resumeEnrollment } from '../../sequences/resume.ts';
import { listStepExecutions, readEnrollment, readSequenceVersion } from '../../sequences/rows.ts';
import { listStepWakes } from '../../sequences/wake.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedSequences, type SeededSequences } from './support/sequenceFixtures.ts';

/**
 * Evidenced follow-up permissions, and the legacy that is excluded for ever
 * (migration 0025; David, 29 September 2026, items 1 and 3).
 *
 * > "Record the enrollment origin alongside the supporting event, recipient, permitted
 * > follow-up, and timing. **The origin label alone must not authorize sending.**"
 *
 * > "Mark existing enrollments `cold_legacy`, preserve their history, and exclude them
 * > from automatic sending. ... A later valid request can establish a new evidenced
 * > follow-up. It must not automatically revive the old cold sequence."
 *
 * Each case below is one of those sentences. The permissions are granted through the
 * real command and their evidence is a real `call_logs` or `mail_messages` row, because
 * the property under test is that the evidence is **re-read**: a test that stubbed it
 * would pass against a source that trusted the label.
 */

let database: TestDatabase;
let seeded: TwoWorkspaces;
let crm: SeededCrm;
let sequences: SeededSequences;

const salesperson = (): RepositoryContext =>
  repositoryContext(
    workspaceScope(seeded.alpha.workspaceId, {
      kind: 'user',
      userId: seeded.alpha.salesperson.userId,
      role: 'salesperson',
    }),
    database.session,
  );

const admin = (): RepositoryContext =>
  repositoryContext(
    workspaceScope(seeded.alpha.workspaceId, {
      kind: 'user',
      userId: seeded.alpha.admin.userId,
      role: 'admin',
    }),
    database.session,
  );

const worker = (): RepositoryContext =>
  repositoryContext(
    workspaceScope(seeded.alpha.workspaceId, { kind: 'system', component: 'worker' }),
    database.session,
  );

/** A contact of the seeded firm, so each case has a person of its own. */
async function addContact(name: string): Promise<string> {
  const { rows } = await database.session.query<{ id: string }>(
    `INSERT INTO contacts (workspace_id, firm_id, full_name) VALUES ($1, $2, $3) RETURNING id`,
    [seeded.alpha.workspaceId, crm.alpha.firmId, name],
  );
  return rows[0]?.id ?? '';
}

/**
 * A recorded call with this person, and what was agreed on it.
 *
 * Since the review of PR 332 (P0-1) the *log* carries the agreement — `agreed_follow_up`
 * and the version it names — and `grantFollowUpPermission` derives the kind and the
 * scope from it rather than from its caller. A log that agreed to nothing, or one whose
 * outcome is a callback, supports no permission through any API, and the cases below
 * assert exactly that.
 */
async function recordCall(
  contactId: string | null,
  agreement:
    | { readonly kind: 'single_email'; readonly templateVersionId: string }
    | { readonly kind: 'agreed_sequence'; readonly sequenceVersionId: string }
    | { readonly kind: 'none' },
  overrides: { readonly firmId?: string; readonly outcome?: string } = {},
): Promise<string> {
  const firmId = overrides.firmId ?? crm.alpha.firmId;
  const { rows } = await database.session.query<{ id: string }>(
    `INSERT INTO call_logs
       (workspace_id, firm_id, contact_id, opportunity_id, outcome, step_effect, occurred_at,
        actor_user_id, agreed_follow_up, agreed_template_version_id, agreed_sequence_version_id)
     VALUES ($1, $2, $3, $4, $5, 'none', now() - interval '1 second', $6, $7, $8, $9)
     RETURNING id`,
    [
      seeded.alpha.workspaceId,
      firmId,
      contactId,
      firmId === crm.alpha.firmId ? crm.alpha.opportunityId : null,
      overrides.outcome ?? 'interested',
      seeded.alpha.salesperson.userId,
      agreement.kind === 'none' ? null : agreement.kind,
      agreement.kind === 'single_email' ? agreement.templateVersionId : null,
      agreement.kind === 'agreed_sequence' ? agreement.sequenceVersionId : null,
    ],
  );
  return rows[0]?.id ?? '';
}

interface Granted {
  readonly permissionId: string;
  readonly contactId: string;
  readonly callLogId: string;
}

/** A permission on the strength of a call that agreed to the seeded published version. */
async function grantAgreedSequence(
  contactId: string,
  versionId: string = sequences.alpha.publishedVersionId,
): Promise<Granted> {
  const callLogId = await recordCall(contactId, { kind: 'agreed_sequence', sequenceVersionId: versionId });
  const granted = await grantFollowUpPermission(salesperson(), {
    firmId: crm.alpha.firmId,
    contactId,
    callLogId,
    grantedByUserId: seeded.alpha.salesperson.userId,
  });
  if (!granted.ok) throw new Error(`the permission fixture was refused: ${granted.reason}`);
  return { permissionId: granted.value.id, contactId, callLogId };
}

/** A permission for the one e-mail agreed on a call, bound to the template it promised. */
async function grantSingleEmail(contactId: string, templateVersionId: string): Promise<Granted> {
  const callLogId = await recordCall(contactId, { kind: 'single_email', templateVersionId });
  const granted = await grantFollowUpPermission(salesperson(), {
    firmId: crm.alpha.firmId,
    contactId,
    callLogId,
    grantedByUserId: seeded.alpha.salesperson.userId,
  });
  if (!granted.ok) throw new Error(`the permission fixture was refused: ${granted.reason}`);
  return { permissionId: granted.value.id, contactId, callLogId };
}


/**
 * An inbound message this workspace matched to the firm and a person **confirmed** as a
 * request (P0-1).
 *
 * Three rows, because the evidence is all three: the message (`incoming`), the match
 * that names the recipient, and the confirmation a person made with a disposition that
 * asks to be written to and no callback committed. An unconfirmed candidate match is
 * exactly what the review found being accepted, so the helper writes the confirmation
 * and the cases below delete one row at a time to see which one carries the authority.
 */
async function seedInboundRequest(
  contactId: string,
  options: {
    readonly disposition?: string;
    readonly withCallback?: boolean;
    /** Leave the match unselected, which is a candidate nobody confirmed (P0-1, round 2). */
    readonly selected?: boolean;
  } = {},
): Promise<{ readonly messageId: string; readonly matchId: string; readonly confirmationId: string }> {
  const suffix = String(inboundCounter++);
  const { rows: mailbox } = await database.session.query<{ id: string }>(
    `INSERT INTO mailboxes (workspace_id, owner_user_id, email_address, provider_account_id, status)
     VALUES ($1, $2, $3, $4, 'connected')
     ON CONFLICT (workspace_id, owner_user_id) DO UPDATE SET status = 'connected'
     RETURNING id`,
    [
      seeded.alpha.workspaceId,
      seeded.alpha.salesperson.userId,
      'fu-mailbox@example.test',
      'fu-account',
    ],
  );
  const { rows: message } = await database.session.query<{ id: string }>(
    `INSERT INTO mail_messages
       (workspace_id, mailbox_id, provider_message_id, provider_thread_id, direction,
        internal_date, header_from, matched)
     VALUES ($1, $2, $3, $4, 'incoming', now(), 'prospect@example.test', true)
     RETURNING id`,
    [seeded.alpha.workspaceId, mailbox[0]?.id ?? '', `fu-message-${suffix}`, `fu-thread-${suffix}`],
  );
  const messageId = message[0]?.id ?? '';
  // `mail_message_matches_resolution_consistent`: a match is resolved or it is not, and
  // `selected` is the resolution. So "selected" writes the resolution a person made, and
  // "unselected" leaves the row as the classifier proposed it — unresolved, `selected`
  // null — which is the state P0-1 of the second review is about.
  const selected = options.selected ?? true;
  const { rows: match } = await database.session.query<{ id: string }>(
    `INSERT INTO mail_message_matches
       (workspace_id, mail_message_id, firm_id, opportunity_id, contact_id, match_rule,
        selected, resolved_at, resolved_by_user_id)
     VALUES ($1, $2, $3, $4, $5, 'participant',
             $6::boolean, CASE WHEN $6::boolean THEN now() END,
             CASE WHEN $6::boolean THEN $7::uuid END)
     RETURNING id`,
    [
      seeded.alpha.workspaceId,
      messageId,
      crm.alpha.firmId,
      crm.alpha.opportunityId,
      contactId,
      selected ? true : null,
      seeded.alpha.salesperson.userId,
    ],
  );
  let callbackId: string | null = null;
  if (options.withCallback === true) {
    const { rows: callback } = await database.session.query<{ id: string }>(
      `INSERT INTO callbacks
         (workspace_id, firm_id, contact_id, opportunity_id, assigned_user_id,
          requested_local_date, source_time_zone, due_at, confirmed_at, confirmed_by_user_id)
       VALUES ($1, $2, $3, $4, $5, current_date + 1, 'America/New_York', now() + interval '1 day', now(), $5)
       RETURNING id`,
      [
        seeded.alpha.workspaceId,
        crm.alpha.firmId,
        contactId,
        crm.alpha.opportunityId,
        seeded.alpha.salesperson.userId,
      ],
    );
    callbackId = callback[0]?.id ?? null;
  }
  const { rows: confirmation } = await database.session.query<{ id: string }>(
    `INSERT INTO mail_reply_confirmations
       (workspace_id, mail_message_id, firm_id, opportunity_id, disposition, suggested_disposition,
        suggested_by, corrected, confirmed_by_user_id, consequences, callback_id)
     VALUES ($1, $2, $3, $4, $5, $5, 'deterministic', false, $6, $7::text[], $8)
     RETURNING id`,
    [
      seeded.alpha.workspaceId,
      messageId,
      crm.alpha.firmId,
      crm.alpha.opportunityId,
      options.disposition ?? 'interested',
      seeded.alpha.salesperson.userId,
      callbackId === null ? ['opportunity_manual'] : ['opportunity_manual', 'callback_committed'],
      callbackId,
    ],
  );
  return {
    messageId,
    matchId: match[0]?.id ?? '',
    confirmationId: confirmation[0]?.id ?? '',
  };
}

let inboundCounter = 1;

/** Another firm of this workspace, with its own open opportunity. */
async function secondFirmWithOpportunity(): Promise<{ readonly firmId: string; readonly opportunityId: string }> {
  const { rows: firms } = await database.session.query<{ id: string }>(
    'INSERT INTO firms (workspace_id, name, assigned_user_id) VALUES ($1, $2, $3) RETURNING id',
    [seeded.alpha.workspaceId, `Ambiguity Holdings ${String(inboundCounter++)}`, seeded.alpha.salesperson.userId],
  );
  const firmId = firms[0]?.id ?? '';
  const { rows: opportunities } = await database.session.query<{ id: string }>(
    `INSERT INTO opportunities (workspace_id, firm_id, stage_id, control_mode_changed_at)
     VALUES ($1, $2, (SELECT id FROM pipeline_stages WHERE workspace_id = $1 ORDER BY position LIMIT 1), now())
     RETURNING id`,
    [seeded.alpha.workspaceId, firmId],
  );
  return { firmId, opportunityId: opportunities[0]?.id ?? '' };
}

/** The eligibility input for an enrollment's first step, as the worker builds it. */
async function stepOf(enrollmentId: string): Promise<StepEligibilityInput> {
  const [execution] = await listStepExecutions(worker(), { enrollmentId });
  if (execution === undefined) throw new Error('the enrollment has no step');
  const enrollment = await readEnrollment(worker(), { enrollmentId });
  if (enrollment === null) throw new Error('the enrollment disappeared');
  return {
    execution,
    opportunityId: enrollment.opportunityId,
    firmId: enrollment.firmId,
    contactId: enrollment.contactId,
    ownerUserId: enrollment.assignedUserId,
    channel: execution.channel,
    actionKind: CHANNEL_ACTION_KINDS[execution.channel],
    now: await databaseNow(worker()),
  };
}

async function enrolFollowUp(contactId: string, permissionId: string): Promise<string> {
  const result = await enrollContact(salesperson(), {
    sequenceVersionId: sequences.alpha.publishedVersionId,
    originKind: 'follow_up',
    permissionId,
    opportunityId: crm.alpha.opportunityId,
    firmId: crm.alpha.firmId,
    contactId,
  });
  if (!result.ok) throw new Error(`the follow-up enrollment was refused: ${result.reason}`);
  return result.value.enrollmentId;
}

/**
 * An enrollment in the shape a pre-0025 database holds: every column the old code
 * wrote, and nothing else, so `origin_kind` is the migration's DEFAULT.
 *
 * This is the whole of David's backfill, and the only way to test it is to write a row
 * the way the deployed binaries do — through the column list they knew.
 */
async function insertLegacyEnrollment(contactId: string): Promise<string> {
  const { rows } = await database.session.query<{ id: string }>(
    `INSERT INTO sequence_enrollments
       (workspace_id, sequence_version_id, opportunity_id, firm_id, contact_id, assigned_user_id,
        firm_time_zone, holiday_calendar_version)
     VALUES ($1, $2, $3, $4, $5, $6, 'America/New_York', 'none.1')
     RETURNING id`,
    [
      seeded.alpha.workspaceId,
      sequences.alpha.publishedVersionId,
      crm.alpha.opportunityId,
      crm.alpha.firmId,
      contactId,
      seeded.alpha.salesperson.userId,
    ],
  );
  const enrollmentId = rows[0]?.id ?? '';
  await database.session.query(
    `INSERT INTO step_executions
       (workspace_id, enrollment_id, step_id, firm_id, contact_id, channel, ordinal,
        due_at, not_before, original_due_at, source_zone, rule_version)
     SELECT $1, $2, s.id, $3, $4, s.channel, s.ordinal,
            now() - interval '1 day', now() - interval '1 day', now() - interval '1 day',
            'America/New_York', 'elapsed.1'
       FROM sequence_steps s
      WHERE s.workspace_id = $1 AND s.sequence_version_id = $5
      ORDER BY s.ordinal
      LIMIT 1`,
    [
      seeded.alpha.workspaceId,
      enrollmentId,
      crm.alpha.firmId,
      contactId,
      sequences.alpha.publishedVersionId,
    ],
  );
  return enrollmentId;
}

beforeAll(async () => {
  database = await createTestDatabase();
  seeded = await seedTwoWorkspaces(database.session);
  crm = await seedCrm(database.session, seeded);
  sequences = await seedSequences(database.session, seeded);
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  // The two tables point at each other since migration 0025 (a permission names the one
  // run it bought), so the binding is released before either is deleted.
  await database.session.query('UPDATE follow_up_permissions SET enrollment_id = NULL');
  await database.session.query('DELETE FROM step_execution_shifts');
  await database.session.query('DELETE FROM step_executions');
  await database.session.query('DELETE FROM sequence_enrollments');
  await database.session.query('DELETE FROM follow_up_permissions');
  await database.session.query('DELETE FROM call_logs');
  await database.session.query('DELETE FROM jobs');
  await database.session.query(
    `UPDATE opportunities
        SET control_mode = 'automated', control_mode_reason = NULL, control_mode_origin = NULL`,
  );
});

describe('cold_legacy: the enrollments that existed before the rule', () => {
  it('is what a pre-0025 insert produces, without an UPDATE touching the row', async () => {
    const enrollmentId = await insertLegacyEnrollment(await addContact('Legacy One'));
    const { rows } = await database.session.query<{ origin_kind: string; permission_id: string | null }>(
      'SELECT origin_kind, permission_id FROM sequence_enrollments WHERE workspace_id = $1 AND id = $2',
      [seeded.alpha.workspaceId, enrollmentId],
    );
    expect(rows[0]).toEqual({ origin_kind: 'cold_legacy', permission_id: null });
  });

  it('never becomes due, and is refused at the step if something else makes it due', async () => {
    const enrollmentId = await insertLegacyEnrollment(await addContact('Legacy Two'));
    const now = await databaseNow(worker());

    // The scheduler does not wake it: `listStepWakes` excludes the origin outright, so
    // no job is materialized and no fence is ever prepared.
    const wakes = await listStepWakes(database.session, { now });
    expect(wakes.filter(wake => wake.workspaceId === seeded.alpha.workspaceId)).toEqual([]);

    // And the step itself refuses, which is the belt to the scheduler's braces.
    expect(await followUpPermissionSource().evaluate(worker(), await stepOf(enrollmentId))).toEqual({
      ok: false,
      reasonCode: 'cold_legacy',
    });
  });

  it('cannot be revived by a resume: the origin is not a column anything clears', async () => {
    const enrollmentId = await insertLegacyEnrollment(await addContact('Legacy Three'));
    const resumed = await resumeEnrollment(worker(), { enrollmentId });
    expect(resumed.ok).toBe(true);

    const { rows } = await database.session.query<{ origin_kind: string }>(
      'SELECT origin_kind FROM sequence_enrollments WHERE workspace_id = $1 AND id = $2',
      [seeded.alpha.workspaceId, enrollmentId],
    );
    expect(rows[0]?.origin_kind).toBe('cold_legacy');
    const wakes = await listStepWakes(database.session, { now: await databaseNow(worker()) });
    expect(wakes.filter(wake => wake.workspaceId === seeded.alpha.workspaceId)).toEqual([]);
    expect(await followUpPermissionSource().evaluate(worker(), await stepOf(enrollmentId))).toEqual({
      ok: false,
      reasonCode: 'cold_legacy',
    });
  });

  it('is superseded, not revived, by a later evidenced follow-up: one command, no hand-stopping', async () => {
    // P1-2 of the GPT-6 review of PR 332. The old shape of this case stopped the legacy
    // row with an UPDATE of its own first, which proved nothing about the path a person
    // takes: a live `cold_legacy` enrollment used to refuse the new evidenced one
    // outright. The command now stops the legacy row terminally and creates the new
    // enrollment in its own transaction, in that order.
    const contactId = await addContact('Legacy Superseded');
    const legacy = await insertLegacyEnrollment(contactId);
    const granted = await grantAgreedSequence(contactId);
    const fresh = await enrolFollowUp(contactId, granted.permissionId);
    expect(fresh).not.toBe(legacy);

    const stopped = await readEnrollment(worker(), { enrollmentId: legacy });
    // Retained, with its history, and the end reason says what happened to it.
    expect(stopped?.state).toBe('stopped');
    expect(stopped?.endReason).toBe('superseded_by_follow_up');
    expect(stopped?.originKind).toBe('cold_legacy');
    // And nothing of the legacy run is due any more.
    const legacySteps = await listStepExecutions(worker(), { enrollmentId: legacy });
    expect(legacySteps.every(step => step.state !== 'pending')).toBe(true);

    const { rows } = await database.session.query<{ id: string; origin_kind: string }>(
      'SELECT id, origin_kind FROM sequence_enrollments WHERE workspace_id = $1 ORDER BY started_at',
      [seeded.alpha.workspaceId],
    );
    expect(rows.map(row => row.origin_kind)).toEqual(['cold_legacy', 'follow_up']);
  });

  it('is not what a later valid request revives: that is a new enrollment of its own', async () => {
    const contactId = await addContact('Legacy Four');
    const legacy = await insertLegacyEnrollment(contactId);
    await database.session.query(
      `UPDATE sequence_enrollments SET state = 'stopped', ended_at = now(), end_reason = 'admin_stop'
        WHERE workspace_id = $1 AND id = $2`,
      [seeded.alpha.workspaceId, legacy],
    );

    const granted = await grantAgreedSequence(contactId);
    const fresh = await enrolFollowUp(contactId, granted.permissionId);
    expect(fresh).not.toBe(legacy);
    const { rows } = await database.session.query<{ id: string; origin_kind: string }>(
      'SELECT id, origin_kind FROM sequence_enrollments WHERE workspace_id = $1 ORDER BY started_at',
      [seeded.alpha.workspaceId],
    );
    expect(rows.map(row => row.origin_kind)).toEqual(['cold_legacy', 'follow_up']);
  });
});

describe('follow_up: the permission is a pointer, and the evidence is the authority', () => {
  it('refuses when the evidence row names another firm', async () => {
    const contactId = await addContact('Mismatch One');
    const granted = await grantAgreedSequence(contactId);
    const enrollmentId = await enrolFollowUp(contactId, granted.permissionId);
    // The call log is re-pointed at another firm in the same workspace — which a merge
    // could do — and the permission stops authorizing anything, although its own row is
    // untouched. (The other workspace's firm would break the composite key instead,
    // which is a different, already-tested refusal.)
    const { rows: elsewhere } = await database.session.query<{ id: string }>(
      `INSERT INTO firms (workspace_id, name, assigned_user_id) VALUES ($1, $2, $3) RETURNING id`,
      [seeded.alpha.workspaceId, `Elsewhere Holdings ${String(Date.now())}`, seeded.alpha.salesperson.userId],
    );
    await database.session.query(
      `UPDATE call_logs SET firm_id = $3, contact_id = NULL, opportunity_id = NULL
        WHERE workspace_id = $1 AND id = $2`,
      [seeded.alpha.workspaceId, granted.callLogId, elsewhere[0]?.id ?? ''],
    );
    expect(await followUpPermissionSource().evaluate(worker(), await stepOf(enrollmentId))).toEqual({
      ok: false,
      reasonCode: 'follow_up_not_permitted',
      detail: 'call_log_firm_mismatch',
    });
  });

  it('refuses when the evidence row names another person', async () => {
    const contactId = await addContact('Mismatch Two');
    const granted = await grantAgreedSequence(contactId);
    const enrollmentId = await enrolFollowUp(contactId, granted.permissionId);
    await database.session.query(
      `UPDATE call_logs SET contact_id = $3 WHERE workspace_id = $1 AND id = $2`,
      [seeded.alpha.workspaceId, granted.callLogId, crm.alpha.contactId],
    );
    expect(await followUpPermissionSource().evaluate(worker(), await stepOf(enrollmentId))).toEqual({
      ok: false,
      reasonCode: 'follow_up_not_permitted',
      detail: 'call_log_contact_mismatch',
    });
  });

  it('refuses when the inbound message is no longer matched to the firm', async () => {
    // The mail arm: `mail_messages` carries no firm, so the evidence is the confirmed
    // match, and a match a merge or a deletion removed is a message that is no longer
    // evidence here.
    const contactId = await addContact('Mismatch Three');
    const inbound = await seedInboundRequest(contactId);
    const granted = await grantFollowUpPermission(salesperson(), {
      firmId: crm.alpha.firmId,
      contactId,
      mailMessageId: inbound.messageId,
      grantedByUserId: seeded.alpha.salesperson.userId,
    });
    if (!granted.ok) throw new Error(`the permission fixture was refused: ${granted.reason}`);
    // One step, because `contextual_reply` permits *a* reply: a multi-step plan on it is
    // refused at the command, which its own case below asserts.
    const enrolled = await enrollContact(salesperson(), {
      sequenceVersionId: await onePublishedStep(),
      originKind: 'follow_up',
      permissionId: granted.value.id,
      opportunityId: crm.alpha.opportunityId,
      firmId: crm.alpha.firmId,
      contactId,
    });
    if (!enrolled.ok) throw new Error(`the follow-up enrollment was refused: ${enrolled.reason}`);
    const enrollmentId = enrolled.value.enrollmentId;

    // Before: the evidence holds.
    expect(await followUpPermissionSource().evaluate(worker(), await stepOf(enrollmentId))).toEqual({ ok: true });

    await database.session.query('DELETE FROM mail_message_matches WHERE workspace_id = $1 AND id = $2', [
      seeded.alpha.workspaceId,
      inbound.matchId,
    ]);
    expect(await followUpPermissionSource().evaluate(worker(), await stepOf(enrollmentId))).toEqual({
      ok: false,
      reasonCode: 'follow_up_not_permitted',
      detail: 'inbound_request_unconfirmed',
    });
  });

  it('refuses an inbound message nobody confirmed: a candidate match is not consent', async () => {
    // P0-1: verification used to accept any match row, selected or not, and a match with
    // no contact at all. The authority is the *confirmation* a person made.
    const contactId = await addContact('Unconfirmed');
    const inbound = await seedInboundRequest(contactId);
    await database.session.query(
      'DELETE FROM mail_reply_confirmations WHERE workspace_id = $1 AND id = $2',
      [seeded.alpha.workspaceId, inbound.confirmationId],
    );
    // The grant is refused by the evidence check, which throws so the command's
    // transaction rolls back and no permission is left behind.
    await expect(
      grantFollowUpPermission(salesperson(), {
        firmId: crm.alpha.firmId,
        contactId,
        mailMessageId: inbound.messageId,
        grantedByUserId: seeded.alpha.salesperson.userId,
      }),
    ).rejects.toThrow('inbound_request_unconfirmed');
  });

  it('refuses a sole match nobody selected: one candidate is still only a candidate', async () => {
    // P0-1 of the second review. The verification used to accept an unselected match when
    // it was the only one the message had, which is the classifier's opinion rather than
    // anybody's consent. `selected` is the column a person writes.
    const contactId = await addContact('Sole Unselected');
    const inbound = await seedInboundRequest(contactId, { selected: false });
    await expect(
      grantFollowUpPermission(salesperson(), {
        firmId: crm.alpha.firmId,
        contactId,
        mailMessageId: inbound.messageId,
        grantedByUserId: seeded.alpha.salesperson.userId,
      }),
    ).rejects.toThrow('inbound_request_unconfirmed');
  });

  it('refuses an ambiguous inbound message whose match nobody selected', async () => {
    const contactId = await addContact('Ambiguous');
    const inbound = await seedInboundRequest(contactId, { selected: false });
    // A second candidate for the same message, at another firm, and neither selected:
    // `mail_message_matches_one_per_opportunity` means a second candidate is a second
    // *conversation*, which is exactly what an ambiguous inbound message is.
    const { rows: hold } = await database.session.query<{ id: string }>(
      `INSERT INTO active_holds (workspace_id, scope_kind, scope_key, reason_code, blocked_action_kinds, source_event_kind)
       VALUES ($1, 'firm', $2, 'ambiguous_match', ARRAY['email_send'], 'message') RETURNING id`,
      [seeded.alpha.workspaceId, crm.alpha.firmId],
    );
    const elsewhere = await secondFirmWithOpportunity();
    await database.session.query(
      `INSERT INTO mail_message_matches
         (workspace_id, mail_message_id, firm_id, opportunity_id, match_rule, ambiguous, hold_id)
       VALUES ($1, $2, $3, $4, 'participant', true, $5)`,
      [
        seeded.alpha.workspaceId,
        inbound.messageId,
        elsewhere.firmId,
        elsewhere.opportunityId,
        hold[0]?.id ?? '',
      ],
    );
    await expect(
      grantFollowUpPermission(salesperson(), {
        firmId: crm.alpha.firmId,
        contactId,
        mailMessageId: inbound.messageId,
        grantedByUserId: seeded.alpha.salesperson.userId,
      }),
    ).rejects.toThrow();
  });

  it('refuses a follow_up_later whose consequence was a callback: that is a call, not an e-mail', async () => {
    const contactId = await addContact('Booked A Call');
    const inbound = await seedInboundRequest(contactId, {
      disposition: 'follow_up_later',
      withCallback: true,
    });
    await expect(
      grantFollowUpPermission(salesperson(), {
        firmId: crm.alpha.firmId,
        contactId,
        mailMessageId: inbound.messageId,
        grantedByUserId: seeded.alpha.salesperson.userId,
      }),
    ).rejects.toThrow();
  });

  it('refuses a callback call log through the API, not only through the call command', async () => {
    // P0-1's sharpest case: `logCallOutcome` refuses to grant on `callback_requested`,
    // but the grant route took a call log id. It now reads the log, and a log that
    // agreed to nothing supports nothing whatever the caller asks for.
    const contactId = await addContact('Call Me Tuesday');
    const callLogId = await recordCall(contactId, { kind: 'none' }, { outcome: 'callback_requested' });
    const refused = await grantFollowUpPermission(salesperson(), {
      firmId: crm.alpha.firmId,
      contactId,
      callLogId,
      grantedByUserId: seeded.alpha.salesperson.userId,
    });
    expect(refused).toEqual({ ok: false, reason: 'follow_up_not_permitted' });
  });

  it('refuses a conversation that agreed to nothing', async () => {
    const contactId = await addContact('Agreed Nothing');
    const callLogId = await recordCall(contactId, { kind: 'none' });
    expect(
      await grantFollowUpPermission(salesperson(), {
        firmId: crm.alpha.firmId,
        contactId,
        callLogId,
        grantedByUserId: seeded.alpha.salesperson.userId,
      }),
    ).toEqual({ ok: false, reason: 'follow_up_not_permitted' });
  });

  it('refuses a call log that names no person: a main line is not somebody\u2019s consent', async () => {
    const contactId = await addContact('Main Line');
    const callLogId = await recordCall(null, {
      kind: 'agreed_sequence',
      sequenceVersionId: sequences.alpha.publishedVersionId,
    });
    await expect(
      grantFollowUpPermission(salesperson(), {
        firmId: crm.alpha.firmId,
        contactId,
        callLogId,
        grantedByUserId: seeded.alpha.salesperson.userId,
      }),
    ).rejects.toThrow();
  });

  it('refuses two pieces of evidence at once', async () => {
    // P0-1: with two, the first that holds up returned and the second was never read.
    const contactId = await addContact('Two Evidences');
    const callLogId = await recordCall(contactId, {
      kind: 'agreed_sequence',
      sequenceVersionId: sequences.alpha.publishedVersionId,
    });
    const inbound = await seedInboundRequest(contactId);
    expect(
      await grantFollowUpPermission(salesperson(), {
        firmId: crm.alpha.firmId,
        contactId,
        callLogId,
        mailMessageId: inbound.messageId,
        grantedByUserId: seeded.alpha.salesperson.userId,
      }),
    ).toEqual({ ok: false, reason: 'invalid_input' });
  });

  it('refuses a revoked permission', async () => {
    const contactId = await addContact('Revoked');
    const granted = await grantAgreedSequence(contactId);
    const enrollmentId = await enrolFollowUp(contactId, granted.permissionId);
    expect((await revokeFollowUpPermission(worker(), granted.permissionId)).ok).toBe(true);
    expect(await followUpPermissionSource().evaluate(worker(), await stepOf(enrollmentId))).toEqual({
      ok: false,
      reasonCode: 'follow_up_not_permitted',
      detail: 'revoked',
    });
  });

  it('refuses an expired permission: timing is part of the permission', async () => {
    const contactId = await addContact('Expired');
    const granted = await grantAgreedSequence(contactId);
    const enrollmentId = await enrolFollowUp(contactId, granted.permissionId);
    const { rows } = await database.session.query<{ expires_at: Date }>(
      `UPDATE follow_up_permissions SET expires_at = granted_at + interval '1 second'
        WHERE workspace_id = $1 AND id = $2 RETURNING expires_at`,
      [seeded.alpha.workspaceId, granted.permissionId],
    );
    const outcome = await followUpPermissionSource().evaluate(worker(), {
      ...(await stepOf(enrollmentId)),
      now: new Date(Date.parse(rows[0]?.expires_at.toISOString() ?? '') + 1000).toISOString(),
    });
    expect(outcome).toEqual({
      ok: false,
      reasonCode: 'follow_up_expired',
      detail: rows[0]?.expires_at.toISOString(),
    });
  });

  it('single_email: permitted until its one e-mail is consumed, then scope-exhausted', async () => {
    // A one-step enrollment, because that is all a `single_email` permission buys:
    // "'Email me an overview' permits that email, not an automatic multi-week sequence."
    const contactId = await addContact('One Email');
    const granted = await grantSingleEmail(contactId, sequences.alpha.template.templateVersionId);
    const oneStep = await onePublishedStep();
    const result = await enrollContact(salesperson(), {
      sequenceVersionId: oneStep,
      originKind: 'follow_up',
      permissionId: granted.permissionId,
      opportunityId: crm.alpha.opportunityId,
      firmId: crm.alpha.firmId,
      contactId,
    });
    if (!result.ok) throw new Error(`refused: ${result.reason}`);
    const step = await stepOf(result.value.enrollmentId);
    expect(await followUpPermissionSource().evaluate(worker(), step)).toEqual({ ok: true });

    // The dispatch claim's own statement, which is what `dispatchOutboundMessage` runs
    // once the fence is claimed.
    expect(await consumeFollowUpPermission(worker(), granted.permissionId)).toBe(true);
    expect(await followUpPermissionSource().evaluate(worker(), step)).toEqual({
      ok: false,
      reasonCode: 'follow_up_scope_exhausted',
      detail: 'already_sent',
    });
    // Idempotent: a second consumption changes nothing and claims nothing.
    expect(await consumeFollowUpPermission(worker(), granted.permissionId)).toBe(false);
  });

  it('single_email: refuses a multi-step plan at the command, before an enrollment exists', async () => {
    const contactId = await addContact('One Email Only');
    const granted = await grantSingleEmail(contactId, sequences.alpha.template.templateVersionId);
    // The seeded published version has more than one step, which is exactly the
    // "automatic multi-week sequence" a single e-mail does not buy.
    const refused = await enrollContact(salesperson(), {
      sequenceVersionId: sequences.alpha.publishedVersionId,
      originKind: 'follow_up',
      permissionId: granted.permissionId,
      opportunityId: crm.alpha.opportunityId,
      firmId: crm.alpha.firmId,
      contactId,
    });
    expect(refused).toEqual({ ok: false, reason: 'follow_up_not_permitted' });
  });

  it('agreed_sequence: the bound follows the enrolment that used it, not the grant', async () => {
    // The third review of PR 332. The grant computed the bound from *its own* instant;
    // an enrolment days later ran a plan whose last step fell outside it — the
    // permission's own sequence, refused by the permission. The bind now recomputes the
    // bound from the start the run actually took, on the calendar it froze.
    const contactId = await addContact('Enrolled Later');
    const versionId = await publishDelayedPlan();
    const granted = await grantAgreedSequence(contactId, versionId);
    // The wait between agreeing and enrolling: the permission was granted three days ago
    // and, because its plan is a week long, is still live.
    await database.session.query(
      `UPDATE follow_up_permissions
          SET granted_at = granted_at - interval '3 days', expires_at = expires_at - interval '3 days'
        WHERE workspace_id = $1 AND id = $2`,
      [seeded.alpha.workspaceId, granted.permissionId],
    );
    const { rows: atGrant } = await database.session.query<{ expires_at: Date }>(
      'SELECT expires_at FROM follow_up_permissions WHERE workspace_id = $1 AND id = $2',
      [seeded.alpha.workspaceId, granted.permissionId],
    );

    const result = await enrollContact(salesperson(), {
      sequenceVersionId: versionId,
      originKind: 'follow_up',
      permissionId: granted.permissionId,
      opportunityId: crm.alpha.opportunityId,
      firmId: crm.alpha.firmId,
      contactId,
    });
    if (!result.ok) throw new Error(`refused: ${result.reason}`);

    const { rows: bound } = await database.session.query<{ expires_at: Date; started_at: Date }>(
      `SELECT p.expires_at, n.started_at
         FROM follow_up_permissions p
         JOIN sequence_enrollments n ON n.workspace_id = p.workspace_id AND n.id = p.enrollment_id
        WHERE p.workspace_id = $1 AND p.id = $2`,
      [seeded.alpha.workspaceId, granted.permissionId],
    );
    const startedAt = bound[0]?.started_at?.toISOString() ?? '';
    const expected = agreedSequenceExpiry(
      (await readSequenceVersion(worker(), versionId))?.steps ?? [],
      startedAt,
      'America/New_York',
      await currentHolidayCalendar(worker()),
    );
    // Exactly the plan's own end, measured from this run's start…
    expect(bound[0]?.expires_at?.toISOString()).toBe(expected);
    // …and later than the bound the grant three days ago had left it with, which is the
    // window the old code would have run this plan inside.
    expect(bound[0]?.expires_at?.getTime() ?? 0).toBeGreaterThan(atGrant[0]?.expires_at?.getTime() ?? 0);
  });

  it('agreed_sequence: refuses a step of another sequence', async () => {
    const contactId = await addContact('Agreed Elsewhere');
    // The permission names a different published **version** from the one the
    // enrollment runs, which is the unit an agreement is made in since P0-3.
    const other = await onePublishedStep();
    const granted = await grantAgreedSequence(contactId, other);
    // The enrollment has to be written directly: `enrollContact` refuses this, which is
    // the same rule one layer earlier.
    const refused = await enrollContact(salesperson(), {
      sequenceVersionId: sequences.alpha.publishedVersionId,
      originKind: 'follow_up',
      permissionId: granted.permissionId,
      opportunityId: crm.alpha.opportunityId,
      firmId: crm.alpha.firmId,
      contactId,
    });
    expect(refused).toEqual({ ok: false, reason: 'follow_up_not_permitted' });

    const { rows } = await database.session.query<{ id: string }>(
      `INSERT INTO sequence_enrollments
         (workspace_id, sequence_version_id, opportunity_id, firm_id, contact_id, assigned_user_id,
          firm_time_zone, holiday_calendar_version, origin_kind, permission_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'America/New_York', 'none.1', 'follow_up', $7)
       RETURNING id`,
      [
        seeded.alpha.workspaceId,
        sequences.alpha.publishedVersionId,
        crm.alpha.opportunityId,
        crm.alpha.firmId,
        contactId,
        seeded.alpha.salesperson.userId,
        granted.permissionId,
      ],
    );
    const enrollmentId = rows[0]?.id ?? '';
    await database.session.query(
      `INSERT INTO step_executions
         (workspace_id, enrollment_id, step_id, firm_id, contact_id, channel, ordinal,
          due_at, not_before, original_due_at, source_zone, rule_version)
       SELECT $1, $2, s.id, $3, $4, s.channel, s.ordinal, now(), now(), now(), 'America/New_York', 'elapsed.1'
         FROM sequence_steps s
        WHERE s.workspace_id = $1 AND s.sequence_version_id = $5
        ORDER BY s.ordinal LIMIT 1`,
      [
        seeded.alpha.workspaceId,
        enrollmentId,
        crm.alpha.firmId,
        contactId,
        sequences.alpha.publishedVersionId,
      ],
    );
    expect(await followUpPermissionSource().evaluate(worker(), await stepOf(enrollmentId))).toEqual({
      ok: false,
      reasonCode: 'follow_up_scope_exhausted',
      detail: 'another_version',
    });
  });

  it('booking_communications is reserved and says so, rather than being waved through', async () => {
    const contactId = await addContact('Booked');
    const granted = await grantFollowUpPermission(salesperson(), {
      firmId: crm.alpha.firmId,
      contactId,
      bookingReference: 'cal-booking-0001',
      grantedByUserId: seeded.alpha.salesperson.userId,
    });
    if (!granted.ok) throw new Error(`refused: ${granted.reason}`);
    const refused = await enrollContact(salesperson(), {
      sequenceVersionId: sequences.alpha.publishedVersionId,
      originKind: 'follow_up',
      permissionId: granted.value.id,
      opportunityId: crm.alpha.opportunityId,
      firmId: crm.alpha.firmId,
      contactId,
    });
    expect(refused).toEqual({ ok: false, reason: 'follow_up_not_permitted' });
  });
});

describe('the manual-mode wall, resolved for follow-ups only (David, item 1)', () => {
  it('a signal-set manual mode does not block a follow-up step', async () => {
    const contactId = await addContact('Replied');
    const granted = await grantAgreedSequence(contactId);
    const enrollmentId = await enrolFollowUp(contactId, granted.permissionId);
    const manual = await setManualControlMode(salesperson(), {
      opportunityId: crm.alpha.opportunityId,
      reason: 'confirmed reply disposition: interested',
      origin: 'human_reply',
    });
    expect(manual.ok).toBe(true);
    expect(await controlModeSource().evaluate(worker(), await stepOf(enrollmentId))).toEqual({ ok: true });
  });

  it("a person's explicit takeover does block it", async () => {
    const contactId = await addContact('Taken Over');
    const granted = await grantAgreedSequence(contactId);
    const enrollmentId = await enrolFollowUp(contactId, granted.permissionId);
    const manual = await setManualControlMode(salesperson(), {
      opportunityId: crm.alpha.opportunityId,
      reason: 'I will handle this firm myself',
      origin: 'salesperson_command',
    });
    expect(manual.ok).toBe(true);
    expect(await controlModeSource().evaluate(worker(), await stepOf(enrollmentId))).toEqual({
      ok: false,
      reasonCode: 'opportunity_manual',
      detail: 'takeover:salesperson_command',
    });
  });

  it('a takeover after a signal escalates the recorded origin, and then blocks', async () => {
    const contactId = await addContact('Replied Then Taken Over');
    const granted = await grantAgreedSequence(contactId);
    const enrollmentId = await enrolFollowUp(contactId, granted.permissionId);
    await setManualControlMode(salesperson(), {
      opportunityId: crm.alpha.opportunityId,
      reason: 'confirmed reply disposition: interested',
      origin: 'human_reply',
    });
    expect(await controlModeSource().evaluate(worker(), await stepOf(enrollmentId))).toEqual({ ok: true });

    await setManualControlMode(salesperson(), {
      opportunityId: crm.alpha.opportunityId,
      reason: 'I will handle this firm myself',
      origin: 'salesperson_command',
    });
    expect(await controlModeSource().evaluate(worker(), await stepOf(enrollmentId))).toEqual({
      ok: false,
      reasonCode: 'opportunity_manual',
      detail: 'takeover:salesperson_command',
    });
  });

  it('a signal never overwrites a recorded takeover', async () => {
    const contactId = await addContact('Taken Over Then Replied');
    const granted = await grantAgreedSequence(contactId);
    const enrollmentId = await enrolFollowUp(contactId, granted.permissionId);
    await setManualControlMode(salesperson(), {
      opportunityId: crm.alpha.opportunityId,
      reason: 'I will handle this firm myself',
      origin: 'salesperson_command',
    });
    await setManualControlMode(salesperson(), {
      opportunityId: crm.alpha.opportunityId,
      reason: 'confirmed reply disposition: interested',
      origin: 'human_reply',
    });
    expect(await controlModeSource().evaluate(worker(), await stepOf(enrollmentId))).toEqual({
      ok: false,
      reasonCode: 'opportunity_manual',
      detail: 'takeover:salesperson_command',
    });
  });

  it('an unrecorded origin — every opportunity that went manual before 0025 — blocks', async () => {
    const contactId = await addContact('Manual Before The Rule');
    const granted = await grantAgreedSequence(contactId);
    const enrollmentId = await enrolFollowUp(contactId, granted.permissionId);
    // The pre-0025 shape: manual, with no origin recorded anywhere the row can see.
    await database.session.query(
      `UPDATE opportunities
          SET control_mode = 'manual', control_mode_reason = 'set before 0025',
              control_mode_changed_at = now(), control_mode_origin = NULL
        WHERE workspace_id = $1 AND id = $2`,
      [seeded.alpha.workspaceId, crm.alpha.opportunityId],
    );
    expect(await controlModeSource().evaluate(worker(), await stepOf(enrollmentId))).toEqual({
      ok: false,
      reasonCode: 'opportunity_manual',
      detail: 'takeover:unrecorded',
    });
  });

  it("a salesperson's own Gmail send is a takeover, and blocks the follow-up", async () => {
    // P1-1 of the GPT-6 review of PR 332, and the coordinator's reading of it: a direct
    // send is the salesperson taking the conversation over, not a prospect signal.
    const contactId = await addContact('Written To By Hand');
    const granted = await grantAgreedSequence(contactId);
    const enrollmentId = await enrolFollowUp(contactId, granted.permissionId);
    const manual = await setManualControlMode(salesperson(), {
      opportunityId: crm.alpha.opportunityId,
      reason: 'sent from Gmail by hand',
      origin: 'direct_send',
    });
    expect(manual.ok).toBe(true);
    expect(await controlModeSource().evaluate(worker(), await stepOf(enrollmentId))).toEqual({
      ok: false,
      reasonCode: 'opportunity_manual',
      detail: 'takeover:direct_send',
    });
  });

  it('unless the person says to keep following up, which is a command and not an inference', async () => {
    const contactId = await addContact('Keep Following Up');
    const granted = await grantAgreedSequence(contactId);
    const enrollmentId = await enrolFollowUp(contactId, granted.permissionId);
    await setManualControlMode(salesperson(), {
      opportunityId: crm.alpha.opportunityId,
      reason: 'sent from Gmail by hand',
      origin: 'direct_send',
    });
    const chosen = await keepFollowingUpAfterDirectSend(salesperson(), {
      opportunityId: crm.alpha.opportunityId,
      reason: 'I answered one question; Callie keeps the agreed sequence',
    });
    expect(chosen.ok).toBe(true);
    expect(await controlModeSource().evaluate(worker(), await stepOf(enrollmentId))).toEqual({ ok: true });
    // The opportunity is still manual: nothing here reverses manual mode.
    const { rows } = await database.session.query<{ control_mode: string; control_mode_origin: string }>(
      'SELECT control_mode, control_mode_origin FROM opportunities WHERE workspace_id = $1 AND id = $2',
      [seeded.alpha.workspaceId, crm.alpha.opportunityId],
    );
    expect(rows[0]?.control_mode).toBe('manual');
    expect(rows[0]?.control_mode_origin).toBe('direct_send_keep_automation');
  });

  it('and a later send by hand takes it back: the choice was about one message', async () => {
    // P1-1 of the second review of PR 332. The person let the automation continue after
    // writing once by hand; writing again by hand is them taking the conversation back,
    // and the choice can be made again afterwards.
    const contactId = await addContact('Wrote By Hand Twice');
    const granted = await grantAgreedSequence(contactId);
    const enrollmentId = await enrolFollowUp(contactId, granted.permissionId);
    await setManualControlMode(salesperson(), {
      opportunityId: crm.alpha.opportunityId,
      reason: 'sent from Gmail by hand',
      origin: 'direct_send',
    });
    await keepFollowingUpAfterDirectSend(salesperson(), {
      opportunityId: crm.alpha.opportunityId,
      reason: 'one answer; Callie keeps the agreed sequence',
    });
    expect(await controlModeSource().evaluate(worker(), await stepOf(enrollmentId))).toEqual({ ok: true });

    // The second hand-written message.
    await setManualControlMode(salesperson(), {
      opportunityId: crm.alpha.opportunityId,
      reason: 'sent from Gmail by hand again',
      origin: 'direct_send',
    });
    expect(await controlModeSource().evaluate(worker(), await stepOf(enrollmentId))).toEqual({
      ok: false,
      reasonCode: 'opportunity_manual',
      detail: 'takeover:direct_send',
    });

    // And the choice is still available, because it is a choice and not a state machine.
    const again = await keepFollowingUpAfterDirectSend(salesperson(), {
      opportunityId: crm.alpha.opportunityId,
      reason: 'again: Callie keeps the agreed sequence',
    });
    expect(again.ok).toBe(true);
    expect(await controlModeSource().evaluate(worker(), await stepOf(enrollmentId))).toEqual({ ok: true });
  });

  it('but a takeover is never downgraded by a later direct send', async () => {
    const contactId = await addContact('Taken Over Then Sent By Hand');
    const granted = await grantAgreedSequence(contactId);
    const enrollmentId = await enrolFollowUp(contactId, granted.permissionId);
    await takeOverOpportunity(salesperson(), {
      opportunityId: crm.alpha.opportunityId,
      reason: 'I will handle this firm myself',
    });
    await setManualControlMode(salesperson(), {
      opportunityId: crm.alpha.opportunityId,
      reason: 'sent from Gmail by hand',
      origin: 'direct_send',
    });
    expect(await controlModeSource().evaluate(worker(), await stepOf(enrollmentId))).toEqual({
      ok: false,
      reasonCode: 'opportunity_manual',
      detail: 'takeover:salesperson_command',
    });
  });

  it('and that choice cannot relabel a takeover: it is conditional on the origin it replaces', async () => {
    const contactId = await addContact('Taken Over Not Relabelled');
    const granted = await grantAgreedSequence(contactId);
    const enrollmentId = await enrolFollowUp(contactId, granted.permissionId);
    await takeOverOpportunity(salesperson(), {
      opportunityId: crm.alpha.opportunityId,
      reason: 'I will handle this firm myself',
    });
    const refused = await keepFollowingUpAfterDirectSend(salesperson(), {
      opportunityId: crm.alpha.opportunityId,
      reason: 'trying to hand it back',
    });
    expect(refused).toEqual({ ok: false, reason: 'invalid_input' });
    expect(await controlModeSource().evaluate(worker(), await stepOf(enrollmentId))).toEqual({
      ok: false,
      reasonCode: 'opportunity_manual',
      detail: 'takeover:salesperson_command',
    });
  });

  it('the takeover command is what writes salesperson_command, and a person is authenticated for it', async () => {
    const contactId = await addContact('Taken Over By Command');
    const granted = await grantAgreedSequence(contactId);
    const enrollmentId = await enrolFollowUp(contactId, granted.permissionId);
    const taken = await takeOverOpportunity(salesperson(), {
      opportunityId: crm.alpha.opportunityId,
      reason: 'I will write to them myself',
    });
    expect(taken.ok).toBe(true);
    expect(await controlModeSource().evaluate(worker(), await stepOf(enrollmentId))).toEqual({
      ok: false,
      reasonCode: 'opportunity_manual',
      detail: 'takeover:salesperson_command',
    });
  });

  it('an administrator classifies one NULL origin, with a reason, and only while it is NULL', async () => {
    const contactId = await addContact('Classified By Hand');
    const granted = await grantAgreedSequence(contactId);
    const enrollmentId = await enrolFollowUp(contactId, granted.permissionId);
    await database.session.query(
      `UPDATE opportunities
          SET control_mode = 'manual', control_mode_reason = 'they replied, set before 0025',
              control_mode_changed_at = now(), control_mode_origin = NULL
        WHERE workspace_id = $1 AND id = $2`,
      [seeded.alpha.workspaceId, crm.alpha.opportunityId],
    );
    // Not a salesperson's command: 5.2's administrator, asked in the domain.
    const refused = await classifyControlModeOrigin(salesperson(), {
      opportunityId: crm.alpha.opportunityId,
      origin: 'human_reply',
      reason: 'I read the reply',
    });
    expect(refused).toEqual({ ok: false, reason: 'admin_only' });

    const classified = await classifyControlModeOrigin(admin(), {
      opportunityId: crm.alpha.opportunityId,
      origin: 'human_reply',
      reason: 'the message of 3 September is a confirmed human reply',
    });
    expect(classified.ok).toBe(true);
    expect(await controlModeSource().evaluate(worker(), await stepOf(enrollmentId))).toEqual({ ok: true });
    // The audit row carries the reason and the evidence the administrator was shown.
    const { rows: audited } = await database.session.query<{ detail: Record<string, unknown> }>(
      `SELECT detail FROM audit_events
        WHERE workspace_id = $1 AND subject_id = $2 AND detail->>'classified' = 'true'`,
      [seeded.alpha.workspaceId, crm.alpha.opportunityId],
    );
    expect(audited).toHaveLength(1);
    expect(String(audited[0]?.detail?.['reason'] ?? '')).toContain('confirmed human reply');
    // The evidence is kept as facts, not as the sentence: `audit.ts` keeps notes out of
    // a detail, and the sentence stays on the opportunity, unchanged.
    expect(audited[0]?.detail?.['evidence']).toMatchObject({ controlModeReasonRecorded: true });

    // And a second classification cannot move a recorded origin.
    const again = await classifyControlModeOrigin(admin(), {
      opportunityId: crm.alpha.opportunityId,
      origin: 'salesperson_command',
      reason: 'changing my mind',
    });
    expect(again).toEqual({ ok: false, reason: 'invalid_input' });
  });

  it('a prospecting step is blocked by manual mode whatever set it', async () => {
    // Unchanged, deliberately: the follow-up rule is an exception for follow-ups.
    const result = await enrollContact(salesperson(), {
      sequenceVersionId: sequences.alpha.publishedVersionId,
      originKind: 'prospecting',
      opportunityId: crm.alpha.opportunityId,
      firmId: crm.alpha.firmId,
      contactId: crm.alpha.contactId,
    });
    if (!result.ok) throw new Error(`refused: ${result.reason}`);
    await setManualControlMode(salesperson(), {
      opportunityId: crm.alpha.opportunityId,
      reason: 'confirmed reply disposition: interested',
      origin: 'human_reply',
    });
    expect(await controlModeSource().evaluate(worker(), await stepOf(result.value.enrollmentId))).toEqual({
      ok: false,
      reasonCode: 'opportunity_manual',
    });
  });
});

/** A published version with exactly one step, for the `single_email` scope. */
async function onePublishedStep(): Promise<string> {
  const { rows: sequenceRows } = await database.session.query<{ id: string }>(
    `INSERT INTO sequences (workspace_id, name, created_by_user_id) VALUES ($1, $2, $3) RETURNING id`,
    [seeded.alpha.workspaceId, `One step ${String(Date.now())}`, seeded.alpha.admin.userId],
  );
  return await publishOneStep(sequenceRows[0]?.id ?? '');
}

/** A published plan with a week in it, so "when does this agreement end" has an answer. */
async function publishDelayedPlan(): Promise<string> {
  const { rows: sequenceRows } = await database.session.query<{ id: string }>(
    `INSERT INTO sequences (workspace_id, name, created_by_user_id) VALUES ($1, $2, $3) RETURNING id`,
    [seeded.alpha.workspaceId, `Delayed plan ${randomUUID().slice(0, 8)}`, seeded.alpha.admin.userId],
  );
  const { rows: versions } = await database.session.query<{ id: string }>(
    `INSERT INTO sequence_versions (workspace_id, sequence_id, version, state)
     VALUES ($1, $2, 1, 'draft') RETURNING id`,
    [seeded.alpha.workspaceId, sequenceRows[0]?.id ?? ''],
  );
  const versionId = versions[0]?.id ?? '';
  await database.session.query(
    `INSERT INTO sequence_steps
       (workspace_id, sequence_version_id, ordinal, channel, delay_unit, delay_amount, template_version_id)
     VALUES ($1, $2, 1, 'email', 'elapsed', 0, $3), ($1, $2, 2, 'email', 'business_days', 5, $3)`,
    [seeded.alpha.workspaceId, versionId, sequences.alpha.template.templateVersionId],
  );
  await database.session.query(
    `UPDATE sequence_versions
        SET state = 'published', published_at = now(), published_by_user_id = $3
      WHERE workspace_id = $1 AND id = $2`,
    [seeded.alpha.workspaceId, versionId, seeded.alpha.admin.userId],
  );
  return versionId;
}

async function publishOneStep(sequenceId: string): Promise<string> {
  const { rows: versions } = await database.session.query<{ id: string }>(
    `INSERT INTO sequence_versions (workspace_id, sequence_id, version, state)
     VALUES ($1, $2, 1, 'draft') RETURNING id`,
    [seeded.alpha.workspaceId, sequenceId],
  );
  const versionId = versions[0]?.id ?? '';
  await database.session.query(
    `INSERT INTO sequence_steps
       (workspace_id, sequence_version_id, ordinal, channel, delay_unit, delay_amount, template_version_id)
     VALUES ($1, $2, 1, 'email', 'elapsed', 0, $3)`,
    [seeded.alpha.workspaceId, versionId, sequences.alpha.template.templateVersionId],
  );
  await database.session.query(
    `UPDATE sequence_versions
        SET state = 'published', published_at = now(), published_by_user_id = $3
      WHERE workspace_id = $1 AND id = $2`,
    [seeded.alpha.workspaceId, versionId, seeded.alpha.admin.userId],
  );
  return versionId;
}

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { setManualControlMode } from '../../crm/pipeline.ts';
import { databaseNow } from '../../policy/clock.ts';
import {
  CHANNEL_ACTION_KINDS,
  controlModeSource,
  followUpPermissionSource,
  type StepEligibilityInput,
} from '../../sequences/eligibility.ts';
import { enrollContact } from '../../sequences/enrollments.ts';
import {
  consumeFollowUpPermission,
  grantFollowUpPermission,
  revokeFollowUpPermission,
} from '../../sequences/followUpPermissions.ts';
import { resumeEnrollment } from '../../sequences/resume.ts';
import { listStepExecutions, readEnrollment } from '../../sequences/rows.ts';
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

/** A recorded `interested` call with this person: the evidence a conversation leaves. */
async function recordCall(contactId: string, firmId = crm.alpha.firmId): Promise<string> {
  const { rows } = await database.session.query<{ id: string }>(
    `INSERT INTO call_logs
       (workspace_id, firm_id, contact_id, opportunity_id, outcome, step_effect, occurred_at, actor_user_id)
     VALUES ($1, $2, $3, $4, 'interested', 'none', now() - interval '1 second', $5)
     RETURNING id`,
    [
      seeded.alpha.workspaceId,
      firmId,
      contactId,
      firmId === crm.alpha.firmId ? crm.alpha.opportunityId : null,
      seeded.alpha.salesperson.userId,
    ],
  );
  return rows[0]?.id ?? '';
}

/** The sequence id of the seeded published version. */
async function seededSequenceId(): Promise<string> {
  const { rows } = await database.session.query<{ sequence_id: string }>(
    'SELECT sequence_id FROM sequence_versions WHERE workspace_id = $1 AND id = $2',
    [seeded.alpha.workspaceId, sequences.alpha.publishedVersionId],
  );
  return rows[0]?.sequence_id ?? '';
}

interface Granted {
  readonly permissionId: string;
  readonly contactId: string;
  readonly callLogId: string;
}

async function grant(
  contactId: string,
  scope: 'single_email' | 'contextual_reply' | 'agreed_sequence',
  overrides: { readonly sequenceId?: string; readonly expiresAt?: string } = {},
): Promise<Granted> {
  const callLogId = await recordCall(contactId);
  const granted = await grantFollowUpPermission(salesperson(), {
    firmId: crm.alpha.firmId,
    contactId,
    kind: scope === 'agreed_sequence' ? 'agreed_sequence' : 'conversation',
    scope,
    callLogId,
    ...(scope === 'agreed_sequence'
      ? { sequenceId: overrides.sequenceId ?? (await seededSequenceId()) }
      : {}),
    ...(overrides.expiresAt === undefined ? {} : { expiresAt: overrides.expiresAt }),
    grantedByUserId: seeded.alpha.salesperson.userId,
  });
  if (!granted.ok) throw new Error(`the permission fixture was refused: ${granted.reason}`);
  return { permissionId: granted.value.id, contactId, callLogId };
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

  it('is not what a later valid request revives: that is a new enrollment of its own', async () => {
    const contactId = await addContact('Legacy Four');
    const legacy = await insertLegacyEnrollment(contactId);
    await database.session.query(
      `UPDATE sequence_enrollments SET state = 'stopped', ended_at = now(), end_reason = 'admin_stop'
        WHERE workspace_id = $1 AND id = $2`,
      [seeded.alpha.workspaceId, legacy],
    );

    const granted = await grant(contactId, 'agreed_sequence');
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
    const granted = await grant(contactId, 'agreed_sequence');
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
    const granted = await grant(contactId, 'agreed_sequence');
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
    // The mail arm: `mail_messages` carries no firm, so the evidence is the match, and a
    // match a merge or a deletion removed is a message that is no longer evidence here.
    const contactId = await addContact('Mismatch Three');
    const { rows: mailbox } = await database.session.query<{ id: string }>(
      `INSERT INTO mailboxes (workspace_id, owner_user_id, email_address, provider_account_id, status)
       VALUES ($1, $2, 'fu-mailbox@example.test', 'fu-account', 'connected') RETURNING id`,
      [seeded.alpha.workspaceId, seeded.alpha.salesperson.userId],
    );
    const { rows: message } = await database.session.query<{ id: string }>(
      `INSERT INTO mail_messages
         (workspace_id, mailbox_id, provider_message_id, provider_thread_id, direction,
          internal_date, header_from, matched)
       VALUES ($1, $2, 'fu-message-1', 'fu-thread-1', 'incoming', now(), 'prospect@example.test', true)
       RETURNING id`,
      [seeded.alpha.workspaceId, mailbox[0]?.id ?? ''],
    );
    const messageId = message[0]?.id ?? '';
    const { rows: match } = await database.session.query<{ id: string }>(
      `INSERT INTO mail_message_matches
         (workspace_id, mail_message_id, firm_id, opportunity_id, contact_id, match_rule)
       VALUES ($1, $2, $3, $4, $5, 'participant') RETURNING id`,
      [seeded.alpha.workspaceId, messageId, crm.alpha.firmId, crm.alpha.opportunityId, contactId],
    );
    const granted = await grantFollowUpPermission(salesperson(), {
      firmId: crm.alpha.firmId,
      contactId,
      kind: 'request',
      scope: 'contextual_reply',
      mailMessageId: messageId,
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
      match[0]?.id ?? '',
    ]);
    expect(await followUpPermissionSource().evaluate(worker(), await stepOf(enrollmentId))).toEqual({
      ok: false,
      reasonCode: 'follow_up_not_permitted',
      detail: 'inbound_match_missing',
    });
  });

  it('refuses a revoked permission', async () => {
    const contactId = await addContact('Revoked');
    const granted = await grant(contactId, 'agreed_sequence');
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
    const granted = await grant(contactId, 'agreed_sequence');
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
    const granted = await grant(contactId, 'single_email');
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
    const granted = await grant(contactId, 'single_email');
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

  it('agreed_sequence: refuses a step of another sequence', async () => {
    const contactId = await addContact('Agreed Elsewhere');
    // The permission names a different sequence from the one the enrollment runs.
    const other = await otherSequenceId();
    const granted = await grant(contactId, 'agreed_sequence', { sequenceId: other });
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
      detail: 'another_sequence',
    });
  });

  it('booking_communications is reserved and says so, rather than being waved through', async () => {
    const contactId = await addContact('Booked');
    const granted = await grantFollowUpPermission(salesperson(), {
      firmId: crm.alpha.firmId,
      contactId,
      kind: 'booking',
      scope: 'booking_communications',
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
    const granted = await grant(contactId, 'agreed_sequence');
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
    const granted = await grant(contactId, 'agreed_sequence');
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
    const granted = await grant(contactId, 'agreed_sequence');
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
    const granted = await grant(contactId, 'agreed_sequence');
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
    const granted = await grant(contactId, 'agreed_sequence');
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

/** Another sequence, published, so "another sequence" is a real one. */
async function otherSequenceId(): Promise<string> {
  const { rows } = await database.session.query<{ id: string }>(
    `INSERT INTO sequences (workspace_id, name, created_by_user_id) VALUES ($1, $2, $3) RETURNING id`,
    [seeded.alpha.workspaceId, `Another sequence ${String(Date.now())}`, seeded.alpha.admin.userId],
  );
  const sequenceId = rows[0]?.id ?? '';
  await publishOneStep(sequenceId);
  return sequenceId;
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

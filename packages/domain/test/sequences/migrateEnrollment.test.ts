import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionQueryable } from '../../db/queryable.ts';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { createDraftVersion, publishVersion, retireVersion, type DraftStepInput } from '../../sequences/definitions.ts';
import { allowAllEligibility } from '../../sequences/eligibility.ts';
import { enrollContact, stepForCadence } from '../../sequences/enrollments.ts';
import { databaseNow } from '../../policy/clock.ts';
import { resolveStepDue } from '../../src/rules/cadence.ts';
import { placeEmailSend } from '../../src/rules/sendingWindow.ts';
import { lockSendGateForStopFact } from '../../policy/sendGate.ts';
import { completeStepExecution, runDueStepExecution } from '../../sequences/executions.ts';
import { grantFollowUpPermission } from '../../sequences/followUpPermissions.ts';
import { completedPrefix, migrateEnrollment } from '../../sequences/migrateEnrollment.ts';
import { listStepExecutions, readEnrollment, readSequenceVersion } from '../../sequences/rows.ts';
import { recordingSendHandoff } from '../../sequences/sendHandoff.ts';
import { seedCrm } from '../db/support/crmFixtures.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedMail, type SeededMail } from '../db/support/mailFixtures.ts';
import { seedSequences } from './support/sequenceFixtures.ts';
import {
  approvedTemplate,
  callStep,
  emailStep,
  newFirm,
  publishedPlan,
  publishedVersionOf,
  type VersionFirm,
} from './support/versionFixtures.ts';

/**
 * `POST /enrollments/migrate`'s domain half: supersede, never remap (send-path v2, S2).
 *
 * > "Explicitly migrating an enrollment must preserve completed steps and the agreed
 * > follow-up scope." — David, 30 September 2026.
 *
 * Every case builds its own sequence and firm. The anchor is pinned to Monday 21
 * September 2026, 09:00 in New York, so a due instant is a date anybody can check by
 * hand: three business days from it is Thursday the 24th at 08:00 EDT, 12:00Z.
 *
 * Each case names, in a comment, the rule whose removal makes it fail.
 */

const ANCHOR = '2026-09-21T13:00:00Z';

let database: TestDatabase;
let seeded: TwoWorkspaces;
let second: SessionQueryable;
let third: SessionQueryable;
/** A connected mailbox for the fence case. */
let mail: SeededMail;

const contextOn = (session: SessionQueryable, who: 'admin' | 'salesperson'): RepositoryContext =>
  repositoryContext(
    workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha[who].userId, role: who }),
    session,
  );
const admin = (): RepositoryContext => contextOn(database.session, 'admin');
const salesperson = (): RepositoryContext => contextOn(database.session, 'salesperson');
const worker = (session: SessionQueryable = database.session): RepositoryContext =>
  repositoryContext(workspaceScope(seeded.alpha.workspaceId, { kind: 'system', component: 'worker' }), session);

/**
 * A three-step plan, published, and its next version with other delays as a **draft**.
 * Publishing v2 retires v1 (one current version per sequence), so a case enrols in v1
 * first and then calls `publish(v2)` — which is the order it happens in for real.
 */
async function twoVersions(): Promise<{ sequenceId: string; v1: string; v2: string; template: string }> {
  const template = await approvedTemplate(admin(), 'Hello from the plan.');
  const plan = await publishedPlan(admin(), [emailStep(template), callStep(2, 2), callStep(3, 5)]);
  const draft = await createDraftVersion(admin(), {
    sequenceId: plan.sequenceId,
    steps: [emailStep(template), callStep(2, 3), callStep(3, 7)],
  });
  if (!draft.ok) throw new Error(`the draft was refused: ${draft.reason}`);
  return { sequenceId: plan.sequenceId, v1: plan.versionId, v2: draft.value.sequenceVersionId, template };
}

async function publish(sequenceVersionId: string): Promise<void> {
  const published = await publishVersion(admin(), { sequenceVersionId });
  if (!published.ok) throw new Error(`the publication was refused: ${published.reason}`);
}

/** Enrol, pin the anchor and the first step's due instant to ANCHOR, and answer the enrollment. */
async function enrolled(
  versionId: string,
  firm: VersionFirm,
  origin: { kind: 'prospecting' } | { kind: 'follow_up'; permissionId: string } = { kind: 'prospecting' },
  anchor: string = ANCHOR,
): Promise<string> {
  const result = await enrollContact(salesperson(), {
    sequenceVersionId: versionId,
    originKind: origin.kind,
    ...(origin.kind === 'follow_up' ? { permissionId: origin.permissionId } : {}),
    opportunityId: firm.opportunityId,
    firmId: firm.firmId,
    contactId: firm.contactId,
  });
  if (!result.ok) throw new Error(`the enrollment was refused: ${result.reason}`);
  const enrollmentId = result.value.enrollmentId;
  await database.session.query('UPDATE sequence_enrollments SET started_at = $2::timestamptz WHERE id = $1', [
    enrollmentId,
    anchor,
  ]);
  await database.session.query(
    `UPDATE step_executions SET due_at = $2::timestamptz, not_before = $2::timestamptz, original_due_at = $2::timestamptz
      WHERE enrollment_id = $1`,
    [enrollmentId, anchor],
  );
  return enrollmentId;
}

const ZONE = 'America/New_York';
/** The seeded calendar every fixture enrollment freezes (`sequenceFixtures.ts`). */
const CALENDAR = { version: 'holidays.2026', dates: ['2026-12-25', '2027-01-01'] };

/** A version's step at `ordinal`, in the cadence rule's shape. */
async function stepOf(versionId: string, ordinal: number): Promise<ReturnType<typeof stepForCadence>> {
  const step = (await readSequenceVersion(admin(), versionId))?.steps.find(entry => entry.ordinal === ordinal);
  if (step === undefined) throw new Error(`the version has no step ${String(ordinal)}`);
  return stepForCadence(step);
}

/** A `single_email` permission for `templateVersionId`, on a recorded interested call. */
async function singleEmailPermission(firm: VersionFirm, templateVersionId: string): Promise<string> {
  const { rows } = await database.session.query<{ id: string }>(
    `INSERT INTO call_logs
       (workspace_id, firm_id, contact_id, opportunity_id, outcome, step_effect, occurred_at,
        actor_user_id, agreed_follow_up, agreed_template_version_id)
     VALUES ($1, $2, $3, $4, 'interested', 'none', now() - interval '1 second', $5, 'single_email', $6)
     RETURNING id`,
    [seeded.alpha.workspaceId, firm.firmId, firm.contactId, firm.opportunityId, seeded.alpha.salesperson.userId, templateVersionId],
  );
  const granted = await grantFollowUpPermission(salesperson(), {
    firmId: firm.firmId,
    contactId: firm.contactId,
    callLogId: rows[0]?.id ?? '',
    grantedByUserId: seeded.alpha.salesperson.userId,
  });
  if (!granted.ok) throw new Error(`the permission was refused: ${granted.reason}`);
  return granted.value.id;
}

/** Complete the enrollment's unfinished step at its due instant, creating its successor. */
async function completeCurrent(enrollmentId: string): Promise<void> {
  const current = (await listStepExecutions(worker(), { enrollmentId })).find(
    step => step.state === 'pending' || step.state === 'held',
  );
  if (current === undefined) throw new Error('the enrollment has no unfinished step');
  const done = await completeStepExecution(worker(), {
    stepExecutionId: current.id,
    completionSource: current.channel === 'email' ? 'send' : 'call_log',
    result: current.channel === 'email' ? 'sent' : 'no_answer',
    // On time, so the successor is the plan's instant and not the late-step spacing floor.
    completedAt: current.dueAt,
  });
  if (!done.ok) throw new Error(`the completion was refused: ${done.reason}`);
}

/** An `agreed_sequence` permission for `versionId`, on a recorded interested call. */
async function agreedPermission(firm: VersionFirm, versionId: string, expiresAt?: string): Promise<string> {
  const { rows } = await database.session.query<{ id: string }>(
    `INSERT INTO call_logs
       (workspace_id, firm_id, contact_id, opportunity_id, outcome, step_effect, occurred_at,
        actor_user_id, agreed_follow_up, agreed_sequence_version_id)
     VALUES ($1, $2, $3, $4, 'interested', 'none', now() - interval '1 second', $5, 'agreed_sequence', $6)
     RETURNING id`,
    [seeded.alpha.workspaceId, firm.firmId, firm.contactId, firm.opportunityId, seeded.alpha.salesperson.userId, versionId],
  );
  const granted = await grantFollowUpPermission(salesperson(), {
    firmId: firm.firmId,
    contactId: firm.contactId,
    callLogId: rows[0]?.id ?? '',
    grantedByUserId: seeded.alpha.salesperson.userId,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  });
  if (!granted.ok) throw new Error(`the permission was refused: ${granted.reason}`);
  return granted.value.id;
}

async function permissionRow(permissionId: string): Promise<{ enrollment_id: string | null; revoked_at: Date | null; consumed_at: Date | null }> {
  const { rows } = await database.session.query<{ enrollment_id: string | null; revoked_at: Date | null; consumed_at: Date | null }>(
    'SELECT enrollment_id, revoked_at, consumed_at FROM follow_up_permissions WHERE id = $1',
    [permissionId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('the permission disappeared');
  return row;
}

async function inTransaction<T>(session: SessionQueryable, work: () => Promise<T>): Promise<T> {
  await session.query('BEGIN');
  try {
    const result = await work();
    await session.query('COMMIT');
    return result;
  } catch (error) {
    await session.query('ROLLBACK');
    throw error;
  }
}

async function someoneWaitsOnALock(): Promise<boolean> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const { rows } = await database.session.query<{ waiting: number }>(
      `SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    if ((rows[0]?.waiting ?? 0) > 0) return true;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return false;
}

beforeAll(async () => {
  database = await createTestDatabase();
  seeded = await seedTwoWorkspaces(database.session);
  // The holiday calendar every enrollment freezes; the plans are made per case.
  await seedSequences(database.session, seeded);
  mail = await seedMail(database.session, seeded, await seedCrm(database.session, seeded));
  second = await database.appRuntimeSession();
  third = await database.appRuntimeSession();
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  await database.session.query('DELETE FROM active_holds');
});

afterEach(async () => {
  await second.query('ROLLBACK');
  await third.query('ROLLBACK');
});

describe('the happy migration', () => {
  it('carries the completed prefix, schedules only the next step on the original anchor, and records the lineage', async () => {
    // Fails if: ordinal 1 is scheduled again, the anchor is not copied, the delay is the
    // old version's, the old enrollment is not ended, or the lineage is not written.
    const { v1, v2 } = await twoVersions();
    const firm = await newFirm(database.session, seeded.alpha);
    // An anchor an hour ago, so the plan's step 2 is still ahead and keeps its instant.
    const anchor = new Date(Date.parse(await databaseNow(admin())) - 60 * 60 * 1000).toISOString();
    const old = await enrolled(v1, firm, { kind: 'prospecting' }, anchor);
    await publish(v2);
    await completeCurrent(old);

    const migrated = await migrateEnrollment(salesperson(), { enrollmentId: old, targetSequenceVersionId: v2 });
    if (!migrated.ok) throw new Error(`the migration was refused: ${migrated.reason}`);
    expect(migrated.value).toMatchObject({
      oldEnrollmentId: old,
      carriedOrdinals: [1],
      nextOrdinal: 2,
      completed: false,
      rescheduledTo: null,
    });

    const before = await readEnrollment(admin(), { enrollmentId: old });
    expect(before).toMatchObject({ state: 'stopped', endReason: 'migration_superseded', sequenceVersionId: v1 });
    const oldSteps = await listStepExecutions(admin(), { enrollmentId: old });
    expect(oldSteps.map(step => [step.ordinal, step.state])).toEqual([
      [1, 'completed'],
      [2, 'cancelled'],
    ]);

    const fresh = migrated.value.newEnrollmentId;
    const { rows } = await database.session.query<{
      same_anchor: boolean;
      migrated_from_enrollment_id: string;
      sequence_version_id: string;
      origin_kind: string;
      state: string;
      firm_time_zone: string;
      holiday_calendar_version: string;
    }>(
      `SELECT n.started_at = o.started_at AS same_anchor, n.migrated_from_enrollment_id, n.sequence_version_id,
              n.origin_kind, n.state, n.firm_time_zone = o.firm_time_zone AS firm_time_zone,
              n.holiday_calendar_version = o.holiday_calendar_version AS holiday_calendar_version
         FROM sequence_enrollments n JOIN sequence_enrollments o ON o.id = $2
        WHERE n.id = $1`,
      [fresh, old],
    );
    expect(rows[0]).toEqual({
      same_anchor: true,
      migrated_from_enrollment_id: old,
      sequence_version_id: v2,
      origin_kind: 'prospecting',
      state: 'active',
      firm_time_zone: true,
      holiday_calendar_version: true,
    });

    const steps = await listStepExecutions(admin(), { enrollmentId: fresh });
    expect(steps).toHaveLength(1);
    // v2's step 2 is three business days after the anchor (v1's was two).
    const [v2Two, v2Three] = [(await stepOf(v2, 2)), (await stepOf(v2, 3))];
    expect(steps[0]).toMatchObject({
      ordinal: 2,
      channel: 'call_task',
      state: 'pending',
      dueAt: resolveStepDue(v2Two, anchor, ZONE, CALENDAR).dueAt,
    });
    const { rows: stepRow } = await database.session.query<{ sequence_version_id: string }>(
      'SELECT sequence_version_id FROM sequence_steps WHERE id = $1',
      [steps[0]?.stepId],
    );
    expect(stepRow[0]?.sequence_version_id).toBe(v2);

    // And the plan continues on the target from there: step 3 at v2's seven days.
    await completeCurrent(fresh);
    const third = (await listStepExecutions(admin(), { enrollmentId: fresh })).find(step => step.ordinal === 3);
    expect(third?.dueAt).toBe(resolveStepDue(v2Three, anchor, ZONE, CALENDAR).dueAt);
  });

  it('writes one audit event naming both enrollments, both versions, the carried steps and the note', async () => {
    // Fails if the audit write is removed.
    const { v1, v2 } = await twoVersions();
    const old = await enrolled(v1, await newFirm(database.session, seeded.alpha));
    await publish(v2);
    await completeCurrent(old);
    const migrated = await migrateEnrollment(admin(), {
      enrollmentId: old,
      targetSequenceVersionId: v2,
      changeNote: 'Moved to the corrected cadence.',
    });
    if (!migrated.ok) throw new Error(`the migration was refused: ${migrated.reason}`);
    const { rows } = await database.session.query<{ actor_kind: string; actor_user_id: string; subject_id: string; detail: Record<string, unknown> }>(
      `SELECT actor_kind, actor_user_id, subject_id, detail FROM audit_events
        WHERE workspace_id = $1 AND action = 'enrollment.migrated' AND subject_id = $2`,
      [seeded.alpha.workspaceId, migrated.value.newEnrollmentId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_kind: 'admin',
      actor_user_id: seeded.alpha.admin.userId,
      detail: {
        oldEnrollmentId: old,
        fromSequenceVersionId: v1,
        targetSequenceVersionId: v2,
        carriedOrdinals: [1],
        nextOrdinal: 2,
        originKind: 'prospecting',
        changeNote: 'Moved to the corrected cadence.',
      },
    });
  });

  it('migrates an enrollment that has done nothing yet from its first step', async () => {
    // k = 0 is a contiguous prefix of nothing: the target's step 1, on the original anchor.
    const { v1, v2 } = await twoVersions();
    const old = await enrolled(v1, await newFirm(database.session, seeded.alpha));
    await publish(v2);
    const migrated = await migrateEnrollment(salesperson(), { enrollmentId: old, targetSequenceVersionId: v2 });
    if (!migrated.ok) throw new Error(`the migration was refused: ${migrated.reason}`);
    expect(migrated.value).toMatchObject({ carriedOrdinals: [], nextOrdinal: 1 });
    const steps = await listStepExecutions(admin(), { enrollmentId: migrated.value.newEnrollmentId });
    expect(steps.map(step => [step.ordinal, step.dueAt])).toEqual([[1, '2026-09-21T13:00:00.000Z']]);
  });
});

describe('a shorter target', () => {
  it('completes the new enrollment at once when the target has no step after the prefix', async () => {
    // Fails if the migration schedules a step that does not exist, or leaves the new
    // enrollment live with nothing to do.
    const template = await approvedTemplate(admin(), 'Short plan.');
    const plan = await publishedPlan(admin(), [emailStep(template), callStep(2, 2), callStep(3, 5)]);
    const old = await enrolled(plan.versionId, await newFirm(database.session, seeded.alpha));
    const short = await publishedVersionOf(admin(), plan.sequenceId, [emailStep(template)]);
    await completeCurrent(old);
    await completeCurrent(old);

    const migrated = await migrateEnrollment(salesperson(), { enrollmentId: old, targetSequenceVersionId: short });
    if (!migrated.ok) throw new Error(`the migration was refused: ${migrated.reason}`);
    expect(migrated.value).toMatchObject({ carriedOrdinals: [1, 2], nextOrdinal: 3, completed: true });
    expect(await readEnrollment(admin(), { enrollmentId: migrated.value.newEnrollmentId })).toMatchObject({
      state: 'completed',
      endReason: 'sequence_complete',
    });
    expect(await listStepExecutions(admin(), { enrollmentId: migrated.value.newEnrollmentId })).toEqual([]);
  });
});

describe('the refusals', () => {
  it('refuses a target that is a draft, retired, the same version, or another sequence’s', async () => {
    // Fails if the target checks are removed: each refusal below would migrate.
    const { v1, v2, sequenceId, template } = await twoVersions();
    const old = await enrolled(v1, await newFirm(database.session, seeded.alpha));
    await publish(v2);
    const other = await publishedPlan(admin(), [emailStep(template)]);
    const { rows: draft } = await database.session.query<{ id: string }>(
      `INSERT INTO sequence_versions (workspace_id, sequence_id, version) VALUES ($1, $2, 99) RETURNING id`,
      [seeded.alpha.workspaceId, sequenceId],
    );
    const migrate = async (target: string) =>
      await migrateEnrollment(salesperson(), { enrollmentId: old, targetSequenceVersionId: target });

    expect(await migrate(draft[0]?.id ?? '')).toEqual({ ok: false, reason: 'version_not_published' });
    expect(await migrate(v1)).toEqual({ ok: false, reason: 'invalid_input' });
    expect(await migrate(other.versionId)).toEqual({ ok: false, reason: 'version_other_sequence' });
    expect((await retireVersion(admin(), { sequenceVersionId: v2 })).ok).toBe(true);
    expect(await migrate(v2)).toEqual({ ok: false, reason: 'version_retired' });
    expect(await readEnrollment(admin(), { enrollmentId: old })).toMatchObject({ state: 'active' });
  });

  it('refuses an enrollment that is not live, and a cold_legacy one', async () => {
    // Fails if the liveness or the cold_legacy rule is removed.
    const { v1, v2 } = await twoVersions();
    const ended = await enrolled(v1, await newFirm(database.session, seeded.alpha));
    await database.session.query(
      "UPDATE sequence_enrollments SET state = 'stopped', ended_at = now(), end_reason = 'admin_stop' WHERE id = $1",
      [ended],
    );
    expect(await migrateEnrollment(salesperson(), { enrollmentId: ended, targetSequenceVersionId: v2 })).toEqual({
      ok: false,
      reason: 'enrollment_not_live',
    });

    const legacy = await enrolled(v1, await newFirm(database.session, seeded.alpha));
    await publish(v2);
    await database.session.query("UPDATE sequence_enrollments SET origin_kind = 'cold_legacy' WHERE id = $1", [legacy]);
    expect(await migrateEnrollment(salesperson(), { enrollmentId: legacy, targetSequenceVersionId: v2 })).toEqual({
      ok: false,
      reason: 'cold_legacy_never_revived',
    });
    expect(await readEnrollment(admin(), { enrollmentId: legacy })).toMatchObject({ state: 'active' });
  });

  it('refuses enrollment_dispatching while a step is dispatched or has an unsettled fence', async () => {
    // Fails if the in-flight check is removed: the step runner has handed the step to the
    // send, so bytes may be about to leave for the old version's step.
    const { v1, v2 } = await twoVersions();
    const old = await enrolled(v1, await newFirm(database.session, seeded.alpha));
    await publish(v2);
    const handed = await runDueStepExecution(worker(), {
      enrollmentId: old,
      now: ANCHOR,
      eligibility: allowAllEligibility(),
      sendHandoff: recordingSendHandoff(),
    });
    expect(handed.kind).toBe('handed_to_send');
    expect((await listStepExecutions(admin(), { enrollmentId: old }))[0]?.state).toBe('dispatched');
    expect(await migrateEnrollment(salesperson(), { enrollmentId: old, targetSequenceVersionId: v2 })).toEqual({
      ok: false,
      reason: 'enrollment_dispatching',
    });

    // A fence that exists for an unfinished step, whatever the step's own state says.
    await database.session.query("UPDATE step_executions SET state = 'pending' WHERE enrollment_id = $1", [old]);
    const [step] = await listStepExecutions(admin(), { enrollmentId: old });
    const firm = (await readEnrollment(admin(), { enrollmentId: old }))!;
    await database.session.query(
      `INSERT INTO outbound_messages
         (workspace_id, mailbox_id, origin_kind, step_execution_id, enrollment_id, firm_id, contact_id,
          opportunity_id, recipient_address, subject, body, template_version_id, rendered_hash,
          provider_message_id_header, send_at, source_zone, placement_rule_version)
       SELECT $1, $2, 'step_execution', e.id, e.enrollment_id, e.firm_id, e.contact_id, $4,
              'robin@fence.example.test', 'A note', 'Hello.', s.template_version_id, repeat('d', 64),
              '<fss.migrate.' || e.id || '@sending.example.test>', now(), 'America/New_York', 'email-window.1'
         FROM step_executions e JOIN sequence_steps s ON s.id = e.step_id
        WHERE e.id = $3`,
      [seeded.alpha.workspaceId, mail.alpha.mailboxId, step?.id, firm.opportunityId],
    );
    expect(await migrateEnrollment(salesperson(), { enrollmentId: old, targetSequenceVersionId: v2 })).toEqual({
      ok: false,
      reason: 'enrollment_dispatching',
    });
    expect(await readEnrollment(admin(), { enrollmentId: old })).toMatchObject({ state: 'active' });
  });

  it('refuses completed_prefix_required when the completed steps are not exactly 1..k', async () => {
    // Fails if the prefix rule is removed: step 2 completed while step 1 is still open
    // would carry a step that never ran.
    const { v1, v2 } = await twoVersions();
    const old = await enrolled(v1, await newFirm(database.session, seeded.alpha));
    await publish(v2);
    const { rows: stepTwo } = await database.session.query<{ id: string }>(
      'SELECT id FROM sequence_steps WHERE sequence_version_id = $1 AND ordinal = 2',
      [v1],
    );
    await database.session.query(
      `INSERT INTO step_executions
         (workspace_id, enrollment_id, step_id, firm_id, contact_id, channel, ordinal, state, due_at, not_before,
          original_due_at, source_zone, rule_version, completed_at, completion_source, result)
       SELECT workspace_id, id, $2, firm_id, contact_id, 'call_task', 2, 'completed', now(), now(), now(),
              'America/New_York', 'business-day.1', now(), 'call_log', 'no_answer'
         FROM sequence_enrollments WHERE id = $1`,
      [old, stepTwo[0]?.id],
    );
    expect(await migrateEnrollment(salesperson(), { enrollmentId: old, targetSequenceVersionId: v2 })).toEqual({
      ok: false,
      reason: 'completed_prefix_required',
    });
    expect(await readEnrollment(admin(), { enrollmentId: old })).toMatchObject({ state: 'active' });
  });

  it('decides the prefix exactly: contiguous, nothing cancelled or skipped, nothing unfinished but k + 1', () => {
    const done = (ordinal: number, result = 'sent') => ({ ordinal, state: 'completed', result });
    const open = (ordinal: number, state = 'pending') => ({ ordinal, state, result: null });
    expect(completedPrefix([])).toBe(0);
    expect(completedPrefix([open(1)])).toBe(0);
    expect(completedPrefix([done(1), done(2), open(3, 'held')])).toBe(2);
    expect(completedPrefix([done(1), done(2)])).toBe(2);
    expect(completedPrefix([done(2), open(1)])).toBeNull();
    expect(completedPrefix([done(1), done(3), open(4)])).toBeNull();
    expect(completedPrefix([done(1, 'skipped'), open(2)])).toBeNull();
    expect(completedPrefix([done(1), { ordinal: 2, state: 'cancelled', result: null }])).toBeNull();
    expect(completedPrefix([done(1), open(3)])).toBeNull();
  });
});

describe('the agreed follow-up scope', () => {
  it('refuses agreed_scope_bound for an agreed sequence offered no fresh permission, and refuses the original one', async () => {
    // Fails if a follow_up run may move on its original agreement.
    const { v1, v2 } = await twoVersions();
    const firm = await newFirm(database.session, seeded.alpha);
    const original = await agreedPermission(firm, v1);
    const old = await enrolled(v1, firm, { kind: 'follow_up', permissionId: original });
    await publish(v2);

    expect(await migrateEnrollment(salesperson(), { enrollmentId: old, targetSequenceVersionId: v2 })).toEqual({
      ok: false,
      reason: 'agreed_scope_bound',
    });
    expect(
      await migrateEnrollment(salesperson(), { enrollmentId: old, targetSequenceVersionId: v2, permissionId: original }),
    ).toEqual({ ok: false, reason: 'follow_up_not_permitted' });
    // A fresh permission, but for the version it already runs: not an agreement to v2.
    const forV1 = await agreedPermission(firm, v1);
    expect(
      await migrateEnrollment(salesperson(), { enrollmentId: old, targetSequenceVersionId: v2, permissionId: forV1 }),
    ).toEqual({ ok: false, reason: 'follow_up_not_permitted' });
    expect(await readEnrollment(admin(), { enrollmentId: old })).toMatchObject({ state: 'active' });
  });

  it('moves on a fresh permission for the target, binds it to the new enrollment, and leaves the old one bound to the old run', async () => {
    // Fails if the fresh permission is not verified (the v1 case above), or not bound to
    // the new enrollment (the bind assertions here).
    const { v1, v2 } = await twoVersions();
    const firm = await newFirm(database.session, seeded.alpha);
    const original = await agreedPermission(firm, v1);
    const old = await enrolled(v1, firm, { kind: 'follow_up', permissionId: original });
    await publish(v2);
    // Nothing completed, so the remainder begins with v2's e-mail (a fresh permission
    // cannot move a run onto a call-first remainder; round 6).
    const fresh = await agreedPermission(firm, v2);

    const migrated = await migrateEnrollment(salesperson(), { enrollmentId: old, targetSequenceVersionId: v2, permissionId: fresh });
    if (!migrated.ok) throw new Error(`the migration was refused: ${migrated.reason}`);
    const next = await readEnrollment(admin(), { enrollmentId: migrated.value.newEnrollmentId });
    expect(next).toMatchObject({ originKind: 'follow_up', permissionId: fresh, sequenceVersionId: v2, state: 'active' });
    expect((await permissionRow(fresh)).enrollment_id).toBe(migrated.value.newEnrollmentId);
    // The original agreement: still bound to the run it bought, which has ended — never
    // revoked, never marked consumed, and unable to buy another run.
    expect(await permissionRow(original)).toEqual({ enrollment_id: old, revoked_at: null, consumed_at: null });

    // And a permission buys one run: the fresh one cannot move the new enrollment again.
    const v3 = await publishedVersionOf(admin(), (await database.session.query<{ sequence_id: string }>(
      'SELECT sequence_id FROM sequence_versions WHERE id = $1',
      [v2],
    )).rows[0]?.sequence_id ?? '', [callStep(1, 0), callStep(2, 4)]);
    expect(
      await migrateEnrollment(salesperson(), {
        enrollmentId: migrated.value.newEnrollmentId,
        targetSequenceVersionId: v3,
        permissionId: fresh,
      }),
    ).toEqual({ ok: false, reason: 'follow_up_not_permitted' });
  });

  it('refuses a permission offered for a prospecting enrollment', async () => {
    const { v1, v2 } = await twoVersions();
    const firm = await newFirm(database.session, seeded.alpha);
    const old = await enrolled(v1, firm);
    await publish(v2);
    const permission = await agreedPermission(firm, v2);
    expect(
      await migrateEnrollment(salesperson(), { enrollmentId: old, targetSequenceVersionId: v2, permissionId: permission }),
    ).toEqual({ ok: false, reason: 'invalid_input' });
  });
});

describe('a replacement step whose planned instant has passed (PR 335 review, P1-6)', () => {
  it('is placed at its delay from now, never on the next tick, and the answer says when', async () => {
    // Fails if the migration keeps the planned instant (21 September + 48 h, long past)
    // and lets the replacement e-mail go on the next tick.
    const template = await approvedTemplate(admin(), 'Late plan.');
    const plan = await publishedPlan(admin(), [emailStep(template), callStep(2, 2)]);
    const old = await enrolled(plan.versionId, await newFirm(database.session, seeded.alpha));
    await completeCurrent(old);
    const target = await publishedVersionOf(admin(), plan.sequenceId, [emailStep(template), emailStep(template, 2, 48)]);

    const before = Date.parse(await databaseNow(admin()));
    const migrated = await migrateEnrollment(salesperson(), { enrollmentId: old, targetSequenceVersionId: target });
    const after = Date.parse(await databaseNow(admin()));
    if (!migrated.ok) throw new Error(`the migration was refused: ${migrated.reason}`);
    expect(migrated.value.nextOrdinal).toBe(2);
    // Its delay from now, then placed in the sending window like any e-mail: never earlier
    // than now + 48 h, never later than the window placement of the latest possible now,
    // and itself an instant inside a window.
    const moved = Date.parse(migrated.value.rescheduledTo ?? '');
    const hours48 = 48 * 60 * 60 * 1000;
    expect(moved).toBeGreaterThanOrEqual(before + hours48 - 1000);
    expect(moved).toBeLessThanOrEqual(
      Date.parse(placeEmailSend(new Date(after + hours48 + 1000).toISOString(), ZONE, { calendar: CALENDAR }).sendAt),
    );
    expect(placeEmailSend(migrated.value.rescheduledTo ?? '', ZONE, { calendar: CALENDAR }).inPlace).toBe(true);
    const [step] = await listStepExecutions(admin(), { enrollmentId: migrated.value.newEnrollmentId });
    expect(step).toMatchObject({ ordinal: 2, channel: 'email', dueAt: migrated.value.rescheduledTo, notBefore: migrated.value.rescheduledTo });
    expect(Date.parse(step?.dueAt ?? '')).toBeGreaterThan(after);
  });
});

describe('the late decision is taken on the wall clock after the locks (PR 335 review, round 2)', () => {
  it('places a step whose plan passed while the migration waited at the gate at its delay from the release', async () => {
    // Fails with the transaction's `now()`: the migration began before the plan's instant,
    // so it would read the step as not late and schedule it at the instant already passed.
    const template = await approvedTemplate(admin(), 'Waited at the gate.');
    const plan = await publishedPlan(admin(), [emailStep(template), callStep(2, 2)]);
    const now = Date.parse(await databaseNow(admin()));
    // Step 2 of the target is one hour after the anchor; the anchor is set so that hour
    // ends three seconds from now.
    const anchor = new Date(now - 60 * 60 * 1000 + 3000).toISOString();
    const old = await enrolled(plan.versionId, await newFirm(database.session, seeded.alpha), { kind: 'prospecting' }, anchor);
    await completeCurrent(old);
    const target = await publishedVersionOf(admin(), plan.sequenceId, [emailStep(template), emailStep(template, 2, 1)]);
    const planned = Date.parse(anchor) + 60 * 60 * 1000;

    await second.query('BEGIN');
    await lockSendGateForStopFact(contextOn(second, 'admin'));
    const migrating = inTransaction(third, async () =>
      await migrateEnrollment(contextOn(third, 'salesperson'), { enrollmentId: old, targetSequenceVersionId: target }),
    );
    expect(await someoneWaitsOnALock()).toBe(true);
    while (Date.parse(await databaseNow(admin())) <= planned + 500) await new Promise(resolve => setTimeout(resolve, 100));
    const released = Date.parse(await databaseNow(admin()));
    await second.query('COMMIT');
    const migrated = await migrating;
    if (!migrated.ok) throw new Error(`the migration was refused: ${migrated.reason}`);

    expect(migrated.value.rescheduledTo).not.toBeNull();
    const [step] = await listStepExecutions(admin(), { enrollmentId: migrated.value.newEnrollmentId });
    expect(Date.parse(step?.dueAt ?? '')).toBeGreaterThanOrEqual(released + 60 * 60 * 1000 - 1000);
    expect(step?.dueAt).toBe(migrated.value.rescheduledTo);
  });
});

describe('the fresh permission must outlive the step it pays for (PR 335 review, round 2)', () => {
  async function lateFollowUp(expiresInMs: number): Promise<{ old: string; target: string; fresh: string; firm: VersionFirm }> {
    const template = await approvedTemplate(admin(), 'An agreed follow-up.');
    const plan = await publishedPlan(admin(), [emailStep(template), callStep(2, 2)]);
    const firm = await newFirm(database.session, seeded.alpha);
    const old = await enrolled(plan.versionId, firm, { kind: 'follow_up', permissionId: await agreedPermission(firm, plan.versionId) });
    await completeCurrent(old);
    const target = await publishedVersionOf(admin(), plan.sequenceId, [emailStep(template), emailStep(template, 2, 48)]);
    const expiresAt = new Date(Date.parse(await databaseNow(admin())) + expiresInMs).toISOString();
    return { old, target, fresh: await agreedPermission(firm, target, expiresAt), firm };
  }

  it('refuses permission_expires_before_step when the delay carries the e-mail past the expiry, and touches nothing', async () => {
    // Fails if the placed instant is not compared with the permission's expiry.
    const { old, target, fresh } = await lateFollowUp(24 * 60 * 60 * 1000);
    expect(
      await migrateEnrollment(salesperson(), { enrollmentId: old, targetSequenceVersionId: target, permissionId: fresh }),
    ).toEqual({ ok: false, reason: 'permission_expires_before_step' });
    expect(await readEnrollment(admin(), { enrollmentId: old })).toMatchObject({ state: 'active' });
    expect((await permissionRow(fresh)).enrollment_id).toBeNull();
  });

  it('refuses when the window placement, not the delay, carries the e-mail past the expiry', async () => {
    // The raw due instant (now + 48 h) is inside the permission; its local day is made a
    // holiday on the calendar the enrollment froze, so the send moves to the next business
    // morning, which is not. Fails if the raw due instant is compared instead of the placed one.
    const hours48 = 48 * 60 * 60 * 1000;
    const { old, target, fresh } = await lateFollowUp(hours48 + 2 * 60 * 1000);
    const rawDay = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE }).format(
      new Date(Date.parse(await databaseNow(admin())) + hours48),
    );
    const version = `holidays.s2-${crypto.randomUUID().slice(0, 8)}`;
    await database.session.query(
      // A historical version (superseded at once): the workspace's current calendar is
      // untouched, and the enrollment below is pointed at this one as its frozen calendar.
      `INSERT INTO workspace_holiday_calendars (workspace_id, version, dates, created_by_user_id, superseded_at)
       VALUES ($1, $2, ARRAY[$3::date], $4, now())`,
      [seeded.alpha.workspaceId, version, rawDay, seeded.alpha.admin.userId],
    );
    await database.session.query('UPDATE sequence_enrollments SET holiday_calendar_version = $2 WHERE id = $1', [old, version]);
    expect(
      await migrateEnrollment(salesperson(), { enrollmentId: old, targetSequenceVersionId: target, permissionId: fresh }),
    ).toEqual({ ok: false, reason: 'permission_expires_before_step' });
    expect(await readEnrollment(admin(), { enrollmentId: old })).toMatchObject({ state: 'active' });
    expect((await permissionRow(fresh)).enrollment_id).toBeNull();
  });

  /** A call task `hours` after the anchor (an elapsed delay, so the instant is exact). */
  const callAfter = (ordinal: number, hours: number): DraftStepInput => ({
    ordinal,
    channel: 'call_task',
    delay: { unit: 'elapsed', hours },
    onNoAnswer: 'advance',
  });

  async function lateFollowUpTo(
    targetSteps: (template: string) => readonly DraftStepInput[],
    expiresInMs: number,
  ): Promise<{ old: string; target: string; fresh: string }> {
    const template = await approvedTemplate(admin(), 'A call, then an e-mail.');
    const plan = await publishedPlan(admin(), [emailStep(template), callStep(2, 2)]);
    const firm = await newFirm(database.session, seeded.alpha);
    const old = await enrolled(plan.versionId, firm, { kind: 'follow_up', permissionId: await agreedPermission(firm, plan.versionId) });
    await completeCurrent(old);
    const target = await publishedVersionOf(admin(), plan.sequenceId, targetSteps(template));
    const expiresAt = new Date(Date.parse(await databaseNow(admin())) + expiresInMs).toISOString();
    return { old, target, fresh: await agreedPermission(firm, target, expiresAt) };
  }

  it('refuses remainder_starts_with_call for a fresh permission onto a call-first remainder, and touches nothing (round 6)', async () => {
    // Fails with the refusal removed: the call-first remainder would migrate, with an
    // e-mail whose timing depends on when Today lists the call.
    const { old, target, fresh } = await lateFollowUpTo(
      template => [emailStep(template), callAfter(2, 1), emailStep(template, 3, 2)],
      10 * 24 * 60 * 60 * 1000,
    );
    expect(
      await migrateEnrollment(salesperson(), { enrollmentId: old, targetSequenceVersionId: target, permissionId: fresh }),
    ).toEqual({ ok: false, reason: 'remainder_starts_with_call' });
    expect(await readEnrollment(admin(), { enrollmentId: old })).toMatchObject({ state: 'active' });
    expect((await permissionRow(fresh)).enrollment_id).toBeNull();
  });

  it('migrates a late e-mail-first remainder that can be sent before the expiry (round 6)', async () => {
    const { old, target, fresh } = await lateFollowUpTo(
      template => [emailStep(template), emailStep(template, 2, 48), callAfter(3, 50)],
      10 * 24 * 60 * 60 * 1000,
    );
    const migrated = await migrateEnrollment(salesperson(), { enrollmentId: old, targetSequenceVersionId: target, permissionId: fresh });
    if (!migrated.ok) throw new Error(`the migration was refused: ${migrated.reason}`);
    expect(migrated.value.rescheduledTo).not.toBeNull();
    expect((await permissionRow(fresh)).enrollment_id).toBe(migrated.value.newEnrollmentId);
  });

  it('migrates a prospecting run onto a call-first remainder: without a fresh permission nothing changes (round 6)', async () => {
    const template = await approvedTemplate(admin(), 'Cold, then a call.');
    const plan = await publishedPlan(admin(), [emailStep(template), callStep(2, 2)]);
    const old = await enrolled(plan.versionId, await newFirm(database.session, seeded.alpha));
    await completeCurrent(old);
    const target = await publishedVersionOf(admin(), plan.sequenceId, [emailStep(template), callAfter(2, 1)]);
    expect((await migrateEnrollment(salesperson(), { enrollmentId: old, targetSequenceVersionId: target })).ok).toBe(true);
  });

  it('still migrates a kept plan inside the permission, with rescheduledTo null', async () => {
    const template = await approvedTemplate(admin(), 'Kept inside the agreement.');
    const plan = await publishedPlan(admin(), [emailStep(template), callStep(2, 2)]);
    const firm = await newFirm(database.session, seeded.alpha);
    const anchor = new Date(Date.parse(await databaseNow(admin())) - 60 * 60 * 1000).toISOString();
    const old = await enrolled(
      plan.versionId,
      firm,
      { kind: 'follow_up', permissionId: await agreedPermission(firm, plan.versionId) },
      anchor,
    );
    await completeCurrent(old);
    const target = await publishedVersionOf(admin(), plan.sequenceId, [emailStep(template), emailStep(template, 2, 24)]);
    const tenDays = new Date(Date.parse(await databaseNow(admin())) + 10 * 24 * 60 * 60 * 1000).toISOString();
    const fresh = await agreedPermission(firm, target, tenDays);
    const migrated = await migrateEnrollment(salesperson(), { enrollmentId: old, targetSequenceVersionId: target, permissionId: fresh });
    if (!migrated.ok) throw new Error(`the migration was refused: ${migrated.reason}`);
    expect(migrated.value.rescheduledTo).toBeNull();
    const [step] = await listStepExecutions(admin(), { enrollmentId: migrated.value.newEnrollmentId });
    expect(step?.dueAt).toBe(new Date(Date.parse(anchor) + 24 * 60 * 60 * 1000).toISOString());
    expect((await permissionRow(fresh)).enrollment_id).toBe(migrated.value.newEnrollmentId);
  });
});

describe('a one-message permission buys an e-mail (PR 335 review, P1-5)', () => {
  it('refuses a single_email permission for a replacement whose next step is a call', async () => {
    // Fails if the verifier skips the channel when the next template is null.
    const template = await approvedTemplate(admin(), 'One e-mail.');
    const plan = await publishedPlan(admin(), [emailStep(template)]);
    const firm = await newFirm(database.session, seeded.alpha);
    const old = await enrolled(plan.versionId, firm, { kind: 'follow_up', permissionId: await singleEmailPermission(firm, template) });
    const callOnly = await publishedVersionOf(admin(), plan.sequenceId, [callStep(1, 0)]);
    const fresh = await singleEmailPermission(firm, template);
    expect(
      await migrateEnrollment(salesperson(), { enrollmentId: old, targetSequenceVersionId: callOnly, permissionId: fresh }),
    ).toEqual({ ok: false, reason: 'follow_up_not_permitted' });
    expect((await permissionRow(fresh)).enrollment_id).toBeNull();
    expect(await readEnrollment(admin(), { enrollmentId: old })).toMatchObject({ state: 'active' });
  });

  it('refuses a single_email permission for a target with no step after the prefix', async () => {
    // Fails if a one-message permission may bind to a run that completes at once.
    const template = await approvedTemplate(admin(), 'Agreed, then shortened.');
    const plan = await publishedPlan(admin(), [emailStep(template), callStep(2, 2)]);
    const firm = await newFirm(database.session, seeded.alpha);
    const old = await enrolled(plan.versionId, firm, { kind: 'follow_up', permissionId: await agreedPermission(firm, plan.versionId) });
    await completeCurrent(old);
    const oneStep = await publishedVersionOf(admin(), plan.sequenceId, [emailStep(template)]);
    const fresh = await singleEmailPermission(firm, template);
    expect(
      await migrateEnrollment(salesperson(), { enrollmentId: old, targetSequenceVersionId: oneStep, permissionId: fresh }),
    ).toEqual({ ok: false, reason: 'follow_up_not_permitted' });
    expect((await permissionRow(fresh)).enrollment_id).toBeNull();
  });

  it('refuses to enrol on a single_email permission in a plan whose first step is a call', async () => {
    // The enrolment path of the same rule: `enrollContact` names its first step.
    const template = await approvedTemplate(admin(), 'Promised an e-mail.');
    const callFirst = await publishedPlan(admin(), [callStep(1, 0)]);
    const firm = await newFirm(database.session, seeded.alpha);
    const permission = await singleEmailPermission(firm, template);
    expect(
      await enrollContact(salesperson(), {
        sequenceVersionId: callFirst.versionId,
        originKind: 'follow_up',
        permissionId: permission,
        opportunityId: firm.opportunityId,
        firmId: firm.firmId,
        contactId: firm.contactId,
      }),
    ).toEqual({ ok: false, reason: 'follow_up_not_permitted' });
    // The same permission still enrols in the e-mail it promised.
    const promised = await publishedPlan(admin(), [emailStep(template)]);
    expect(
      (
        await enrollContact(salesperson(), {
          sequenceVersionId: promised.versionId,
          originKind: 'follow_up',
          permissionId: permission,
          opportunityId: firm.opportunityId,
          firmId: firm.firmId,
          contactId: firm.contactId,
        })
      ).ok,
    ).toBe(true);
  });
});

describe('a publication racing a migration onto the version it would retire (PR 335 review, P2-a)', () => {
  async function ready(): Promise<{ old: string; v2: string; v3: string }> {
    const { v1, v2, template, sequenceId } = await twoVersions();
    const old = await enrolled(v1, await newFirm(database.session, seeded.alpha));
    await publish(v2);
    const v3 = await createDraftVersion(admin(), { sequenceId, steps: [emailStep(template), callStep(2, 9)] });
    if (!v3.ok) throw new Error(`the draft was refused: ${v3.reason}`);
    return { old, v2, v3: v3.value.sequenceVersionId };
  }

  it('a publication holding the retirement makes the migration wait, and the migration then refuses', async () => {
    // Fails if the target is read without a lock: the migration would move the enrollment
    // onto a version the committed publication has retired.
    const { old, v2, v3 } = await ready();
    await second.query('BEGIN');
    expect((await publishVersion(contextOn(second, 'admin'), { sequenceVersionId: v3 })).ok).toBe(true);
    const migrating = inTransaction(third, async () =>
      await migrateEnrollment(contextOn(third, 'salesperson'), { enrollmentId: old, targetSequenceVersionId: v2 }),
    );
    expect(await someoneWaitsOnALock()).toBe(true);
    await second.query('COMMIT');
    expect(await migrating).toEqual({ ok: false, reason: 'version_retired' });
    expect(await readEnrollment(admin(), { enrollmentId: old })).toMatchObject({ state: 'active' });
  });

  it('a migration holding the target makes the publication wait; the moved enrollment keeps running on the retired version', async () => {
    const { old, v2, v3 } = await ready();
    await second.query('BEGIN');
    const migrated = await migrateEnrollment(contextOn(second, 'salesperson'), { enrollmentId: old, targetSequenceVersionId: v2 });
    if (!migrated.ok) throw new Error(`the migration was refused: ${migrated.reason}`);
    const publishing = inTransaction(third, async () => await publishVersion(contextOn(third, 'admin'), { sequenceVersionId: v3 }));
    expect(await someoneWaitsOnALock()).toBe(true);
    await second.query('COMMIT');
    expect((await publishing).ok).toBe(true);
    expect((await readSequenceVersion(admin(), v2))?.state).toBe('retired');
    expect(await readEnrollment(admin(), { enrollmentId: migrated.value.newEnrollmentId })).toMatchObject({
      state: 'active',
      sequenceVersionId: v2,
    });
  });
});

describe('firm exclusivity', () => {
  it('never shows two live prospecting enrollments at the firm, and keeps the migrated one the firm’s', async () => {
    // Fails if the new enrollment is inserted before the old one ends:
    // `sequence_enrollments_one_active_per_contact` refuses the insert.
    const { v1, v2 } = await twoVersions();
    const firm = await newFirm(database.session, seeded.alpha);
    const old = await enrolled(v1, firm);
    await publish(v2);
    const migrated = await migrateEnrollment(salesperson(), { enrollmentId: old, targetSequenceVersionId: v2 });
    if (!migrated.ok) throw new Error(`the migration was refused: ${migrated.reason}`);
    const { rows } = await database.session.query<{ id: string }>(
      `SELECT id FROM sequence_enrollments
        WHERE firm_id = $1 AND origin_kind = 'prospecting' AND ended_at IS NULL`,
      [firm.firmId],
    );
    expect(rows.map(row => row.id)).toEqual([migrated.value.newEnrollmentId]);

    // The firm is still taken for prospecting: a second contact's cold enrollment refuses.
    const { rows: colleague } = await database.session.query<{ id: string }>(
      `INSERT INTO contacts (workspace_id, firm_id, full_name, is_primary) VALUES ($1, $2, 'Sam Example', false) RETURNING id`,
      [seeded.alpha.workspaceId, firm.firmId],
    );
    expect(
      await enrollContact(salesperson(), {
        sequenceVersionId: v2,
        originKind: 'prospecting',
        opportunityId: firm.opportunityId,
        firmId: firm.firmId,
        contactId: colleague[0]?.id ?? '',
      }),
    ).toEqual({ ok: false, reason: 'firm_already_enrolled' });
  });
});

describe('authorization', () => {
  it('lets an administrator or the assigned salesperson migrate, and nobody else', async () => {
    // Fails if the assignee check is removed: the salesperson is not this firm's.
    const { v1, v2 } = await twoVersions();
    const adminsFirm = await newFirm(database.session, seeded.alpha, seeded.alpha.admin.userId);
    const result = await enrollContact(admin(), {
      sequenceVersionId: v1,
      originKind: 'prospecting',
      opportunityId: adminsFirm.opportunityId,
      firmId: adminsFirm.firmId,
      contactId: adminsFirm.contactId,
    });
    if (!result.ok) throw new Error(`the enrollment was refused: ${result.reason}`);
    const old = result.value.enrollmentId;
    await publish(v2);

    expect(await migrateEnrollment(salesperson(), { enrollmentId: old, targetSequenceVersionId: v2 })).toEqual({
      ok: false,
      reason: 'not_assigned',
    });
    expect(await migrateEnrollment(worker(), { enrollmentId: old, targetSequenceVersionId: v2 })).toEqual({
      ok: false,
      reason: 'admin_only',
    });
    // Another workspace cannot see the enrollment at all.
    const beta = repositoryContext(
      workspaceScope(seeded.beta.workspaceId, { kind: 'user', userId: seeded.beta.admin.userId, role: 'admin' }),
      database.session,
    );
    expect(await migrateEnrollment(beta, { enrollmentId: old, targetSequenceVersionId: v2 })).toEqual({
      ok: false,
      reason: 'enrollment_unknown',
    });
    expect((await migrateEnrollment(admin(), { enrollmentId: old, targetSequenceVersionId: v2 })).ok).toBe(true);
  });
});

describe('a concurrent step claim and a migration never both proceed', () => {
  /**
   * The step runner's claim of a due e-mail step (`runDueStepExecution`: pending →
   * dispatched, with the fence prepared) against a migration of the same enrollment, on
   * two connections. Both lock the enrollment first, so they serialize on its row; the
   * cases pin each order with a held transaction and prove the other side is waiting,
   * then race the two freely.
   */
  async function dueEnrollment(): Promise<{ old: string; v2: string }> {
    const { v1, v2 } = await twoVersions();
    const old = await enrolled(v1, await newFirm(database.session, seeded.alpha));
    await publish(v2);
    return { old, v2 };
  }
  const claim = async (session: SessionQueryable, enrollmentId: string) => {
    const handoff = recordingSendHandoff();
    const outcome = await runDueStepExecution(worker(session), {
      enrollmentId,
      now: ANCHOR,
      eligibility: allowAllEligibility(),
      sendHandoff: handoff,
    });
    return { outcome, prepared: handoff.prepared.length };
  };

  it('a migration holding the enrollment makes the claim wait, and the claim then finds nothing to send', async () => {
    // Fails if the claim could run the old step after the migration ended it.
    const { old, v2 } = await dueEnrollment();
    await second.query('BEGIN');
    const migrated = await migrateEnrollment(contextOn(second, 'salesperson'), { enrollmentId: old, targetSequenceVersionId: v2 });
    expect(migrated.ok).toBe(true);

    const claimed = inTransaction(third, async () => await claim(third, old));
    expect(await someoneWaitsOnALock()).toBe(true);
    await second.query('COMMIT');
    const { outcome, prepared } = await claimed;
    expect(outcome.kind).not.toBe('handed_to_send');
    expect(prepared).toBe(0);
  });

  it('a claim holding the enrollment makes the migration wait, and the migration then refuses', async () => {
    // Fails if the in-flight check is removed: the migration would end an enrollment
    // whose step has just been handed to the send.
    const { old, v2 } = await dueEnrollment();
    await second.query('BEGIN');
    const { outcome } = await claim(second, old);
    expect(outcome.kind).toBe('handed_to_send');

    const migrating = inTransaction(third, async () =>
      await migrateEnrollment(contextOn(third, 'salesperson'), { enrollmentId: old, targetSequenceVersionId: v2 }),
    );
    expect(await someoneWaitsOnALock()).toBe(true);
    await second.query('COMMIT');
    expect(await migrating).toEqual({ ok: false, reason: 'enrollment_dispatching' });
    expect(await readEnrollment(admin(), { enrollmentId: old })).toMatchObject({ state: 'active' });
  });

  it('races the two freely, several times: exactly one proceeds, and no deadlock', async () => {
    for (let round = 0; round < 6; round += 1) {
      const { old, v2 } = await dueEnrollment();
      const [claimed, migrated] = await Promise.allSettled([
        inTransaction(second, async () => await claim(second, old)),
        inTransaction(third, async () =>
          await migrateEnrollment(contextOn(third, 'salesperson'), { enrollmentId: old, targetSequenceVersionId: v2 }),
        ),
      ]);
      const failures = [claimed, migrated].flatMap(result =>
        result.status === 'rejected' ? [String((result.reason as { code?: string }).code ?? result.reason)] : [],
      );
      expect(failures, `round ${String(round)}`).toEqual([]);
      const sent = claimed.status === 'fulfilled' && claimed.value.prepared === 1;
      const moved = migrated.status === 'fulfilled' && migrated.value.ok;
      expect(sent !== moved, `round ${String(round)}: sent ${String(sent)}, moved ${String(moved)}`).toBe(true);
    }
  });
});

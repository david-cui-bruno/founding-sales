import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionQueryable } from '../../db/queryable.ts';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { databaseNow } from '../../policy/clock.ts';
import { openHold, releaseHold } from '../../policy/holds.ts';
import { allowAllEligibility } from '../../sequences/eligibility.ts';
import { enrollContact, stopEnrollments } from '../../sequences/enrollments.ts';
import { runDueStepExecution } from '../../sequences/executions.ts';
import { resumeEnrollment } from '../../sequences/resume.ts';
import { readEnrollment } from '../../sequences/rows.ts';
import { recordingSendHandoff } from '../../sequences/sendHandoff.ts';
import { consumeTerminalStops } from '../../sequences/terminalStops.ts';
import { lockSendGateForStopFact } from '../../policy/sendGate.ts';
import { backendPid, waitUntilBlocked } from '../outbound/support/dispatchFixtures.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';
import { seedSequences, type SeededSequences } from './support/sequenceFixtures.ts';

/**
 * One lock order for an enrollment and its steps (wave 2 batch review, P1).
 *
 * The scheduler resumes a held enrollment itself since wave 2 (S4.1), and the Today
 * pause's Resume resumes one on request. The command locks the
 * enrollment and then its unfinished steps; the scheduler locked the step and then the
 * enrollment. Two orders on one enrollment can deadlock, so every path now takes the
 * enrollment first (`lockStepWithEnrollment`).
 *
 * ## The vacuous-pass trap, named
 *
 * "Both finished" is true of two runs that never overlapped. So the first case pins the
 * interleaving: the resume command's first lock is held, the scheduler is proved to be
 * waiting, and the command's second lock — the steps — is taken with `NOWAIT`, which
 * refuses if the scheduler already holds the step (what the old order did). The second
 * case runs the two real functions at once on separate connections, several times, and
 * asserts neither ever fails, least of all with a Postgres deadlock (40P01).
 */

const DAY = 86_400_000;

let database: TestDatabase;
let seeded: TwoWorkspaces;
let crm: SeededCrm;
let sequences: SeededSequences;
let scheduler: SessionQueryable;
let desktop: SessionQueryable;

const worker = (session: SessionQueryable): RepositoryContext =>
  repositoryContext(workspaceScope(seeded.alpha.workspaceId, { kind: 'system', component: 'worker' }), session);

const salesperson = (session: SessionQueryable): RepositoryContext =>
  repositoryContext(
    workspaceScope(seeded.alpha.workspaceId, {
      kind: 'user',
      userId: seeded.alpha.salesperson.userId,
      role: 'salesperson',
    }),
    session,
  );

const admin = (): RepositoryContext =>
  repositoryContext(
    workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.admin.userId, role: 'admin' }),
    database.session,
  );

async function clearEnrollments(): Promise<void> {
  for (const table of [
    'step_execution_shifts',
    'step_executions',
    'sequence_enrollments',
    'sequence_event_cursors',
    'today_items',
    'today_snapshots',
    'active_holds',
    'crm_domain_events',
  ]) {
    await database.session.query(`DELETE FROM ${table}`);
  }
}

/**
 * An enrollment out of a long hold: a nine-day firm pause, now released, its step still
 * held for `long_hold_review` and overdue.
 */
async function heldEnrollment(): Promise<{ enrollmentId: string; stepExecutionId: string }> {
  const enrolled = await enrollContact(salesperson(database.session), {
    sequenceVersionId: sequences.alpha.publishedVersionId,
    originKind: 'prospecting' as const,
    opportunityId: crm.alpha.opportunityId,
    firmId: crm.alpha.firmId,
    contactId: crm.alpha.contactId,
  });
  if (!enrolled.ok) throw new Error(`the enrollment fixture was refused: ${enrolled.reason}`);
  const enrollmentId = enrolled.value.enrollmentId;
  const workspaceId = seeded.alpha.workspaceId;

  await database.session.query(
    "UPDATE sequence_enrollments SET started_at = now() - interval '10 days' WHERE workspace_id = $1 AND id = $2",
    [workspaceId, enrollmentId],
  );
  const due = new Date(Date.parse(await databaseNow(admin())) - 10 * DAY).toISOString();
  await database.session.query(
    `UPDATE step_executions SET due_at = $3::timestamptz, not_before = $3::timestamptz, original_due_at = $3::timestamptz
      WHERE workspace_id = $1 AND enrollment_id = $2 AND state IN ('pending', 'held')`,
    [workspaceId, enrollmentId, due],
  );
  const hold = await openHold(admin(), {
    scopeKind: 'firm',
    scopeKey: crm.alpha.firmId,
    reasonCode: 'scoped_pause',
    blockedActionKinds: ['email_send', 'enrollment_advance'],
    sourceEventKind: 'test.lock_order',
  });
  await database.session.query("UPDATE active_holds SET started_at = now() - interval '9 days' WHERE id = $1", [hold]);
  await releaseHold(admin(), hold);

  const { rows } = await database.session.query<{ id: string }>(
    `UPDATE step_executions
        SET state = 'held', hold_reason_code = 'long_hold_review', not_before = now() - interval '1 hour'
      WHERE workspace_id = $1 AND enrollment_id = $2 AND state IN ('pending', 'held')
      RETURNING id`,
    [workspaceId, enrollmentId],
  );
  const stepExecutionId = rows[0]?.id;
  if (stepExecutionId === undefined) throw new Error('the enrollment fixture has no unfinished step');
  return { enrollmentId, stepExecutionId };
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
  for (let attempt = 0; attempt < 200; attempt += 1) {
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
  crm = await seedCrm(database.session, seeded);
  sequences = await seedSequences(database.session, seeded);
  scheduler = await database.appRuntimeSession();
  desktop = await database.appRuntimeSession();
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  await clearEnrollments();
});

afterEach(async () => {
  // A failed case must not leave a transaction open on either connection for the next.
  await scheduler.query('ROLLBACK');
  await desktop.query('ROLLBACK');
});

describe('the scheduler and the resume command take one lock order', () => {
  it('the scheduler waits for the enrollment and holds no step while it waits', async () => {
    const { enrollmentId, stepExecutionId } = await heldEnrollment();
    const now = await databaseNow(admin());

    // The resume command's first lock: the enrollment.
    await desktop.query('BEGIN');
    await desktop.query('SELECT id FROM sequence_enrollments WHERE id = $1 FOR UPDATE', [enrollmentId]);

    const ran = inTransaction(scheduler, async () =>
      await runDueStepExecution(worker(scheduler), {
        stepExecutionId,
        now,
        eligibility: allowAllEligibility(),
        sendHandoff: recordingSendHandoff(),
      }),
    );
    expect(await someoneWaitsOnALock()).toBe(true);

    // Its second lock: the unfinished steps. `NOWAIT` refuses at once if the scheduler
    // already holds the step, which is what the old order (step, then enrollment) did.
    const steps = await desktop.query<{ id: string }>(
      `SELECT id FROM step_executions WHERE enrollment_id = $1 AND state IN ('pending', 'held') FOR UPDATE NOWAIT`,
      [enrollmentId],
    );
    expect(steps.rows.map(row => row.id)).toContain(stepExecutionId);
    await desktop.query('COMMIT');

    const outcome = await ran;
    expect(outcome.kind).not.toBe('nothing_to_do');
    expect((await readEnrollment(worker(database.session), { enrollmentId }))?.state).toBe('active');
  });

  it('runs the scheduler and the resume command at once on one enrollment, and neither fails', async () => {
    for (let round = 0; round < 6; round += 1) {
      await clearEnrollments();
      const { enrollmentId, stepExecutionId } = await heldEnrollment();
      const now = await databaseNow(admin());

      const [ran, resumed] = await Promise.allSettled([
        inTransaction(scheduler, async () =>
          await runDueStepExecution(worker(scheduler), {
            stepExecutionId,
            now,
            eligibility: allowAllEligibility(),
            sendHandoff: recordingSendHandoff(),
          }),
        ),
        inTransaction(desktop, async () => await resumeEnrollment(salesperson(desktop), { enrollmentId })),
      ]);

      const failures = [ran, resumed].flatMap(result =>
        result.status === 'rejected' ? [String((result.reason as { code?: string }).code ?? result.reason)] : [],
      );
      expect(failures, `round ${String(round)}`).toEqual([]);
      expect(resumed.status === 'fulfilled' && resumed.value.ok, `round ${String(round)}`).toBe(true);
      expect((await readEnrollment(worker(database.session), { enrollmentId }))?.state).toBe('active');

      // Resumed once, whichever came first: one shift by the union, never two.
      const { rows } = await database.session.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM step_execution_shifts WHERE enrollment_id = $1 AND reason = 'hold_union'",
        [enrollmentId],
      );
      expect(rows[0]?.count, `round ${String(round)}`).toBe('1');
    }
  });
});

/**
 * The send gate comes before the enrollment (send-path v2, review finding, slice A5).
 *
 * Every stop writer takes gate, then cursor, then enrollments. `runDueStepExecution`
 * used to lock the enrollment first and reach the gate later, through a hold opened for
 * a missing template variable or a skipped terminal fence. A concurrent stop that held
 * the gate and then wanted the enrollment deadlocked with it.
 */
const FIRST_DUE = '2026-09-21T13:00:00Z';

/** An enrollment whose first email step is due and whose contact has no usable name. */
async function missingVariableEnrollment(): Promise<{ enrollmentId: string; stepExecutionId: string }> {
  const { rows } = await database.session.query<{ id: string }>(
    `INSERT INTO contacts (workspace_id, firm_id, full_name) VALUES ($1, $2, '?') RETURNING id`,
    [seeded.alpha.workspaceId, crm.alpha.firmId],
  );
  const enrolled = await enrollContact(salesperson(database.session), {
    sequenceVersionId: sequences.alpha.publishedVersionId,
    originKind: 'prospecting' as const,
    opportunityId: crm.alpha.opportunityId,
    firmId: crm.alpha.firmId,
    contactId: rows[0]?.id ?? '',
  });
  if (!enrolled.ok) throw new Error(`the enrollment fixture was refused: ${enrolled.reason}`);
  const steps = await database.session.query<{ id: string }>(
    `UPDATE step_executions
        SET due_at = $3::timestamptz, not_before = $3::timestamptz, original_due_at = $3::timestamptz
      WHERE workspace_id = $1 AND enrollment_id = $2 AND state IN ('pending', 'held')
      RETURNING id`,
    [seeded.alpha.workspaceId, enrolled.value.enrollmentId, FIRST_DUE],
  );
  const stepExecutionId = steps.rows[0]?.id;
  if (stepExecutionId === undefined) throw new Error('the enrollment fixture has no unfinished step');
  return { enrollmentId: enrolled.value.enrollmentId, stepExecutionId };
}

describe('a step run takes the send gate before the enrollment', () => {
  it('waits on the gate holding no enrollment lock, so a stop that holds the gate can take the row', async () => {
    const { enrollmentId, stepExecutionId } = await missingVariableEnrollment();

    // Session A is a stop writer: it holds the gate.
    await desktop.query('BEGIN');
    await lockSendGateForStopFact(worker(desktop));

    const schedulerPid = await backendPid(scheduler);
    const ran = inTransaction(scheduler, async () =>
      await runDueStepExecution(worker(scheduler), {
        stepExecutionId,
        now: FIRST_DUE,
        eligibility: allowAllEligibility(),
        sendHandoff: recordingSendHandoff(),
      }),
    );
    const settled = ran.then(
      () => undefined,
      () => undefined,
    );
    await waitUntilBlocked(database.session, schedulerPid, 'advisory');

    // The stop's next lock. Before the fix the step run already held the enrollment and
    // this refused with 55P03 (and, without NOWAIT, deadlocked).
    const locked = await desktop.query<{ id: string }>(
      'SELECT id FROM sequence_enrollments WHERE id = $1 FOR UPDATE NOWAIT',
      [enrollmentId],
    );
    expect(locked.rows).toHaveLength(1);
    const stopped = await stopEnrollments(worker(desktop), {
      enrollmentId,
      reason: 'stage_lost',
      cancelReason: 'terminal_stop',
    });
    expect(stopped.enrollmentsStopped).toBe(1);
    await desktop.query('COMMIT');

    await settled;
    expect(await ran).toEqual({ kind: 'nothing_to_do' });
    expect((await readEnrollment(worker(database.session), { enrollmentId }))?.state).not.toBe('active');
  });

  it('runs the terminal-stop drain and the step run at once, and neither deadlocks', async () => {
    for (let round = 0; round < 6; round += 1) {
      await clearEnrollments();
      const { enrollmentId, stepExecutionId } = await missingVariableEnrollment();
      await database.session.query(
        `INSERT INTO crm_domain_events
           (workspace_id, event_kind, firm_id, opportunity_id, dedupe_key, actor_kind, occurred_at, owed_enrollment_ids)
         VALUES ($1, 'opportunity.manual_mode', $2, $3, $4, 'system', now(), $5)`,
        [seeded.alpha.workspaceId, crm.alpha.firmId, crm.alpha.opportunityId, `lock-order-${String(round)}`, [enrollmentId]],
      );

      const [ran, drained] = await Promise.allSettled([
        inTransaction(scheduler, async () =>
          await runDueStepExecution(worker(scheduler), {
            stepExecutionId,
            now: FIRST_DUE,
            eligibility: allowAllEligibility(),
            sendHandoff: recordingSendHandoff(),
          }),
        ),
        inTransaction(desktop, async () => await consumeTerminalStops(worker(desktop), { limit: 5 })),
      ]);
      const failures = [ran, drained].flatMap(result =>
        result.status === 'rejected' ? [String((result.reason as { code?: string }).code ?? result.reason)] : [],
      );
      expect(failures, `round ${String(round)}`).toEqual([]);
      expect(drained.status === 'fulfilled' && drained.value.enrollmentsStopped, `round ${String(round)}`).toBe(1);
      expect((await readEnrollment(worker(database.session), { enrollmentId }))?.state, `round ${String(round)}`).not.toBe(
        'active',
      );
    }
  });
});

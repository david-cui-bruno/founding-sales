import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionQueryable } from '../../db/queryable.ts';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { databaseNow } from '../../policy/clock.ts';
import { openHold, releaseHold } from '../../policy/holds.ts';
import { allowAllEligibility } from '../../sequences/eligibility.ts';
import { enrollContact } from '../../sequences/enrollments.ts';
import { runDueStepExecution } from '../../sequences/executions.ts';
import { resumeEnrollment } from '../../sequences/resume.ts';
import { readEnrollment } from '../../sequences/rows.ts';
import { recordingSendHandoff } from '../../sequences/sendHandoff.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';
import { seedSequences, type SeededSequences } from './support/sequenceFixtures.ts';

/**
 * One lock order for an enrollment and its steps (wave 2 batch review, P1).
 *
 * The scheduler resumes a `review_required` enrollment since wave 2 (S4.1), and the
 * desktop's resume command still resumes one by hand. The command locks the
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
 * An enrollment as an older release left it: a nine-day firm pause, now released, the
 * enrollment `review_required` and its step held for `long_hold_review`.
 */
async function reviewRequiredEnrollment(): Promise<{ enrollmentId: string; stepExecutionId: string }> {
  const enrolled = await enrollContact(salesperson(database.session), {
    sequenceVersionId: sequences.alpha.publishedVersionId,
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

  await database.session.query(
    `UPDATE sequence_enrollments SET state = 'review_required', review_union_milliseconds = $3
      WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, enrollmentId, 9 * DAY],
  );
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
    const { enrollmentId, stepExecutionId } = await reviewRequiredEnrollment();
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
      const { enrollmentId, stepExecutionId } = await reviewRequiredEnrollment();
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

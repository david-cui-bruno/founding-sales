import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@fss/domain/db/testing';
import { HandlerRegistry, SCHEDULER_ADVISORY_LOCK_KEY, canaryHandler, enqueueJob } from '@fss/domain/jobs';
import { runSchedulerPass, type DueWorkSource } from '../src/scheduler/schedulerPass.ts';
import { canarySource } from '../src/scheduler/sources.ts';
import { runOnce } from '../src/runner/jobRunner.ts';

/**
 * Appendix G scenario 1: "Two scheduler transactions synchronized over one due
 * execution create one job row; repeat for Today, recovery, and mail sync."
 *
 * Two different things have to be true, and only one of them is the lock. The
 * transaction advisory lock makes two overlapping passes serialize; the per-workspace
 * idempotency key makes two inserts of the same due work collapse even when the lock
 * is not what stopped them, which is the case an overlapping deployment produces.
 * Both are asserted below, on real connections with a real barrier.
 */

const NOW = '2026-09-20T13:00:00.000Z';

function source(workspaceId: string, kind: string, idempotencyKey: string): DueWorkSource {
  return {
    name: kind,
    find: async () =>
      await Promise.resolve([{ workspaceId, kind, idempotencyKey, payload: { due: NOW }, maxAttempts: 4 }]),
  };
}

describe('scheduler pass (Appendix G scenario 1)', () => {
  let database: TestDatabase;
  let workspaceId: string;

  beforeAll(async () => {
    database = await createTestDatabase();
    const { rows } = await database.session.query<{ id: string }>(
      "INSERT INTO workspaces (slug, display_name) VALUES ('alpha', 'Alpha') RETURNING id",
    );
    workspaceId = rows[0]?.id ?? '';
  });

  afterAll(async () => {
    await database.drop();
  });

  it('holds a stable, version-independent advisory key distinct from the migration lock', async () => {
    const { MIGRATION_ADVISORY_LOCK_KEY } = await import('@fss/domain/db');
    expect(Number.isSafeInteger(SCHEDULER_ADVISORY_LOCK_KEY)).toBe(true);
    expect(SCHEDULER_ADVISORY_LOCK_KEY).not.toBe(MIGRATION_ADVISORY_LOCK_KEY);
  });

  it.each([
    ['sequence action', 'sequence.action', 'step-execution:11111111-1111-4111-8111-111111111111'],
    ['today', 'today.build', 'today:alpha:2026-09-20:today.v1'],
    ['mail recovery', 'mail.recover', 'mail-recover:mailbox-1:3'],
    ['mail sync', 'mail.sync', 'mail-sync:mailbox-1'],
  ])(
    'creates one job row when two barrier-synchronised transactions see the same due %s',
    async (_label, kind, key) => {
      const first = await database.appRuntimeSession();
      const second = await database.appRuntimeSession();

      // Both transactions open and both reach the insert. The second blocks on the
      // unique index until the first commits, then finds the row and inserts nothing.
      await first.query('BEGIN');
      await second.query('BEGIN');
      const specification = { workspaceId, kind, idempotencyKey: key, payload: { due: NOW }, maxAttempts: 4 };
      const inserted = await enqueueJob(first, specification);
      const blocked = enqueueJob(second, specification);
      await first.query('COMMIT');
      const collapsed = await blocked;
      await second.query('COMMIT');

      expect(inserted.inserted).toBe(true);
      expect(collapsed.inserted).toBe(false);

      const { rows } = await database.session.query<{ count: string }>(
        'SELECT count(*) AS count FROM jobs WHERE workspace_id = $1 AND kind = $2 AND idempotency_key = $3',
        [workspaceId, kind, key],
      );
      expect(Number(rows[0]?.count)).toBe(1);
    },
  );

  it('serialises two overlapping passes on the transaction advisory lock', async () => {
    const first = await database.appRuntimeSession();
    const second = await database.appRuntimeSession();
    const sources = [source(workspaceId, 'canary', 'canary:2026-09-20T13:00:00.000Z')];

    // The first pass keeps its transaction open, so it still holds the lock.
    const held = await runSchedulerPass(first, { sources, now: NOW, holdOpenForTest: true });
    expect(held.outcome).toBe('ran');
    expect(held.inserted).toBe(1);

    const refused = await runSchedulerPass(second, { sources, now: NOW });
    expect(refused.outcome).toBe('lock_not_acquired');
    expect(refused.inserted).toBe(0);

    await first.query('COMMIT');

    // The lock is transaction-scoped, so committing releases it without an unlock.
    const after = await runSchedulerPass(second, { sources, now: NOW });
    expect(after.outcome).toBe('ran');
    expect(after.inserted).toBe(0);
  });

  it('records a scheduler heartbeat and performs no external action', async () => {
    const session = await database.appRuntimeSession();
    const report = await runSchedulerPass(session, { sources: [], now: NOW, instanceKey: 'scheduler-under-test' });
    expect(report.outcome).toBe('ran');
    expect(report.externalActions).toBe(0);

    const { rows } = await database.session.query<{ instance_key: string; expected_interval_seconds: number }>(
      "SELECT instance_key, expected_interval_seconds FROM heartbeats WHERE component = 'scheduler'",
    );
    expect(rows.map(row => row.instance_key)).toContain('scheduler-under-test');
    expect(rows[0]?.expected_interval_seconds).toBe(60);
  });

  it('drives the canary from the scheduler to the worker and back', async () => {
    const session = await database.appRuntimeSession();
    const at = '2026-09-20T15:07:00.000Z';

    const first = await runSchedulerPass(session, { sources: [canarySource()], now: at });
    expect(first.outcome).toBe('ran');
    // One canary row and one canary job for the workspace's quarter hour.
    expect(first.inserted).toBe(1);

    // A second pass in the same quarter hour materializes nothing new: the canary row
    // is refused by its primary key and the job by its idempotency key.
    const second = await runSchedulerPass(session, { sources: [canarySource()], now: '2026-09-20T15:14:59.000Z' });
    expect(second.inserted).toBe(0);
    expect(second.alreadyPresent).toBe(1);

    const registry = new HandlerRegistry();
    registry.register(canaryHandler());
    const worked = await runOnce(database.session, { registry, owner: 'worker-canary-loop', limit: 10 });
    expect(worked.completed).toBe(1);

    const { rows } = await database.session.query<{ completed_at: Date | null }>(
      "SELECT completed_at FROM canary_runs WHERE quarter_hour = TIMESTAMPTZ '2026-09-20 15:00:00+00'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.completed_at).not.toBeNull();
  });

  it('refuses to run against a database outside the worker schema range', async () => {
    const behind = await createTestDatabase({ throughVersion: 1 });
    try {
      const report = await runSchedulerPass(behind.session, { sources: [], now: NOW });
      expect(report.outcome).toBe('schema_out_of_range');
      expect(report.inserted).toBe(0);
    } finally {
      await behind.drop();
    }
  });
});

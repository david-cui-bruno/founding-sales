import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@fss/domain/db/testing';
import type { SessionQueryable } from '@fss/domain/db';
import {
  HandlerRegistry,
  IDEMPOTENCY_PROTECTIONS,
  canaryHandler,
  claimJobs,
  completeJob,
  enqueueJob,
  reclaimExpiredLeases,
  runTwiceUnderStolenLease,
  type JobHandler,
} from '@fss/domain/jobs';
import { runClaimedJob, runOnce } from '../src/runner/jobRunner.ts';

/**
 * Appendix G scenario 2: "Worker A pauses past lease, worker B reclaims, A resumes:
 * one business effect, proven by fencing or uniqueness."
 *
 * The lease is not the protection — the lease is only a hint about who is probably
 * working. The protection is the monotonic fencing token on the job row and the
 * handler's own idempotency, and the test below proves both by actually letting A
 * wake up and try.
 */

const NOW = '2026-09-20T13:00:00.000Z';

/** A business table the fixture handlers write to. Two effects would be two rows. */
async function createEffectTable(session: SessionQueryable): Promise<void> {
  await session.query(`
    CREATE TABLE effect_log (
      workspace_id uuid NOT NULL REFERENCES workspaces (id),
      effect_key text NOT NULL,
      recorded_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT effect_log_once UNIQUE (workspace_id, effect_key)
    )
  `);
  await session.query('GRANT SELECT, INSERT, UPDATE, DELETE ON effect_log TO app_runtime');
}

describe('at-least-once job execution under a stolen lease', () => {
  let database: TestDatabase;
  let workspaceId: string;

  beforeAll(async () => {
    database = await createTestDatabase();
    const { rows } = await database.session.query<{ id: string }>(
      "INSERT INTO workspaces (slug, display_name) VALUES ('alpha', 'Alpha') RETURNING id",
    );
    workspaceId = rows[0]?.id ?? '';
    await createEffectTable(database.session);
  });

  afterAll(async () => {
    await database.drop();
  });

  it('gives worker A a stale fencing token after B reclaims, and A writes nothing', async () => {
    const session = database.session;
    await enqueueJob(session, {
      workspaceId,
      kind: 'canary',
      idempotencyKey: 'canary:2026-09-20T13:00:00.000Z',
      payload: { quarterHour: NOW },
      maxAttempts: 4,
    });

    const [claimA] = await claimJobs(session, { owner: 'worker-a', kinds: ['canary'], limit: 1, leaseSeconds: 30 });
    expect(claimA).toBeDefined();
    if (claimA === undefined) return;
    expect(claimA.attempt).toBe(1);

    // A's lease expires while A is paused (a stop-the-world GC, a frozen task).
    await session.query(
      "UPDATE jobs SET lease_expires_at = now() - INTERVAL '1 second' WHERE workspace_id = $1 AND id = $2",
      [workspaceId, claimA.id],
    );
    expect(await reclaimExpiredLeases(session, { limit: 10 })).toBe(1);

    const [claimB] = await claimJobs(session, { owner: 'worker-b', kinds: ['canary'], limit: 1, leaseSeconds: 30 });
    expect(claimB).toBeDefined();
    if (claimB === undefined) return;
    expect(claimB.attempt).toBe(2);
    // Monotonic: the reclaim did not reset it, and B's token is strictly higher.
    expect(BigInt(claimB.fencingToken)).toBeGreaterThan(BigInt(claimA.fencingToken));

    expect(await completeJob(session, claimB)).toBe('completed');
    // A resumes and tries to finish the job it thinks it still owns.
    expect(await completeJob(session, claimA)).toBe('lease_lost');

    const { rows } = await database.session.query<{ state: string; attempt_count: number }>(
      'SELECT state, attempt_count FROM jobs WHERE workspace_id = $1 AND id = $2',
      [workspaceId, claimA.id],
    );
    expect(rows[0]?.state).toBe('done');
    expect(rows[0]?.attempt_count).toBe(2);
  });

  it('runs every registered handler twice under a stolen lease and records one effect', async () => {
    const registry = new HandlerRegistry();
    registry.register(canaryHandler());

    // One fixture handler per declared protection, so the harness covers the whole
    // vocabulary rather than only the kinds this lane happens to have implemented.
    const fenced: JobHandler = {
      kind: 'today.build',
      protection: 'fencing_token',
      maxAttempts: 4,
      leaseSeconds: 30,
      handle: async input => {
        await input.session.query('INSERT INTO effect_log (workspace_id, effect_key) VALUES ($1, $2)', [
          input.scope.workspaceId,
          `today:${input.job.id}`,
        ]);
      },
    };
    const unique: JobHandler = {
      kind: 'mail.sync',
      protection: 'business_uniqueness',
      maxAttempts: 4,
      leaseSeconds: 30,
      handle: async input => {
        await input.session.query(
          'INSERT INTO effect_log (workspace_id, effect_key) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [input.scope.workspaceId, `mail-sync:${input.job.idempotencyKey}`],
        );
      },
    };
    const fenced_outbound: JobHandler = {
      kind: 'sequence.action',
      protection: 'outbound_fence',
      maxAttempts: 4,
      leaseSeconds: 30,
      handle: async input => {
        // Stands in for the outbound at-most-once fence: the prepared -> dispatching
        // transition is the thing that authorizes one process, and it is irreversible.
        await input.session.query(
          'INSERT INTO effect_log (workspace_id, effect_key) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [input.scope.workspaceId, `fence:${input.job.idempotencyKey}`],
        );
      },
    };
    registry.register(fenced);
    registry.register(unique);
    registry.register(fenced_outbound);

    expect(new Set(registry.all().map(handler => handler.protection))).toEqual(new Set(IDEMPOTENCY_PROTECTIONS));

    for (const handler of registry.all()) {
      const report = await runTwiceUnderStolenLease({
        session: database.session,
        registry,
        run: runClaimedJob,
        workspaceId,
        kind: handler.kind,
        idempotencyKey: `${handler.kind}:stolen-lease`,
        payload: { quarterHour: NOW },
        countEffects: async () => {
          const { rows } = await database.session.query<{ count: string }>(
            'SELECT count(*) AS count FROM effect_log WHERE workspace_id = $1 AND effect_key LIKE $2',
            [workspaceId, `%${handler.kind === 'canary' ? '' : 'stolen-lease'}%`],
          );
          return Number(rows[0]?.count);
        },
      });
      expect(report.staleOutcome, `${handler.kind} let a stale lease finish the job`).toBe('lease_lost');
      expect(report.effectsAfter - report.effectsBefore, `${handler.kind} produced more than one effect`).toBe(1);
    }
  });

  it('completes a canary through the runner and records the completion timestamp', async () => {
    const registry = new HandlerRegistry();
    registry.register(canaryHandler());
    await database.session.query(
      "INSERT INTO canary_runs (workspace_id, quarter_hour) VALUES ($1, TIMESTAMPTZ '2026-09-20T13:15:00Z')",
      [workspaceId],
    );
    await enqueueJob(database.session, {
      workspaceId,
      kind: 'canary',
      idempotencyKey: 'canary:2026-09-20T13:15:00.000Z',
      payload: { quarterHour: '2026-09-20T13:15:00.000Z' },
      maxAttempts: 4,
    });

    const report = await runOnce(database.session, { registry, owner: 'worker-canary', limit: 5 });
    expect(report.completed).toBe(1);
    expect(report.failed).toBe(0);

    const { rows } = await database.session.query<{ completed_at: Date | null; completed_by: string | null }>(
      "SELECT completed_at, completed_by FROM canary_runs WHERE workspace_id = $1 AND quarter_hour = TIMESTAMPTZ '2026-09-20T13:15:00Z'",
      [workspaceId],
    );
    expect(rows[0]?.completed_at).not.toBeNull();
    expect(rows[0]?.completed_by).toBe('worker-canary');
  });
});

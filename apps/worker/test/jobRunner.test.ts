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
  quarterHourOf,
  reclaimExpiredLeases,
  runTwiceUnderStolenLease,
  type JobHandler,
} from '@fss/domain/jobs';
import { runClaimedJob, runOnce } from '../src/runner/jobRunner.ts';

/**
 * Appendix G scenario 2: "Worker A pauses past lease, worker B reclaims, A resumes:
 * one business effect, proven by fencing or uniqueness."
 *
 * The lease is not the protection. The lease is a hint about who is probably working;
 * a paused worker still believes it holds one. The protection is the monotonic fencing
 * token on the job row and the handler's own idempotency, and the tests below prove it
 * by actually letting A wake up and try.
 */

const QUARTER_HOUR = quarterHourOf('2026-09-20T13:07:00.000Z');

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

  it('gives worker A a stale fencing token after B reclaims, and A finishes nothing', async () => {
    const session = database.session;
    await enqueueJob(session, {
      workspaceId,
      kind: 'canary',
      idempotencyKey: 'canary:plain-steal',
      payload: { quarterHour: QUARTER_HOUR },
      maxAttempts: 4,
    });

    const [claimA] = await claimJobs(session, { owner: 'worker-a', kinds: ['canary'], limit: 1, leaseSeconds: 30 });
    expect(claimA).toBeDefined();
    if (claimA === undefined) return;
    expect(claimA.attempt).toBe(1);

    // A's lease expires while A is paused: a stop-the-world pause, a frozen task.
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
    // A resumes and tries to finish the job it believes it still owns.
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

    /**
     * One fixture handler per declared protection, so the harness covers the whole
     * vocabulary rather than only the kinds this lane happens to have implemented. The
     * real handlers land in later lanes and add themselves to this same loop.
     */
    const countKeys = async (prefix: string): Promise<number> => {
      const { rows } = await database.session.query<{ count: string }>(
        'SELECT count(*) AS count FROM effect_log WHERE workspace_id = $1 AND effect_key LIKE $2',
        [workspaceId, `${prefix}%`],
      );
      return Number(rows[0]?.count);
    };

    // fencing_token: a plain INSERT with no conflict clause. A second run would raise;
    // it never runs, because the runner locks the job row by token first.
    const fenced: JobHandler = {
      kind: 'mail.watch_renew',
      protection: 'fencing_token',
      maxAttempts: 4,
      leaseSeconds: 30,
      handle: async input => {
        await input.session.query('INSERT INTO effect_log (workspace_id, effect_key) VALUES ($1, $2)', [
          input.scope.workspaceId,
          `watch:${input.job.idempotencyKey}`,
        ]);
      },
    };
    // business_uniqueness: the handler's own unique key collapses a replay.
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
    // outbound_fence: stands in for the prepared -> dispatching transition, which is
    // irreversible, so this handler runs outside the completion transaction.
    const outbound: JobHandler = {
      kind: 'sequence.action',
      protection: 'outbound_fence',
      maxAttempts: 4,
      leaseSeconds: 30,
      handle: async input => {
        await input.session.query(
          'INSERT INTO effect_log (workspace_id, effect_key) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [input.scope.workspaceId, `fence:${input.job.idempotencyKey}`],
        );
      },
    };
    registry.register(canaryHandler()).register(fenced).register(unique).register(outbound);

    expect(new Set(registry.all().map(handler => handler.protection))).toEqual(new Set(IDEMPOTENCY_PROTECTIONS));

    await database.session.query(
      'INSERT INTO canary_runs (workspace_id, quarter_hour) VALUES ($1, $2::timestamptz)',
      [workspaceId, QUARTER_HOUR],
    );
    const countCanaryCompletions = async (): Promise<number> => {
      const { rows } = await database.session.query<{ count: string }>(
        'SELECT count(*) AS count FROM canary_runs WHERE workspace_id = $1 AND completed_at IS NOT NULL',
        [workspaceId],
      );
      return Number(rows[0]?.count);
    };

    const probes: readonly { readonly kind: string; readonly countEffects: () => Promise<number> }[] = [
      { kind: 'canary', countEffects: countCanaryCompletions },
      { kind: 'mail.watch_renew', countEffects: async () => await countKeys('watch:') },
      { kind: 'mail.sync', countEffects: async () => await countKeys('mail-sync:') },
      { kind: 'sequence.action', countEffects: async () => await countKeys('fence:') },
    ];
    expect(probes.map(probe => probe.kind).sort()).toEqual(registry.kinds().sort());

    for (const probe of probes) {
      const report = await runTwiceUnderStolenLease({
        session: database.session,
        registry,
        run: runClaimedJob,
        workspaceId,
        kind: probe.kind,
        idempotencyKey: `${probe.kind}:stolen-lease`,
        payload: { quarterHour: QUARTER_HOUR },
        countEffects: probe.countEffects,
      });
      expect(report.freshOutcome, `${probe.kind} did not complete for the worker that held the lease`).toBe(
        'completed',
      );
      expect(report.staleOutcome, `${probe.kind} let a stale lease finish the job`).toBe('lease_lost');
      expect(report.effectsAfter - report.effectsBefore, `${probe.kind} produced other than one effect`).toBe(1);
      expect(BigInt(report.freshFencingToken)).toBeGreaterThan(BigInt(report.staleFencingToken));
    }
  });

  it('completes a canary through the runner and records the completion timestamp', async () => {
    const registry = new HandlerRegistry();
    registry.register(canaryHandler());
    const quarterHour = quarterHourOf('2026-09-20T13:20:00.000Z');
    await database.session.query(
      'INSERT INTO canary_runs (workspace_id, quarter_hour) VALUES ($1, $2::timestamptz)',
      [workspaceId, quarterHour],
    );
    await enqueueJob(database.session, {
      workspaceId,
      kind: 'canary',
      idempotencyKey: `canary:${quarterHour}`,
      payload: { quarterHour },
      maxAttempts: 4,
    });

    const report = await runOnce(database.session, { registry, owner: 'worker-canary', limit: 5 });
    expect(report.completed).toBe(1);
    expect(report.failed).toBe(0);

    const { rows } = await database.session.query<{ completed_at: Date | null; completed_by: string | null }>(
      'SELECT completed_at, completed_by FROM canary_runs WHERE workspace_id = $1 AND quarter_hour = $2::timestamptz',
      [workspaceId, quarterHour],
    );
    expect(rows[0]?.completed_at).not.toBeNull();
    expect(rows[0]?.completed_by).toBe('worker-canary');
  });

  it('records a worker heartbeat with its expected interval', async () => {
    const registry = new HandlerRegistry();
    registry.register(canaryHandler());
    await runOnce(database.session, { registry, owner: 'worker-heartbeat', limit: 1 });
    const { rows } = await database.session.query<{ expected_interval_seconds: number }>(
      "SELECT expected_interval_seconds FROM heartbeats WHERE component = 'worker' AND instance_key = 'worker-heartbeat'",
    );
    expect(rows[0]?.expected_interval_seconds).toBe(60);
  });
});

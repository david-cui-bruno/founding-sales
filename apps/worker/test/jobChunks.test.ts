import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
import { createTestDatabase, type TestDatabase } from '@fss/domain/db/testing/testDatabase.ts';
import { runTwiceUnderStolenLease } from '@fss/domain/jobs/atLeastOnce.ts';
import type { BackoffPolicy } from '@fss/domain/jobs/backoff.ts';
import { HandlerRegistry, type JobHandler } from '@fss/domain/jobs/handlerRegistry.ts';
import {
  claimJobs,
  enqueueJob,
  reclaimExpiredLeases,
  writeProgress,
  type ClaimedJob,
} from '@fss/domain/jobs/jobStore.ts';
import { runClaimedJob, runOnce } from '../src/runner/jobRunner.ts';

/**
 * The chunk protocol.
 *
 * What is being proved is the thing a long sweep needs and a single-transaction handler
 * cannot give it: work already done stays done when the process dies mid-sweep. Every
 * chunk commits with its cursor, so a crash costs the chunk in flight and nothing else,
 * and the cursor write is fenced, so a worker that lost its lease cannot drag a live
 * worker's cursor backwards.
 */

const CHUNKS = 5;
/** No waiting between attempts: the retry ladder is tested elsewhere. */
const IMMEDIATE: BackoffPolicy = { baseSeconds: 0, factor: 1, maximumSeconds: 0, jitterFraction: 0 };

async function createChunkTable(session: SessionQueryable): Promise<void> {
  await session.query(`
    CREATE TABLE chunk_log (
      workspace_id uuid NOT NULL REFERENCES workspaces (id),
      run_key text NOT NULL,
      chunk integer NOT NULL,
      CONSTRAINT chunk_log_once UNIQUE (workspace_id, run_key, chunk)
    )
  `);
  await session.query('GRANT SELECT, INSERT, UPDATE, DELETE ON chunk_log TO app_runtime');
}

/**
 * A handler that does five bounded units of work and remembers where it is in
 * `payload.progress`. `dieAt` is the chunk the process does not survive.
 */
function chunkedHandler(options: { readonly dieAt?: number } = {}): JobHandler {
  return {
    kind: 'retention.batch',
    protection: 'business_uniqueness',
    maxAttempts: 8,
    leaseSeconds: 30,
    handle: async input => {
      const progress = input.job.payload['progress'] as { readonly chunk?: number } | undefined;
      const chunk = progress?.chunk ?? 0;
      if (options.dieAt === chunk) throw new Error(`the worker died in chunk ${String(chunk)}`);
      await input.session.query(
        'INSERT INTO chunk_log (workspace_id, run_key, chunk) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [input.scope.workspaceId, input.job.idempotencyKey, chunk],
      );
      return { progress: { chunk: chunk + 1 }, done: chunk + 1 >= CHUNKS };
    },
  };
}

describe('chunked bulk work', () => {
  let database: TestDatabase;
  let workspaceId: string;

  beforeAll(async () => {
    database = await createTestDatabase();
    const { rows } = await database.session.query<{ id: string }>(
      "INSERT INTO workspaces (slug, display_name) VALUES ('alpha', 'Alpha') RETURNING id",
    );
    workspaceId = rows[0]?.id ?? '';
    await createChunkTable(database.session);
  });

  // The claim is by kind, not by key, so a job one test left runnable is a job the
  // next test claims by accident. Each test starts with an empty queue.
  beforeEach(async () => {
    await database.session.query('DELETE FROM jobs');
  });

  afterAll(async () => {
    await database.drop();
  });

  const chunksOf = async (key: string): Promise<number[]> => {
    const { rows } = await database.session.query<{ chunk: number }>(
      'SELECT chunk FROM chunk_log WHERE workspace_id = $1 AND run_key = $2 ORDER BY chunk',
      [workspaceId, key],
    );
    return rows.map(row => row.chunk);
  };

  const jobRow = async (key: string): Promise<{ state: string; progress: unknown; attempt_count: number }> => {
    const { rows } = await database.session.query<{ state: string; progress: unknown; attempt_count: number }>(
      `SELECT state, payload -> 'progress' AS progress, attempt_count
         FROM jobs WHERE workspace_id = $1 AND kind = 'retention.batch' AND idempotency_key = $2`,
      [workspaceId, key],
    );
    const row = rows[0];
    if (row === undefined) throw new Error(`${key} is not in the queue`);
    return row;
  };

  const enqueue = async (key: string): Promise<void> => {
    await enqueueJob(database.session, {
      workspaceId,
      kind: 'retention.batch',
      idempotencyKey: key,
      payload: {},
      maxAttempts: 8,
    });
  };

  it('resumes at the chunk after the last one that committed', async () => {
    const key = 'sweep:crash-after-three';
    await enqueue(key);

    const dying = new HandlerRegistry().register(chunkedHandler({ dieAt: 3 }));
    const first = await runOnce(database.session, {
      registry: dying,
      owner: 'worker-dies',
      limit: 1,
      backoff: IMMEDIATE,
    });
    expect(first.claimed).toBe(1);
    expect(first.failed).toBe(1);
    // Three chunks committed before the death, and the cursor points at the fourth.
    expect(await chunksOf(key)).toEqual([0, 1, 2]);
    const afterCrash = await jobRow(key);
    expect(afterCrash.state).toBe('retryable');
    expect(afterCrash.progress).toEqual({ chunk: 3 });

    const healthy = new HandlerRegistry().register(chunkedHandler());
    const second = await runOnce(database.session, {
      registry: healthy,
      owner: 'worker-resumes',
      limit: 1,
      backoff: IMMEDIATE,
    });
    expect(second.completed).toBe(1);
    // Five chunks, each exactly once: nothing was re-done and nothing was skipped.
    expect(await chunksOf(key)).toEqual([0, 1, 2, 3, 4]);
    expect((await jobRow(key)).state).toBe('done');
  });

  it('hands the job back to the queue with its cursor when the lease runs out', async () => {
    const key = 'sweep:out-of-lease';
    await enqueue(key);
    const registry = new HandlerRegistry().register(chunkedHandler());
    const [claim] = await claimJobs(database.session, {
      owner: 'worker-slow',
      kinds: ['retention.batch'],
      limit: 1,
      leaseSeconds: 30,
    });
    expect(claim).toBeDefined();
    if (claim === undefined) return;

    // The clock jumps past the lease after the first chunk: the runner must stop rather
    // than run a second chunk on a lease it no longer credibly holds.
    const deadline = Date.parse(claim.leaseExpiresAt);
    let call = 0;
    const outcome = await runClaimedJob(database.session, {
      registry,
      job: claim,
      backoff: IMMEDIATE,
      now: () => {
        call += 1;
        return call <= 2 ? deadline - 30_000 : deadline;
      },
    });
    expect(outcome).toBe('requeued');
    expect(await chunksOf(key)).toEqual([0]);
    const row = await jobRow(key);
    expect(row.state).toBe('queued');
    expect(row.progress).toEqual({ chunk: 1 });
    // A yield is not a failed attempt: the claim's attempt comes back off the count.
    expect(row.attempt_count).toBe(0);
  });

  it('refuses a stale claimant progress write and accepts the live one', async () => {
    const key = 'sweep:stolen-cursor';
    await enqueue(key);
    const [stale] = await claimJobs(database.session, {
      owner: 'worker-a',
      kinds: ['retention.batch'],
      limit: 1,
      leaseSeconds: 30,
    });
    expect(stale).toBeDefined();
    if (stale === undefined) return;
    await database.session.query(
      "UPDATE jobs SET lease_expires_at = now() - INTERVAL '1 second' WHERE workspace_id = $1 AND id = $2",
      [workspaceId, stale.id],
    );
    await reclaimExpiredLeases(database.session, { limit: 10 });
    const [fresh] = await claimJobs(database.session, {
      owner: 'worker-b',
      kinds: ['retention.batch'],
      limit: 1,
      leaseSeconds: 30,
    });
    expect(fresh).toBeDefined();
    if (fresh === undefined) return;

    const write = (claim: ClaimedJob, chunk: number): Promise<'written' | 'lease_lost'> =>
      writeProgress(database.session, {
        jobId: claim.id,
        workspaceId: claim.workspaceId,
        fencingToken: claim.fencingToken,
        progress: { chunk },
      });
    expect(await write(fresh, 9)).toBe('written');
    // Worker A wakes up believing it is still sweeping, and moves nothing.
    expect(await write(stale, 1)).toBe('lease_lost');
    expect((await jobRow(key)).progress).toEqual({ chunk: 9 });
  });

  it('produces one set of chunks under a real stolen lease', async () => {
    const key = 'sweep:stolen-lease';
    const registry = new HandlerRegistry().register(chunkedHandler());
    const report = await runTwiceUnderStolenLease({
      session: database.session,
      registry,
      run: runClaimedJob,
      workspaceId,
      kind: 'retention.batch',
      idempotencyKey: key,
      payload: {},
      countEffects: async () => (await chunksOf(key)).length,
    });
    expect(report.freshOutcome).toBe('completed');
    expect(report.staleOutcome).toBe('lease_lost');
    expect(report.effectsAfter - report.effectsBefore).toBe(CHUNKS);
    expect(await chunksOf(key)).toEqual([0, 1, 2, 3, 4]);
  });
});

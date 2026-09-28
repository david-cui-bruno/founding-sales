import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
import { createTestDatabase, type TestDatabase } from '@fss/domain/db/testing/testDatabase.ts';
import { runTwiceUnderStolenLease } from '@fss/domain/jobs/atLeastOnce.ts';
import type { BackoffPolicy } from '@fss/domain/jobs/backoff.ts';
import { HandlerRegistry, type JobHandler } from '@fss/domain/jobs/handlerRegistry.ts';
import {
  claimJobs,
  databaseNowMs,
  enqueueJob,
  reclaimExpiredLeases,
  requeueForNextChunk,
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

  /** A clock that says the lease is spent, so each call commits one chunk and yields. */
  const oneChunkPerCall = (claim: ClaimedJob): (() => Promise<number>) => {
    const deadline = Date.parse(claim.leaseExpiresAt);
    let call = 0;
    return async () => {
      call += 1;
      return await Promise.resolve(call <= 1 ? deadline - 30_000 : deadline);
    };
  };

  it('resumes at the chunk after the last one that committed, when the worker simply stops', async () => {
    const key = 'sweep:crash-after-three';
    await enqueue(key);
    const registry = new HandlerRegistry().register(chunkedHandler());

    // Three chunks, each its own claim and its own commit.
    for (let chunk = 0; chunk < 3; chunk += 1) {
      const [claim] = await claimJobs(database.session, {
        owner: `worker-chunk-${String(chunk)}`,
        kinds: ['retention.batch'],
        limit: 1,
        leaseSeconds: 30,
      });
      expect(claim).toBeDefined();
      if (claim === undefined) return;
      expect(
        await runClaimedJob(database.session, { registry, job: claim, backoff: IMMEDIATE, now: oneChunkPerCall(claim) }),
      ).toBe('requeued');
    }
    expect(await chunksOf(key)).toEqual([0, 1, 2]);

    // The worker now dies between claiming and doing anything: no failure is
    // recorded, because a process that is gone records nothing. The lease simply
    // expires and another worker reclaims the row.
    const [abandoned] = await claimJobs(database.session, {
      owner: 'worker-that-vanishes',
      kinds: ['retention.batch'],
      limit: 1,
      leaseSeconds: 30,
    });
    expect(abandoned).toBeDefined();
    if (abandoned === undefined) return;
    await database.session.query(
      "UPDATE jobs SET lease_expires_at = now() - INTERVAL '1 second' WHERE workspace_id = $1 AND id = $2",
      [workspaceId, abandoned.id],
    );
    expect(await reclaimExpiredLeases(database.session, { limit: 10 })).toBe(1);
    // Nothing was lost: the cursor is still where the third chunk left it.
    expect((await jobRow(key)).progress).toEqual({ chunk: 3 });

    const healthy = await runOnce(database.session, {
      registry,
      owner: 'worker-resumes',
      limit: 1,
      backoff: IMMEDIATE,
    });
    expect(healthy.completed).toBe(1);
    // Five chunks, each exactly once: nothing was re-done and nothing was skipped.
    expect(await chunksOf(key)).toEqual([0, 1, 2, 3, 4]);
    expect((await jobRow(key)).state).toBe('done');

    // And the worker that vanished, waking up at last, hands nothing back.
    expect(await requeueForNextChunk(database.session, abandoned)).toBe('lease_lost');
    expect((await jobRow(key)).state).toBe('done');
  });

  it('keeps the committed chunks when a handler throws part way through', async () => {
    const key = 'sweep:throw-after-three';
    await enqueue(key);
    const dying = new HandlerRegistry().register(chunkedHandler({ dieAt: 3 }));
    const first = await runOnce(database.session, {
      registry: dying,
      owner: 'worker-throws',
      limit: 1,
      backoff: IMMEDIATE,
    });
    expect(first.failed).toBe(1);
    expect(await chunksOf(key)).toEqual([0, 1, 2]);
    const afterThrow = await jobRow(key);
    expect(afterThrow.state).toBe('retryable');
    expect(afterThrow.progress).toEqual({ chunk: 3 });

    const healthy = new HandlerRegistry().register(chunkedHandler());
    expect(
      (await runOnce(database.session, { registry: healthy, owner: 'worker-retries', limit: 1, backoff: IMMEDIATE }))
        .completed,
    ).toBe(1);
    expect(await chunksOf(key)).toEqual([0, 1, 2, 3, 4]);
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
    const outcome = await runClaimedJob(database.session, {
      registry,
      job: claim,
      backoff: IMMEDIATE,
      now: oneChunkPerCall(claim),
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

    const write = async (claim: ClaimedJob, chunk: number): Promise<string> =>
      (
        await writeProgress(database.session, {
          jobId: claim.id,
          workspaceId: claim.workspaceId,
          fencingToken: claim.fencingToken,
          progress: { chunk },
        })
      ).outcome;
    expect(await write(fresh, 9)).toBe('written');
    // Worker A wakes up believing it is still sweeping, and moves nothing.
    expect(await write(stale, 1)).toBe('lease_lost');
    expect((await jobRow(key)).progress).toEqual({ chunk: 9 });
  });

  it('fails a handler that yields for ever, at the chunk limit, naming the limit', async () => {
    const key = 'sweep:never-finishes';
    await enqueue(key);
    // Never done. Without a budget this job would chunk, yield, be requeued with its
    // attempt returned and its run_at reset, and do it again for ever.
    const forever = new HandlerRegistry().register({
      ...chunkedHandler(),
      handle: async input => {
        const progress = input.job.payload['progress'] as { readonly chunk?: number } | undefined;
        const chunk = progress?.chunk ?? 0;
        return await Promise.resolve({ progress: { chunk: chunk + 1 }, done: false });
      },
    });

    let outcome = '';
    for (let poll = 0; poll < 20 && outcome !== 'retryable' && outcome !== 'dead'; poll += 1) {
      const [claim] = await claimJobs(database.session, {
        owner: `worker-forever-${String(poll)}`,
        kinds: ['retention.batch'],
        limit: 1,
        leaseSeconds: 30,
      });
      expect(claim).toBeDefined();
      if (claim === undefined) return;
      outcome = await runClaimedJob(database.session, {
        registry: forever,
        job: claim,
        backoff: IMMEDIATE,
        now: oneChunkPerCall(claim),
        chunkCountLimit: 3,
      });
    }
    expect(outcome).toBe('retryable');

    const { rows } = await database.session.query<{ error_code: string; error_detail: string; state: string }>(
      `SELECT error_code, error_detail, state FROM jobs
        WHERE workspace_id = $1 AND kind = 'retention.batch' AND idempotency_key = $2`,
      [workspaceId, key],
    );
    expect(rows[0]?.error_code).toBe('chunk_budget_exhausted');
    expect(rows[0]?.error_detail).toContain('3 chunks');
    // It is a failure, so the retry ladder now owns it and it reaches `dead`.
    expect(rows[0]?.state).toBe('retryable');
  });

  it('fails a chunked job that has been chunking longer than its hours', async () => {
    const key = 'sweep:all-night';
    await enqueue(key);
    const registry = new HandlerRegistry().register(chunkedHandler());
    const [first] = await claimJobs(database.session, {
      owner: 'worker-evening',
      kinds: ['retention.batch'],
      limit: 1,
      leaseSeconds: 30,
    });
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(
      await runClaimedJob(database.session, { registry, job: first, backoff: IMMEDIATE, now: oneChunkPerCall(first) }),
    ).toBe('requeued');

    // Morning. The claim is new, the cursor is old, and the first chunk was hours ago.
    const [second] = await claimJobs(database.session, {
      owner: 'worker-morning',
      kinds: ['retention.batch'],
      limit: 1,
      leaseSeconds: 30,
    });
    expect(second).toBeDefined();
    if (second === undefined) return;
    const sevenHoursOn = (await databaseNowMs(database.session)) + 7 * 60 * 60 * 1000;
    expect(
      await runClaimedJob(database.session, {
        registry,
        job: second,
        backoff: IMMEDIATE,
        now: async () => await Promise.resolve(sevenHoursOn),
      }),
    ).toBe('retryable');

    const { rows } = await database.session.query<{ error_code: string; error_detail: string }>(
      `SELECT error_code, error_detail FROM jobs
        WHERE workspace_id = $1 AND kind = 'retention.batch' AND idempotency_key = $2`,
      [workspaceId, key],
    );
    expect(rows[0]?.error_code).toBe('chunk_budget_exhausted');
    expect(rows[0]?.error_detail).toContain('seconds without finishing');
    // Nothing more was done on it: the budget is read before the work, not after.
    expect(await chunksOf(key)).toEqual([0]);
  });

  it('refuses to chunk an outbound-fence handler', async () => {
    // Declared: the process does not start.
    expect(() =>
      new HandlerRegistry().register({
        kind: 'sequence.action',
        protection: 'outbound_fence',
        maxAttempts: 4,
        leaseSeconds: 30,
        chunked: true,
        handle: async () => await Promise.resolve(),
      }),
    ).toThrowError(expect.objectContaining({ name: 'HandlerRegistryError' }));

    // Undeclared, and it returns a chunk anyway: the job fails, it does not loop.
    const key = 'fence:chunk-attempt';
    await enqueueJob(database.session, {
      workspaceId,
      kind: 'sequence.action',
      idempotencyKey: key,
      payload: {},
      maxAttempts: 4,
    });
    const sneaky = new HandlerRegistry().register({
      kind: 'sequence.action',
      protection: 'outbound_fence',
      maxAttempts: 4,
      leaseSeconds: 30,
      handle: async () => await Promise.resolve({ progress: { chunk: 1 }, done: false }),
    });
    const [claim] = await claimJobs(database.session, {
      owner: 'worker-fence',
      kinds: ['sequence.action'],
      limit: 1,
      leaseSeconds: 30,
    });
    expect(claim).toBeDefined();
    if (claim === undefined) return;
    expect(await runClaimedJob(database.session, { registry: sneaky, job: claim, backoff: IMMEDIATE })).toBe(
      'retryable',
    );
    const { rows } = await database.session.query<{ error_code: string }>(
      `SELECT error_code FROM jobs WHERE workspace_id = $1 AND kind = 'sequence.action' AND idempotency_key = $2`,
      [workspaceId, key],
    );
    expect(rows[0]?.error_code).toBe('chunking_unsupported');
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

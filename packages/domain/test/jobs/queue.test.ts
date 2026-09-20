import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/index.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import {
  DEFAULT_BACKOFF,
  archiveCompletedPayloads,
  backoffSeconds,
  claimJobs,
  completeJob,
  enqueueJob,
  failJob,
  listDeadJobs,
  reclaimExpiredLeases,
  renewLease,
  requeueDeadJob,
  type ClaimedJob,
} from '../../jobs/index.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';

/**
 * The claim, the lease, the retry ladder and the dead-job path, on a real database.
 *
 * Every assertion here is about what PostgreSQL did: `not_before` is compared in
 * database time, the lease is reclaimed through the partial index, the fourth failure
 * is dead, and a requeue is an audited admin command that leaves the idempotency key
 * alone. The two-workspace fixture runs underneath all of it.
 */
describe('the job queue', () => {
  let database: TestDatabase;
  let seeded: TwoWorkspaces;
  let alpha: RepositoryContext;
  let beta: RepositoryContext;

  beforeAll(async () => {
    database = await createTestDatabase();
    seeded = await seedTwoWorkspaces(database.session);
    alpha = repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.admin.userId, role: 'admin' }),
      database.session,
    );
    beta = repositoryContext(
      workspaceScope(seeded.beta.workspaceId, { kind: 'user', userId: seeded.beta.admin.userId, role: 'admin' }),
      database.session,
    );
  });

  afterAll(async () => {
    await database.drop();
  });

  it('collapses a second enqueue of the same key and keeps the workspaces apart', async () => {
    const specification = {
      kind: seeded.collidingJobKey.kind,
      idempotencyKey: seeded.collidingJobKey.idempotencyKey,
      payload: { mailbox: 'mailbox-1' },
      maxAttempts: 4,
    };
    const inAlpha = await enqueueJob(database.session, { ...specification, workspaceId: seeded.alpha.workspaceId });
    const again = await enqueueJob(database.session, { ...specification, workspaceId: seeded.alpha.workspaceId });
    const inBeta = await enqueueJob(database.session, { ...specification, workspaceId: seeded.beta.workspaceId });

    expect(inAlpha.inserted).toBe(true);
    expect(again.inserted).toBe(false);
    expect(again.jobId).toBe(inAlpha.jobId);
    // The same key in the other workspace is a different job. Nothing crossed.
    expect(inBeta.inserted).toBe(true);
    expect(inBeta.jobId).not.toBe(inAlpha.jobId);
  });

  it('respects not_before in database time, not the caller’s clock', async () => {
    await enqueueJob(database.session, {
      workspaceId: seeded.alpha.workspaceId,
      kind: 'retention.batch',
      idempotencyKey: 'retention:raw_mime:2026-09-20',
      payload: {},
      notBefore: new Date(Date.now() + 60_000).toISOString(),
      maxAttempts: 4,
    });
    expect(
      await claimJobs(database.session, {
        owner: 'worker-1',
        kinds: ['retention.batch'],
        limit: 5,
        leaseSeconds: 30,
      }),
    ).toEqual([]);

    // Bring `not_before` into the past in database time and the same claim finds it.
    await database.session.query(
      "UPDATE jobs SET not_before = now() - INTERVAL '1 second' WHERE workspace_id = $1 AND kind = 'retention.batch'",
      [seeded.alpha.workspaceId],
    );
    const claimed = await claimJobs(database.session, {
      owner: 'worker-1',
      kinds: ['retention.batch'],
      limit: 5,
      leaseSeconds: 30,
    });
    expect(claimed.map(job => job.kind)).toEqual(['retention.batch']);
    const job = claimed[0];
    if (job !== undefined) expect(await completeJob(database.session, job)).toBe('completed');
  });

  it('claims only the kinds the worker has handlers for', async () => {
    await enqueueJob(database.session, {
      workspaceId: seeded.alpha.workspaceId,
      kind: 'research.page',
      idempotencyKey: 'research:q1:p1',
      payload: {},
      maxAttempts: 4,
    });
    expect(
      await claimJobs(database.session, { owner: 'worker-1', kinds: ['import.batch'], limit: 5, leaseSeconds: 30 }),
    ).toEqual([]);
    expect(await claimJobs(database.session, { owner: 'worker-1', kinds: [], limit: 5, leaseSeconds: 30 })).toEqual([]);
  });

  it('reclaims an expired lease through the second partial index', async () => {
    await enqueueJob(database.session, {
      workspaceId: seeded.alpha.workspaceId,
      kind: 'import.batch',
      idempotencyKey: 'import:batch-1:1',
      payload: { row: 1 },
      maxAttempts: 4,
    });
    const [claim] = await claimJobs(database.session, {
      owner: 'worker-1',
      kinds: ['import.batch'],
      limit: 1,
      leaseSeconds: 30,
    });
    expect(claim).toBeDefined();
    if (claim === undefined) return;

    // A live lease is not reclaimable, and renewing it keeps it that way.
    expect(await reclaimExpiredLeases(database.session, { limit: 10 })).toBe(0);
    expect(await renewLease(database.session, claim, 60)).toBe('renewed');

    await database.session.query(
      "UPDATE jobs SET lease_expires_at = now() - INTERVAL '1 second' WHERE workspace_id = $1 AND id = $2",
      [claim.workspaceId, claim.id],
    );
    expect(await reclaimExpiredLeases(database.session, { limit: 10 })).toBe(1);

    const { rows } = await database.session.query<{ state: string; error_code: string; lease_owner: string | null }>(
      'SELECT state, error_code, lease_owner FROM jobs WHERE workspace_id = $1 AND id = $2',
      [claim.workspaceId, claim.id],
    );
    expect(rows[0]?.state).toBe('retryable');
    expect(rows[0]?.error_code).toBe('lease_expired');
    expect(rows[0]?.lease_owner).toBeNull();
    // The old owner cannot renew a lease that was taken from it.
    expect(await renewLease(database.session, claim, 60)).toBe('lease_lost');
  });

  it('retries with bounded exponential backoff and is dead on the fourth failure', async () => {
    await enqueueJob(database.session, {
      workspaceId: seeded.alpha.workspaceId,
      kind: 'research.firm',
      idempotencyKey: 'research-firm:firm-1:1',
      payload: {},
      maxAttempts: 4,
    });

    const outcomes: string[] = [];
    let last: ClaimedJob | undefined;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      // Each retry is scheduled into the future, so bring it back to now to claim it.
      await database.session.query(
        "UPDATE jobs SET run_at = now() - INTERVAL '1 second' WHERE workspace_id = $1 AND kind = 'research.firm'",
        [seeded.alpha.workspaceId],
      );
      const [claim] = await claimJobs(database.session, {
        owner: `worker-${String(attempt)}`,
        kinds: ['research.firm'],
        limit: 1,
        leaseSeconds: 30,
      });
      expect(claim, `attempt ${String(attempt)} was not claimable`).toBeDefined();
      if (claim === undefined) return;
      last = claim;
      expect(claim.attempt).toBe(attempt);
      outcomes.push(await failJob(database.session, claim, { code: 'provider_refused', detail: 'provider said no' }));
    }
    expect(outcomes).toEqual(['retryable', 'retryable', 'retryable', 'dead']);

    // The ladder itself, as a pure function: 30 s, 60 s, 120 s, capped at fifteen minutes.
    expect([1, 2, 3, 4, 10].map(attempt => backoffSeconds(attempt, DEFAULT_BACKOFF))).toEqual([30, 60, 120, 240, 900]);

    const dead = await listDeadJobs(alpha);
    expect(dead.map(job => job.kind)).toContain('research.firm');
    const entry = dead.find(job => job.kind === 'research.firm');
    expect(entry?.attempts).toBe(4);
    expect(entry?.errorCode).toBe('provider_refused');

    // A dead job is not claimable again by a worker; only the admin command revives it.
    expect(
      await claimJobs(database.session, { owner: 'worker-9', kinds: ['research.firm'], limit: 1, leaseSeconds: 30 }),
    ).toEqual([]);
    // And the worker that killed it cannot complete it afterwards.
    if (last !== undefined) expect(await completeJob(database.session, last)).toBe('lease_lost');

    // The other workspace sees no dead job at all.
    expect(await listDeadJobs(beta)).toEqual([]);
  });

  it('requeues a dead job only for an admin, and audits it', async () => {
    const dead = await listDeadJobs(alpha);
    const target = dead.find(job => job.kind === 'research.firm');
    expect(target).toBeDefined();
    if (target === undefined) return;

    const salesperson = repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, {
        kind: 'user',
        userId: seeded.alpha.salesperson.userId,
        role: 'salesperson',
      }),
      database.session,
    );
    expect(await requeueDeadJob(salesperson, { jobId: target.id, reason: 'I would like to try again' })).toEqual({
      requeued: false,
      reason: 'not_admin',
    });
    const worker = repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, { kind: 'system', component: 'worker' }),
      database.session,
    );
    expect(await requeueDeadJob(worker, { jobId: target.id, reason: 'automatic' })).toEqual({
      requeued: false,
      reason: 'not_admin',
    });

    // Another workspace's admin cannot reach it either: the scope supplies the workspace.
    expect(await requeueDeadJob(beta, { jobId: target.id, reason: 'wrong workspace' })).toEqual({
      requeued: false,
      reason: 'not_dead',
    });

    const outcome = await requeueDeadJob(alpha, { jobId: target.id, reason: 'provider is back' });
    expect(outcome).toEqual({ requeued: true, jobId: target.id, kind: 'research.firm' });

    const { rows } = await database.session.query<{
      state: string;
      attempt_count: number;
      requeued_count: number;
      idempotency_key: string;
      dead_at: Date | null;
    }>('SELECT state, attempt_count, requeued_count, idempotency_key, dead_at FROM jobs WHERE workspace_id = $1 AND id = $2', [
      seeded.alpha.workspaceId,
      target.id,
    ]);
    expect(rows[0]?.state).toBe('queued');
    expect(rows[0]?.attempt_count).toBe(0);
    expect(rows[0]?.requeued_count).toBe(1);
    expect(rows[0]?.dead_at).toBeNull();
    // Appendix A: "unique key unchanged".
    expect(rows[0]?.idempotency_key).toBe('research-firm:firm-1:1');

    const audit = await database.session.query<{ action: string; subject_id: string; detail: { reason?: string } }>(
      "SELECT action, subject_id, detail FROM audit_events WHERE workspace_id = $1 AND action = 'job.requeue'",
      [seeded.alpha.workspaceId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.subject_id).toBe(target.id);
    expect(audit.rows[0]?.detail.reason).toBe('provider is back');
  });

  it('archives completed payloads after the operational window and keeps the dedupe key', async () => {
    await enqueueJob(database.session, {
      workspaceId: seeded.alpha.workspaceId,
      kind: 'today.build',
      idempotencyKey: 'today:alpha:2026-09-19:today.v1',
      payload: { firmCount: 12, note: 'a payload may name a prospect' },
      maxAttempts: 4,
    });
    const [claim] = await claimJobs(database.session, {
      owner: 'worker-1',
      kinds: ['today.build'],
      limit: 1,
      leaseSeconds: 30,
    });
    expect(claim).toBeDefined();
    if (claim === undefined) return;
    expect(await completeJob(database.session, claim)).toBe('completed');

    // Inside the window nothing is archived.
    expect(await archiveCompletedPayloads(database.session, { olderThanSeconds: 3600, limit: 100 })).toBe(0);

    await database.session.query(
      "UPDATE jobs SET completed_at = now() - INTERVAL '8 days' WHERE workspace_id = $1 AND id = $2",
      [claim.workspaceId, claim.id],
    );
    expect(await archiveCompletedPayloads(database.session, { olderThanSeconds: 7 * 24 * 3600, limit: 100 })).toBe(1);

    const { rows } = await database.session.query<{
      payload: Record<string, unknown>;
      idempotency_key: string;
      payload_archived_at: Date | null;
    }>('SELECT payload, idempotency_key, payload_archived_at FROM jobs WHERE workspace_id = $1 AND id = $2', [
      claim.workspaceId,
      claim.id,
    ]);
    expect(rows[0]?.payload).toEqual({});
    expect(rows[0]?.payload_archived_at).not.toBeNull();
    // The dedupe key survives its horizon; only the payload went.
    expect(rows[0]?.idempotency_key).toBe('today:alpha:2026-09-19:today.v1');

    // A second sweep finds nothing to do.
    expect(await archiveCompletedPayloads(database.session, { olderThanSeconds: 7 * 24 * 3600, limit: 100 })).toBe(0);
  });

  it('never archives a dead job’s payload, because a requeue has to have something to run', async () => {
    await enqueueJob(database.session, {
      workspaceId: seeded.beta.workspaceId,
      kind: 'suppression.finalize',
      idempotencyKey: 'suppression-finalize:event-1',
      payload: { eventId: 'event-1' },
      maxAttempts: 1,
    });
    const [claim] = await claimJobs(database.session, {
      owner: 'worker-1',
      kinds: ['suppression.finalize'],
      limit: 1,
      leaseSeconds: 30,
    });
    expect(claim).toBeDefined();
    if (claim === undefined) return;
    expect(await failJob(database.session, claim, { code: 'finalizer_failed' })).toBe('dead');

    // The database refuses to give a dead row a completion time at all, so it can
    // never look archivable: `jobs_completed_at_consistent` is what enforces that.
    await expect(
      database.session.query(
        "UPDATE jobs SET completed_at = now() - INTERVAL '30 days' WHERE workspace_id = $1 AND id = $2",
        [claim.workspaceId, claim.id],
      ),
    ).rejects.toMatchObject({ constraint: 'jobs_completed_at_consistent' });

    await archiveCompletedPayloads(database.session, { olderThanSeconds: 0, limit: 100 });
    const { rows } = await database.session.query<{
      payload: Record<string, unknown>;
      payload_archived_at: Date | null;
    }>('SELECT payload, payload_archived_at FROM jobs WHERE workspace_id = $1 AND id = $2', [
      claim.workspaceId,
      claim.id,
    ]);
    expect(rows[0]?.payload).toEqual({ eventId: 'event-1' });
    expect(rows[0]?.payload_archived_at).toBeNull();
  });
});

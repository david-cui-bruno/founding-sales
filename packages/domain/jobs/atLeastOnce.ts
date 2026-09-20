import type { SessionQueryable } from '../db/queryable.ts';
import type { HandlerRegistry } from './handlerRegistry.ts';
import { HandlerRegistryError } from './handlerRegistry.ts';
import { claimJobs, enqueueJob, reclaimExpiredLeases, type ClaimedJob } from './jobStore.ts';

/**
 * The at-least-once test harness (specification 13.2, Appendix G scenario 2).
 *
 * It is here rather than in a test file because it is a contract every later lane has
 * to satisfy: a lane that registers `mail.sync` or `sequence.action` adds a probe and
 * runs this, and if its handler produces two business effects under a stolen lease the
 * gate says so. The harness performs the theft for real — expires the lease, reclaims
 * the row, lets a second worker claim and finish, then lets the first worker wake up
 * and try — rather than simulating it by calling the handler twice.
 */

export type JobRunOutcome = 'completed' | 'lease_lost' | 'retryable' | 'dead' | 'no_handler';

/** The runner's entry point, as a type, so the harness does not import `apps/worker`. */
export type RunClaimedJob = (
  session: SessionQueryable,
  options: { readonly registry: HandlerRegistry; readonly job: ClaimedJob },
) => Promise<JobRunOutcome>;

export interface StolenLeaseProbe {
  readonly session: SessionQueryable;
  readonly registry: HandlerRegistry;
  readonly run: RunClaimedJob;
  readonly workspaceId: string;
  readonly kind: string;
  readonly idempotencyKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
  /** How many business effects exist now. Two calls, one difference; one is the pass. */
  countEffects: () => Promise<number>;
}

export interface StolenLeaseReport {
  readonly kind: string;
  readonly effectsBefore: number;
  readonly effectsAfter: number;
  /** What the reclaiming worker's run returned. Expected `completed`. */
  readonly freshOutcome: JobRunOutcome;
  /** What the woken worker's run returned. Expected `lease_lost`, never `completed`. */
  readonly staleOutcome: JobRunOutcome;
  readonly staleFencingToken: string;
  readonly freshFencingToken: string;
}

export async function runTwiceUnderStolenLease(probe: StolenLeaseProbe): Promise<StolenLeaseReport> {
  const handler = probe.registry.get(probe.kind);
  if (handler === undefined) {
    throw new HandlerRegistryError('KIND_UNKNOWN', `${probe.kind} has no registered handler to test`);
  }

  const effectsBefore = await probe.countEffects();
  await enqueueJob(probe.session, {
    workspaceId: probe.workspaceId,
    kind: probe.kind,
    idempotencyKey: probe.idempotencyKey,
    payload: probe.payload,
    maxAttempts: handler.maxAttempts,
  });

  const [stale] = await claimJobs(probe.session, {
    owner: 'stolen-lease-worker-a',
    kinds: [probe.kind],
    limit: 1,
    leaseSeconds: handler.leaseSeconds,
  });
  if (stale === undefined) throw new Error(`${probe.kind} did not become claimable`);

  // Worker A pauses past its lease. Nothing about A knows this happened.
  await probe.session.query(
    "UPDATE jobs SET lease_expires_at = now() - INTERVAL '1 second' WHERE workspace_id = $1 AND id = $2",
    [stale.workspaceId, stale.id],
  );
  await reclaimExpiredLeases(probe.session, { limit: 10 });

  const [fresh] = await claimJobs(probe.session, {
    owner: 'stolen-lease-worker-b',
    kinds: [probe.kind],
    limit: 1,
    leaseSeconds: handler.leaseSeconds,
  });
  if (fresh === undefined) throw new Error(`${probe.kind} was not reclaimable after the lease expired`);

  const freshOutcome = await probe.run(probe.session, { registry: probe.registry, job: fresh });
  // A wakes up here, still holding what it believes is a valid lease.
  const staleOutcome = await probe.run(probe.session, { registry: probe.registry, job: stale });

  return {
    kind: probe.kind,
    effectsBefore,
    effectsAfter: await probe.countEffects(),
    freshOutcome,
    staleOutcome,
    staleFencingToken: stale.fencingToken,
    freshFencingToken: fresh.fencingToken,
  };
}

import type { Queryable } from '../db/queryable.ts';

/**
 * Appendix E step 5: "discard runnable job state and rematerialise from business
 * state."
 *
 * The restored `jobs` rows describe a world that no longer exists — leases held by
 * workers that died with the old instance, `run_at` instants already past,
 * idempotency keys for work whose business effect has since been reconstructed by
 * steps 2 to 4. Jobs are derived state, so they are thrown away and the next
 * scheduler pass inserts what is genuinely due.
 *
 * **Dead jobs are kept.** 13.2 makes reviving an exhausted job an audited admin
 * command and the dead-job alarm is what gets somebody's attention; discarding them
 * here would erase the one part of the queue that is not derived — the record that
 * something failed four times. The drill asserts they survive.
 *
 * **`running` is discarded too**, and that is the point rather than an oversight. A
 * `running` row after a restore is a lease whose owner is gone; leaving it would
 * leave work claimed by nobody until the lease expired, and the handler's own
 * idempotency protection is what makes rematerialising it safe.
 */

export interface DiscardRunnableReport {
  readonly discarded: number;
  readonly queued: number;
  readonly running: number;
  readonly retryable: number;
  /** Not discarded. Counted so the report can say what was left alone. */
  readonly dead_kept: number;
  readonly done_kept: number;
}

const DISCARDED_STATES = ['queued', 'running', 'retryable'] as const;

export async function discardRunnableJobs(db: Queryable): Promise<DiscardRunnableReport> {
  const { rows } = await db.query<{ state: string }>(
    `DELETE FROM jobs WHERE state = ANY ($1::text[]) RETURNING state`,
    [[...DISCARDED_STATES]],
  );
  const counted = (state: string): number => rows.filter(row => row.state === state).length;

  const kept = await db.query<{ state: string; count: string }>(
    `SELECT state, count(*)::text AS count FROM jobs WHERE state IN ('dead', 'done') GROUP BY state`,
  );
  const keptCount = (state: string): number => Number(kept.rows.find(row => row.state === state)?.count ?? '0');

  return {
    discarded: rows.length,
    queued: counted('queued'),
    running: counted('running'),
    retryable: counted('retryable'),
    dead_kept: keptCount('dead'),
    done_kept: keptCount('done'),
  };
}

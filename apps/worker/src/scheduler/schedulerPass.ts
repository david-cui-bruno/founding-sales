import type { SessionQueryable } from '@fss/domain/db';
import { WORKER_SCHEMA_RANGE, checkSchemaRange } from '@fss/domain/db';
import {
  SCHEDULER_ADVISORY_LOCK_KEY,
  enqueueJob,
  recordHeartbeat,
  type JobSpecification,
} from '@fss/domain/jobs';

/**
 * The one-minute scheduler pass (specification 13.1).
 *
 * "Once per minute, one bounded pass runs under `pg_try_advisory_xact_lock` on a
 * stable version-independent key using a dedicated connection, statement timeout, and
 * pass timeout. It finds due work through indexed queries and inserts idempotent jobs;
 * it performs no external action. Overlapping deployments serialize on the same key."
 *
 * Every clause of that sentence is a decision this file makes:
 *
 * * **`pg_try_advisory_xact_lock`, not `pg_advisory_lock`.** A pass that cannot get
 *   the lock returns immediately and lets the next minute try. Queueing would build a
 *   backlog of passes that all want to insert the same work.
 * * **Transaction-scoped.** The lock is released by COMMIT or ROLLBACK, including the
 *   ROLLBACK a dying connection gets for free. A session lock leaked by a killed task
 *   would stop the scheduler until someone noticed.
 * * **A dedicated connection.** The caller passes a `SessionQueryable` it promises is
 *   one backend: an advisory lock taken on a pooled connection is taken by whichever
 *   backend answered, and released by whichever backend answers next.
 * * **Timeouts are `SET LOCAL`.** They expire with the transaction, so a pass cannot
 *   leave a short `statement_timeout` behind on a connection the pool reuses.
 * * **No external action.** The pass inserts rows. Everything that talks to the world
 *   is a job the worker claims, which is what makes the pass safe to repeat.
 * * **It declares its schema range.** A scheduler that does not understand the
 *   database does not materialize work into it.
 */

export interface DueWorkSource {
  /** For the report, and for the structured log line. Not a business identifier. */
  readonly name: string;
  /** Indexed queries only. A source that talks to anything outside PostgreSQL is a bug. */
  find(session: SessionQueryable, now: string): Promise<readonly JobSpecification[]>;
}

export interface SchedulerPassOptions {
  readonly sources: readonly DueWorkSource[];
  /** The instant the pass reasons about. Due times are still compared in database time. */
  readonly now: string;
  readonly instanceKey?: string | undefined;
  readonly statementTimeoutMilliseconds?: number | undefined;
  readonly passTimeoutMilliseconds?: number | undefined;
  /**
   * Leave the transaction open so a test can prove a second pass is refused while the
   * lock is held. Production never sets it; the caller then owns the COMMIT.
   */
  readonly holdOpenForTest?: boolean | undefined;
}

export type SchedulerPassOutcome = 'ran' | 'lock_not_acquired' | 'schema_out_of_range' | 'timed_out';

export interface SchedulerPassReport {
  readonly outcome: SchedulerPassOutcome;
  readonly inserted: number;
  readonly alreadyPresent: number;
  /** Always zero. Asserted by a test, because "performs no external action" is a contract. */
  readonly externalActions: number;
  readonly sources: readonly { readonly name: string; readonly inserted: number; readonly alreadyPresent: number }[];
}

export const DEFAULT_STATEMENT_TIMEOUT_MILLISECONDS = 5_000;
export const DEFAULT_PASS_TIMEOUT_MILLISECONDS = 45_000;
export const SCHEDULER_HEARTBEAT_INTERVAL_SECONDS = 60;

function emptyReport(outcome: SchedulerPassOutcome): SchedulerPassReport {
  return { outcome, inserted: 0, alreadyPresent: 0, externalActions: 0, sources: [] };
}

/**
 * Run one pass. Returns rather than throws for the two ordinary refusals — another
 * scheduler holds the lock, or the database is outside this binary's range — because
 * both are expected states of a healthy deployment and neither is an error to page on.
 */
export async function runSchedulerPass(
  session: SessionQueryable,
  options: SchedulerPassOptions,
): Promise<SchedulerPassReport> {
  const schema = await checkSchemaRange(session, WORKER_SCHEMA_RANGE);
  if (!schema.accepted) return emptyReport('schema_out_of_range');

  const statementTimeout = options.statementTimeoutMilliseconds ?? DEFAULT_STATEMENT_TIMEOUT_MILLISECONDS;
  const passTimeout = options.passTimeoutMilliseconds ?? DEFAULT_PASS_TIMEOUT_MILLISECONDS;
  const deadline = Date.now() + passTimeout;

  await session.query('BEGIN');
  let committed = false;
  try {
    await session.query(`SET LOCAL statement_timeout = ${String(Math.trunc(statementTimeout))}`);
    // The pass timeout is the transaction's own ceiling: a pass that somehow runs long
    // is aborted by the server rather than by a promise race the server never hears about.
    await session.query(`SET LOCAL idle_in_transaction_session_timeout = ${String(Math.trunc(passTimeout))}`);

    const locked = await session.query<{ acquired: boolean }>('SELECT pg_try_advisory_xact_lock($1) AS acquired', [
      SCHEDULER_ADVISORY_LOCK_KEY,
    ]);
    if (locked.rows[0]?.acquired !== true) {
      await session.query('ROLLBACK');
      committed = true;
      return emptyReport('lock_not_acquired');
    }

    const perSource: { name: string; inserted: number; alreadyPresent: number }[] = [];
    let inserted = 0;
    let alreadyPresent = 0;
    let timedOut = false;

    for (const source of options.sources) {
      if (Date.now() > deadline) {
        timedOut = true;
        break;
      }
      let sourceInserted = 0;
      let sourcePresent = 0;
      for (const specification of await source.find(session, options.now)) {
        const outcome = await enqueueJob(session, specification);
        if (outcome.inserted) sourceInserted += 1;
        else sourcePresent += 1;
      }
      inserted += sourceInserted;
      alreadyPresent += sourcePresent;
      perSource.push({ name: source.name, inserted: sourceInserted, alreadyPresent: sourcePresent });
    }

    await recordHeartbeat(session, {
      component: 'scheduler',
      instanceKey: options.instanceKey ?? 'scheduler',
      expectedIntervalSeconds: SCHEDULER_HEARTBEAT_INTERVAL_SECONDS,
      detail: { inserted, sources: perSource.length },
    });

    if (options.holdOpenForTest !== true) {
      await session.query('COMMIT');
      committed = true;
    }
    return {
      outcome: timedOut ? 'timed_out' : 'ran',
      inserted,
      alreadyPresent,
      externalActions: 0,
      sources: perSource,
    };
  } catch (error) {
    if (!committed) await session.query('ROLLBACK');
    committed = true;
    throw error;
  } finally {
    if (!committed && options.holdOpenForTest !== true) await session.query('ROLLBACK');
  }
}

import type { SessionQueryable } from '@fss/domain/db/queryable.ts';

/**
 * What the apply locked, and what waited for it.
 *
 * A migration that takes `ACCESS EXCLUSIVE` on a busy table is the difference between
 * a release nobody notices and one that stops the product; the rehearsal never
 * measured it because it migrated an empty database with nothing else connected. So a
 * second connection samples `pg_locks` and `pg_stat_activity` every 100 ms for the
 * whole apply and reports, per relation, the strongest mode taken and how long the
 * strongest was held, plus any backend that was waiting on a lock.
 *
 * Sampling is not the same as observing every lock: a lock taken and released inside
 * one 100 ms window is invisible here. That is the honest limit of reading a catalogue
 * from outside the transaction, and it is stated in the printed table.
 */

export const SAMPLE_INTERVAL_MS = 100;

/** PostgreSQL's table lock modes, weakest first. */
const MODES: readonly string[] = [
  'AccessShareLock',
  'RowShareLock',
  'RowExclusiveLock',
  'ShareUpdateExclusiveLock',
  'ShareLock',
  'ShareRowExclusiveLock',
  'ExclusiveLock',
  'AccessExclusiveLock',
];

export interface RelationLock {
  readonly relation: string;
  readonly mode: string;
  /** Samples the mode was seen in, times the sample interval. A lower bound. */
  readonly heldMs: number;
}

export interface LockWait {
  readonly relation: string;
  readonly mode: string;
  readonly waitEvent: string;
  readonly samples: number;
}

export interface LockReport {
  readonly samples: number;
  readonly relations: readonly RelationLock[];
  readonly waits: readonly LockWait[];
  /** The longest `ACCESS EXCLUSIVE` seen, by relation. */
  readonly longestAccessExclusive: RelationLock | null;
}

interface Row {
  readonly relation: string | null;
  readonly mode: string;
  readonly granted: boolean;
  readonly wait_event_type: string | null;
  readonly wait_event: string | null;
  readonly [column: string]: unknown;
}

export interface LockSampler {
  stop(): Promise<LockReport>;
}

/**
 * Start sampling the locks held by `backendPid` on `session`, which must be a
 * connection of its own — the migrating connection is inside a transaction and cannot
 * answer questions while it runs.
 */
export function sampleLocks(session: SessionQueryable, backendPid: number): LockSampler {
  const heldSamples = new Map<string, number>();
  const waitSamples = new Map<string, LockWait>();
  let samples = 0;
  let stopped = false;

  const take = async (): Promise<void> => {
    const { rows } = await session.query<Row>(
      `SELECT c.relname AS relation, l.mode, l.granted, a.wait_event_type, a.wait_event
         FROM pg_locks l
         LEFT JOIN pg_class c ON c.oid = l.relation
         LEFT JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.pid = $1 AND l.locktype = 'relation'`,
      [backendPid],
    );
    samples += 1;
    for (const row of rows) {
      if (row.relation === null) continue;
      if (row.granted) {
        const key = `${row.relation}\u0000${row.mode}`;
        heldSamples.set(key, (heldSamples.get(key) ?? 0) + 1);
      }
      if (row.wait_event_type === 'Lock') {
        const key = `${row.relation}\u0000${row.mode}\u0000${row.wait_event ?? ''}`;
        const seen = waitSamples.get(key);
        waitSamples.set(key, {
          relation: row.relation,
          mode: row.mode,
          waitEvent: row.wait_event ?? 'Lock',
          samples: (seen?.samples ?? 0) + 1,
        });
      }
    }
  };

  // One sample straight away, so that an apply shorter than the interval is not
  // invisible, and then every interval until `stop`.
  void take().catch(() => undefined);
  const timer = setInterval(() => {
    if (stopped) return;
    void take().catch(() => undefined);
  }, SAMPLE_INTERVAL_MS);
  timer.unref();

  return {
    async stop(): Promise<LockReport> {
      stopped = true;
      clearInterval(timer);
      const byRelation = new Map<string, RelationLock>();
      for (const [key, count] of heldSamples) {
        const [relation = '', mode = ''] = key.split('\u0000');
        const seen = byRelation.get(relation);
        const stronger = seen === undefined || MODES.indexOf(mode) > MODES.indexOf(seen.mode);
        if (stronger) byRelation.set(relation, { relation, mode, heldMs: count * SAMPLE_INTERVAL_MS });
      }
      const relations = [...byRelation.values()].sort(
        (left, right) => MODES.indexOf(right.mode) - MODES.indexOf(left.mode) || left.relation.localeCompare(right.relation),
      );
      const exclusive = relations
        .filter(entry => entry.mode === 'AccessExclusiveLock')
        .sort((left, right) => right.heldMs - left.heldMs);
      return {
        samples,
        relations,
        waits: [...waitSamples.values()].sort((left, right) => right.samples - left.samples),
        longestAccessExclusive: exclusive[0] ?? null,
      };
    },
  };
}

/** The backend process id of `session`, so the sampler knows whose locks to read. */
export async function backendPidOf(session: SessionQueryable): Promise<number> {
  const { rows } = await session.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  const pid = rows[0]?.pid;
  if (pid === undefined) throw new Error('the server did not report a backend pid');
  return pid;
}

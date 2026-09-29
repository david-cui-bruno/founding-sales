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
 * ## What a sample can and cannot say (GPT-6 review, P1-7)
 *
 * Sampling is not tracing. A lock taken and released inside one 100 ms window is
 * invisible here, so an empty table means "nothing was held long enough to be seen",
 * never "nothing was taken". And a lock seen in exactly one sample was held for *some*
 * time under two intervals — it is reported as `observed once; duration unknown
 * (< 200 ms)` rather than as "held at least 100 ms", which would be a number nobody
 * measured. Only **contiguous** runs of samples are added up: two sightings a second
 * apart are two observations of a lock that may have been taken twice, not one long
 * hold, and the longest contiguous run is what is reported.
 *
 * None of it is a production duration estimate. This runs on fixture-sized data with
 * no concurrent reader; the same statement against a table with a hundred million rows
 * holds its lock for as long as the rewrite takes. The report says so on its own line.
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
  /** How many samples saw it at all, contiguous or not. */
  readonly observations: number;
  /** The longest contiguous run of samples, in samples. 1 means "seen once". */
  readonly longestRunSamples: number;
  /**
   * What can honestly be said about how long it was held. `null` when it was seen
   * exactly once: the duration is then unknown and bounded only by two intervals.
   */
  readonly heldAtLeastMs: number | null;
  /** The sentence the evidence prints for this row. */
  readonly duration: string;
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
  // Sample indices per (relation, mode), so contiguity can be judged afterwards rather
  // than by adding sightings that may be minutes apart.
  const heldSamples = new Map<string, number[]>();
  const waitSamples = new Map<string, LockWait>();
  let samples = 0;
  let stopped = false;

  const take = async (): Promise<void> => {
    const index = samples;
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
        const seen = heldSamples.get(key);
        if (seen === undefined) heldSamples.set(key, [index]);
        else seen.push(index);
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
      for (const [key, indices] of heldSamples) {
        const [relation = '', mode = ''] = key.split('\u0000');
        const entry = summarise(relation, mode, indices);
        const seen = byRelation.get(relation);
        const stronger = seen === undefined || MODES.indexOf(mode) > MODES.indexOf(seen.mode);
        if (stronger) byRelation.set(relation, entry);
      }
      const relations = [...byRelation.values()].sort(
        (left, right) => MODES.indexOf(right.mode) - MODES.indexOf(left.mode) || left.relation.localeCompare(right.relation),
      );
      const exclusive = relations
        .filter(entry => entry.mode === 'AccessExclusiveLock')
        .sort((left, right) => right.longestRunSamples - left.longestRunSamples);
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

/**
 * What one relation's sightings support. `indices` are the sample numbers it was seen
 * in; a run of consecutive numbers is one observation of one hold.
 */
function summarise(relation: string, mode: string, indices: readonly number[]): RelationLock {
  const sorted = [...indices].sort((left, right) => left - right);
  let longest = 0;
  let run = 0;
  let previous: number | null = null;
  for (const index of sorted) {
    run = previous !== null && index === previous + 1 ? run + 1 : 1;
    if (run > longest) longest = run;
    previous = index;
  }
  if (longest <= 1) {
    return {
      relation,
      mode,
      observations: sorted.length,
      longestRunSamples: longest,
      heldAtLeastMs: null,
      duration: `observed ${sorted.length === 1 ? 'once' : `${String(sorted.length)} times, never twice running`}; duration unknown (< ${String(2 * SAMPLE_INTERVAL_MS)} ms)`,
    };
  }
  // n consecutive samples bound the hold from below by (n - 1) intervals: the first and
  // the last sighting are that far apart, and nothing is known about either end.
  const atLeast = (longest - 1) * SAMPLE_INTERVAL_MS;
  return {
    relation,
    mode,
    observations: sorted.length,
    longestRunSamples: longest,
    heldAtLeastMs: atLeast,
    duration: `held at least ${String(atLeast)} ms (${String(longest)} contiguous samples of ${String(sorted.length)} sightings)`,
  };
}

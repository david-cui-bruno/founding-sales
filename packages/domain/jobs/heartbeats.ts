import type { Queryable } from '../db/queryable.ts';

/**
 * Heartbeats (specification 13.3: "Heartbeats cover API, scheduler, worker, and every
 * mailbox"; alarm: "three missed one-minute scheduler or mailbox checks").
 *
 * A heartbeat is an upsert on `(component, instance_key, workspace_id)` rather than an
 * append, because what an alarm asks is "when did this component last prove it was
 * alive", and a table that grows by 1,440 rows a day per component to answer one
 * question is a retention problem invented for nothing.
 *
 * `expected_interval_seconds` travels with the row. The alarm's "three missed checks"
 * and the emitter's period then come from the same place, which is the only way they
 * stay equal through a configuration change.
 *
 * The mailbox component is the only workspace-scoped one; migration 0001 enforces that
 * with a pair of checks, and the signature below makes it a type error to forget.
 */

export type HeartbeatComponent = 'api' | 'scheduler' | 'worker' | 'mailbox';

export type HeartbeatInput =
  | {
      readonly component: 'api' | 'scheduler' | 'worker';
      readonly instanceKey: string;
      readonly expectedIntervalSeconds?: number | undefined;
      readonly detail?: Readonly<Record<string, unknown>> | undefined;
    }
  | {
      readonly component: 'mailbox';
      readonly workspaceId: string;
      readonly instanceKey: string;
      readonly expectedIntervalSeconds?: number | undefined;
      readonly detail?: Readonly<Record<string, unknown>> | undefined;
    };

export const DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 60;

/**
 * How late past its promised interval a beat may be and still count as on time, per
 * component. Zero for the three that beat on their own loop; half an interval for the
 * mailbox, whose check is asked for by one loop and performed by another.
 *
 * The API, scheduler and worker each write their own row from their own loop — the
 * worker on every runner pass, about once a second — so their beat is on time or it
 * is not, and they keep the plain `age <= expected_interval_seconds` they have always
 * had. Nothing here makes them any slower to alarm.
 *
 * A mailbox check is different. The scheduler pass asks for it (60 s plus the pass's
 * own duration after the previous pass, because the loop waits after it finishes) and
 * a runner slot performs it after claiming it: up to `FSS_RUNNER_IDLE_MS` (one second)
 * later when the slot is idle, longer when the slot is finishing another job. So two
 * healthy checks are 60 s plus a second or so apart, not 60 s, and the metrics loop —
 * another fixed-delay loop on its own phase — would sometimes sample in that extra
 * second and publish zero for a mailbox that missed nothing. Because the two loops
 * drift against each other slowly, it could sit in that second for several samples in
 * a row, which is three missed checks to the alarm.
 *
 * Thirty seconds absorbs that and still leaves a missed check visible: the check due
 * at 60 s that has not come by 90 s is a zero in its own minute, and three missed
 * checks alarm about half a minute later than three exactly-on-time misses would.
 * `test/release/mailboxHeartbeatCadence.check.ts` holds it inside that bound.
 */
export const HEARTBEAT_GRACE_SECONDS: Readonly<Record<HeartbeatComponent, number>> = Object.freeze({
  api: 0,
  scheduler: 0,
  worker: 0,
  mailbox: 30,
});

/**
 * Whether a beat of this age keeps its component's promise. The one definition of
 * "fresh": the diagnostics view and the metric the alarms read both come from here.
 */
export function heartbeatIsFresh(input: {
  readonly component: HeartbeatComponent;
  readonly ageSeconds: number;
  readonly expectedIntervalSeconds: number;
}): boolean {
  return input.ageSeconds <= input.expectedIntervalSeconds + HEARTBEAT_GRACE_SECONDS[input.component];
}

/** Record that this component is alive, at database time. */
export async function recordHeartbeat(db: Queryable, input: HeartbeatInput): Promise<void> {
  const workspaceId = input.component === 'mailbox' ? input.workspaceId : null;
  await db.query(
    `INSERT INTO heartbeats (workspace_id, component, instance_key, observed_at, expected_interval_seconds, detail)
     VALUES ($1, $2, $3, now(), $4, $5::jsonb)
     ON CONFLICT (component, instance_key, workspace_id)
     DO UPDATE SET observed_at = now(),
                   expected_interval_seconds = EXCLUDED.expected_interval_seconds,
                   detail = EXCLUDED.detail`,
    [
      workspaceId,
      input.component,
      input.instanceKey,
      input.expectedIntervalSeconds ?? DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
      JSON.stringify(input.detail ?? {}),
    ],
  );
}

export interface HeartbeatStatus {
  readonly component: HeartbeatComponent;
  readonly instanceKey: string;
  readonly workspaceId: string | null;
  readonly ageSeconds: number;
  readonly expectedIntervalSeconds: number;
  /**
   * Fresh means "arrived within its promised interval", allowing the component's
   * `HEARTBEAT_GRACE_SECONDS`. Anything else is a missed check.
   */
  readonly fresh: boolean;
}

/**
 * Every heartbeat with its age in database time. The comparison is `now()` in SQL, so
 * a worker whose own clock has drifted cannot declare a dead component healthy.
 */
export async function readHeartbeats(db: Queryable): Promise<HeartbeatStatus[]> {
  const { rows } = await db.query<{
    component: HeartbeatComponent;
    instance_key: string;
    workspace_id: string | null;
    age_seconds: string;
    expected_interval_seconds: number;
  }>(
    `SELECT component, instance_key, workspace_id, expected_interval_seconds,
            extract(epoch FROM now() - observed_at)::text AS age_seconds
       FROM heartbeats
      ORDER BY component, instance_key`,
  );
  return rows.map(row => {
    const ageSeconds = Number(row.age_seconds);
    return {
      component: row.component,
      instanceKey: row.instance_key,
      workspaceId: row.workspace_id,
      ageSeconds,
      expectedIntervalSeconds: row.expected_interval_seconds,
      fresh: heartbeatIsFresh({
        component: row.component,
        ageSeconds,
        expectedIntervalSeconds: row.expected_interval_seconds,
      }),
    };
  });
}

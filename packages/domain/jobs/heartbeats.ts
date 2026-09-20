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
  /** Fresh means "arrived within its promised interval". Anything else is a missed check. */
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
      fresh: ageSeconds <= row.expected_interval_seconds,
    };
  });
}

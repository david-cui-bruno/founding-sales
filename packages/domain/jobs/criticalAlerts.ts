import type { Queryable } from '../db/queryable.ts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { isAdminScope } from '../db/workspaceScope.ts';

/**
 * Critical alerts and their acknowledgement (specification 13.3: "Alerts are sent by
 * an independent AWS email path … and repeated while critical and unacknowledged",
 * and docs/decisions/g1-alert-repetition.md).
 *
 * CloudWatch notifies on state transitions, so an alarm that stays in `ALARM` is
 * silent. G1's contract is that the application publishes
 * `UnacknowledgedCriticalAlertAgeSeconds` while a critical condition is unacknowledged
 * and nothing when there is none, so the alarm cycles and each cycle mails; an admin
 * acknowledging stops it immediately rather than at the end of a timer.
 *
 * That makes "which alert, raised when, acknowledged by whom" business state, which is
 * why it lives here beside the audit trail and not in an AWS console.
 */

export interface RaiseAlertInput {
  readonly workspaceId: string;
  readonly alertKey: string;
  readonly severity?: 'critical' | 'warning' | undefined;
  readonly detail?: Readonly<Record<string, unknown>> | undefined;
}

export interface RaisedAlert {
  readonly id: string;
  readonly alertKey: string;
  /** False when the condition was already open. The raise time does not move. */
  readonly raised: boolean;
}

/**
 * Raise, or re-observe, a condition. One open alert per key: a condition that keeps
 * firing updates `last_observed_at` and leaves `raised_at` alone, so the age the
 * metric publishes is the age of the condition rather than of the latest observation.
 */
export async function raiseCriticalAlert(db: Queryable, input: RaiseAlertInput): Promise<RaisedAlert> {
  const { rows } = await db.query<{ id: string; raised: boolean }>(
    `WITH updated AS (
       UPDATE critical_alerts
          SET last_observed_at = now(), detail = $4::jsonb
        WHERE workspace_id = $1 AND alert_key = $2 AND resolved_at IS NULL
      RETURNING id
     ), inserted AS (
       INSERT INTO critical_alerts (workspace_id, alert_key, severity, detail)
       SELECT $1, $2, $3, $4::jsonb
        WHERE NOT EXISTS (SELECT 1 FROM updated)
       -- Two tasks raising the same condition in the same instant both see no row to
       -- update; the partial unique index is what decides, and the loser inserts
       -- nothing rather than failing. The read below then finds the winner's row.
       ON CONFLICT (workspace_id, alert_key) WHERE resolved_at IS NULL DO NOTHING
       RETURNING id
     )
     SELECT id, false AS raised FROM updated
     UNION ALL
     SELECT id, true AS raised FROM inserted`,
    [input.workspaceId, input.alertKey, input.severity ?? 'critical', JSON.stringify(input.detail ?? {})],
  );
  const row = rows[0];
  if (row !== undefined) return { id: row.id, alertKey: input.alertKey, raised: row.raised };

  const existing = await db.query<{ id: string }>(
    'SELECT id FROM critical_alerts WHERE workspace_id = $1 AND alert_key = $2 AND resolved_at IS NULL',
    [input.workspaceId, input.alertKey],
  );
  const open = existing.rows[0];
  if (open === undefined) throw new Error(`raising ${input.alertKey} neither inserted nor found an open alert`);
  return { id: open.id, alertKey: input.alertKey, raised: false };
}

/** Close a condition. Resolving is not acknowledging: a resolved alert is simply over. */
export async function resolveCriticalAlert(db: Queryable, workspaceId: string, alertKey: string): Promise<boolean> {
  const { rowCount } = await db.query(
    'UPDATE critical_alerts SET resolved_at = now() WHERE workspace_id = $1 AND alert_key = $2 AND resolved_at IS NULL',
    [workspaceId, alertKey],
  );
  return (rowCount ?? 0) === 1;
}

/**
 * The age of the oldest unacknowledged, unresolved critical alert, in seconds, or null
 * when there is none. Null is the signal to publish no datapoint at all: the alarm
 * treats missing data as not breaching, so silence is how "nothing is wrong" is said.
 */
export async function unacknowledgedCriticalAlertAgeSeconds(db: Queryable): Promise<number | null> {
  const { rows } = await db.query<{ age_seconds: string | null }>(
    `SELECT extract(epoch FROM now() - min(raised_at))::text AS age_seconds
       FROM critical_alerts
      WHERE acknowledged_at IS NULL AND resolved_at IS NULL AND severity = 'critical'`,
  );
  const value = rows[0]?.age_seconds;
  return value === null || value === undefined ? null : Number(value);
}

export interface OpenAlert {
  readonly id: string;
  readonly alertKey: string;
  readonly severity: 'critical' | 'warning';
  readonly raisedAt: string;
  readonly lastObservedAt: string;
  readonly acknowledgedAt: string | null;
  readonly acknowledgedByUserId: string | null;
}

export async function listOpenAlerts(context: RepositoryContext): Promise<OpenAlert[]> {
  const { rows } = await context.db.query<{
    id: string;
    alert_key: string;
    severity: 'critical' | 'warning';
    raised_at: Date;
    last_observed_at: Date;
    acknowledged_at: Date | null;
    acknowledged_by_user_id: string | null;
  }>(
    `SELECT id, alert_key, severity, raised_at, last_observed_at, acknowledged_at, acknowledged_by_user_id
       FROM critical_alerts
      WHERE workspace_id = $1 AND resolved_at IS NULL
      ORDER BY raised_at`,
    [context.scope.workspaceId],
  );
  return rows.map(row => ({
    id: row.id,
    alertKey: row.alert_key,
    severity: row.severity,
    raisedAt: row.raised_at.toISOString(),
    lastObservedAt: row.last_observed_at.toISOString(),
    acknowledgedAt: row.acknowledged_at === null ? null : row.acknowledged_at.toISOString(),
    acknowledgedByUserId: row.acknowledged_by_user_id,
  }));
}

export type AcknowledgeOutcome =
  | { readonly acknowledged: true; readonly alertKey: string }
  | { readonly acknowledged: false; readonly reason: 'not_admin' | 'not_open' | 'already_acknowledged' };

/**
 * The admin acknowledge command G1 asked for. Admin only, and audited in the same
 * transaction, because the acknowledgement is the thing that silences a repeating
 * critical alert and "who silenced it" is the first question afterwards.
 */
export async function acknowledgeCriticalAlert(
  context: RepositoryContext,
  options: { readonly alertId: string; readonly note?: string | undefined },
): Promise<AcknowledgeOutcome> {
  if (!isAdminScope(context.scope)) return { acknowledged: false, reason: 'not_admin' };
  const actor = context.scope.actor;
  if (actor.kind !== 'user') return { acknowledged: false, reason: 'not_admin' };

  const { rows } = await context.db.query<{ alert_key: string }>(
    `UPDATE critical_alerts
        SET acknowledged_at = now(), acknowledged_by_user_id = $3
      WHERE workspace_id = $1 AND id = $2 AND resolved_at IS NULL AND acknowledged_at IS NULL
    RETURNING alert_key`,
    [context.scope.workspaceId, options.alertId, actor.userId],
  );
  const alertKey = rows[0]?.alert_key;
  if (alertKey === undefined) {
    const existing = await context.db.query<{ acknowledged_at: Date | null }>(
      'SELECT acknowledged_at FROM critical_alerts WHERE workspace_id = $1 AND id = $2 AND resolved_at IS NULL',
      [context.scope.workspaceId, options.alertId],
    );
    if (existing.rows.length === 0) return { acknowledged: false, reason: 'not_open' };
    return { acknowledged: false, reason: 'already_acknowledged' };
  }

  await context.db.query(
    `INSERT INTO audit_events (workspace_id, actor_kind, actor_user_id, action, subject_kind, subject_id, detail)
     VALUES ($1, 'admin', $2, 'alert.acknowledge', 'critical_alert', $3, $4::jsonb)`,
    [
      context.scope.workspaceId,
      actor.userId,
      options.alertId,
      JSON.stringify({ alertKey, note: options.note ?? null }),
    ],
  );
  return { acknowledged: true, alertKey };
}

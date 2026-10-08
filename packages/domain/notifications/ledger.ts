import { notificationReceiptSchema, type ActionableNotificationsResponse, type NotificationItem, type TodayActionTarget, type NotificationReceipt } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { readNotificationCandidates, notificationCandidatesFromToday } from './actions.ts';
import { openTodayAction, readTodayActions, currentTodayTarget } from '../today/actions.ts';

interface AttemptRow {
  readonly [column: string]: unknown;
  attempt_id: string; device_id: string; event_key: string; action_id: string; target: TodayActionTarget;
  status: NotificationReceipt['status']; attempted_at: Date; native_shown_at: Date | null;
  acknowledged_at: Date | null; failed_at: Date | null; unknown_at: Date | null;
}
function receipt(row: AttemptRow): NotificationReceipt {
  return notificationReceiptSchema.parse({ attemptId: row.attempt_id, deviceId: row.device_id, status: row.status,
    attemptedAt: row.attempted_at.toISOString(), nativeShownAt: row.native_shown_at?.toISOString() ?? null,
    acknowledgedAt: row.acknowledged_at?.toISOString() ?? null, failedAt: row.failed_at?.toISOString() ?? null,
    unknownAt: row.unknown_at?.toISOString() ?? null });
}
async function ownedDevice(context: RepositoryContext, deviceId: string): Promise<boolean> {
  if (context.scope.actor.kind !== 'user') return false;
  const { rows } = await context.db.query(`SELECT 1 FROM devices d JOIN workspace_memberships m ON m.workspace_id=d.workspace_id AND m.user_id=d.user_id
    WHERE d.workspace_id=$1 AND d.id=$2 AND d.user_id=$3 AND d.status='active' AND m.status='active'`,
  [context.scope.workspaceId, deviceId, context.scope.actor.userId]);
  return rows.length === 1;
}

export async function claimNotification(context: RepositoryContext, input: { eventKey: string; deviceId: string; now: string }): Promise<NotificationItem | null> {
  if (context.scope.actor.kind !== 'user' || !await ownedDevice(context, input.deviceId)) return null;
  const candidate = (await readNotificationCandidates(context, input)).find(item => item.eventKey === input.eventKey);
  if (candidate === undefined) return null;
  const { rows } = await context.db.query<AttemptRow>(`INSERT INTO actionable_notification_attempts
    (workspace_id,user_id,device_id,event_key,action_id,phase,target,attempted_at)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) ON CONFLICT(workspace_id,user_id,event_key) DO NOTHING RETURNING *`,
  [context.scope.workspaceId, context.scope.actor.userId, input.deviceId, candidate.eventKey, candidate.actionId, candidate.phase, JSON.stringify(candidate.target), input.now]);
  return rows[0] === undefined ? null : { ...candidate, receipt: receipt(rows[0]) };
}
export async function readActionableNotifications(context: RepositoryContext, input: { deviceId: string; now: string }): Promise<ActionableNotificationsResponse> {
  if (context.scope.actor.kind !== 'user') throw new Error('notification_user_required');
  if (!await ownedDevice(context, input.deviceId)) throw new Error('notification_device_unavailable');
  const today = await readTodayActions(context, input);
  const candidates = notificationCandidatesFromToday(today.actions, input.now);
  const currentEventKeys = today.actions.flatMap(action => action.kind === 'reply'
    ? [`${action.actionId}:attention`, `${action.actionId}:reply_overdue`]
    : [`${action.actionId}:${action.kind === 'call' ? `pre_call:${action.dueAt}` : 'attention'}`]);
  // Keep every durable marker. Presentation includes current events plus at most100
  // recent device receipts, so obsolete lifetime history cannot grow each poll.
  const { rows } = await context.db.query<AttemptRow>(`WITH selected AS (
    SELECT attempt_id FROM actionable_notification_attempts WHERE workspace_id=$1 AND user_id=$2 AND event_key=ANY($4::text[])
    UNION
    SELECT attempt_id FROM (SELECT attempt_id FROM actionable_notification_attempts
      WHERE workspace_id=$1 AND user_id=$2 AND device_id=$3 ORDER BY attempted_at DESC,attempt_id DESC LIMIT 100) recent
  ) SELECT a.* FROM actionable_notification_attempts a JOIN selected USING(attempt_id)
    WHERE a.workspace_id=$1 AND a.user_id=$2 ORDER BY a.attempted_at,a.attempt_id`,
  [context.scope.workspaceId, context.scope.actor.userId, input.deviceId, currentEventKeys]);
  const byEvent = new Map(rows.map(row => [row.event_key, row]));
  const recoveries: ActionableNotificationsResponse['recoveries'] = [];
  for (const row of rows.filter(row => row.device_id === input.deviceId)) {
    const current = currentTodayTarget(today.actions, { actionId: row.action_id, target: row.target }) !== null;
    recoveries.push({ eventKey: row.event_key, actionId: row.action_id, target: row.target, current, receipt: receipt(row) });
  }
  return { version: 1, workspaceId: context.scope.workspaceId, userId: context.scope.actor.userId, asOf: input.now,
    items: candidates.map(item => { const row = byEvent.get(item.eventKey); return { ...item, receipt: row === undefined ? null : receipt(row) }; }), recoveries };
}

export async function observeNotification(context: RepositoryContext, input: { attemptId: string; deviceId: string; observation: 'native_shown' | 'failed' | 'unknown'; now: string }): Promise<boolean> {
  if (context.scope.actor.kind !== 'user' || !await ownedDevice(context, input.deviceId)) return false;
  const { rowCount } = await context.db.query(`UPDATE actionable_notification_attempts SET
    status=CASE WHEN status='acknowledged' THEN status WHEN $5='native_shown' THEN 'native_shown'
      WHEN status='native_shown' THEN status ELSE $5 END,
    native_shown_at=CASE WHEN $5='native_shown' THEN coalesce(native_shown_at,$6::timestamptz) ELSE native_shown_at END,
    failed_at=CASE WHEN $5='failed' THEN coalesce(failed_at,$6::timestamptz) ELSE failed_at END,
    unknown_at=CASE WHEN $5='unknown' THEN coalesce(unknown_at,$6::timestamptz) ELSE unknown_at END
    WHERE workspace_id=$1 AND user_id=$2 AND attempt_id=$3 AND device_id=$4`,
  [context.scope.workspaceId, context.scope.actor.userId, input.attemptId, input.deviceId, input.observation, input.now]);
  return rowCount === 1;
}
export async function acknowledgeNotification(context: RepositoryContext, input: { attemptId: string; deviceId: string; now: string }): Promise<TodayActionTarget | null> {
  if (context.scope.actor.kind !== 'user' || !await ownedDevice(context, input.deviceId)) return null;
  const { rows } = await context.db.query<AttemptRow>(`UPDATE actionable_notification_attempts SET status='acknowledged',acknowledged_at=coalesce(acknowledged_at,$4::timestamptz)
    WHERE workspace_id=$1 AND user_id=$2 AND attempt_id=$3 RETURNING *`, [context.scope.workspaceId, context.scope.actor.userId, input.attemptId, input.now]);
  const row = rows[0];
  return row === undefined ? null : (await openTodayAction(context, { actionId: row.action_id, target: row.target, now: input.now })).target;
}

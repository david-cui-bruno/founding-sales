import { isDeepStrictEqual } from 'node:util';
import type { TodayAction, TodayActionsResponse, TodayActionTarget } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { workspaceBusinessTimeZone } from './snapshots.ts';
import { currentHolidayCalendar } from '../sequences/calendars.ts';
import { replyDeadline } from './replyDeadline.ts';

/** Live metadata only. Daily snapshots are presentation, never the action authority. */
export async function readTodayActions(context: RepositoryContext, input: { now: string }): Promise<TodayActionsResponse> {
  const businessTimeZone = await workspaceBusinessTimeZone(context);
  const calendar = await currentHolidayCalendar(context);
  const actor = context.scope.actor;
  const assignee = actor.kind === 'user' && actor.role !== 'admin' ? actor.userId : null;
  const { rows } = await context.db.query<{ id: string; firm_id: string; name: string; internal_date: Date; substantive: boolean }>(
    `SELECT m.id, f.id AS firm_id, f.name, m.internal_date,
         (EXISTS (SELECT 1 FROM mail_message_classifications c WHERE c.workspace_id=m.workspace_id AND c.mail_message_id=m.id AND c.layer='deterministic' AND c.class='human')
           OR EXISTS (SELECT 1 FROM mail_reply_confirmations c WHERE c.workspace_id=m.workspace_id AND c.mail_message_id=m.id)) AS substantive
       FROM mail_messages m
       JOIN LATERAL (
         SELECT x.firm_id, x.contact_id FROM mail_message_matches x
          WHERE x.workspace_id=m.workspace_id AND x.mail_message_id=m.id
            AND (x.selected IS TRUE OR (x.selected IS NULL AND NOT x.ambiguous
              AND NOT EXISTS (SELECT 1 FROM mail_message_matches other WHERE other.workspace_id=x.workspace_id AND other.mail_message_id=x.mail_message_id AND other.id<>x.id)))
          ORDER BY x.selected DESC NULLS LAST, x.created_at, x.id LIMIT 1
       ) chosen ON true
       JOIN firms f ON f.workspace_id=m.workspace_id AND f.id=chosen.firm_id
      WHERE m.workspace_id=$1 AND m.direction='incoming' AND f.status='active'
        AND ($2::uuid IS NULL OR f.assigned_user_id=$2)
        AND EXISTS (SELECT 1 FROM mail_message_classifications c WHERE c.workspace_id=m.workspace_id AND c.mail_message_id=m.id AND c.layer='deterministic' AND c.class IN ('human','uncertain'))
        AND NOT EXISTS (SELECT 1 FROM mail_reply_confirmations c WHERE c.workspace_id=m.workspace_id AND c.mail_message_id=m.id AND c.disposition IN ('not_interested','opt_out'))
        AND NOT EXISTS (
          SELECT 1 FROM mail_message_effects e JOIN mail_messages o ON o.workspace_id=e.workspace_id AND o.id=e.mail_message_id
           WHERE e.workspace_id=m.workspace_id AND o.mailbox_id=m.mailbox_id AND o.direction='outgoing'
             AND e.effect_kind='direct_send_conversation' AND e.detail->>'firmId'=f.id::text
             AND o.provider_thread_id=m.provider_thread_id
             AND chosen.contact_id IS NOT NULL AND e.detail->'recipientContactIds' ? chosen.contact_id::text
             AND o.internal_date>m.internal_date)
        AND NOT EXISTS (
          SELECT 1 FROM mail_messages newer
           WHERE newer.workspace_id=m.workspace_id AND newer.mailbox_id=m.mailbox_id AND newer.provider_thread_id=m.provider_thread_id
             AND newer.direction='incoming' AND (newer.internal_date,newer.id)>(m.internal_date,m.id)
             AND EXISTS (SELECT 1 FROM mail_message_matches x WHERE x.workspace_id=newer.workspace_id AND x.mail_message_id=newer.id AND x.firm_id=f.id
               AND (x.selected IS TRUE OR (x.selected IS NULL AND NOT x.ambiguous
                 AND NOT EXISTS (SELECT 1 FROM mail_message_matches other WHERE other.workspace_id=x.workspace_id AND other.mail_message_id=x.mail_message_id AND other.id<>x.id))))
             AND EXISTS (SELECT 1 FROM mail_message_classifications c WHERE c.workspace_id=newer.workspace_id AND c.mail_message_id=newer.id AND c.layer='deterministic' AND c.class IN ('human','uncertain','opt_out')))
        AND NOT EXISTS (SELECT 1 FROM crm_mail_reply_resolutions resolved WHERE resolved.workspace_id=m.workspace_id AND resolved.request_message_id=m.id)
        AND NOT EXISTS (SELECT 1 FROM outreach_reply_requests r WHERE r.workspace_id=m.workspace_id AND r.original_message_id=m.id AND r.state='delivered')
      ORDER BY m.internal_date,m.id`, [context.scope.workspaceId, assignee]);
  const actions: TodayAction[] = rows.map(row => {
    const dueAt = replyDeadline(row.internal_date.toISOString(), businessTimeZone, calendar);
    return { actionId: `reply-message:${row.id}`, kind: 'reply', subject: row.name, reason: row.substantive ? 'substantive_reply' : 'reply_review', dueAt, state: Date.parse(input.now) >= Date.parse(dueAt) ? 'overdue' : 'open', target: { kind: 'reply', firmId: row.firm_id, messageId: row.id } };
  });
  const { rows: meetings } = await context.db.query<{ id: string; firm_id: string; name: string; starts_at: Date; current_booking_uid: string }>(
    `SELECT m.id, f.id AS firm_id, f.name, m.starts_at, m.current_booking_uid FROM meetings m
       JOIN firms f ON f.workspace_id=m.workspace_id AND f.id=m.firm_id
      WHERE m.workspace_id=$1 AND f.status='active' AND ($2::uuid IS NULL OR f.assigned_user_id=$2)
        AND m.state IN ('booked','rescheduled') AND m.starts_at >= $3::timestamptz
        AND m.starts_at <= $3::timestamptz + interval '7 days'
      ORDER BY m.starts_at,m.id`, [context.scope.workspaceId, assignee, input.now]);
  for (const meeting of meetings) actions.push({ actionId: `meeting:${meeting.id}`, kind: 'call', subject: meeting.name, reason: 'upcoming_call', dueAt: meeting.starts_at.toISOString(), state: 'open', target: { kind: 'meeting', firmId: meeting.firm_id, meetingId: meeting.id, startsAt: meeting.starts_at.toISOString(), bookingUid: meeting.current_booking_uid } });
  const { rows: mailboxes } = await context.db.query<{ id: string; generation: number; status: string; disconnected_at: Date }>(
    `SELECT id, generation, status, disconnected_at FROM mailboxes
      WHERE workspace_id=$1 AND status='revoked'
        AND $2::uuid IS NOT NULL AND owner_user_id=$2 ORDER BY disconnected_at,id`, [context.scope.workspaceId, actor.kind === 'user' && actor.role === 'admin' ? actor.userId : null]);
  for (const mailbox of mailboxes) actions.push({ actionId: `mailbox:${mailbox.id}:${String(mailbox.generation)}:${mailbox.status}`, kind: 'problem', subject: 'Mailbox needs reconnecting', reason: 'mailbox_disconnected', dueAt: mailbox.disconnected_at.toISOString(), state: 'open', target: { kind: 'settings', tab: 'administration', section: 'sending-admin', mailboxId: mailbox.id } });
  actions.sort((a,b) => priority(a)-priority(b) || a.dueAt.localeCompare(b.dueAt) || a.actionId.localeCompare(b.actionId));
  return { version: 1, workspaceId: context.scope.workspaceId, businessTimeZone, asOf: input.now, actions };
}

/** Revalidate the exact current target. Opening never completes an unanswered action. */
export async function openTodayAction(context: RepositoryContext, input: { actionId: string; target: TodayActionTarget; now: string }): Promise<{ version: 1; target: TodayActionTarget | null }> {
  return { version: 1, target: currentTodayTarget((await readTodayActions(context, { now: input.now })).actions, input) };
}

/** Match exact authority within one already-read projection; it grants no later action. */
export function currentTodayTarget(actions: readonly TodayAction[], input: { actionId: string; target: TodayActionTarget }): TodayActionTarget | null {
  const current = actions.find(action => action.actionId === input.actionId);
  return current !== undefined && isDeepStrictEqual(current.target, input.target) ? current.target : null;
}

function priority(action: TodayAction): number { return action.kind === 'reply' ? action.state === 'overdue' ? 0 : 1 : action.kind === 'call' ? 2 : 3; }

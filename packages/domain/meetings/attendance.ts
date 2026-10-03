import type { MeetingAttendanceChoice, MeetingAttendanceRefusalCode, MeetingAttendanceSet, MeetingState } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import { decideFirmMutation } from '../crm/authorization.ts';
import { loadFirmForUpdate } from '../crm/firms.ts';
import { recordFunnelFact, reinstateFunnelFact, withdrawFunnelFacts } from '../funnel/facts.ts';
import { lockSendGateForStopFact } from '../policy/sendGate.ts';
import { MEETING_COLUMNS, type MeetingRow } from './calcom.ts';

/**
 * Attendance, confirmed by a person (lane M1, migration 0039).
 *
 * Cal.com's `MEETING_ENDED` is the scheduled end, so a meeting whose end has passed is
 * `ended`: nobody has said who came. A person says it here:
 *
 *   * `attended` → `held`, source `manual`, by them, now;
 *   * `no_show` → `no_show`, source `manual`; it remembers `ended` (or the unconfirmed state
 *     the meeting was in) as `state_before_no_show`;
 *   * `unconfirmed` undoes the person's own confirmation, back to `ended`. A Cal.com no-show
 *     or a recording's confirmation is never undone this way: refused with its reason.
 *
 * Who may: an administrator, or the firm's assigned salesperson (`decideFirmMutation`), on
 * a meeting matched to a firm, not cancelled, whose scheduled start has passed. The same
 * choice twice is accepted and changes nothing; the route makes a replayed command id
 * answer what it answered (`runRouteCommand`).
 *
 * **The funnel.** `meeting.held` is written only here (and, later, by a recording's
 * confirmation), dated at the meeting's start, keyed by its original booking uid. Undoing
 * a confirmation, or replacing it with a no-show, withdraws it (`withdrawn_reason
 * attendance_unconfirmed`); confirming again reinstates the same row. Nothing is written
 * for `ended`. Nothing here sends anything, and nothing here changes a deal's stage.
 *
 * **M7's hook.** The follow-through engine gates on confirmed attendance: a meeting that
 * becomes `held` here (`toState === 'held'` below) is where a recap would be scheduled. M1
 * schedules nothing.
 *
 * Lock order, the one every meeting writer keeps: the send gate (advisory), then the firm
 * row, then the meeting row (`meetings/match.ts`, `meetings/calcom.ts`).
 */

export type AttendanceResult =
  | { readonly ok: true; readonly value: MeetingAttendanceSet }
  | { readonly ok: false; readonly reason: MeetingAttendanceRefusalCode };

const refuse = (reason: MeetingAttendanceRefusalCode): AttendanceResult => ({ ok: false, reason });

/** Why `unconfirmed` withdrew a fact, and why a person's no-show replaced an attendance. */
export const ATTENDANCE_UNCONFIRMED_REASON = 'attendance_unconfirmed';

/** Every booking uid a meeting has had: its `meeting.held` fact is keyed by one of them. */
async function bookingUidsOf(context: RepositoryContext, meeting: Pick<MeetingRow, 'id' | 'booking_uid' | 'current_booking_uid'>): Promise<string[]> {
  const { rows } = await context.db.query<{ booking_uid: string }>(
    'SELECT booking_uid FROM meeting_booking_uids WHERE workspace_id = $1 AND meeting_id = $2',
    [context.scope.workspaceId, meeting.id],
  );
  return [...new Set([meeting.booking_uid, meeting.current_booking_uid, ...rows.map(row => row.booking_uid)])];
}

/**
 * The `meeting.held` fact for a meeting that is now confirmed held: the one it had, brought
 * back if it was withdrawn, or a new one dated at the meeting's start. Exported for the
 * person's match of an unmatched booking (`meetings/match.ts`), which owes it for a meeting
 * already confirmed.
 */
export async function recordHeldFact(
  context: RepositoryContext,
  meeting: Pick<MeetingRow, 'id' | 'booking_uid' | 'current_booking_uid' | 'firm_id' | 'starts_at' | 'attendance_source'>,
): Promise<void> {
  if (meeting.firm_id === null) return;
  const keys = await bookingUidsOf(context, meeting);
  const existing = await reinstateFunnelFact(context, { kind: 'meeting.held', dedupeKeys: keys, preferredKey: meeting.booking_uid });
  if (existing !== 'absent') return;
  await recordFunnelFact(context, {
    kind: 'meeting.held',
    source: 'calendar',
    dedupeKey: meeting.booking_uid,
    firmId: meeting.firm_id,
    occurredAt: meeting.starts_at.toISOString(),
    detail: { attendanceSource: meeting.attendance_source ?? 'manual' },
  });
}

/** Withdraw a meeting's `meeting.held` fact, under whichever of its uids it was keyed. */
export async function withdrawHeldFact(
  context: RepositoryContext,
  meeting: Pick<MeetingRow, 'id' | 'booking_uid' | 'current_booking_uid'>,
  reason: string,
): Promise<number> {
  return await withdrawFunnelFacts(context, { kind: 'meeting.held', dedupeKeys: await bookingUidsOf(context, meeting), reason });
}

export async function setMeetingAttendance(
  context: RepositoryContext,
  input: { readonly meetingId: string; readonly attendance: MeetingAttendanceChoice },
): Promise<AttendanceResult> {
  const actor = context.scope.actor;
  // A confirmation names the person who made it (`meetings_attendance_confirmer`).
  if (actor.kind !== 'user') return refuse('invalid_input');
  const workspaceId = context.scope.workspaceId;

  await lockSendGateForStopFact(context);
  const { rows: located } = await context.db.query<{ firm_id: string | null }>(
    'SELECT firm_id FROM meetings WHERE workspace_id = $1 AND id = $2',
    [workspaceId, input.meetingId],
  );
  const where = located[0];
  if (where === undefined) return refuse('meeting_unknown');
  if (where.firm_id === null) return refuse('meeting_unmatched');
  const firm = await loadFirmForUpdate(context, where.firm_id);
  if (firm === null) return refuse('firm_unknown');
  const decision = decideFirmMutation(context, firm);
  if (!decision.permitted) return refuse(decision.reason === 'firm_merged' ? 'firm_merged' : decision.reason === 'not_assigned' ? 'not_assigned' : 'firm_unknown');

  const { rows: locked } = await context.db.query<MeetingRow & { started: boolean }>(
    `SELECT ${MEETING_COLUMNS}, starts_at <= now() AS started FROM meetings WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
    [workspaceId, input.meetingId],
  );
  const meeting = locked[0];
  if (meeting === undefined) return refuse('meeting_unknown');
  // The firm the meeting names moved under the lock (a merge): its permission was not asked.
  if (meeting.firm_id !== firm.id) return refuse('meeting_unknown');
  if (meeting.state === 'cancelled') return refuse('meeting_cancelled');
  if (!meeting.started) return refuse('meeting_not_started');

  const answer = (row: MeetingRow): AttendanceResult => ({
    ok: true,
    value: { meetingId: row.id, state: row.state, attendanceSource: row.attendance_source },
  });

  let toState: MeetingState;
  let before: MeetingState | null = null;
  let manual = true;
  switch (input.attendance) {
    case 'attended':
      if (meeting.state === 'held') return answer(meeting);
      toState = 'held';
      break;
    case 'no_show':
      if (meeting.state === 'no_show') return answer(meeting);
      toState = 'no_show';
      // What it was before anybody confirmed anything: a person's own `held` was `ended`.
      before = meeting.state === 'held' ? 'ended' : meeting.state;
      break;
    case 'unconfirmed':
      if (meeting.state !== 'held' && meeting.state !== 'no_show') return answer(meeting);
      if (meeting.attendance_source === 'calcom_no_show') return refuse('attendance_from_calcom');
      if (meeting.attendance_source === 'recording') return refuse('attendance_from_recording');
      toState = 'ended';
      manual = false;
      break;
  }

  const { rows: written } = await context.db.query<MeetingRow>(
    `UPDATE meetings
        SET state = $3, state_before_no_show = $4,
            attendance_source = CASE WHEN $5::boolean THEN 'manual' END,
            attendance_confirmed_at = CASE WHEN $5::boolean THEN now() END,
            attendance_confirmed_by = CASE WHEN $5::boolean THEN $6::uuid END,
            updated_at = now()
      WHERE workspace_id = $1 AND id = $2
      RETURNING ${MEETING_COLUMNS}`,
    [workspaceId, meeting.id, toState, before, manual, actor.userId],
  );
  const updated = written[0];
  if (updated === undefined) return refuse('meeting_unknown');

  if (toState === 'held') {
    await recordHeldFact(context, updated);
    // M7 hook: confirmed attendance. The follow-through engine starts here; M1 sends nothing.
  } else if (meeting.state === 'held') {
    await withdrawHeldFact(context, updated, ATTENDANCE_UNCONFIRMED_REASON);
  }
  await recordCrmAuditEvent(context, {
    action: 'meeting.attendance_set',
    subjectKind: 'meeting',
    subjectId: meeting.id,
    detail: {
      firmId: firm.id,
      attendance: input.attendance,
      fromState: meeting.state,
      fromSource: meeting.attendance_source,
      toState,
    },
  });
  return answer(updated);
}

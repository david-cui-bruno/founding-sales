import type {
  StageSuggestion,
  FirmMeetingDto,
  MeetingMatchRefusalCode,
  MeetingMatched,
  MeetingState,
  UnmatchedMeetingDto,
} from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import { decideFirmMutation } from '../crm/authorization.ts';
import { createContact } from '../crm/contacts.ts';
import { loadFirmForUpdate, readFirm } from '../crm/firms.ts';
import { addEmailRoute } from '../crm/routes.ts';
import { lockSendGateForStopFact } from '../policy/sendGate.ts';
import { mayChangeStage } from '../crm/board.ts';
import { recordHeldFact } from './attendance.ts';
import { readDemoBookedSuggestions } from './stageSuggestion.ts';
import { applyBooked, MEETING_COLUMNS, type MeetingRow } from './calcom.ts';

/**
 * A person attaches a booking Callie could not match to the right firm (slice M1), and
 * the two meeting reads the desktop shows.
 *
 * ## The match
 *
 * `matchMeetingToFirm` is the webhook's matched path, run late and on a person's word:
 *
 *   1. the firm is the person's to change (`decideFirmMutation`: the assignee or an
 *      administrator; a merged firm is refused);
 *   2. the meeting is still unmatched — a meeting that already names a firm is refused,
 *      because moving a booked demo between firms is a different operation (the firm
 *      merge does it);
 *   3. the contact: the firm's contact whose address the attendee booked with, when there
 *      is exactly one; otherwise a new contact at the firm, with the address, when the
 *      booking named one;
 *   4. the meeting's `stage_review_items` row is resolved by this person;
 *   5. unless the meeting is cancelled, `applyBooked` — the same function the webhook
 *      runs for a matched booking: manual control for the firm's open opportunity, the
 *      stop owed to the firm's live prospecting and cold_legacy enrollments (an agreed
 *      follow-up keeps running), the funnel fact. No stage moves (lane M1: stage changes
 *      are manual; `stage` is always `none`). `meeting.held` only for a meeting whose
 *      attendance is confirmed — never for one that has merely `ended`.
 *
 * **Lock order**, the one every stop-fact writer keeps: the send gate first (advisory,
 * exclusive), then the firm row, then the meeting row, then the opportunity `applyBooked`
 * sets manual. The gate is what serializes this with the webhook and the
 * reconciliation, which take it before the meeting row.
 */

type MatchResult =
  | { readonly ok: true; readonly value: MeetingMatched }
  | { readonly ok: false; readonly reason: MeetingMatchRefusalCode };

const refuse = (reason: MeetingMatchRefusalCode): MatchResult => ({ ok: false, reason });

export async function matchMeetingToFirm(
  context: RepositoryContext,
  input: { readonly meetingId: string; readonly firmId: string },
): Promise<MatchResult> {
  const actor = context.scope.actor;
  // A review item is resolved by a person (`stage_review_items_resolution_consistent`).
  if (actor.kind !== 'user') return refuse('invalid_input');
  const workspaceId = context.scope.workspaceId;

  await lockSendGateForStopFact(context);
  const firm = await loadFirmForUpdate(context, input.firmId);
  if (firm === null) return refuse('firm_unknown');
  const decision = decideFirmMutation(context, firm);
  if (!decision.permitted) {
    return refuse(decision.reason === 'firm_merged' ? 'firm_merged' : decision.reason === 'not_assigned' ? 'not_assigned' : 'firm_unknown');
  }

  const { rows: meetings } = await context.db.query<MeetingRow & { attendee_email: string | null }>(
    `SELECT ${MEETING_COLUMNS}, attendee_email FROM meetings WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
    [workspaceId, input.meetingId],
  );
  const meeting = meetings[0];
  if (meeting === undefined) return refuse('meeting_unknown');
  if (meeting.firm_id !== null) return refuse('meeting_already_matched');

  // ---- the contact ------------------------------------------------------------
  let contactId: string | null = null;
  const attendee = meeting.attendee_email;
  if (attendee !== null) {
    const { rows: known } = await context.db.query<{ contact_id: string }>(
      `SELECT DISTINCT a.contact_id FROM email_addresses a
         JOIN contacts c ON c.workspace_id = a.workspace_id AND c.id = a.contact_id AND c.status = 'active'
        WHERE a.workspace_id = $1 AND a.firm_id = $2 AND a.address = $3 AND a.contact_id IS NOT NULL
          AND a.eligibility <> 'retired'`,
      [workspaceId, firm.id, attendee],
    );
    if (known.length === 1) {
      contactId = known[0]?.contact_id ?? null;
    } else if (known.length === 0) {
      // Nobody at this firm has the address: the person who booked becomes a contact,
      // named by the address until somebody types their name (the meeting row holds no
      // name — Cal.com's payload is not stored).
      const created = await createContact(context, { firmId: firm.id, fullName: attendee.slice(0, 200) });
      if (!created.ok) return refuse(created.reason === 'not_assigned' ? 'not_assigned' : 'invalid_input');
      contactId = created.value.id;
      const route = await addEmailRoute(context, { firmId: firm.id, contactId, address: attendee, source: 'salesperson' });
      if (!route.ok) return refuse('invalid_input');
    }
    // Two contacts at the firm with one address: the meeting names the firm only, as
    // `matchAttendee` does, rather than choosing between them.
  }

  const { rows: linked } = await context.db.query<MeetingRow>(
    `UPDATE meetings SET firm_id = $3, contact_id = $4, updated_at = now()
      WHERE workspace_id = $1 AND id = $2
      RETURNING ${MEETING_COLUMNS}`,
    [workspaceId, meeting.id, firm.id, contactId],
  );
  const updated = linked[0];
  if (updated === undefined) return refuse('meeting_unknown');

  await context.db.query(
    `UPDATE stage_review_items SET resolved_at = now(), resolved_by_user_id = $3, firm_id = $4
      WHERE workspace_id = $1 AND evidence_kind = 'meeting.booked' AND evidence_id = $2 AND resolved_at IS NULL`,
    [workspaceId, meeting.id, actor.userId, firm.id],
  );

  // Lane M1: a match moves no stage. The answer keeps its field for the desktops that read it.
  const stage: MeetingMatched['stage'] = 'none';
  if (updated.state !== 'cancelled') {
    await applyBooked(context, updated);
    if (updated.state === 'held') await recordHeldFact(context, updated);
  }
  await recordCrmAuditEvent(context, {
    action: 'meeting.matched_by_person',
    subjectKind: 'meeting',
    subjectId: meeting.id,
    detail: { firmId: firm.id, contactId, state: updated.state, stage },
  });
  return { ok: true, value: { meetingId: meeting.id, firmId: firm.id, contactId, state: updated.state, stage } };
}

/**
 * The bookings no firm is attached to, soonest first, at most fifty. Every active
 * member may read them: the booking was made on the workspace's own page and matching it
 * is how it reaches a firm at all. Only the state, the time, the attendee's address and
 * why it was not matched; nothing else about the booking is stored.
 */
export async function listUnmatchedMeetings(context: RepositoryContext): Promise<readonly UnmatchedMeetingDto[]> {
  const { rows } = await context.db.query<{
    id: string;
    state: MeetingState;
    starts_at: Date;
    ends_at: Date;
    attendee_email: string | null;
    reason: 'firm_unmatched' | 'firm_ambiguous' | null;
  }>(
    `SELECT m.id, m.state, m.starts_at, m.ends_at, m.attendee_email, r.reason
       FROM meetings m
       LEFT JOIN stage_review_items r
         ON r.workspace_id = m.workspace_id AND r.evidence_kind = 'meeting.booked' AND r.evidence_id = m.id::text
        AND r.resolved_at IS NULL AND r.reason IN ('firm_unmatched', 'firm_ambiguous')
      WHERE m.workspace_id = $1 AND m.firm_id IS NULL AND m.state <> 'cancelled'
      ORDER BY m.starts_at, m.id
      LIMIT 50`,
    [context.scope.workspaceId],
  );
  return rows.map(row => ({
    meetingId: row.id,
    state: row.state,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at.toISOString(),
    attendeeEmail: row.attendee_email,
    reason: row.reason,
  }));
}

/**
 * A firm's meetings, newest start first, at most fifty; null when the firm is not in
 * this workspace. A meeting's state and time are "stage/dates" in Appendix F's first
 * row, which every active member may read.
 */
export async function listFirmMeetings(context: RepositoryContext, firmId: string): Promise<readonly FirmMeetingDto[] | null> {
  const firm = await readFirm(context, firmId);
  if (firm === null) return null;
  const { rows } = await context.db.query<{ id: string; state: MeetingState; starts_at: Date; ends_at: Date; attendance_source: string | null }>(
    `SELECT id, state, starts_at, ends_at, attendance_source FROM meetings
      WHERE workspace_id = $1 AND firm_id = $2
      ORDER BY starts_at DESC, id
      LIMIT 50`,
    [context.scope.workspaceId, firmId],
  );
  return rows.map(row => ({
    meetingId: row.id,
    state: row.state,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at.toISOString(),
    // Lane M1: how attendance was confirmed, so the row offers Undo only for a person's own.
    attendanceSource: row.attendance_source,
  }));
}

/**
 * The firm page's "Move to Demo booked" (lane M1, `stageSuggestion.ts`): offered only to a
 * person who could make the move — an administrator or the firm's assignee — as the board
 * offers a stage control. Null for anybody else, and when nothing is to be suggested.
 */
export async function readFirmStageSuggestion(context: RepositoryContext, firmId: string): Promise<StageSuggestion | null> {
  const firm = await readFirm(context, firmId);
  if (firm === null || !mayChangeStage(context, firm.assigned_user_id)) return null;
  return (await readDemoBookedSuggestions(context, [firmId])).get(firmId) ?? null;
}

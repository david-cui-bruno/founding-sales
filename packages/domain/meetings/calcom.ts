import { lockTodayForFirmChange } from '../today/build.ts';
import { foldMeetingOutcomes } from './outcomeCorrections.ts';
import { createHash } from 'node:crypto';
import { CALCOM_APPLIED_TRIGGERS, type CalcomAppliedTrigger, type MeetingAttendanceSource, type MeetingState } from '@fss/contracts';
import type { Queryable } from '../db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../db/workspaceScope.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import { readOpenOpportunity, setManualControlMode } from '../crm/pipeline.ts';
import { openReviewItem } from '../crm/stageEvidence.ts';
import { recordFunnelFact } from '../funnel/facts.ts';
import { lockSendGateForStopFact } from '../policy/sendGate.ts';
import { stopEnrollments } from '../sequences/enrollments.ts';
import { attendeeAddressOf } from './attendee.ts';
import { detailsEmpty, mergeBookingDetails, NO_BOOKING_DETAILS, parseWebhookBookingDetails, type BookingDetails } from './bookingDetails.ts';
import { reconcileHeldFacts } from './heldFacts.ts';
import { moveRecordingsToSurvivor } from './recordings.ts';
import { manualModeEndReason } from '../sequences/terminalStops.ts';

/**
 * Cal.com webhook deliveries → meetings → the pipeline (call-to-booking slice W, 0028).
 *
 * The route has verified the HMAC over the raw body before this is called. Here:
 *
 *   * **Dedupe.** `calcom_events.event_id` is the sha256 of that raw body, so an exact
 *     redelivery inserts nothing and applies nothing.
 *   * **Order.** Events are ordered by the payload's own `createdAt`. An event older than
 *     the last one applied to the meeting is recorded `stale` and not applied, so a
 *     cancelled meeting is never restored by a create that arrived late. A cancelled
 *     meeting is terminal for every later event too. No-show mark and unmark apply in
 *     order, and unmark restores the state the meeting had before the mark.
 *   * **Matching.** The attendee's e-mail → a contact → its firm; failing that the
 *     attendee's domain → the one firm whose website has it; otherwise a review item.
 *   * **A booking** moves no deal (lane M1: stage changes are manual). It stops
 *     conflicting prospecting at the firm through the existing stop writers — manual mode
 *     on the open opportunity (`setManualControlMode`, origin `engaged_call`: a booked demo
 *     is a conversation) and `stopEnrollments` for every live **prospecting** enrollment
 *     there; an evidenced follow-up is compatible with a booking and keeps running — and
 *     records the funnel fact. The CRM sends no reminder: Cal.com owns those.
 *   * **Attendance** (lane M1, 0039). `MEETING_ENDED` is the scheduled end: `ended`, never
 *     `held`. Cal.com's no-show flag confirms absence; nothing from Cal.com confirms
 *     attendance, and no Cal.com time event overwrites a confirmation.
 *
 * Lock order: the send gate first, before any row, as every stop-fact writer takes it
 * (`policy/sendGate.ts`); then the meeting; then the opportunity `applyBooked` sets manual.
 */

export type CalcomEventOutcome = 'applied' | 'stale' | 'ignored' | 'unmatched' | 'malformed';

export interface CalcomReceipt {
  readonly duplicate: boolean;
  readonly eventId: string;
  readonly outcome: CalcomEventOutcome | null;
  readonly meetingId: string | null;
  readonly meetingState: MeetingState | null;
}

/** The dedupe key: sha256 of the exact bytes Cal.com signed. */
export function calcomEventIdOf(rawBody: Buffer): string {
  return createHash('sha256').update(rawBody).digest('hex');
}

/**
 * One event, in the shape `applyEvent` takes: a verified webhook delivery parsed by
 * `parseCalcomEvent`, or one the reconciliation synthesized from Cal.com's API
 * (`meetings/reconcile.ts`). Exported for that second producer only.
 */
export interface ParsedEvent {
  readonly trigger: string;
  readonly createdAt: string | null;
  readonly uid: string | null;
  readonly rescheduleUid: string | null;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly organizerEmail: string | null;
  readonly attendeeEmail: string | null;
  /** For `BOOKING_NO_SHOW_UPDATED`: whether any attendee is marked a no-show. */
  readonly noShow: boolean | null;
  /** Lane M2 (0040): the booking's title, attendee name, notes, answers and location. */
  readonly details?: BookingDetails | null;
}

const UID = /^[A-Za-z0-9_-]{1,128}$/u;

const record = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const text = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);
const uidOf = (value: unknown): string | null => {
  const candidate = text(value);
  return candidate !== null && UID.test(candidate) ? candidate : null;
};
const instantOf = (value: unknown): string | null => {
  const candidate = text(value);
  if (candidate === null) return null;
  const parsed = Date.parse(candidate);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};
/** `meetings/attendee.ts`: the spelling the suppression canonicalizer normalizes to. */
const emailOf = (value: unknown): string | null => attendeeAddressOf(value);

/**
 * Cal.com's two shapes. Booking events nest the booking under `payload` and date the
 * delivery with the top-level `createdAt`. `MEETING_STARTED` and `MEETING_ENDED` are
 * **flat** — the booking's fields are at the top level (Cal.com's webhook reference,
 * "Unlike other events, MEETING_ENDED uses a flat payload structure") — and their
 * `createdAt` is the *booking's* creation, not the event's. Their instant is the one
 * they fire at, the scheduled `endTime` (`startTime` for a start), falling back to
 * `updatedAt`; ordering a meeting's end by when it was booked would make every end
 * stale behind the booking's own events.
 */
const FLAT_TRIGGERS: readonly string[] = ['MEETING_ENDED', 'MEETING_STARTED'];

export function parseCalcomEvent(body: unknown): ParsedEvent {
  const top = record(body);
  const trigger = text(top['triggerEvent']) ?? 'UNKNOWN';
  const flat = FLAT_TRIGGERS.includes(trigger) && typeof top['payload'] !== 'object';
  const payload = flat ? top : record(top['payload']);
  const createdAt = flat
    ? (instantOf(trigger === 'MEETING_STARTED' ? top['startTime'] : top['endTime']) ?? instantOf(top['updatedAt']))
    : instantOf(top['createdAt']);
  const attendees = Array.isArray(payload['attendees']) ? (payload['attendees'] as unknown[]) : [];
  const firstAttendee = record(attendees[0]);
  const noShowFlags = attendees.map(entry => record(entry)['noShow']).filter(flag => typeof flag === 'boolean');
  return {
    trigger,
    createdAt,
    uid: uidOf(payload['uid']) ?? uidOf(payload['bookingUid']),
    rescheduleUid: uidOf(payload['rescheduleUid']),
    startsAt: instantOf(payload['startTime']),
    endsAt: instantOf(payload['endTime']),
    organizerEmail: emailOf(record(payload['organizer'])['email']) ?? (flat ? emailOf(record(payload['user'])['email']) : null),
    attendeeEmail: emailOf(firstAttendee['email']),
    noShow: noShowFlags.length === 0 ? null : noShowFlags.some(flag => flag === true),
    details: parseWebhookBookingDetails(payload),
  };
}

export interface MeetingRow {
  readonly id: string;
  readonly firm_id: string | null;
  readonly contact_id: string | null;
  readonly opportunity_id: string | null;
  readonly state: MeetingState;
  readonly state_before_no_show: MeetingState | null;
  /** Lane M1, 0039: how attendance was confirmed; null while unconfirmed. */
  readonly attendance_source: MeetingAttendanceSource | null;
  readonly attendance_confirmed_at: Date | null;
  readonly attendance_confirmed_by: string | null;
  /**
   * Lane M1, 0039: Cal.com flagged the attendee absent before the start. Applied as
   * `no_show` once the start has passed (`applyPendingAbsence`), unless a person confirmed.
   */
  readonly calcom_absent_pending: boolean;
  readonly booking_uid: string;
  readonly current_booking_uid: string;
  readonly starts_at: Date;
  readonly ends_at: Date;
  readonly last_event_at: Date;
  readonly attendee_email: string | null;
  /** Lane M2, 0040: what the booking says besides its times (`bookingDetails.ts`). */
  readonly event_title: string | null;
  readonly attendee_name: string | null;
  readonly booking_notes: string | null;
  readonly booking_answers: Readonly<Record<string, string>> | null;
  readonly location_type: string | null;
  readonly video_call_url: string | null;
  readonly zoom_meeting_id: string | null;
  /** Lane M2, review M2R: the source time of what set the details; null when there are none. */
  readonly details_observed_at: Date | null;
  readonly [column: string]: unknown;
}

export const MEETING_COLUMNS =
  'id, firm_id, contact_id, opportunity_id, state, state_before_no_show, attendance_source, attendance_confirmed_at, attendance_confirmed_by, calcom_absent_pending, booking_uid, current_booking_uid, starts_at, ends_at, last_event_at, attendee_email, ' +
  'event_title, attendee_name, booking_notes, booking_answers, location_type, video_call_url, zoom_meeting_id, details_observed_at';

/**
 * A meeting's confirmation (lane M1, 0039): `held` (by a person or a recording) or
 * `no_show` (by a person or Cal.com's flag). Cal.com's time events — the scheduled end, a
 * reschedule, a cancellation — never overwrite one, and no fold of duplicate rows erases one.
 */
export function isConfirmed(row: Pick<MeetingRow, 'state'>): boolean {
  return row.state === 'held' || row.state === 'no_show';
}

/** What a write leaves in the three attendance columns. All null: unconfirmed. */
export interface Attendance {
  readonly source: MeetingAttendanceSource | null;
  readonly at: string | null;
  readonly by: string | null;
}

export const UNCONFIRMED: Attendance = Object.freeze({ source: null, at: null, by: null });

export function attendanceOf(row: Pick<MeetingRow, 'attendance_source' | 'attendance_confirmed_at' | 'attendance_confirmed_by'>): Attendance {
  return {
    source: row.attendance_source,
    at: row.attendance_confirmed_at === null ? null : row.attendance_confirmed_at.toISOString(),
    by: row.attendance_confirmed_by,
  };
}

/** A state a write leaves, with what it remembers before a no-show and its attendance. */
export interface MeetingStateWrite {
  readonly state: MeetingState;
  readonly before: MeetingState | null;
  readonly attendance: Attendance;
}

/**
 * The state rows that are one meeting end with (lane M1): a confirmation among them, when
 * any is confirmed — newest-row-wins must not erase a confirmation — else `base`, which the
 * caller took from the newest row or the event. A person's confirmation beats any other,
 * whatever the timestamps (review M1R, finding 1): Cal.com's flag never overrides what a
 * person said. Between two of the same kind, the newest wins.
 */
export function keepConfirmation(base: MeetingStateWrite, rows: readonly MeetingRow[]): MeetingStateWrite {
  const byPerson = (row: MeetingRow): number => (row.attendance_source === 'manual' ? 1 : 0);
  const confirmed = rows
    .filter(isConfirmed)
    .sort(
      (left, right) =>
        byPerson(right) - byPerson(left) ||
        (right.attendance_confirmed_at?.getTime() ?? 0) - (left.attendance_confirmed_at?.getTime() ?? 0),
    )[0];
  if (confirmed === undefined) return base;
  return { state: confirmed.state, before: confirmed.state_before_no_show, attendance: attendanceOf(confirmed) };
}

/** A row's own state as a write, its attendance kept only when it is a confirmation. */
function stateOf(row: MeetingRow): MeetingStateWrite {
  return { state: row.state, before: row.state_before_no_show, attendance: isConfirmed(row) ? attendanceOf(row) : UNCONFIRMED };
}

/**
 * Whether rows that look like one meeting are booked by different people (slice M1,
 * review fold 3, finding 7). Compared in the one canonical form (`meetings/attendee.ts`);
 * a row with no attendee conflicts with nobody. Rows with two attendees are never folded:
 * a fold keeps one attendee, and the other would then be on no row a deletion measures.
 */
export function attendeesConflict(rows: readonly Pick<MeetingRow, 'attendee_email'>[]): boolean {
  const keys = new Set<string>();
  for (const row of rows) {
    if (row.attendee_email === null) continue;
    keys.add(attendeeAddressOf(row.attendee_email) ?? row.attendee_email.normalize('NFKC').trim().toLowerCase());
  }
  return keys.size > 1;
}

/**
 * Whether rows that look like one meeting must not be folded (lane M1, review M1F): two
 * attendees, or two different firms. A fold keeps the firm association of whichever row
 * has one; two rows matched to different firms are a person's to decide, on the attendee
 * conflict's path (`openAttendeeConflict`).
 */
export function foldConflict(rows: readonly Pick<MeetingRow, 'attendee_email' | 'firm_id'>[]): 'attendee_conflict' | 'firm_conflict' | null {
  if (attendeesConflict(rows)) return 'attendee_conflict';
  const firms = new Set(rows.map(row => row.firm_id).filter(firm => firm !== null));
  return firms.size > 1 ? 'firm_conflict' : null;
}

/** The attendee a fold's survivor ends with: its own, else the first folded row's. */
function attendeeAfterFold(survivor: MeetingRow, others: readonly MeetingRow[]): string | null {
  return survivor.attendee_email ?? others.find(row => row.attendee_email !== null)?.attendee_email ?? null;
}

/** 0028's bound on a review item's `detail` (`stage_review_items_detail_bounded`). */
const REVIEW_DETAIL_MAX = 2000;

/**
 * Rows that should be one meeting but name different attendees: nothing is folded. Each
 * row keeps its own uids, and a person is asked (review fold 3, finding 7).
 *
 * The review item's evidence is `meeting.attendee_conflict`. Its `evidence_id` is `c`
 * and the sha256 of the sorted meeting ids — one item per membership, whatever its size
 * (`evidence_id` holds 200 characters). Its `detail` is the **complete** membership and
 * nothing else: `meetingIds`, every id, comma-separated (review fold 4). A deletion that
 * takes any member finds the item by that list (`retention/deletion.ts`). A membership
 * whose list does not fit 0028's 2,000-character detail is not recorded: the rows are
 * still left apart, the answer is `false`, and the caller counts it — never a throw
 * that would roll back a whole reconciliation. (A reconciliation's chain names at most
 * 51 uids, and 51 ids fit, so this is a bound, not a path.)
 *
 * `stage_review_items_reason_known` (0028) admits no reason of its own, so its reason
 * is `firm_ambiguous` — which booking is whose cannot be decided. It is not a
 * `meeting.booked` item, so "Bookings to match" does not list it.
 */
export async function openAttendeeConflict(
  context: RepositoryContext,
  rows: readonly MeetingRow[],
  reason: 'attendee_conflict' | 'firm_conflict' = 'attendee_conflict',
): Promise<boolean> {
  const ids = [...new Set(rows.map(row => row.id))].sort();
  const detail = { meetingIds: ids.join(',') };
  if (JSON.stringify(detail).length > REVIEW_DETAIL_MAX) return false;
  await openReviewItem(
    context,
    {
      evidenceKind: 'meeting.attendee_conflict',
      evidenceId: `c${createHash('sha256').update(ids.join(',')).digest('hex')}`,
      detail,
    },
    'firm_ambiguous',
    { firmId: null, opportunityId: null },
  );
  await recordCrmAuditEvent(context, {
    action: 'meeting.fold_refused',
    subjectKind: 'meeting',
    subjectId: ids[0] ?? '',
    detail: { members: ids.length, reason },
  });
  return true;
}

/**
 * The meeting a booking uid belongs to, locked. Through `meeting_booking_uids` (0029,
 * slice M1): every uid a meeting has been — the original, every intermediate of a
 * reschedule chain, the current one — resolves to it. The two uid columns are the
 * fallback for a row written before its aliases (none, after 0029's backfill).
 */
async function meetingByUid(context: RepositoryContext, uid: string): Promise<MeetingRow | null> {
  const { rows: aliased } = await context.db.query<MeetingRow>(
    `SELECT ${MEETING_COLUMNS.split(', ').map(column => `m.${column}`).join(', ')}
       FROM meeting_booking_uids a
       JOIN meetings m ON m.workspace_id = a.workspace_id AND m.id = a.meeting_id
      WHERE a.workspace_id = $1 AND a.booking_uid = $2
      FOR UPDATE OF m`,
    [context.scope.workspaceId, uid],
  );
  if (aliased[0] !== undefined) return aliased[0];
  const { rows } = await context.db.query<MeetingRow>(
    `SELECT ${MEETING_COLUMNS} FROM meetings
      WHERE workspace_id = $1 AND (booking_uid = $2 OR current_booking_uid = $2)
      ORDER BY (booking_uid = $2) DESC LIMIT 1 FOR UPDATE`,
    [context.scope.workspaceId, uid],
  );
  return rows[0] ?? null;
}

/**
 * Record uids as the meeting's (0029). A uid that is already some meeting's is left
 * where it is: the fold that joins two meetings moves aliases explicitly
 * (`foldMeetings`), and nothing else may take one from a meeting.
 */
export async function aliasMeeting(context: RepositoryContext, meetingId: string, uids: readonly (string | null)[]): Promise<void> {
  const known = [...new Set(uids.filter((uid): uid is string => uid !== null))];
  if (known.length === 0) return;
  await context.db.query(
    `INSERT INTO meeting_booking_uids (workspace_id, booking_uid, meeting_id)
     SELECT $1, uid, $2 FROM unnest($3::text[]) AS uid
     ON CONFLICT (workspace_id, booking_uid) DO NOTHING`,
    [context.scope.workspaceId, meetingId, known],
  );
}

/**
 * Who the booking is with: the attendee's e-mail on a contact, else the attendee's
 * domain on exactly one firm's website. Ambiguity is never resolved by a guess.
 */
export async function matchAttendee(
  context: RepositoryContext,
  attendeeEmail: string | null,
): Promise<
  | { readonly kind: 'matched'; readonly firmId: string; readonly contactId: string | null }
  | { readonly kind: 'unmatched' | 'ambiguous' }
> {
  if (attendeeEmail === null) return { kind: 'unmatched' };
  const { rows: byAddress } = await context.db.query<{ firm_id: string; contact_id: string | null }>(
    `SELECT DISTINCT a.firm_id, a.contact_id FROM email_addresses a
       JOIN firms f ON f.workspace_id = a.workspace_id AND f.id = a.firm_id AND f.status = 'active'
      WHERE a.workspace_id = $1 AND a.address = $2 AND a.eligibility <> 'retired'`,
    [context.scope.workspaceId, attendeeEmail],
  );
  const firms = new Set(byAddress.map(row => row.firm_id));
  if (firms.size === 1) {
    const contacts = [...new Set(byAddress.map(row => row.contact_id).filter((id): id is string => id !== null))];
    return { kind: 'matched', firmId: byAddress[0]?.firm_id ?? '', contactId: contacts.length === 1 ? (contacts[0] ?? null) : null };
  }
  if (firms.size > 1) return { kind: 'ambiguous' };

  const domain = attendeeEmail.split('@')[1] ?? '';
  if (domain.length === 0) return { kind: 'unmatched' };
  const { rows: byDomain } = await context.db.query<{ id: string }>(
    `SELECT id FROM firms
      WHERE workspace_id = $1 AND status = 'active' AND website IS NOT NULL
        AND lower(regexp_replace(substring(website FROM '^https?://([^/:?#]+)'), '^www\\.', '')) = $2
      LIMIT 2`,
    [context.scope.workspaceId, domain.replace(/^www\./u, '')],
  );
  if (byDomain.length === 1) return { kind: 'matched', firmId: byDomain[0]?.id ?? '', contactId: null };
  return { kind: byDomain.length > 1 ? 'ambiguous' : 'unmatched' };
}

/**
 * Receive one verified delivery. The caller runs it in one transaction.
 */
export async function receiveCalcomEvent(
  db: Queryable,
  input: { readonly workspaceId: string; readonly rawBody: Buffer; readonly body: unknown },
): Promise<CalcomReceipt> {
  const context = repositoryContext(workspaceScope(input.workspaceId, { kind: 'system', component: 'worker' }), db);
  await lockSendGateForStopFact(context);

  const eventId = calcomEventIdOf(input.rawBody);
  const parsed = parseCalcomEvent(input.body);
  return await recordAndApply(context, eventId, parsed);
}

/**
 * Receive one event the reconciliation synthesized from Cal.com's bookings API (slice
 * M1, `meetings/reconcile.ts`). The same record-then-apply as a webhook delivery, under
 * the same send-gate lock taken first: the delivery id is the caller's deterministic
 * one (so a replayed run is a duplicate), and the event's `createdAt` is the booking's
 * own `updatedAt`, so a webhook newer than what the API said stays authoritative through
 * `applyEvent`'s ordering. The caller runs it in one transaction.
 */
export async function receiveSynthesizedCalcomEvent(
  db: Queryable,
  input: { readonly workspaceId: string; readonly eventId: string; readonly event: ParsedEvent },
): Promise<CalcomReceipt> {
  if (!/^[0-9a-f]{64}$/u.test(input.eventId)) throw new Error('a synthesized Cal.com event id is a sha256 in hex');
  const context = repositoryContext(workspaceScope(input.workspaceId, { kind: 'system', component: 'worker' }), db);
  await lockSendGateForStopFact(context);
  return await recordAndApply(context, input.eventId, input.event);
}

/** Booking writers take firm locks before meeting rows, matching analysis/task writers. */
export async function lockMeetingFirmsForUids(context: RepositoryContext, uids: readonly string[]): Promise<void> {
  await lockTodayForFirmChange(context);
  await context.db.query(`SELECT f.id FROM firms f WHERE f.workspace_id=$1 AND f.id IN (
    SELECT m.firm_id FROM meetings m WHERE m.workspace_id=$1 AND
      (m.booking_uid=ANY($2::text[]) OR m.current_booking_uid=ANY($2::text[]) OR m.id IN
        (SELECT a.meeting_id FROM meeting_booking_uids a WHERE a.workspace_id=$1 AND a.booking_uid=ANY($2::text[])))) ORDER BY f.id FOR UPDATE`, [context.scope.workspaceId, [...uids]]);
}

/** Dedupe on the delivery id, apply, and record the outcome. The send gate is held. */
async function recordAndApply(context: RepositoryContext, eventId: string, parsed: ParsedEvent): Promise<CalcomReceipt> {
  await lockMeetingFirmsForUids(context, [parsed.uid, parsed.rescheduleUid].filter((uid): uid is string => uid !== null));
  const db = context.db;
  const workspaceId = context.scope.workspaceId;
  const trigger = /^[A-Z][A-Z_]{1,63}$/u.test(parsed.trigger) ? parsed.trigger : 'UNKNOWN';
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO calcom_events (workspace_id, event_id, trigger_event, booking_uid, payload_created_at, outcome)
     VALUES ($1, $2, $3, $4, $5::timestamptz, 'ignored')
     ON CONFLICT ON CONSTRAINT calcom_events_once DO NOTHING
     RETURNING id`,
    [workspaceId, eventId, trigger, parsed.uid, parsed.createdAt],
  );
  const rowId = inserted.rows[0]?.id;
  if (rowId === undefined) {
    return { duplicate: true, eventId, outcome: null, meetingId: null, meetingState: null };
  }

  const applied = await applyEvent(context, trigger, parsed);
  await db.query('UPDATE calcom_events SET outcome = $3, meeting_id = $4 WHERE workspace_id = $1 AND id = $2', [
    workspaceId,
    rowId,
    applied.outcome,
    applied.meetingId,
  ]);
  await recordCrmAuditEvent(context, {
    action: 'meeting.event_received',
    subjectKind: 'calcom_event',
    subjectId: rowId,
    detail: { trigger, outcome: applied.outcome, meetingId: applied.meetingId, state: applied.meetingState },
  });
  return { duplicate: false, eventId, ...applied };
}

async function applyEvent(
  context: RepositoryContext,
  trigger: string,
  event: ParsedEvent,
): Promise<Omit<CalcomReceipt, 'duplicate' | 'eventId'>> {
  const none = (outcome: CalcomEventOutcome, meeting: MeetingRow | null = null): Omit<CalcomReceipt, 'duplicate' | 'eventId'> => ({
    outcome,
    meetingId: meeting?.id ?? null,
    meetingState: meeting?.state ?? null,
  });
  if (!(CALCOM_APPLIED_TRIGGERS as readonly string[]).includes(trigger)) return none('ignored');
  const kind = trigger as CalcomAppliedTrigger;
  if (event.createdAt === null) return none('malformed');

  const lookupUid = kind === 'BOOKING_RESCHEDULED' ? (event.rescheduleUid ?? event.uid) : event.uid;
  if (lookupUid === null) return none('malformed');
  let existing = await meetingByUid(context, lookupUid);

  // Both uids of a reschedule are resolved before anything else (review fold 2, the
  // partial half of finding 7). When the original was never ingested but the
  // replacement already has a row — its cancellation arrived first — that row *is* the
  // meeting, and the ordering below decides whether the reschedule still changes it.
  let adoptOriginal = false;
  if (existing === null && kind === 'BOOKING_RESCHEDULED' && event.uid !== null && event.uid !== lookupUid) {
    const replacement = await meetingByUid(context, event.uid);
    if (replacement !== null) {
      existing = replacement;
      // The row takes the original's uid as the one it began as only when it has no
      // established original of its own: it was created from an event about the
      // replacement itself (`booking_uid` is the replacement's uid). A row found through
      // `current_booking_uid` already knows where it began — A→B, B→C, cancel C, then a
      // B→C replay with new bytes must not rename A to B (review fold 3).
      adoptOriginal = replacement.booking_uid === event.uid;
    }
  }

  if (existing !== null) {
    // Ordered by the payload's own timestamp; an older event is history, not state.
    const stale = Date.parse(event.createdAt) < existing.last_event_at.getTime() || existing.state === 'cancelled';
    // The one identity write, after the staleness decision. It is made for a stale
    // reschedule too, and only for a row with no established original: "B replaced A"
    // is a fact whatever the order of delivery, and without it a late event about A
    // would book a second meeting (the fold 2 adoption test).
    if (adoptOriginal) {
      const { rows: adopted } = await context.db.query<MeetingRow>(
        `UPDATE meetings SET booking_uid = $3, updated_at = now()
          WHERE workspace_id = $1 AND id = $2 AND booking_uid = $4
          RETURNING ${MEETING_COLUMNS}`,
        [context.scope.workspaceId, existing.id, lookupUid, event.uid],
      );
      existing = adopted[0] ?? existing;
    }
    // Whatever the order of delivery, the uids a reschedule names belong to this
    // meeting from now on (0029): a late event about either finds it.
    if (kind === 'BOOKING_RESCHEDULED') await aliasMeeting(context, existing.id, [lookupUid, event.uid]);
    if (stale) {
      // A deferred absence does not wait on the order of delivery (review M1F, finding 2).
      return none('stale', (await applyPendingAbsence(context, existing)) ?? existing);
    }
  }

  // ---- no meeting yet -----------------------------------------------------
  if (existing === null) {
    if (kind === 'MEETING_ENDED' || kind === 'BOOKING_NO_SHOW_UPDATED') return none('unmatched');
    if (event.startsAt === null || event.endsAt === null) return none('malformed');
    const state: MeetingState =
      kind === 'BOOKING_CANCELLED' ? 'cancelled' : kind === 'BOOKING_RESCHEDULED' ? 'rescheduled' : 'booked';
    const match = await matchAttendee(context, event.attendeeEmail);
    const firmId = match.kind === 'matched' ? match.firmId : null;
    const contactId = match.kind === 'matched' ? match.contactId : null;
    const { rows } = await context.db.query<MeetingRow>(
      `INSERT INTO meetings (workspace_id, booking_uid, current_booking_uid, firm_id, contact_id, state, starts_at, ends_at,
                             organizer_email, attendee_email, last_event_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, GREATEST($8::timestamptz, $7::timestamptz), $9, $10, $11::timestamptz)
       RETURNING ${MEETING_COLUMNS}`,
      [
        context.scope.workspaceId,
        lookupUid,
        event.uid ?? lookupUid,
        firmId,
        contactId,
        state,
        event.startsAt,
        event.endsAt,
        event.organizerEmail,
        event.attendeeEmail,
        event.createdAt,
      ],
    );
    const inserted = rows[0];
    if (inserted === undefined) throw new Error('the meeting insert returned no row');
    const meeting = (await writeBookingDetails(context, inserted.id, event.details ?? null, event.createdAt)) ?? inserted;
    await aliasMeeting(context, meeting.id, [lookupUid, event.uid]);
    if (firmId === null) {
      await openReviewItem(
        context,
        { evidenceKind: 'meeting.booked', evidenceId: meeting.id, detail: { bookingUid: lookupUid } },
        match.kind === 'ambiguous' ? 'firm_ambiguous' : 'firm_unmatched',
        { firmId: null, opportunityId: null },
      );
      return { outcome: 'unmatched', meetingId: meeting.id, meetingState: meeting.state };
    }
    if (state !== 'cancelled') await applyBooked(context, meeting);
    return { outcome: 'applied', meetingId: meeting.id, meetingState: state };
  }

  // ---- an existing meeting ------------------------------------------------
  // Lane M1: the scheduled end is `ended`, never `held`; and no Cal.com time event — the
  // end, a reschedule, a cancellation — overwrites a confirmation (`held`, `no_show`). A
  // reschedule moves `booked`, `rescheduled` and `ended` to `rescheduled`, the reconciliation's
  // rule too (`reconcile.ts`), and its times move either way.
  const confirmed = isConfirmed(existing);
  const kept: MeetingStateWrite = stateOf(existing);
  // An event about the meeting's current booking that carries that booking's times sets
  // them, whatever its trigger (review fold 4). A meeting moved to a booking whose body
  // was never read — the reconciliation's link to an unlisted successor keeps the old
  // booking's times — takes the new booking's times from its first event, a cancellation
  // included, before the state it applies. The ordering above has already let it apply.
  const aboutCurrent = event.uid !== null && event.uid === existing.current_booking_uid && event.startsAt !== null && event.endsAt !== null;
  const timesChange = kind === 'BOOKING_RESCHEDULED' || kind === 'BOOKING_CREATED' || aboutCurrent;
  // The start this same write leaves, which is the one a no-show is judged by (review M1F,
  // finding 3): stored times may still be a predecessor's.
  const effectiveStart = timesChange && event.startsAt !== null ? event.startsAt : existing.starts_at.toISOString();
  let next: MeetingStateWrite | null = null;
  // Cal.com's absence flagged before the start (review M1F, finding 2): kept until the start
  // has passed. A reschedule, a cancellation and Cal.com's unmark clear it.
  let pending = existing.calcom_absent_pending;
  let deferred = false;
  switch (kind) {
    case 'BOOKING_CREATED':
      // A create after the meeting exists (a redelivery with new bytes): times only.
      next = kept;
      break;
    case 'BOOKING_RESCHEDULED':
      next = confirmed ? kept : { state: 'rescheduled', before: null, attendance: UNCONFIRMED };
      pending = false;
      break;
    case 'BOOKING_CANCELLED':
      next = confirmed ? null : { state: 'cancelled', before: null, attendance: UNCONFIRMED };
      pending = false;
      break;
    case 'MEETING_ENDED':
      next = existing.state === 'booked' || existing.state === 'rescheduled' ? { state: 'ended', before: null, attendance: UNCONFIRMED } : null;
      break;
    case 'BOOKING_NO_SHOW_UPDATED':
      // Cal.com's flag is a confirmation of absence over an unconfirmed meeting; it never
      // replaces a confirmation, and its unmark undoes only its own mark. A mark before the
      // meeting's start (judged by the start this write leaves) is not yet a fact: it is
      // kept as `calcom_absent_pending` and nothing else changes (review M1R finding 7,
      // M1F findings 2 and 3); the next delivery or reconciliation after the start applies it.
      if (event.noShow === true && !confirmed && !(await hasStarted(context, effectiveStart))) {
        next = kept;
        pending = true;
        deferred = true;
      } else if (event.noShow === true && !confirmed) {
        next = { state: 'no_show', before: existing.state, attendance: { source: 'calcom_no_show', at: event.createdAt, by: null } };
        pending = false;
      } else if (event.noShow === false) {
        if (existing.state === 'no_show' && existing.attendance_source === 'calcom_no_show') {
          next = { state: existing.state_before_no_show ?? 'booked', before: null, attendance: UNCONFIRMED };
        } else if (pending) {
          next = kept;
        }
        pending = false;
      }
      break;
  }
  if (next === null) {
    await touch(context, existing.id, event.createdAt);
    if (aboutCurrent) await writeBookingDetails(context, existing.id, event.details ?? null, event.createdAt);
    return none('applied', (await applyPendingAbsence(context, existing)) ?? existing);
  }
  // A reschedule whose replacement uid already has a row of its own: an event about the
  // new booking (its cancellation, say) arrived before the reschedule that names it.
  // Both uids are resolved before the ordering is applied (review fold 1, finding 7):
  // the replacement row is folded into this meeting, and its later state wins.
  // A deferred absence moves no ordering: a later delivery is still applied.
  let lastEventAt = deferred ? existing.last_event_at.toISOString() : event.createdAt;
  let startsAt = event.startsAt;
  let endsAt = event.endsAt;
  let currentUid = kind === 'BOOKING_RESCHEDULED' ? event.uid : null;
  let folded = false;
  if (kind === 'BOOKING_RESCHEDULED' && event.uid !== null && event.uid !== lookupUid) {
    const replacement = await meetingByUid(context, event.uid);
    if (replacement !== null && replacement.id !== existing.id) {
      // Two people: the rows stay apart, each with its own uids, and a person decides.
      // The reschedule changes neither (review fold 3, finding 7).
      // Two firms likewise (review M1F, finding 1).
      const conflict = foldConflict([existing, replacement]);
      if (conflict !== null) {
        await openAttendeeConflict(context, [existing, replacement], conflict);
        return none('unmatched', existing);
      }
      await foldReplacement(context, existing, replacement);
      folded = true;
      if (replacement.last_event_at.getTime() > Date.parse(event.createdAt)) {
        // The replacement's row is newer than this reschedule: it may itself have been
        // rescheduled on (B→C before the delayed A→B, review fold 2). Its state, its
        // current uid and its times are the meeting's now; this event only joins the
        // two rows.
        next = stateOf(replacement);
        lastEventAt = replacement.last_event_at.toISOString();
        startsAt = replacement.starts_at.toISOString();
        endsAt = replacement.ends_at.toISOString();
        currentUid = replacement.current_booking_uid;
        pending = replacement.calcom_absent_pending;
      }
      // Whichever row was newer, a confirmation either row holds is the meeting's (lane M1).
      next = keepConfirmation(next, [existing, replacement]);
    }
  }
  const { rows } = await context.db.query<MeetingRow>(
    `UPDATE meetings
        SET state = $3, state_before_no_show = $4,
            attendance_source = $10, attendance_confirmed_at = $11::timestamptz, attendance_confirmed_by = $12::uuid,
            starts_at = CASE WHEN $5::boolean AND $6::timestamptz IS NOT NULL THEN $6::timestamptz ELSE starts_at END,
            ends_at = CASE WHEN $5::boolean AND $7::timestamptz IS NOT NULL THEN GREATEST($7::timestamptz, COALESCE($6::timestamptz, starts_at)) ELSE ends_at END,
            current_booking_uid = CASE WHEN $5::boolean AND $8::text IS NOT NULL THEN $8::text ELSE current_booking_uid END,
            last_event_at = GREATEST(last_event_at, $9::timestamptz),
            calcom_absent_pending = $13::boolean AND $3 IN ('booked', 'rescheduled', 'ended'), updated_at = now()
      WHERE workspace_id = $1 AND id = $2
      RETURNING ${MEETING_COLUMNS}`,
    [
      context.scope.workspaceId,
      existing.id,
      next.state,
      next.before,
      timesChange,
      startsAt,
      endsAt,
      currentUid,
      lastEventAt,
      next.attendance.source,
      next.attendance.at,
      next.attendance.by,
      pending,
    ],
  );
  // The booking's details follow its current booking (lane M2): a reschedule's are the new
  // booking's, and any event about the current booking refreshes them.
  // By the event's own time (review M2R, finding 2): a delayed reschedule only fills what a
  // newer delivery of the replacement left empty.
  const detailed = kind === 'BOOKING_RESCHEDULED' || aboutCurrent ? await writeBookingDetails(context, existing.id, event.details ?? null, event.createdAt) : null;
  const written = detailed ?? rows[0] ?? existing;
  // Once the start has passed, a deferred absence is the meeting's state: an end becomes
  // `no_show` rather than `ended` (review M1F, finding 2).
  const updated = (await applyPendingAbsence(context, written)) ?? written;
  await aliasMeeting(context, updated.id, [updated.booking_uid, updated.current_booking_uid, event.uid]);
  // No new funnel fact from the event itself: `meeting.held` is written only when attendance
  // is confirmed (`meetings/attendance.ts`), which no Cal.com event does (lane M1). A fold
  // leaves exactly the facts the survivor's state owes (review M1R, finding 4).
  if (folded) await reconcileHeldFacts(context, updated);
  return { outcome: deferred ? 'ignored' : 'applied', meetingId: updated.id, meetingState: updated.state };
}

/**
 * Fold a replacement booking's early row into the meeting it replaces: its deliveries
 * point at the surviving meeting, its unresolved review item goes (the surviving meeting
 * is the one a person should see), and the row itself is removed so the surviving
 * meeting can take its uid as `current_booking_uid`.
 */
async function foldReplacement(context: RepositoryContext, survivor: MeetingRow, replacement: MeetingRow): Promise<void> {
  const workspaceId = context.scope.workspaceId;
  await context.db.query('UPDATE calcom_events SET meeting_id = $3 WHERE workspace_id = $1 AND meeting_id = $2', [
    workspaceId,
    replacement.id,
    survivor.id,
  ]);
  // Every uid the replacement had, before the row (and its cascade) goes (0029).
  await context.db.query('UPDATE meeting_booking_uids SET meeting_id = $3 WHERE workspace_id = $1 AND meeting_id = $2', [
    workspaceId,
    replacement.id,
    survivor.id,
  ]);
  // Lane M4: its uploaded recordings, likewise, before the row's cascade would take them (0041).
  await moveRecordingsToSurvivor(context, replacement.id, survivor.id);
  // The person who booked stays on a row (review fold 3, finding 7): the caller has
  // refused a fold of two different attendees, so this only fills an empty one. The firm
  // association likewise (review M1F, finding 1): a survivor with no firm takes the
  // replacement's firm, contact and opportunity — the caller has refused two different
  // firms — so the held fact the fold reconciles afterwards stays counted.
  await context.db.query(
    `UPDATE meetings
        SET attendee_email = COALESCE(attendee_email, $3),
            contact_id = CASE WHEN firm_id IS NULL THEN $5::uuid ELSE contact_id END,
            opportunity_id = CASE WHEN firm_id IS NULL THEN $6::uuid ELSE opportunity_id END,
            firm_id = COALESCE(firm_id, $4::uuid)
      WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, survivor.id, replacement.attendee_email, replacement.firm_id, replacement.contact_id, replacement.opportunity_id],
  );
  // The replacement is the meeting's booking from now on: its details, at the time they were
  // observed, meet the survivor's by the same freshness rule as any source.
  if (replacement.details_observed_at !== null) {
    await writeBookingDetails(context, survivor.id, bookingDetailsOfRow(replacement), replacement.details_observed_at.toISOString());
  }
  if (survivor.firm_id === null && replacement.firm_id !== null) {
    await context.db.query(
      `DELETE FROM stage_review_items
        WHERE workspace_id = $1 AND evidence_kind = 'meeting.booked' AND evidence_id = $2 AND resolved_at IS NULL
          AND reason IN ('firm_unmatched', 'firm_ambiguous')`,
      [workspaceId, survivor.id],
    );
  }
  await context.db.query(
    `DELETE FROM stage_review_items
      WHERE workspace_id = $1 AND evidence_kind = 'meeting.booked' AND evidence_id = $2 AND resolved_at IS NULL`,
    [workspaceId, replacement.id],
  );
  await foldMeetingOutcomes(context, { sourceMeetingId: replacement.id, targetMeetingId: survivor.id });
  await context.db.query('DELETE FROM meetings WHERE workspace_id = $1 AND id = $2', [workspaceId, replacement.id]);
  await recordCrmAuditEvent(context, {
    action: 'meeting.replacement_folded',
    subjectKind: 'meeting',
    subjectId: survivor.id,
    detail: { replacementBookingUid: replacement.booking_uid, replacementState: replacement.state },
  });
}

/**
 * Join several rows that turned out to be one meeting (Cal.com slice M1, review fold 2):
 * the reconciliation found a chain's uids resolving to more than one meeting — A booked,
 * the A→B webhook lost, B's cancellation webhook recorded B on a row of its own.
 *
 * W's fold rules, generalized: the survivor is the row the caller names (the one holding
 * the chain's oldest uid); every other row's deliveries **and aliases** move to it before
 * the row is removed, and its unresolved review item goes with it. The survivor takes the
 * newest row's state, times and current uid (the greatest `last_event_at`), and the
 * links of a matched row when it has none of its own. No alias is lost: they move first.
 * No attendee is lost either (review fold 3, finding 7): a survivor with none takes the
 * folded row's, and rows with two different attendees are refused here — the caller
 * checks `foldConflict` first and asks a person instead (`openAttendeeConflict`). Two
 * different firms are refused the same way (review M1F, finding 1).
 * The caller holds the send gate and has the rows locked.
 */
export async function foldMeetings(context: RepositoryContext, rows: readonly MeetingRow[], survivorId: string): Promise<MeetingRow> {
  const workspaceId = context.scope.workspaceId;
  const survivor = rows.find(row => row.id === survivorId);
  if (survivor === undefined) throw new Error('the fold names a survivor that is not one of its rows');
  const others = rows.filter(row => row.id !== survivorId);
  if (others.length === 0) return survivor;
  if (foldConflict(rows) !== null) throw new Error('a fold of meetings booked by different attendees or firms was attempted');
  const attendee = attendeeAfterFold(survivor, others);
  const newest = [...rows].sort((left, right) => right.last_event_at.getTime() - left.last_event_at.getTime())[0] ?? survivor;
  const linked = survivor.firm_id === null ? (others.find(row => row.firm_id !== null) ?? null) : null;
  // The newest row's state, unless any row holds a confirmation (lane M1): that is kept.
  const write = keepConfirmation(stateOf(newest), rows);
  if (linked !== null) await context.db.query('UPDATE meetings SET firm_id=$3,contact_id=$4,opportunity_id=$5 WHERE workspace_id=$1 AND id=$2', [workspaceId, survivor.id, linked.firm_id, linked.contact_id, linked.opportunity_id]);
  for (const other of others) {
    await context.db.query('UPDATE calcom_events SET meeting_id = $3 WHERE workspace_id = $1 AND meeting_id = $2', [workspaceId, other.id, survivor.id]);
    await context.db.query('UPDATE meeting_booking_uids SET meeting_id = $3 WHERE workspace_id = $1 AND meeting_id = $2', [
      workspaceId,
      other.id,
      survivor.id,
    ]);
    // Lane M4: its uploaded recordings go with the meeting they were of (0041).
    await moveRecordingsToSurvivor(context, other.id, survivor.id);
    await context.db.query(
      `DELETE FROM stage_review_items
        WHERE workspace_id = $1 AND evidence_kind = 'meeting.booked' AND evidence_id = $2 AND resolved_at IS NULL`,
      [workspaceId, other.id],
    );
    await foldMeetingOutcomes(context, { sourceMeetingId: other.id, targetMeetingId: survivor.id });
    await context.db.query('DELETE FROM meetings WHERE workspace_id = $1 AND id = $2', [workspaceId, other.id]);
  }
  const { rows: folded } = await context.db.query<MeetingRow>(
    `UPDATE meetings
        SET state = $3, state_before_no_show = $4,
            attendance_source = $13, attendance_confirmed_at = $14::timestamptz, attendance_confirmed_by = $15::uuid,
            starts_at = $5::timestamptz, ends_at = $6::timestamptz,
            current_booking_uid = $7, last_event_at = GREATEST(last_event_at, $8::timestamptz),
            firm_id = COALESCE(firm_id, $9::uuid), contact_id = CASE WHEN firm_id IS NULL THEN $10::uuid ELSE contact_id END,
            opportunity_id = CASE WHEN firm_id IS NULL THEN $11::uuid ELSE opportunity_id END,
            attendee_email = COALESCE(attendee_email, $12::text),
            calcom_absent_pending = $16::boolean AND $3 IN ('booked', 'rescheduled', 'ended'),
            updated_at = now()
      WHERE workspace_id = $1 AND id = $2
      RETURNING ${MEETING_COLUMNS}`,
    [
      workspaceId,
      survivor.id,
      write.state,
      write.before,
      newest.starts_at.toISOString(),
      newest.ends_at.toISOString(),
      newest.current_booking_uid,
      newest.last_event_at.toISOString(),
      linked?.firm_id ?? null,
      linked?.contact_id ?? null,
      linked?.opportunity_id ?? null,
      attendee,
      write.attendance.source,
      write.attendance.at,
      write.attendance.by,
      rows.some(row => row.calcom_absent_pending === true),
    ],
  );
  // The details: each from the row whose details were observed most recently, the next
  // where it has none (lane M2, review M2R) — never from a row only because it is newer.
  const observed = (row: MeetingRow): number => row.details_observed_at?.getTime() ?? -Infinity;
  const byObservation = [...rows].sort((left, right) => observed(right) - observed(left));
  const composed = composeBookingDetails(byObservation.map(bookingDetailsOfRow));
  const newestObservation = byObservation[0]?.details_observed_at ?? null;
  const result = (await storeBookingDetails(context, survivor.id, composed, newestObservation === null ? null : newestObservation.toISOString())) ?? folded[0] ?? survivor;
  if (linked !== null) {
    await context.db.query(
      `DELETE FROM stage_review_items
        WHERE workspace_id = $1 AND evidence_kind = 'meeting.booked' AND evidence_id = $2 AND resolved_at IS NULL
          AND reason IN ('firm_unmatched', 'firm_ambiguous')`,
      [workspaceId, survivor.id],
    );
  }
  await aliasMeeting(context, survivor.id, others.flatMap(other => [other.booking_uid, other.current_booking_uid]));
  // Every row's facts are the survivor's now: one `meeting.held` when it is held, none
  // otherwise, the extras withdrawn here (review M1R, finding 4).
  await reconcileHeldFacts(context, result);
  await recordCrmAuditEvent(context, {
    action: 'meeting.folded',
    subjectKind: 'meeting',
    subjectId: survivor.id,
    detail: { folded: others.length, state: result.state },
  });
  return result;
}

/** Whether a start has passed, by the database's clock (as `attendance.ts`). */
async function hasStarted(context: RepositoryContext, startsAt: string): Promise<boolean> {
  const { rows } = await context.db.query<{ started: boolean }>('SELECT $1::timestamptz <= now() AS started', [startsAt]);
  return rows[0]?.started === true;
}

/**
 * Apply a deferred Cal.com absence (review M1F, finding 2): a meeting with
 * `calcom_absent_pending`, unconfirmed, whose start has passed by the database's clock,
 * becomes `no_show` (source `calcom_no_show`, remembering the state it was in). Called after
 * every delivery to a known meeting and by every reconciliation run for a chain's meeting,
 * so it depends on no booking's freshness. Answers the written row, or null when there was
 * nothing to apply.
 */
export async function applyPendingAbsence(context: RepositoryContext, meeting: Pick<MeetingRow, 'id' | 'calcom_absent_pending'>): Promise<MeetingRow | null> {
  if (meeting.calcom_absent_pending !== true) return null;
  const { rows } = await context.db.query<MeetingRow>(
    `UPDATE meetings
        SET state = 'no_show', state_before_no_show = state,
            attendance_source = 'calcom_no_show', attendance_confirmed_at = now(), attendance_confirmed_by = NULL,
            calcom_absent_pending = false, updated_at = now()
      WHERE workspace_id = $1 AND id = $2 AND calcom_absent_pending
        AND state IN ('booked', 'rescheduled', 'ended') AND starts_at <= now()
      RETURNING ${MEETING_COLUMNS}`,
    [context.scope.workspaceId, meeting.id],
  );
  return rows[0] ?? null;
}

/** A row's stored details, as `BookingDetails`. */
export function bookingDetailsOfRow(row: MeetingRow): BookingDetails {
  return {
    title: row.event_title ?? null,
    attendeeName: row.attendee_name ?? null,
    notes: row.booking_notes ?? null,
    answers: row.booking_answers ?? null,
    locationType: row.location_type ?? null,
    videoCallUrl: row.video_call_url ?? null,
    zoomMeetingId: row.zoom_meeting_id ?? null,
    // A stored location was named by the source that set it: it travels as a whole.
    locationNamed: (row.location_type ?? row.video_call_url ?? row.zoom_meeting_id ?? null) !== null,
  };
}

/**
 * Each field from the first of `candidates` that has it; the three conferencing fields
 * together, from the first that has any (review M2R, finding 4: no Zoom id from one booking
 * beside another booking's location).
 */
function composeBookingDetails(candidates: readonly BookingDetails[]): BookingDetails {
  const first = <K extends keyof BookingDetails>(key: K): BookingDetails[K] =>
    candidates.find(candidate => candidate[key] !== null)?.[key] ?? NO_BOOKING_DETAILS[key];
  const located = candidates.find(candidate => candidate.locationType !== null || candidate.videoCallUrl !== null || candidate.zoomMeetingId !== null);
  return {
    title: first('title'),
    attendeeName: first('attendeeName'),
    notes: first('notes'),
    answers: first('answers'),
    locationType: located?.locationType ?? null,
    videoCallUrl: located?.videoCallUrl ?? null,
    zoomMeetingId: located?.zoomMeetingId ?? null,
    locationNamed: located !== undefined,
  };
}

/**
 * A source's booking details meet the meeting's (lane M2, 0040; review M2R): by
 * `mergeBookingDetails`, against the stored details and the source time that set them —
 * a source at least as new replaces, an older one only fills. `observedAt` is the source's
 * own time: the delivery's, or the reconciliation read's. Answers the written row, or null
 * when there was nothing to write.
 */
export async function writeBookingDetails(
  context: RepositoryContext,
  meetingId: string,
  details: BookingDetails | null,
  observedAt: string | null,
): Promise<MeetingRow | null> {
  if (details === null || detailsEmpty(details) || observedAt === null) return null;
  const { rows } = await context.db.query<MeetingRow>(`SELECT ${MEETING_COLUMNS} FROM meetings WHERE workspace_id = $1 AND id = $2 FOR UPDATE`, [
    context.scope.workspaceId,
    meetingId,
  ]);
  const row = rows[0];
  if (row === undefined) return null;
  const merged = mergeBookingDetails(
    { details: bookingDetailsOfRow(row), observedAt: row.details_observed_at === null ? null : row.details_observed_at.toISOString() },
    details,
    observedAt,
  );
  return await storeBookingDetails(context, meetingId, merged.details, merged.observedAt);
}

/** Write exactly these details and their source time. */
async function storeBookingDetails(
  context: RepositoryContext,
  meetingId: string,
  details: BookingDetails,
  observedAt: string | null,
): Promise<MeetingRow | null> {
  const empty = detailsEmpty({ ...details, locationNamed: false });
  const { rows } = await context.db.query<MeetingRow>(
    `UPDATE meetings
        SET event_title = $3, attendee_name = $4, booking_notes = $5, booking_answers = $6::jsonb, location_type = $7,
            video_call_url = $8, zoom_meeting_id = $9, details_observed_at = $10::timestamptz, updated_at = now()
      WHERE workspace_id = $1 AND id = $2
      RETURNING ${MEETING_COLUMNS}`,
    [
      context.scope.workspaceId,
      meetingId,
      details.title,
      details.attendeeName,
      details.notes,
      details.answers === null ? null : JSON.stringify(details.answers),
      details.locationType,
      details.videoCallUrl,
      details.zoomMeetingId,
      empty ? null : observedAt,
    ],
  );
  return rows[0] ?? null;
}

async function touch(context: RepositoryContext, meetingId: string, at: string): Promise<void> {
  await context.db.query(
    `UPDATE meetings SET last_event_at = GREATEST(last_event_at, $3::timestamptz), updated_at = now()
      WHERE workspace_id = $1 AND id = $2`,
    [context.scope.workspaceId, meetingId, at],
  );
}

/** The enrollment origins a booked demo ends. A follow-up is not one of them. */
export const BOOKING_STOPS_ORIGIN_KINDS: readonly string[] = Object.freeze(['prospecting', 'cold_legacy']);

/** What `applyBooked` reads of a meeting. */
export type BookedMeeting = Pick<MeetingRow, 'id' | 'firm_id' | 'booking_uid'>;

/**
 * A booked meeting with a firm: the link to its open deal, the stop, the funnel fact.
 *
 * **No stage changes here** (lane M1; David, 3 October 2026: deal-stage changes are
 * manual). A booking used to move the firm's deal to Demo booked, or open one there, through
 * `applyStageEvidence`; now the board and the firm page offer that move as one click
 * (`meetings/stageSuggestion.ts`) and a person makes it through the ordinary stage command.
 * The `meeting.booked` funnel fact is still written, and an unmatched booking still opens
 * its review item (`applyEvent`).
 *
 * Exported for the person's match of an unmatched booking (`meetings/match.ts`, slice
 * M1), which owes exactly what a matched webhook does. The caller holds the send gate.
 */
export async function applyBooked(context: RepositoryContext, meeting: BookedMeeting): Promise<void> {
  const firmId = meeting.firm_id ?? '';
  const opportunity = await readOpenOpportunity(context, firmId);
  if (opportunity !== null) {
    await context.db.query('UPDATE meetings SET opportunity_id = $3, updated_at = now() WHERE workspace_id = $1 AND id = $2', [
      context.scope.workspaceId,
      meeting.id,
      opportunity.id,
    ]);
    // Manual control, origin `engaged_call`. Its signal owes a stop to the firm's live
    // prospecting and cold_legacy enrollments only (review fold 1, finding 3): the
    // firm-wide snapshot 7.3 uses for every other cause would owe one to the agreed
    // follow-up too, and the terminal-stop drain would end it a minute later.
    await setManualControlMode(context, {
      opportunityId: opportunity.id,
      reason: 'meeting booked',
      origin: 'engaged_call',
      owedOriginKinds: BOOKING_STOPS_ORIGIN_KINDS,
    });
  }
  // Only prospecting stops, now, through the stop writer (the caller holds the send gate). An evidenced follow-up — the overview promised on the call —
  // is compatible with a booked demo and keeps running within its permission.
  const { rows: prospecting } = await context.db.query<{ id: string }>(
    `SELECT id FROM sequence_enrollments
      WHERE workspace_id = $1 AND firm_id = $2 AND ended_at IS NULL AND origin_kind = ANY($3::text[])
      ORDER BY id`,
    [context.scope.workspaceId, firmId, [...BOOKING_STOPS_ORIGIN_KINDS]],
  );
  if (prospecting.length > 0) {
    const stopped = await stopEnrollments(context, {
      enrollmentIds: prospecting.map(row => row.id),
      reason: manualModeEndReason('engaged_call'),
      cancelReason: 'terminal_stop',
    });
    await recordCrmAuditEvent(context, {
      action: 'enrollments.stopped_by_meeting',
      subjectKind: 'meeting',
      subjectId: meeting.id,
      detail: { firmId, enrollmentsStopped: stopped.enrollmentsStopped, executionsCancelled: stopped.executionsCancelled },
    });
  }
  await recordFunnelFact(context, {
    kind: 'meeting.booked',
    source: 'calendar',
    dedupeKey: meeting.booking_uid,
    firmId,
    ...(opportunity === null ? {} : { opportunityId: opportunity.id }),
  });
}

import { createHash } from 'node:crypto';
import { CALCOM_APPLIED_TRIGGERS, type CalcomAppliedTrigger, type MeetingState } from '@fss/contracts';
import type { Queryable } from '../db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../db/workspaceScope.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import { readOpenOpportunity, setManualControlMode } from '../crm/pipeline.ts';
import { applyStageEvidence, openReviewItem, type StageEvidenceOutcome } from '../crm/stageEvidence.ts';
import { recordFunnelFact } from '../funnel/facts.ts';
import { lockSendGateForStopFact } from '../policy/sendGate.ts';
import { stopEnrollments } from '../sequences/enrollments.ts';
import { attendeeAddressOf } from './attendee.ts';
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
 *   * **A booking** applies `meeting.booked` through `applyStageEvidence` (the pipeline
 *     move to Demo booked), stops conflicting prospecting at the firm through the
 *     existing stop writers — manual mode on the opportunity (`setManualControlMode`,
 *     origin `engaged_call`: a booked demo is a conversation) and `stopEnrollments` for
 *     every live **prospecting** enrollment there; an evidenced follow-up is compatible
 *     with a booking and keeps running — and records the funnel fact. The CRM sends no reminder: Cal.com owns those.
 *
 * Lock order: the send gate first, before any row, as every stop-fact writer takes it
 * (`policy/sendGate.ts`); then the meeting; then what `applyStageEvidence` locks.
 */

export type CalcomEventOutcome = 'applied' | 'stale' | 'ignored' | 'unmatched' | 'malformed';

export interface CalcomReceipt {
  readonly duplicate: boolean;
  readonly eventId: string;
  readonly outcome: CalcomEventOutcome | null;
  readonly meetingId: string | null;
  readonly meetingState: MeetingState | null;
  readonly stage: StageEvidenceOutcome | null;
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
  };
}

export interface MeetingRow {
  readonly id: string;
  readonly firm_id: string | null;
  readonly contact_id: string | null;
  readonly opportunity_id: string | null;
  readonly state: MeetingState;
  readonly state_before_no_show: MeetingState | null;
  readonly booking_uid: string;
  readonly current_booking_uid: string;
  readonly starts_at: Date;
  readonly ends_at: Date;
  readonly last_event_at: Date;
  readonly [column: string]: unknown;
}

export const MEETING_COLUMNS =
  'id, firm_id, contact_id, opportunity_id, state, state_before_no_show, booking_uid, current_booking_uid, starts_at, ends_at, last_event_at';

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

/** Dedupe on the delivery id, apply, and record the outcome. The send gate is held. */
async function recordAndApply(context: RepositoryContext, eventId: string, parsed: ParsedEvent): Promise<CalcomReceipt> {
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
    return { duplicate: true, eventId, outcome: null, meetingId: null, meetingState: null, stage: null };
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
    stage: null,
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
    if (stale) return none('stale', existing);
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
    const meeting = rows[0];
    if (meeting === undefined) throw new Error('the meeting insert returned no row');
    await aliasMeeting(context, meeting.id, [lookupUid, event.uid]);
    if (firmId === null) {
      await openReviewItem(
        context,
        { evidenceKind: 'meeting.booked', evidenceId: meeting.id, detail: { bookingUid: lookupUid } },
        match.kind === 'ambiguous' ? 'firm_ambiguous' : 'firm_unmatched',
        { firmId: null, opportunityId: null },
      );
      return { outcome: 'unmatched', meetingId: meeting.id, meetingState: meeting.state, stage: null };
    }
    const stage = state === 'cancelled' ? null : await applyBooked(context, meeting, event.createdAt);
    return { outcome: 'applied', meetingId: meeting.id, meetingState: state, stage };
  }

  // ---- an existing meeting ------------------------------------------------
  let next: { state: MeetingState; before: MeetingState | null } | null = null;
  switch (kind) {
    case 'BOOKING_CREATED':
      // A create after the meeting exists (a redelivery with new bytes): times only.
      next = { state: existing.state, before: existing.state_before_no_show };
      break;
    case 'BOOKING_RESCHEDULED':
      next = { state: 'rescheduled', before: null };
      break;
    case 'BOOKING_CANCELLED':
      next = { state: 'cancelled', before: null };
      break;
    case 'MEETING_ENDED':
      next = existing.state === 'no_show' ? null : { state: 'held', before: null };
      break;
    case 'BOOKING_NO_SHOW_UPDATED':
      if (event.noShow === true && existing.state !== 'no_show') next = { state: 'no_show', before: existing.state };
      else if (event.noShow === false && existing.state === 'no_show') {
        next = { state: existing.state_before_no_show ?? 'booked', before: null };
      }
      break;
  }
  if (next === null) {
    await touch(context, existing.id, event.createdAt);
    return none('applied', existing);
  }
  // A reschedule whose replacement uid already has a row of its own: an event about the
  // new booking (its cancellation, say) arrived before the reschedule that names it.
  // Both uids are resolved before the ordering is applied (review fold 1, finding 7):
  // the replacement row is folded into this meeting, and its later state wins.
  let lastEventAt = event.createdAt;
  let startsAt = event.startsAt;
  let endsAt = event.endsAt;
  let currentUid = kind === 'BOOKING_RESCHEDULED' ? event.uid : null;
  if (kind === 'BOOKING_RESCHEDULED' && event.uid !== null && event.uid !== lookupUid) {
    const replacement = await meetingByUid(context, event.uid);
    if (replacement !== null && replacement.id !== existing.id) {
      await foldReplacement(context, existing, replacement);
      if (replacement.last_event_at.getTime() > Date.parse(event.createdAt)) {
        // The replacement's row is newer than this reschedule: it may itself have been
        // rescheduled on (B→C before the delayed A→B, review fold 2). Its state, its
        // current uid and its times are the meeting's now; this event only joins the
        // two rows.
        next = { state: replacement.state, before: replacement.state_before_no_show };
        lastEventAt = replacement.last_event_at.toISOString();
        startsAt = replacement.starts_at.toISOString();
        endsAt = replacement.ends_at.toISOString();
        currentUid = replacement.current_booking_uid;
      }
    }
  }
  const timesChange = kind === 'BOOKING_RESCHEDULED' || kind === 'BOOKING_CREATED';
  const { rows } = await context.db.query<MeetingRow>(
    `UPDATE meetings
        SET state = $3, state_before_no_show = $4,
            starts_at = CASE WHEN $5::boolean AND $6::timestamptz IS NOT NULL THEN $6::timestamptz ELSE starts_at END,
            ends_at = CASE WHEN $5::boolean AND $7::timestamptz IS NOT NULL THEN GREATEST($7::timestamptz, COALESCE($6::timestamptz, starts_at)) ELSE ends_at END,
            current_booking_uid = CASE WHEN $5::boolean AND $8::text IS NOT NULL THEN $8::text ELSE current_booking_uid END,
            last_event_at = GREATEST(last_event_at, $9::timestamptz), updated_at = now()
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
    ],
  );
  const updated = rows[0] ?? existing;
  await aliasMeeting(context, updated.id, [updated.booking_uid, updated.current_booking_uid, event.uid]);
  if (next.state === 'held' && existing.state !== 'held' && updated.firm_id !== null) {
    await recordFunnelFact(context, {
      kind: 'meeting.held',
      source: 'calendar',
      dedupeKey: updated.booking_uid,
      firmId: updated.firm_id,
    });
  }
  return { outcome: 'applied', meetingId: updated.id, meetingState: updated.state, stage: null };
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
  await context.db.query(
    `DELETE FROM stage_review_items
      WHERE workspace_id = $1 AND evidence_kind = 'meeting.booked' AND evidence_id = $2 AND resolved_at IS NULL`,
    [workspaceId, replacement.id],
  );
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
 * The caller holds the send gate and has the rows locked.
 */
export async function foldMeetings(context: RepositoryContext, rows: readonly MeetingRow[], survivorId: string): Promise<MeetingRow> {
  const workspaceId = context.scope.workspaceId;
  const survivor = rows.find(row => row.id === survivorId);
  if (survivor === undefined) throw new Error('the fold names a survivor that is not one of its rows');
  const others = rows.filter(row => row.id !== survivorId);
  if (others.length === 0) return survivor;
  const newest = [...rows].sort((left, right) => right.last_event_at.getTime() - left.last_event_at.getTime())[0] ?? survivor;
  const linked = survivor.firm_id === null ? (others.find(row => row.firm_id !== null) ?? null) : null;
  for (const other of others) {
    await context.db.query('UPDATE calcom_events SET meeting_id = $3 WHERE workspace_id = $1 AND meeting_id = $2', [workspaceId, other.id, survivor.id]);
    await context.db.query('UPDATE meeting_booking_uids SET meeting_id = $3 WHERE workspace_id = $1 AND meeting_id = $2', [
      workspaceId,
      other.id,
      survivor.id,
    ]);
    await context.db.query(
      `DELETE FROM stage_review_items
        WHERE workspace_id = $1 AND evidence_kind = 'meeting.booked' AND evidence_id = $2 AND resolved_at IS NULL`,
      [workspaceId, other.id],
    );
    await context.db.query('DELETE FROM meetings WHERE workspace_id = $1 AND id = $2', [workspaceId, other.id]);
  }
  const { rows: folded } = await context.db.query<MeetingRow>(
    `UPDATE meetings
        SET state = $3, state_before_no_show = $4, starts_at = $5::timestamptz, ends_at = $6::timestamptz,
            current_booking_uid = $7, last_event_at = GREATEST(last_event_at, $8::timestamptz),
            firm_id = COALESCE(firm_id, $9::uuid), contact_id = CASE WHEN firm_id IS NULL THEN $10::uuid ELSE contact_id END,
            opportunity_id = CASE WHEN firm_id IS NULL THEN $11::uuid ELSE opportunity_id END,
            updated_at = now()
      WHERE workspace_id = $1 AND id = $2
      RETURNING ${MEETING_COLUMNS}`,
    [
      workspaceId,
      survivor.id,
      newest.state,
      newest.state_before_no_show,
      newest.starts_at.toISOString(),
      newest.ends_at.toISOString(),
      newest.current_booking_uid,
      newest.last_event_at.toISOString(),
      linked?.firm_id ?? null,
      linked?.contact_id ?? null,
      linked?.opportunity_id ?? null,
    ],
  );
  const result = folded[0] ?? survivor;
  if (linked !== null) {
    await context.db.query(
      `DELETE FROM stage_review_items
        WHERE workspace_id = $1 AND evidence_kind = 'meeting.booked' AND evidence_id = $2 AND resolved_at IS NULL
          AND reason IN ('firm_unmatched', 'firm_ambiguous')`,
      [workspaceId, survivor.id],
    );
  }
  await aliasMeeting(context, survivor.id, others.flatMap(other => [other.booking_uid, other.current_booking_uid]));
  await recordCrmAuditEvent(context, {
    action: 'meeting.folded',
    subjectKind: 'meeting',
    subjectId: survivor.id,
    detail: { folded: others.length, state: result.state },
  });
  return result;
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
 * A booked meeting with a firm: the pipeline move, the stop, the funnel fact.
 *
 * Exported for the person's match of an unmatched booking (`meetings/match.ts`, slice
 * M1), which owes exactly what a matched webhook does. The caller holds the send gate.
 */
export async function applyBooked(context: RepositoryContext, meeting: BookedMeeting, occurredAt: string): Promise<StageEvidenceOutcome> {
  const firmId = meeting.firm_id ?? '';
  const stage = await applyStageEvidence(context, {
    firmId,
    evidenceKind: 'meeting.booked',
    evidenceId: meeting.id,
    occurredAt,
    detail: { bookingUid: meeting.booking_uid },
  });
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
  // Only prospecting stops, now, through the stop writer (the send gate is held since
  // `applyStageEvidence`). An evidenced follow-up — the overview promised on the call —
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
  return stage;
}

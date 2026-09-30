import { createHash } from 'node:crypto';
import type { MeetingState } from '@fss/contracts';
import type { Queryable } from '../db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../db/workspaceScope.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import { lockSendGateForStopFact } from '../policy/sendGate.ts';
import { receiveSynthesizedCalcomEvent, type ParsedEvent } from './calcom.ts';

/**
 * Cal.com reconciliation (slice M1): the bookings Cal.com's API reports, compared with
 * `meetings`, so a lost webhook does not leave a demo booked in Callie that was
 * cancelled or moved in Cal.com.
 *
 * ## What is read
 *
 * Cal.com API v2 "Get all bookings", `GET https://api.cal.com/v2/bookings`, with
 * `Authorization: Bearer <api key>` and `cal-api-version: 2026-05-01`, filtered to the
 * window `afterStart = now − 7 days`, `beforeEnd = now + 60 days`, `status` omitted so
 * every status is walked, `limit` 100 a page, following `pagination.nextCursor` while
 * `pagination.hasMore`:
 *
 *   * https://cal.com/docs/api-reference/v2/bookings/get-all-bookings (the endpoint, the
 *     header, the filters, the cursor pagination and the booking shape: `uid`, `status`
 *     of `accepted | cancelled | rejected | pending | awaiting_host`, `start`, `end`,
 *     `createdAt`, `updatedAt` (nullable), `rescheduledFromUid`, `rescheduledToUid`,
 *     `hosts[].email`, `attendees[].email` and `attendees[].absent`);
 *   * https://cal.com/docs/api-reference/v2/introduction (the bearer API key);
 *   * https://cal.com/docs/api-reference/v2/v1-v2-differences (the `api.cal.com/v2` host
 *     and the required version header).
 *
 * The HTTP client is the worker's (`apps/worker/src/calcom/bookingsClient.ts`); this file
 * sees only the `CalcomBookingsClient` interface, so tests use a fake and no test makes a
 * network call.
 *
 * ## What is done with it
 *
 * Every difference becomes a **synthesized event fed to the same `applyEvent` path** a
 * webhook takes (`receiveSynthesizedCalcomEvent`): the same dedupe table, the same
 * ordering, the same matching, the same `applyBooked`. Nothing here writes a meeting
 * directly, and nothing here deletes one.
 *
 *   * its delivery id is sha256 of `reconcile:{uid}:{trigger}:{status}:{instant}` — the
 *     same booking in the same state is the same delivery, so a replayed run is a
 *     duplicate at `calcom_events_once` and applies nothing;
 *   * its `createdAt` is the booking's own `updatedAt` (its `createdAt` when Cal.com has
 *     no update), so `applyEvent`'s ordering keeps a webhook newer than the API's answer
 *     authoritative. Two events have an instant of their own: an end is dated at the
 *     booking's `end`, as `parseCalcomEvent` dates Cal.com's own `MEETING_ENDED`, and a
 *     no-show mark at the later of `updatedAt` and `end` (it cannot precede the end).
 *
 * The mapping, booking → what the meeting should be:
 *
 *   * `accepted` with `rescheduledFromUid` → `BOOKING_RESCHEDULED` (uid, rescheduleUid);
 *     `accepted` without → `BOOKING_CREATED`. Either is synthesized when there is no
 *     meeting, when the meeting's current uid is not this booking's, or when its times
 *     differ.
 *   * `cancelled` with `rescheduledToUid` → nothing: that is the old half of a
 *     reschedule, and the new booking carries it.
 *   * `cancelled` otherwise → `BOOKING_CANCELLED` for a meeting that is not cancelled. A
 *     cancelled booking Callie never saw is not recorded: there is nothing to undo and an
 *     unmatched one would only open a review item about a demo that is not happening.
 *   * `pending`, `rejected`, `awaiting_host` → nothing. The webhook path never creates a
 *     meeting for them either (`BOOKING_REQUESTED` and `BOOKING_REJECTED` are `ignored`).
 *   * an attendee marked `absent` → `BOOKING_NO_SHOW_UPDATED` (mark); none marked, on a
 *     meeting that is `no_show` → the unmark;
 *   * an accepted booking whose `end` has passed, on a meeting still booked or
 *     rescheduled → `MEETING_ENDED`.
 *
 * A cancelled meeting is terminal (`applyEvent`), so it is never compared.
 *
 * ## Bounded
 *
 * At most `maxPages` pages and `deadlineMs` of fetching; a run that hit either says so
 * (`truncated`) and applies what it read — every event is independent and the next run
 * reads again. The counts are returned for the handler's log line and recorded as one
 * audit event when anything was synthesized.
 */

export const CALCOM_API_ORIGIN = 'https://api.cal.com';
/** The version header value the bookings list requires (see the doc URL above). */
export const CALCOM_BOOKINGS_API_VERSION = '2026-05-01';
export const RECONCILE_WINDOW_PAST_DAYS = 7;
export const RECONCILE_WINDOW_FUTURE_DAYS = 60;
export const RECONCILE_PAGE_LIMIT = 100;
export const RECONCILE_MAX_PAGES = 10;
export const RECONCILE_DEADLINE_MS = 30_000;

export interface CalcomBookingsQuery {
  readonly afterStart: string;
  readonly beforeEnd: string;
  readonly cursor: string | null;
  readonly limit: number;
}

export interface CalcomBookingsPage {
  /** The page's `data`, unparsed: `parseCalcomBooking` reads each. */
  readonly bookings: readonly unknown[];
  /** `pagination.nextCursor` when `pagination.hasMore`, else null. */
  readonly nextCursor: string | null;
}

/** The one call reconciliation makes. A fake in tests; `fetch` in the worker. */
export interface CalcomBookingsClient {
  listBookings(query: CalcomBookingsQuery): Promise<CalcomBookingsPage>;
}

export interface CalcomBooking {
  readonly uid: string;
  readonly status: 'accepted' | 'cancelled' | 'rejected' | 'pending' | 'awaiting_host';
  readonly start: string;
  readonly end: string;
  readonly createdAt: string;
  readonly updatedAt: string | null;
  readonly rescheduledFromUid: string | null;
  readonly rescheduledToUid: string | null;
  readonly hostEmail: string | null;
  readonly attendeeEmail: string | null;
  readonly anyAttendeeAbsent: boolean;
}

const UID = /^[A-Za-z0-9_-]{1,128}$/u;
const EMAIL = /^[^@\s]+@[^@\s]+$/u;
const STATUSES: readonly string[] = ['accepted', 'cancelled', 'rejected', 'pending', 'awaiting_host'];

const record = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const uidOf = (value: unknown): string | null => (typeof value === 'string' && UID.test(value) ? value : null);
const instantOf = (value: unknown): string | null => {
  if (typeof value !== 'string' || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};
const emailOf = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const candidate = value.trim().toLowerCase();
  return EMAIL.test(candidate) && candidate.length <= 320 ? candidate : null;
};

/** One entry of the list's `data`, or null when it is not a booking this can use. */
export function parseCalcomBooking(value: unknown): CalcomBooking | null {
  const row = record(value);
  const uid = uidOf(row['uid']);
  const status = typeof row['status'] === 'string' ? row['status'].toLowerCase() : '';
  const start = instantOf(row['start']);
  const end = instantOf(row['end']);
  const createdAt = instantOf(row['createdAt']);
  if (uid === null || !STATUSES.includes(status) || start === null || end === null || createdAt === null) return null;
  const attendees = Array.isArray(row['attendees']) ? (row['attendees'] as unknown[]).map(record) : [];
  const hosts = Array.isArray(row['hosts']) ? (row['hosts'] as unknown[]).map(record) : [];
  return {
    uid,
    status: status as CalcomBooking['status'],
    start,
    end,
    createdAt,
    updatedAt: instantOf(row['updatedAt']),
    rescheduledFromUid: uidOf(row['rescheduledFromUid']),
    rescheduledToUid: uidOf(row['rescheduledToUid']),
    hostEmail: emailOf(hosts[0]?.['email']),
    attendeeEmail: emailOf(attendees[0]?.['email']),
    anyAttendeeAbsent: attendees.some(attendee => attendee['absent'] === true),
  };
}

export interface FetchedBookings {
  readonly bookings: readonly CalcomBooking[];
  readonly pages: number;
  readonly malformed: number;
  readonly truncated: boolean;
}

/** Read the window, bounded by pages and time. A failed request throws: the job retries. */
export async function fetchCalcomBookings(
  client: CalcomBookingsClient,
  options: {
    readonly now: string;
    readonly maxPages?: number;
    readonly deadlineMs?: number;
    readonly clock?: () => number;
  },
): Promise<FetchedBookings> {
  const clock = options.clock ?? (() => Date.now());
  const startedAt = clock();
  const maxPages = options.maxPages ?? RECONCILE_MAX_PAGES;
  const deadlineMs = options.deadlineMs ?? RECONCILE_DEADLINE_MS;
  const now = Date.parse(options.now);
  const day = 24 * 60 * 60 * 1000;
  const query = {
    afterStart: new Date(now - RECONCILE_WINDOW_PAST_DAYS * day).toISOString(),
    beforeEnd: new Date(now + RECONCILE_WINDOW_FUTURE_DAYS * day).toISOString(),
    limit: RECONCILE_PAGE_LIMIT,
  };
  const bookings: CalcomBooking[] = [];
  const seen = new Set<string>();
  let malformed = 0;
  let pages = 0;
  let cursor: string | null = null;
  let truncated = false;
  for (;;) {
    if (pages >= maxPages || clock() - startedAt >= deadlineMs) {
      truncated = true;
      break;
    }
    const page: CalcomBookingsPage = await client.listBookings({ ...query, cursor });
    pages += 1;
    for (const entry of page.bookings) {
      const booking = parseCalcomBooking(entry);
      if (booking === null) {
        malformed += 1;
        continue;
      }
      if (seen.has(booking.uid)) continue;
      seen.add(booking.uid);
      bookings.push(booking);
    }
    if (page.nextCursor === null || page.nextCursor === cursor) break;
    cursor = page.nextCursor;
  }
  return { bookings, pages, malformed, truncated };
}

export interface ReconcileCounts {
  readonly bookings: number;
  readonly unchanged: number;
  readonly skipped: number;
  readonly synthesized: number;
  readonly applied: number;
  readonly stale: number;
  readonly duplicate: number;
  readonly unmatched: number;
}

interface StoredMeeting {
  readonly id: string;
  readonly state: MeetingState;
  readonly current_booking_uid: string;
  readonly starts_at: Date;
  readonly ends_at: Date;
  readonly [column: string]: unknown;
}

async function meetingOf(context: RepositoryContext, uid: string): Promise<StoredMeeting | null> {
  const { rows } = await context.db.query<StoredMeeting>(
    `SELECT id, state, current_booking_uid, starts_at, ends_at FROM meetings
      WHERE workspace_id = $1 AND (booking_uid = $2 OR current_booking_uid = $2)
      ORDER BY (current_booking_uid = $2) DESC LIMIT 1`,
    [context.scope.workspaceId, uid],
  );
  return rows[0] ?? null;
}

type Trigger = 'BOOKING_CREATED' | 'BOOKING_RESCHEDULED' | 'BOOKING_CANCELLED' | 'MEETING_ENDED' | 'BOOKING_NO_SHOW_UPDATED';

interface PlannedEvent {
  readonly trigger: Trigger;
  readonly instant: string;
  readonly noShow: boolean | null;
}

const later = (left: string, right: string): string => (Date.parse(left) >= Date.parse(right) ? left : right);

/** What the meeting should become, as the events `applyEvent` needs to get there. */
export function planBooking(
  booking: CalcomBooking,
  meeting: Pick<StoredMeeting, 'state' | 'current_booking_uid' | 'starts_at' | 'ends_at'> | null,
  now: string,
): readonly PlannedEvent[] {
  const instant = booking.updatedAt ?? booking.createdAt;
  if (booking.status === 'cancelled') {
    if (booking.rescheduledToUid !== null) return [];
    if (meeting === null || meeting.state === 'cancelled') return [];
    return [{ trigger: 'BOOKING_CANCELLED', instant, noShow: null }];
  }
  if (booking.status !== 'accepted') return [];
  if (meeting !== null && meeting.state === 'cancelled') return [];

  const events: PlannedEvent[] = [];
  const identity: Trigger = booking.rescheduledFromUid === null ? 'BOOKING_CREATED' : 'BOOKING_RESCHEDULED';
  let state: MeetingState;
  if (meeting === null) {
    events.push({ trigger: identity, instant, noShow: null });
    state = identity === 'BOOKING_RESCHEDULED' ? 'rescheduled' : 'booked';
  } else {
    state = meeting.state;
    const moved =
      meeting.current_booking_uid !== booking.uid ||
      meeting.starts_at.toISOString() !== booking.start ||
      meeting.ends_at.toISOString() !== booking.end;
    if (moved) {
      events.push({ trigger: identity, instant, noShow: null });
      if (identity === 'BOOKING_RESCHEDULED' && state !== 'no_show' && state !== 'held') state = 'rescheduled';
    }
  }
  if (booking.anyAttendeeAbsent && state !== 'no_show') {
    events.push({ trigger: 'BOOKING_NO_SHOW_UPDATED', instant: later(instant, booking.end), noShow: true });
  } else if (!booking.anyAttendeeAbsent && state === 'no_show') {
    events.push({ trigger: 'BOOKING_NO_SHOW_UPDATED', instant: later(instant, booking.end), noShow: false });
  } else if (!booking.anyAttendeeAbsent && (state === 'booked' || state === 'rescheduled') && Date.parse(booking.end) <= Date.parse(now)) {
    events.push({ trigger: 'MEETING_ENDED', instant: booking.end, noShow: null });
  }
  return events;
}

/** The deterministic delivery id of one synthesized event. */
export function reconcileEventId(booking: Pick<CalcomBooking, 'uid' | 'status'>, event: PlannedEvent): string {
  const flag = event.noShow === null ? '' : `:${String(event.noShow)}`;
  return createHash('sha256')
    .update(`reconcile:${booking.uid}:${event.trigger}${flag}:${booking.status}:${event.instant}`)
    .digest('hex');
}

/**
 * Apply one read of the window to `meetings`. The caller runs it in one transaction.
 *
 * The send gate is taken first, once, and held to the end of the transaction, so the
 * snapshot each booking is compared against cannot move under a webhook between the
 * comparison and the event (every synthesized event takes it again, which is a no-op).
 */
export async function reconcileCalcomBookings(
  db: Queryable,
  input: { readonly workspaceId: string; readonly bookings: readonly CalcomBooking[]; readonly now: string; readonly truncated?: boolean },
): Promise<ReconcileCounts> {
  const context = repositoryContext(workspaceScope(input.workspaceId, { kind: 'system', component: 'worker' }), db);
  await lockSendGateForStopFact(context);
  const counts = { bookings: input.bookings.length, unchanged: 0, skipped: 0, synthesized: 0, applied: 0, stale: 0, duplicate: 0, unmatched: 0 };
  for (const booking of input.bookings) {
    if (booking.status !== 'accepted' && booking.status !== 'cancelled') {
      counts.skipped += 1;
      continue;
    }
    const meeting =
      (await meetingOf(context, booking.uid)) ??
      (booking.rescheduledFromUid === null ? null : await meetingOf(context, booking.rescheduledFromUid));
    const planned = planBooking(booking, meeting, input.now);
    if (planned.length === 0) {
      counts.unchanged += 1;
      continue;
    }
    for (const event of planned) {
      counts.synthesized += 1;
      const parsed: ParsedEvent = {
        trigger: event.trigger,
        createdAt: event.instant,
        uid: booking.uid,
        rescheduleUid: event.trigger === 'BOOKING_RESCHEDULED' ? booking.rescheduledFromUid : null,
        startsAt: booking.start,
        endsAt: booking.end,
        organizerEmail: booking.hostEmail,
        attendeeEmail: booking.attendeeEmail,
        noShow: event.noShow,
      };
      const receipt = await receiveSynthesizedCalcomEvent(db, {
        workspaceId: input.workspaceId,
        eventId: reconcileEventId(booking, event),
        event: parsed,
      });
      if (receipt.duplicate) counts.duplicate += 1;
      else if (receipt.outcome === 'stale') counts.stale += 1;
      else if (receipt.outcome === 'unmatched') counts.unmatched += 1;
      else if (receipt.outcome === 'applied') counts.applied += 1;
    }
  }
  if (counts.synthesized > 0) {
    await recordCrmAuditEvent(context, {
      action: 'meeting.reconciled',
      subjectKind: 'workspace',
      subjectId: input.workspaceId,
      detail: { ...counts, truncated: input.truncated === true },
    });
  }
  return counts;
}

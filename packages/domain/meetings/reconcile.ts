import { createHash } from 'node:crypto';
import type { MeetingState } from '@fss/contracts';
import type { Queryable } from '../db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../db/workspaceScope.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import { lockSendGateForStopFact } from '../policy/sendGate.ts';
import { aliasMeeting, foldMeetings, MEETING_COLUMNS, receiveSynthesizedCalcomEvent, type MeetingRow, type ParsedEvent } from './calcom.ts';
import { attendeeAddressOf, deletionTombstoneKeyOf } from './attendee.ts';

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
 *   * its delivery id is `reconcileEventId`'s — the same booking in the same state is
 *     the same delivery, so a replayed run is a duplicate at `calcom_events_once`;
 *   * its `createdAt` is the booking's own `updatedAt`, so `applyEvent`'s ordering keeps
 *     a webhook newer than the API's answer authoritative.
 *
 * The bookings are joined into reschedule chains first, whatever their status
 * (`bookingChains`), and each chain is planned against its one meeting (`planChain`,
 * which says what each booking becomes). A chain with no meeting whose attendee's data
 * was deleted is not recorded (`attendeeTombstoned`). `docs/greenfield/meetings.md`
 * has the whole mapping.
 *
 * ## Bounded
 *
 * At most `maxPages` pages and `deadlineMs` of fetching, each request handed only what
 * is left of the budget. A run that hit either says so (`truncated`) and applies what it
 * read: every event is independent and the next run reads again. The counts are returned for the handler's log line and recorded as one
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
  /** What is left of the run's fetching budget: the request must give up by then. */
  readonly timeoutMs: number;
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
const STATUSES: readonly string[] = ['accepted', 'cancelled', 'rejected', 'pending', 'awaiting_host'];

const record = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const uidOf = (value: unknown): string | null => (typeof value === 'string' && UID.test(value) ? value : null);
const instantOf = (value: unknown): string | null => {
  if (typeof value !== 'string' || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};
/** The webhook's spelling (`meetings/attendee.ts`), so both paths store the same address. */
const emailOf = (value: unknown): string | null => attendeeAddressOf(value);

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
    const elapsed = clock() - startedAt;
    if (pages >= maxPages || elapsed >= deadlineMs) {
      truncated = true;
      break;
    }
    let page: CalcomBookingsPage;
    try {
      // The request is given what is left of the run's budget, not a fresh timeout of
      // its own: a page that starts a moment before the deadline ends at it.
      page = await client.listBookings({ ...query, cursor, timeoutMs: deadlineMs - elapsed });
    } catch (error) {
      // Cut short by the deadline: what was read is applied and the run says so. Any
      // other failure is the job's to retry.
      if (clock() - startedAt >= deadlineMs) {
        truncated = true;
        break;
      }
      throw error;
    }
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
  readonly chains: number;
  readonly unchanged: number;
  readonly skipped: number;
  /** Chains not recorded because their attendee's data was deleted (a deletion tombstone). */
  readonly tombstoned: number;
  readonly synthesized: number;
  readonly applied: number;
  readonly stale: number;
  readonly duplicate: number;
  readonly unmatched: number;
}

/** What `planChain` reads of the meeting a chain resolves to. */
export interface StoredMeeting {
  readonly id: string;
  readonly state: MeetingState;
  readonly current_booking_uid: string;
  readonly starts_at: Date;
  readonly ends_at: Date;
  readonly last_event_at: Date;
  readonly [column: string]: unknown;
}

/**
 * The one meeting a chain is, through `meeting_booking_uids` (0029): every uid of the
 * chain is looked up, and when they resolve to two or more meetings those are folded
 * into the one holding the oldest uid (`foldMeetings`, W's rules), keeping the newest
 * state, times and current uid — even when the newest row is already cancelled (review
 * fold 2, finding 1). Null when no uid is known.
 */
async function unifyChain(context: RepositoryContext, uids: readonly string[]): Promise<StoredMeeting | null> {
  const { rows: found } = await context.db.query<{ id: string; position: string }>(
    `SELECT m.id, min(u.position) AS position
       FROM unnest($2::text[]) WITH ORDINALITY AS u(uid, position)
       JOIN meetings m ON m.workspace_id = $1
        AND (m.id IN (SELECT a.meeting_id FROM meeting_booking_uids a WHERE a.workspace_id = $1 AND a.booking_uid = u.uid)
             OR m.booking_uid = u.uid OR m.current_booking_uid = u.uid)
      GROUP BY m.id`,
    [context.scope.workspaceId, [...uids]],
  );
  if (found.length === 0) return null;
  const { rows } = await context.db.query<MeetingRow>(
    `SELECT ${MEETING_COLUMNS} FROM meetings WHERE workspace_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE`,
    [context.scope.workspaceId, found.map(row => row.id)],
  );
  // The survivor holds the chain's oldest uid.
  const survivorId = [...found].sort((left, right) => Number(left.position) - Number(right.position))[0]?.id;
  const survivor = rows.find(row => row.id === survivorId) ?? rows[0];
  if (survivor === undefined) return null;
  const meeting = rows.length === 1 ? survivor : await foldMeetings(context, rows, survivor.id);
  await aliasMeeting(context, meeting.id, uids);
  return meeting;
}

type Trigger = 'BOOKING_CREATED' | 'BOOKING_RESCHEDULED' | 'BOOKING_CANCELLED' | 'MEETING_ENDED' | 'BOOKING_NO_SHOW_UPDATED';

export interface PlannedEvent {
  readonly trigger: Trigger;
  /** The booking the event is about (`uid`); for a reschedule, the new one. */
  readonly booking: CalcomBooking;
  /** For a reschedule: the uid it replaced. */
  readonly rescheduleUid: string | null;
  readonly instant: string;
  readonly noShow: boolean | null;
}

/**
 * A reschedule chain: the uids from the oldest this read knows (possibly one Cal.com
 * only names, as a `rescheduledFromUid`) to the newest, and the listed bookings by uid.
 */
export interface BookingChain {
  readonly uids: readonly string[];
  readonly bookings: ReadonlyMap<string, CalcomBooking>;
}

const MAX_CHAIN = 50;

/**
 * Every listed booking in exactly one chain, joined by `rescheduledFromUid` and
 * `rescheduledToUid` whatever each booking's status (review fold 1, finding 1): the old
 * half of a reschedule is `cancelled` in Cal.com, and a chain read status by status
 * loses who replaced whom.
 */
export function bookingChains(bookings: readonly CalcomBooking[]): readonly BookingChain[] {
  const byUid = new Map(bookings.map(booking => [booking.uid, booking]));
  const next = new Map<string, string>();
  const prev = new Map<string, string>();
  const link = (from: string, to: string): void => {
    if (from === to || next.has(from) || prev.has(to)) return;
    next.set(from, to);
    prev.set(to, from);
  };
  for (const booking of bookings) {
    if (booking.rescheduledToUid !== null) link(booking.uid, booking.rescheduledToUid);
    if (booking.rescheduledFromUid !== null) link(booking.rescheduledFromUid, booking.uid);
  }
  const covered = new Set<string>();
  const chains: BookingChain[] = [];
  for (const booking of bookings) {
    if (covered.has(booking.uid)) continue;
    // Forward to the newest listed booking, then back to the oldest uid named.
    let tail = booking.uid;
    for (let steps = 0; steps < MAX_CHAIN; steps += 1) {
      const after = next.get(tail);
      if (after === undefined || !byUid.has(after) || covered.has(after) || after === booking.uid) break;
      tail = after;
    }
    const uids = [tail];
    for (let steps = 0; steps < MAX_CHAIN; steps += 1) {
      const before = prev.get(uids[0] ?? '');
      if (before === undefined || uids.includes(before) || covered.has(before)) break;
      uids.unshift(before);
      if (!byUid.has(before)) break;
    }
    for (const uid of uids) covered.add(uid);
    chains.push({ uids, bookings: byUid });
  }
  return chains;
}

const instantOfBooking = (booking: CalcomBooking): string => booking.updatedAt ?? booking.createdAt;
const later = (left: string, right: string): string => (Date.parse(left) >= Date.parse(right) ? left : right);
const plusOne = (instant: string): string => new Date(Date.parse(instant) + 1).toISOString();

/**
 * The events that take a chain's meeting — or no meeting — to what Cal.com says.
 *
 *   * **A known meeting**: the chain must contain the meeting's current uid, or the
 *     meeting has moved past what this read knows (a newer webhook) and nothing is
 *     planned. Each link after the current uid is a `BOOKING_RESCHEDULED` (old → new),
 *     dated at the new booking's `createdAt`, before the newest booking's terminal
 *     state, so `applyEvent`'s own folding joins them.
 *   * **No meeting**: the newest booking's own event first — `BOOKING_CANCELLED` for a
 *     cancellation (the terminal fact is recorded, so a late older create is `stale`),
 *     `BOOKING_RESCHEDULED`/`BOOKING_CREATED` for an accepted booking — then every older
 *     link, newest first, so `applyEvent` adopts each original uid onto the one row.
 *   * **Derived events** (an end, a no-show mark or its reversal) only from a snapshot no
 *     older than the meeting's last applied event, about the meeting's current booking
 *     (review fold 1, finding 2). An end is dated at the later of the booking's `end` and
 *     just after the meeting's last event, so a meeting whose no-show mark was reversed
 *     after its end still converges to held (finding 5).
 */
export function planChain(chain: BookingChain, meeting: StoredMeeting | null, now: string): readonly PlannedEvent[] {
  const tailUid = chain.uids[chain.uids.length - 1] ?? '';
  const tail = chain.bookings.get(tailUid);
  if (tail === undefined) return [];
  if (tail.status !== 'accepted' && tail.status !== 'cancelled') return [];
  // The newest booking was itself moved to one this read did not list (beyond the
  // window): its state is not the meeting's.
  const movedAway = tail.status === 'cancelled' && tail.rescheduledToUid !== null;
  const linkAt = (index: number): PlannedEvent | null => {
    const to = chain.bookings.get(chain.uids[index + 1] ?? '');
    const from = chain.uids[index];
    if (to === undefined || from === undefined) return null;
    return { trigger: 'BOOKING_RESCHEDULED', booking: to, rescheduleUid: from, instant: to.createdAt, noShow: null };
  };
  const events: PlannedEvent[] = [];

  let state: MeetingState;
  let lastEventAt: string;
  let fresh: boolean;
  if (meeting === null) {
    if (movedAway) return [];
    const before = chain.uids.length >= 2 ? (chain.uids[chain.uids.length - 2] ?? null) : null;
    if (tail.status === 'cancelled') {
      events.push({ trigger: 'BOOKING_CANCELLED', booking: tail, rescheduleUid: null, instant: instantOfBooking(tail), noShow: null });
      state = 'cancelled';
    } else if (before !== null) {
      events.push({ trigger: 'BOOKING_RESCHEDULED', booking: tail, rescheduleUid: before, instant: instantOfBooking(tail), noShow: null });
      state = 'rescheduled';
    } else {
      events.push({ trigger: 'BOOKING_CREATED', booking: tail, rescheduleUid: null, instant: instantOfBooking(tail), noShow: null });
      state = 'booked';
    }
    // The older links, newest first: each adopts its original uid onto the one row.
    const firstLink = tail.status === 'cancelled' ? chain.uids.length - 2 : chain.uids.length - 3;
    for (let index = firstLink; index >= 0; index -= 1) {
      const planned = linkAt(index);
      if (planned !== null) events.push(planned);
    }
    lastEventAt = instantOfBooking(tail);
    fresh = true;
  } else {
    if (meeting.state === 'cancelled') return [];
    const position = chain.uids.indexOf(meeting.current_booking_uid);
    if (position === -1) return [];
    state = meeting.state;
    lastEventAt = meeting.last_event_at.toISOString();
    // The snapshot's own freshness, against the meeting as it stands before this run.
    fresh = Date.parse(instantOfBooking(tail)) >= meeting.last_event_at.getTime();
    for (let index = position; index < chain.uids.length - 1; index += 1) {
      const planned = linkAt(index);
      if (planned === null) continue;
      events.push(planned);
      lastEventAt = later(lastEventAt, planned.instant);
      if (state !== 'held' && state !== 'no_show') state = 'rescheduled';
    }
    if (movedAway) return events;
    if (tail.status === 'cancelled') {
      events.push({ trigger: 'BOOKING_CANCELLED', booking: tail, rescheduleUid: null, instant: instantOfBooking(tail), noShow: null });
      return events;
    }
    const linked = events.length > 0;
    const timesDiffer = meeting.starts_at.toISOString() !== tail.start || meeting.ends_at.toISOString() !== tail.end;
    if (!linked && timesDiffer) {
      const identity: Trigger = tail.rescheduledFromUid === null ? 'BOOKING_CREATED' : 'BOOKING_RESCHEDULED';
      const rescheduleUid = identity === 'BOOKING_RESCHEDULED' ? (chain.uids[chain.uids.length - 2] ?? tail.rescheduledFromUid) : null;
      events.push({ trigger: identity, booking: tail, rescheduleUid, instant: instantOfBooking(tail), noShow: null });
      if (identity === 'BOOKING_RESCHEDULED' && state !== 'held' && state !== 'no_show') state = 'rescheduled';
      if (fresh) lastEventAt = later(lastEventAt, instantOfBooking(tail));
    }
  }

  if (tail.status !== 'accepted' || !fresh) return events;
  if (tail.anyAttendeeAbsent && state !== 'no_show') {
    events.push({ trigger: 'BOOKING_NO_SHOW_UPDATED', booking: tail, rescheduleUid: null, instant: later(instantOfBooking(tail), tail.end), noShow: true });
  } else if (!tail.anyAttendeeAbsent && state === 'no_show') {
    events.push({ trigger: 'BOOKING_NO_SHOW_UPDATED', booking: tail, rescheduleUid: null, instant: later(instantOfBooking(tail), tail.end), noShow: false });
  } else if (!tail.anyAttendeeAbsent && (state === 'booked' || state === 'rescheduled') && Date.parse(tail.end) <= Date.parse(now)) {
    events.push({ trigger: 'MEETING_ENDED', booking: tail, rescheduleUid: null, instant: later(tail.end, plusOne(lastEventAt)), noShow: null });
  }
  return events;
}

/** The deterministic delivery id of one synthesized event. */
export function reconcileEventId(event: PlannedEvent): string {
  const flag = event.noShow === null ? '' : `:${String(event.noShow)}`;
  const from = event.rescheduleUid === null ? '' : `:${event.rescheduleUid}`;
  return createHash('sha256')
    .update(`reconcile:${event.booking.uid}${from}:${event.trigger}${flag}:${event.booking.status}:${event.instant}`)
    .digest('hex');
}

/**
 * Whether a person's data was deleted under this address: a `deletion_tombstone`
 * suppression of the handle (`retention/deletion.ts`), which a deletion records for
 * every address it removes, a meeting attendee's included. Any tombstone, whatever
 * else has been recorded for the handle since: the deletion is terminal.
 */
async function attendeeTombstoned(context: RepositoryContext, attendeeEmail: string | null): Promise<boolean> {
  if (attendeeEmail === null) return false;
  // The key the deletion wrote (`meetings/attendee.ts`): the canonical handle, or for an
  // address the canonicalizer refuses, its fallback key. Never "not suppressed" for want
  // of a canonical form (review fold 2, finding 3 (i)).
  const key = deletionTombstoneKeyOf(attendeeEmail);
  if (key === null) return false;
  const { rows } = await context.db.query(
    `SELECT 1 FROM suppression_events
      WHERE workspace_id = $1 AND scope = 'handle' AND canonical_key = $2 AND source = 'deletion_tombstone'
      LIMIT 1`,
    [context.scope.workspaceId, key],
  );
  return rows.length > 0;
}

/**
 * Apply one read of the window to `meetings`. The caller runs it in one transaction.
 *
 * The send gate is taken first, once, and held to the end of the transaction, so the
 * snapshot each chain is compared against cannot move under a webhook between the
 * comparison and the event (every synthesized event takes it again, which is a no-op).
 *
 * A chain with no meeting whose attendee's data was deleted is not recorded at all:
 * deletion removed the meeting and its deliveries, and recording the booking again
 * would bring the person's address back (review fold 1, finding 3).
 */
export async function reconcileCalcomBookings(
  db: Queryable,
  input: { readonly workspaceId: string; readonly bookings: readonly CalcomBooking[]; readonly now: string; readonly truncated?: boolean },
): Promise<ReconcileCounts> {
  const context = repositoryContext(workspaceScope(input.workspaceId, { kind: 'system', component: 'worker' }), db);
  await lockSendGateForStopFact(context);
  const chains = bookingChains(input.bookings);
  const counts = {
    bookings: input.bookings.length,
    chains: chains.length,
    unchanged: 0,
    skipped: 0,
    tombstoned: 0,
    synthesized: 0,
    applied: 0,
    stale: 0,
    duplicate: 0,
    unmatched: 0,
  };
  for (const chain of chains) {
    const tail = chain.bookings.get(chain.uids[chain.uids.length - 1] ?? '');
    if (tail === undefined || (tail.status !== 'accepted' && tail.status !== 'cancelled')) {
      counts.skipped += 1;
      continue;
    }
    const meeting = await unifyChain(context, chain.uids);
    if (meeting === null) {
      const attendees = chain.uids.map(uid => chain.bookings.get(uid)?.attendeeEmail ?? null);
      let tombstoned = false;
      for (const attendee of new Set(attendees)) tombstoned ||= await attendeeTombstoned(context, attendee);
      if (tombstoned) {
        counts.tombstoned += 1;
        continue;
      }
    }
    const planned = planChain(chain, meeting, input.now);
    if (planned.length === 0) {
      counts.unchanged += 1;
      continue;
    }
    for (const event of planned) {
      counts.synthesized += 1;
      const parsed: ParsedEvent = {
        trigger: event.trigger,
        createdAt: event.instant,
        uid: event.booking.uid,
        rescheduleUid: event.rescheduleUid,
        startsAt: event.booking.start,
        endsAt: event.booking.end,
        organizerEmail: event.booking.hostEmail,
        attendeeEmail: event.booking.attendeeEmail,
        noShow: event.noShow,
      };
      const receipt = await receiveSynthesizedCalcomEvent(db, {
        workspaceId: input.workspaceId,
        eventId: reconcileEventId(event),
        event: parsed,
      });
      if (receipt.duplicate) counts.duplicate += 1;
      else if (receipt.outcome === 'stale') counts.stale += 1;
      else if (receipt.outcome === 'unmatched') counts.unmatched += 1;
      else if (receipt.outcome === 'applied') counts.applied += 1;
    }
    // Every uid of the chain is this meeting's from now on, intermediates included, and
    // anything the events left as a second row is folded in (0029).
    await unifyChain(context, chain.uids);
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

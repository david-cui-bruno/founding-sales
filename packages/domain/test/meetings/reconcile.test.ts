import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { withTransaction } from '../../db/queryable.ts';
import { openAttendeeConflict, receiveCalcomEvent } from '../../meetings/calcom.ts';
import {
  bookingChains,
  fetchCalcomBookings,
  parseCalcomBooking,
  planChain,
  reconcileCalcomBookings,
  type CalcomBooking,
  type CalcomBookingsClient,
  type CalcomBookingsQuery,
  type ReconcileCounts,
} from '../../meetings/reconcile.ts';
import { readCalcomSecret } from '../../meetings/calcomSecret.ts';
import { commitDeletion, previewDeletion } from '../../retention/deletion.ts';
import { recordingSuppressionJournal } from '../../suppression/journal.ts';
import { repositoryContext, workspaceScope } from '../../db/workspaceScope.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';

/**
 * Cal.com reconciliation (slice M1), at the domain, over a fake bookings client: a lost
 * webhook is repaired through the webhook's own `applyEvent`, a newer webhook stays
 * authoritative, a replayed run applies nothing, and nothing is ever deleted.
 */

const NOW = '2026-10-01T12:00:00.000Z';
const ATTENDEE = 'partner@northwind-law.example';

/** One booking as Cal.com's `GET /v2/bookings` lists it (the documented shape). */
function apiBooking(uid: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    uid,
    title: 'Callie demo',
    status: 'accepted',
    start: '2026-10-06T15:00:00.000Z',
    end: '2026-10-06T15:30:00.000Z',
    createdAt: '2026-09-30T12:00:00.000Z',
    updatedAt: '2026-09-30T12:00:00.000Z',
    hosts: [{ id: 1, name: 'David', email: 'David@UseCallie.example' }],
    attendees: [{ name: 'A Partner', email: ATTENDEE, timeZone: 'UTC', absent: false }],
    absentHost: false,
    ...extra,
  };
}

function parsed(uid: string, extra: Record<string, unknown> = {}): CalcomBooking {
  const booking = parseCalcomBooking(apiBooking(uid, extra));
  if (booking === null) throw new Error('fixture booking did not parse');
  return booking;
}

describe('Cal.com reconciliation', () => {
  let database: TestDatabase;
  let seeded: TwoWorkspaces;
  let counter = 0;
  const workspaceId = (): string => seeded.alpha.workspaceId;
  const uid = (): string => {
    counter += 1;
    return `rc${String(counter)}x`;
  };

  async function webhook(trigger: string, createdAt: string, payload: Record<string, unknown>): Promise<void> {
    const body = { triggerEvent: trigger, createdAt, payload };
    await withTransaction(database.session, async () =>
      await receiveCalcomEvent(database.session, { workspaceId: workspaceId(), rawBody: Buffer.from(JSON.stringify(body)), body }),
    );
  }

  const webhookBooking = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    uid: id,
    startTime: '2026-10-06T15:00:00.000Z',
    endTime: '2026-10-06T15:30:00.000Z',
    attendees: [{ email: ATTENDEE }],
    ...extra,
  });

  async function reconcile(bookings: readonly CalcomBooking[]): Promise<ReconcileCounts> {
    return await withTransaction(database.session, async () =>
      await reconcileCalcomBookings(database.session, { workspaceId: workspaceId(), bookings, now: NOW }),
    );
  }

  async function meeting(id: string): Promise<{ state: string; current_booking_uid: string; starts_at: Date } | undefined> {
    const { rows } = await database.session.query<{ state: string; current_booking_uid: string; starts_at: Date }>(
      `SELECT state, current_booking_uid, starts_at FROM meetings
        WHERE workspace_id = $1 AND (booking_uid = $2 OR current_booking_uid = $2)`,
      [workspaceId(), id],
    );
    return rows[0];
  }

  async function meetingsNamed(uids: readonly string[]): Promise<{ booking_uid: string; current_booking_uid: string; state: string }[]> {
    const { rows } = await database.session.query<{ booking_uid: string; current_booking_uid: string; state: string }>(
      `SELECT booking_uid, current_booking_uid, state FROM meetings
        WHERE workspace_id = $1 AND (booking_uid = ANY($2::text[]) OR current_booking_uid = ANY($2::text[]))
        ORDER BY booking_uid`,
      [workspaceId(), [...uids]],
    );
    return rows;
  }

  const eventCount = async (): Promise<number> => {
    const { rows } = await database.session.query<{ count: string }>('SELECT count(*) AS count FROM calcom_events WHERE workspace_id = $1', [workspaceId()]);
    return Number(rows[0]?.count);
  };

  beforeAll(async () => {
    database = await createTestDatabase();
    seeded = await seedTwoWorkspaces(database.session);
    await database.session.query(
      `INSERT INTO firms (workspace_id, name, website, assigned_user_id) VALUES ($1, 'Northwind Law', 'https://www.northwind-law.example/', $2)`,
      [workspaceId(), seeded.alpha.salesperson.userId],
    );
  });

  afterAll(async () => {
    await database.drop();
  });

  it('repairs a lost BOOKING_CANCELLED through the webhook path', async () => {
    const id = uid();
    await webhook('BOOKING_CREATED', '2026-09-30T12:00:00.000Z', webhookBooking(id));
    const counts = await reconcile([parsed(id, { status: 'cancelled', updatedAt: '2026-09-30T13:00:00.000Z' })]);
    expect(counts).toMatchObject({ synthesized: 1, applied: 1, stale: 0 });
    expect((await meeting(id))?.state).toBe('cancelled');
    // The repair is a recorded delivery, like any webhook's.
    const { rows } = await database.session.query<{ trigger_event: string; outcome: string; payload_created_at: Date }>(
      "SELECT trigger_event, outcome, payload_created_at FROM calcom_events WHERE workspace_id = $1 AND booking_uid = $2 AND trigger_event = 'BOOKING_CANCELLED'",
      [workspaceId(), id],
    );
    expect(rows.map(row => ({ ...row, payload_created_at: row.payload_created_at.toISOString() }))).toEqual([
      { trigger_event: 'BOOKING_CANCELLED', outcome: 'applied', payload_created_at: '2026-09-30T13:00:00.000Z' },
    ]);
  });

  it('repairs a lost BOOKING_RESCHEDULED: the new uid and the new time', async () => {
    const a = uid();
    const b = uid();
    await webhook('BOOKING_CREATED', '2026-09-30T12:00:00.000Z', webhookBooking(a));
    const counts = await reconcile([
      // Cal.com lists the old half cancelled and naming the new one, and the new one.
      parsed(a, { status: 'cancelled', rescheduledToUid: b, updatedAt: '2026-09-30T14:00:00.000Z' }),
      parsed(b, {
        rescheduledFromUid: a,
        start: '2026-10-09T13:00:00.000Z',
        end: '2026-10-09T13:30:00.000Z',
        createdAt: '2026-09-30T14:00:00.000Z',
        updatedAt: '2026-09-30T14:00:00.000Z',
      }),
    ]);
    expect(counts).toMatchObject({ chains: 1, synthesized: 1, applied: 1 });
    const repaired = await meeting(a);
    expect(repaired).toMatchObject({ state: 'rescheduled', current_booking_uid: b });
    expect(repaired?.starts_at.toISOString()).toBe('2026-10-09T13:00:00.000Z');
  });

  it('is a no-op when the same run is replayed', async () => {
    const id = uid();
    await webhook('BOOKING_CREATED', '2026-09-30T12:00:00.000Z', webhookBooking(id));
    const bookings = [parsed(id, { status: 'cancelled', updatedAt: '2026-09-30T15:00:00.000Z' })];
    expect((await reconcile(bookings)).applied).toBe(1);
    const before = await eventCount();
    const replay = await reconcile(bookings);
    expect(replay).toMatchObject({ synthesized: 0, applied: 0, unchanged: 1 });
    expect(await eventCount()).toBe(before);
  });

  it('keeps a newer webhook authoritative: an older API answer is recorded stale, once', async () => {
    const id = uid();
    await webhook('BOOKING_CREATED', '2026-09-30T12:00:00.000Z', webhookBooking(id));
    // The webhook moved the time at 16:00; the API's page was read before that.
    await webhook(
      'BOOKING_CREATED',
      '2026-09-30T16:00:00.000Z',
      webhookBooking(id, { startTime: '2026-10-07T15:00:00.000Z', endTime: '2026-10-07T15:30:00.000Z' }),
    );
    const older = [parsed(id, { updatedAt: '2026-09-30T15:00:00.000Z' })];
    expect(await reconcile(older)).toMatchObject({ synthesized: 1, stale: 1, applied: 0 });
    expect((await meeting(id))?.starts_at.toISOString()).toBe('2026-10-07T15:00:00.000Z');
    // Replayed, the stale delivery is a duplicate: one row, not one an hour.
    const before = await eventCount();
    expect(await reconcile(older)).toMatchObject({ synthesized: 1, duplicate: 1 });
    expect(await eventCount()).toBe(before);
  });

  it('records a booking whose webhook never came, and moves the pipeline as the webhook would', async () => {
    const id = uid();
    expect(await reconcile([parsed(id)])).toMatchObject({ synthesized: 1, applied: 1 });
    expect((await meeting(id))?.state).toBe('booked');
    const { rows } = await database.session.query<{ key: string }>(
      `SELECT s.key FROM meetings m
         JOIN opportunities o ON o.workspace_id = m.workspace_id AND o.id = m.opportunity_id
         JOIN pipeline_stages s ON s.workspace_id = o.workspace_id AND s.id = o.stage_id
        WHERE m.workspace_id = $1 AND m.booking_uid = $2`,
      [workspaceId(), id],
    );
    expect(rows[0]?.key).toBe('demo_booked');
  });

  it('marks a past meeting held, and an absent attendee a no-show, then its reversal', async () => {
    const held = uid();
    const absent = uid();
    await webhook('BOOKING_CREATED', '2026-09-28T12:00:00.000Z', webhookBooking(held, { startTime: '2026-09-29T15:00:00.000Z', endTime: '2026-09-29T15:30:00.000Z' }));
    await webhook('BOOKING_CREATED', '2026-09-28T12:00:00.000Z', webhookBooking(absent, { startTime: '2026-09-29T15:00:00.000Z', endTime: '2026-09-29T15:30:00.000Z' }));
    const past = { start: '2026-09-29T15:00:00.000Z', end: '2026-09-29T15:30:00.000Z', updatedAt: '2026-09-28T12:00:00.000Z' };
    await reconcile([
      parsed(held, past),
      parsed(absent, { ...past, attendees: [{ email: ATTENDEE, absent: true }], updatedAt: '2026-09-29T16:00:00.000Z' }),
    ]);
    expect((await meeting(held))?.state).toBe('held');
    expect((await meeting(absent))?.state).toBe('no_show');
    // The mark is taken back in Cal.com.
    const reversed = [parsed(absent, { ...past, updatedAt: '2026-09-29T17:00:00.000Z' })];
    await reconcile(reversed);
    expect((await meeting(absent))?.state).toBe('booked');
    // The next run converges: the meeting is past its end, so it was held (fold 1,
    // finding 5). Its end is dated just after the reversal, not behind it.
    expect(await reconcile(reversed)).toMatchObject({ synthesized: 1, applied: 1 });
    expect((await meeting(absent))?.state).toBe('held');
    expect(await reconcile(reversed)).toMatchObject({ synthesized: 0 });
  });

  it('never deletes a meeting, and leaves alone a booking the API no longer lists', async () => {
    const id = uid();
    await webhook('BOOKING_CREATED', '2026-09-30T12:00:00.000Z', webhookBooking(id));
    const { rows: before } = await database.session.query<{ count: string }>('SELECT count(*) AS count FROM meetings WHERE workspace_id = $1', [workspaceId()]);
    expect(await reconcile([])).toMatchObject({ bookings: 0, synthesized: 0 });
    const { rows: after } = await database.session.query<{ count: string }>('SELECT count(*) AS count FROM meetings WHERE workspace_id = $1', [workspaceId()]);
    expect(after[0]?.count).toBe(before[0]?.count);
    expect((await meeting(id))?.state).toBe('booked');
  });

  it('records nothing for a pending or rejected booking', async () => {
    const pending = uid();
    const rejected = uid();
    const counts = await reconcile([parsed(pending, { status: 'pending' }), parsed(rejected, { status: 'rejected' })]);
    expect(counts).toMatchObject({ synthesized: 0, skipped: 2 });
    for (const id of [pending, rejected]) expect(await meeting(id)).toBeUndefined();
  });

  // ---- review fold 1, finding 1: reschedule identities through cancellations --------
  it('folds a lost A→B and a lost cancellation of B into the one meeting', async () => {
    const a = uid();
    const b = uid();
    await webhook('BOOKING_CREATED', '2026-09-30T12:00:00.000Z', webhookBooking(a));
    await reconcile([
      parsed(a, { status: 'cancelled', rescheduledToUid: b, updatedAt: '2026-09-30T13:00:00.000Z' }),
      parsed(b, {
        status: 'cancelled',
        rescheduledFromUid: a,
        start: '2026-10-09T13:00:00.000Z',
        end: '2026-10-09T13:30:00.000Z',
        createdAt: '2026-09-30T13:00:00.000Z',
        updatedAt: '2026-09-30T14:00:00.000Z',
      }),
    ]);
    expect(await meetingsNamed([a, b])).toEqual([{ booking_uid: a, current_booking_uid: b, state: 'cancelled' }]);
  });

  it('follows A→B→C through a cancelled intermediate B to C s time', async () => {
    const [a, b, c] = [uid(), uid(), uid()];
    await webhook('BOOKING_CREATED', '2026-09-30T12:00:00.000Z', webhookBooking(a));
    await reconcile([
      parsed(a, { status: 'cancelled', rescheduledToUid: b, updatedAt: '2026-09-30T13:00:00.000Z' }),
      parsed(b, { status: 'cancelled', rescheduledFromUid: a, rescheduledToUid: c, createdAt: '2026-09-30T13:00:00.000Z', updatedAt: '2026-09-30T14:00:00.000Z' }),
      parsed(c, {
        rescheduledFromUid: b,
        start: '2026-10-12T18:00:00.000Z',
        end: '2026-10-12T18:30:00.000Z',
        createdAt: '2026-09-30T14:00:00.000Z',
        updatedAt: '2026-09-30T14:00:00.000Z',
      }),
    ]);
    expect(await meetingsNamed([a, b, c])).toEqual([{ booking_uid: a, current_booking_uid: c, state: 'rescheduled' }]);
    expect((await meeting(c))?.starts_at.toISOString()).toBe('2026-10-12T18:00:00.000Z');
  });

  it('records a cancellation it never saw, so an older create delivered later is stale', async () => {
    const a = uid();
    const b = uid();
    const lone = uid();
    await reconcile([
      parsed(a, { status: 'cancelled', rescheduledToUid: b, updatedAt: '2026-09-30T13:00:00.000Z' }),
      parsed(b, { status: 'cancelled', rescheduledFromUid: a, createdAt: '2026-09-30T13:00:00.000Z', updatedAt: '2026-09-30T14:00:00.000Z' }),
      parsed(lone, { status: 'cancelled', updatedAt: '2026-09-30T13:00:00.000Z' }),
    ]);
    expect(await meetingsNamed([a, b])).toEqual([{ booking_uid: a, current_booking_uid: b, state: 'cancelled' }]);
    // The original's create, delivered late with new bytes: history, not a second meeting.
    await webhook('BOOKING_CREATED', '2026-09-30T11:00:00.000Z', webhookBooking(a));
    await webhook('BOOKING_CREATED', '2026-09-30T11:00:00.000Z', webhookBooking(lone));
    expect(await meetingsNamed([a, b])).toEqual([{ booking_uid: a, current_booking_uid: b, state: 'cancelled' }]);
    expect(await meetingsNamed([lone])).toEqual([{ booking_uid: lone, current_booking_uid: lone, state: 'cancelled' }]);
  });

  // ---- review fold 2: one meeting per chain, through the uid aliases (0029) -----------
  async function resolvedMeetings(uids: readonly string[]): Promise<string[]> {
    const { rows } = await database.session.query<{ booking_uid: string; meeting_id: string }>(
      'SELECT booking_uid, meeting_id FROM meeting_booking_uids WHERE workspace_id = $1 AND booking_uid = ANY($2::text[]) ORDER BY booking_uid',
      [workspaceId(), [...uids]],
    );
    expect(rows.map(row => row.booking_uid).sort()).toEqual([...uids].sort());
    return [...new Set(rows.map(row => row.meeting_id))];
  }

  it('folds A into B s row when B s cancellation webhook already made one (fold 2, B)', async () => {
    const a = uid();
    const b = uid();
    await webhook('BOOKING_CREATED', '2026-09-30T12:00:00.000Z', webhookBooking(a));
    // A→B is lost; B's cancellation arrives and, knowing nothing of A, records B alone.
    await webhook('BOOKING_CANCELLED', '2026-09-30T14:00:00.000Z', webhookBooking(b, { startTime: '2026-10-09T13:00:00.000Z', endTime: '2026-10-09T13:30:00.000Z' }));
    expect(await meetingsNamed([a, b])).toHaveLength(2);
    await reconcile([
      parsed(a, { status: 'cancelled', rescheduledToUid: b, updatedAt: '2026-09-30T13:00:00.000Z' }),
      parsed(b, { status: 'cancelled', rescheduledFromUid: a, createdAt: '2026-09-30T13:00:00.000Z', updatedAt: '2026-09-30T14:00:00.000Z' }),
    ]);
    expect(await meetingsNamed([a, b])).toEqual([{ booking_uid: a, current_booking_uid: b, state: 'cancelled' }]);
    expect(await resolvedMeetings([a, b])).toHaveLength(1);
  });

  it('folds the two rows even when the link it would synthesize is older than the original s last event (fold 2, B)', async () => {
    const a = uid();
    const b = uid();
    await webhook('BOOKING_CREATED', '2026-09-30T12:00:00.000Z', webhookBooking(a));
    // A redelivery of A's create with new bytes, later than the reschedule it predates.
    await webhook('BOOKING_CREATED', '2026-09-30T15:00:00.000Z', webhookBooking(a, { title: 'redelivered' }));
    // A→B at 13:00 is lost; B's cancellation at 16:00 records B on a row of its own.
    await webhook('BOOKING_CANCELLED', '2026-09-30T16:00:00.000Z', webhookBooking(b));
    await reconcile([
      parsed(a, { status: 'cancelled', rescheduledToUid: b, updatedAt: '2026-09-30T13:00:00.000Z' }),
      parsed(b, { status: 'cancelled', rescheduledFromUid: a, createdAt: '2026-09-30T13:00:00.000Z', updatedAt: '2026-09-30T16:00:00.000Z' }),
    ]);
    // The A→B link is stale against A's 15:00 event, so W's own fold never runs; the
    // chain's fold does, and the newest row (B, cancelled) wins.
    expect(await meetingsNamed([a, b])).toEqual([{ booking_uid: a, current_booking_uid: b, state: 'cancelled' }]);
    expect(await resolvedMeetings([a, b])).toHaveLength(1);
  });

  it('keeps B of an unknown A→B→C, so a delayed create of B is stale (fold 2, C)', async () => {
    const [a, b, c] = [uid(), uid(), uid()];
    await reconcile([
      parsed(a, { status: 'cancelled', rescheduledToUid: b, updatedAt: '2026-09-30T13:00:00.000Z' }),
      parsed(b, { status: 'cancelled', rescheduledFromUid: a, rescheduledToUid: c, createdAt: '2026-09-30T13:00:00.000Z', updatedAt: '2026-09-30T14:00:00.000Z' }),
      parsed(c, { rescheduledFromUid: b, createdAt: '2026-09-30T14:00:00.000Z', updatedAt: '2026-09-30T14:00:00.000Z' }),
    ]);
    expect(await resolvedMeetings([a, b, c])).toHaveLength(1);
    await webhook('BOOKING_CREATED', '2026-09-30T13:00:00.000Z', webhookBooking(b));
    expect(await meetingsNamed([a, b, c])).toEqual([{ booking_uid: a, current_booking_uid: c, state: 'rescheduled' }]);
    expect(await resolvedMeetings([a, b, c])).toHaveLength(1);
  });

  it('leaves one meeting for A→B→C whatever the order of the webhooks, mixed with reconciliation (fold 2, C)', async () => {
    const orders = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ] as const;
    for (const [index, order] of orders.entries()) {
      const [a, b, c] = [uid(), uid(), uid()];
      const events = [
        () => webhook('BOOKING_CREATED', '2026-09-30T12:00:00.000Z', webhookBooking(a)),
        () => webhook('BOOKING_RESCHEDULED', '2026-09-30T13:00:00.000Z', webhookBooking(b, { rescheduleUid: a, startTime: '2026-10-08T15:00:00.000Z', endTime: '2026-10-08T15:30:00.000Z' })),
        () => webhook('BOOKING_RESCHEDULED', '2026-09-30T14:00:00.000Z', webhookBooking(c, { rescheduleUid: b, startTime: '2026-10-09T15:00:00.000Z', endTime: '2026-10-09T15:30:00.000Z' })),
      ];
      const snapshot = [
        parsed(a, { status: 'cancelled', rescheduledToUid: b, updatedAt: '2026-09-30T13:00:00.000Z' }),
        parsed(b, { status: 'cancelled', rescheduledFromUid: a, rescheduledToUid: c, createdAt: '2026-09-30T13:00:00.000Z', updatedAt: '2026-09-30T14:00:00.000Z' }),
        parsed(c, { rescheduledFromUid: b, start: '2026-10-09T15:00:00.000Z', end: '2026-10-09T15:30:00.000Z', createdAt: '2026-09-30T14:00:00.000Z', updatedAt: '2026-09-30T14:00:00.000Z' }),
      ];
      // The reconciliation runs at a different point of each order: after the first,
      // second or third delivery.
      for (const [step, which] of order.entries()) {
        await events[which]?.();
        if (step === index % 3) await reconcile(snapshot);
      }
      await reconcile(snapshot);
      expect(await meetingsNamed([a, b, c]), `order ${order.join('')}`).toEqual([{ booking_uid: a, current_booking_uid: c, state: 'rescheduled' }]);
      expect(await resolvedMeetings([a, b, c]), `order ${order.join('')}`).toHaveLength(1);
      expect((await meeting(c))?.starts_at.toISOString()).toBe('2026-10-09T15:00:00.000Z');
    }
  });

  // ---- review fold 1, finding 2: derived events respect freshness and identity -------
  it('does not let an old snapshot s end mark a newer reschedule held', async () => {
    const a = uid();
    const b = uid();
    // A for today 11:00–11:30, booked at 09:00; the 11:00 webhook moves it to B tomorrow.
    await webhook('BOOKING_CREATED', '2026-10-01T09:00:00.000Z', webhookBooking(a, { startTime: '2026-10-01T11:00:00.000Z', endTime: '2026-10-01T11:30:00.000Z' }));
    await webhook(
      'BOOKING_RESCHEDULED',
      '2026-10-01T11:00:00.000Z',
      webhookBooking(b, { rescheduleUid: a, startTime: '2026-10-02T11:00:00.000Z', endTime: '2026-10-02T11:30:00.000Z' }),
    );
    // Noon: the API's page still has the 09:00 view of A.
    const counts = await reconcile([
      parsed(a, { start: '2026-10-01T11:00:00.000Z', end: '2026-10-01T11:30:00.000Z', createdAt: '2026-10-01T09:00:00.000Z', updatedAt: '2026-10-01T09:00:00.000Z' }),
    ]);
    expect(counts).toMatchObject({ synthesized: 0 });
    expect(await meetingsNamed([a, b])).toEqual([{ booking_uid: a, current_booking_uid: b, state: 'rescheduled' }]);
    const { rows } = await database.session.query<{ count: string }>(
      "SELECT count(*) AS count FROM funnel_facts WHERE workspace_id = $1 AND kind = 'meeting.held' AND dedupe_key = $2",
      [workspaceId(), a],
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });

  // ---- review fold 1, finding 3: a deleted person is not read back -------------------
  it('tombstones an attendee the suppression canonicalizer refuses, and does not bring it back (fold 2, D i)', async () => {
    const id = uid();
    const attendee = 'josé@unicode-law.example';
    const { rows: firmRows } = await database.session.query<{ id: string }>(
      `INSERT INTO firms (workspace_id, name, website, assigned_user_id) VALUES ($1, 'Unicode Law', 'https://unicode-law.example', $2) RETURNING id`,
      [workspaceId(), seeded.alpha.salesperson.userId],
    );
    const firmId = firmRows[0]?.id ?? '';
    await webhook('BOOKING_CREATED', '2026-09-30T12:00:00.000Z', webhookBooking(id, { attendees: [{ email: 'JOSÉ@Unicode-Law.example' }] }));
    const { rows: stored } = await database.session.query<{ attendee_email: string; firm_id: string }>(
      'SELECT attendee_email, firm_id FROM meetings WHERE workspace_id = $1 AND booking_uid = $2',
      [workspaceId(), id],
    );
    expect(stored).toEqual([{ attendee_email: attendee, firm_id: firmId }]);
    const admin = repositoryContext(
      workspaceScope(workspaceId(), { kind: 'user', userId: seeded.alpha.admin.userId, role: 'admin' }),
      database.session,
    );
    const preview = await withTransaction(database.session, async () => await previewDeletion(admin, { targetKind: 'firm', firmId }));
    expect(preview.value?.tombstoneHandles).toContain(attendee);
    const committed = await withTransaction(database.session, async () =>
      await commitDeletion(admin, {
        requestId: preview.value?.requestId ?? '',
        previewHash: preview.value?.previewHash ?? '',
        commandId: `delete-${id}`,
        journal: recordingSuppressionJournal(),
      }),
    );
    expect(committed.ok, committed.ok ? '' : committed.reason).toBe(true);
    const { rows: tombstones } = await database.session.query<{ count: string }>(
      "SELECT count(*) AS count FROM suppression_events WHERE workspace_id = $1 AND scope = 'handle' AND canonical_key = $2 AND source = 'deletion_tombstone'",
      [workspaceId(), attendee],
    );
    expect(Number(tombstones[0]?.count)).toBe(1);
    expect(await reconcile([parsed(id, { attendees: [{ email: 'josé@unicode-law.example', absent: false }] })])).toMatchObject({ tombstoned: 1, synthesized: 0 });
    const { rows } = await database.session.query<{ count: string }>('SELECT count(*) AS count FROM meetings WHERE workspace_id = $1 AND attendee_email = $2', [
      workspaceId(),
      attendee,
    ]);
    expect(Number(rows[0]?.count)).toBe(0);
  });

  it('does not bring back a meeting or an address deletion removed', async () => {
    const id = uid();
    const attendee = 'deleted.person@tombstone-law.example';
    const { rows: firmRows } = await database.session.query<{ id: string }>(
      `INSERT INTO firms (workspace_id, name, website, assigned_user_id) VALUES ($1, 'Tombstone Law', 'https://tombstone-law.example', $2) RETURNING id`,
      [workspaceId(), seeded.alpha.salesperson.userId],
    );
    const firmId = firmRows[0]?.id ?? '';
    // Matched by domain: the attendee is on no route, so only the meeting holds the address.
    await webhook('BOOKING_CREATED', '2026-09-30T12:00:00.000Z', webhookBooking(id, { attendees: [{ email: attendee }] }));
    expect((await meeting(id))?.state).toBe('booked');
    const admin = repositoryContext(
      workspaceScope(workspaceId(), { kind: 'user', userId: seeded.alpha.admin.userId, role: 'admin' }),
      database.session,
    );
    const preview = await withTransaction(database.session, async () => await previewDeletion(admin, { targetKind: 'firm', firmId }));
    const committed = await withTransaction(database.session, async () =>
      await commitDeletion(admin, {
        requestId: preview.value?.requestId ?? '',
        previewHash: preview.value?.previewHash ?? '',
        commandId: `delete-${id}`,
        journal: recordingSuppressionJournal(),
      }),
    );
    expect(committed.ok, committed.ok ? '' : committed.reason).toBe(true);
    expect(await meeting(id)).toBeUndefined();

    expect(await reconcile([parsed(id, { attendees: [{ email: attendee, absent: false }] })])).toMatchObject({ tombstoned: 1, synthesized: 0 });
    expect(await meeting(id)).toBeUndefined();
    const { rows } = await database.session.query<{ count: string }>(
      `SELECT (SELECT count(*) FROM meetings WHERE workspace_id = $1 AND attendee_email = $2)
            + (SELECT count(*) FROM email_addresses WHERE workspace_id = $1 AND address = $2) AS count`,
      [workspaceId(), attendee],
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });

  // ---- review fold 3, finding 6: a successor beyond the window is still a link -------
  it('records A→B when only A is listed, so B s cancellation lands on the one meeting (fold 3, item 6)', async () => {
    const [z, a, b] = [uid(), uid(), uid()];
    await webhook('BOOKING_CREATED', '2026-09-30T12:00:00.000Z', webhookBooking(a));
    // Cal.com lists A (which came from Z, moved to B); B itself is beyond the window.
    const counts = await reconcile([
      parsed(a, { status: 'cancelled', rescheduledFromUid: z, rescheduledToUid: b, updatedAt: '2026-09-30T13:00:00.000Z' }),
    ]);
    expect(counts).toMatchObject({ successors: 1, synthesized: 0 });
    expect(await meetingsNamed([a, b])).toEqual([{ booking_uid: a, current_booking_uid: b, state: 'rescheduled' }]);
    // A's times until B's body arrives.
    expect((await meeting(b))?.starts_at.toISOString()).toBe('2026-10-06T15:00:00.000Z');
    expect(await resolvedMeetings([z, a, b])).toHaveLength(1);

    await webhook('BOOKING_CANCELLED', '2026-09-30T14:00:00.000Z', webhookBooking(b, { startTime: '2026-10-09T13:00:00.000Z', endTime: '2026-10-09T13:30:00.000Z' }));
    expect(await meetingsNamed([z, a, b])).toEqual([{ booking_uid: a, current_booking_uid: b, state: 'cancelled' }]);
    expect(await resolvedMeetings([z, a, b])).toHaveLength(1);
    // A replay of the same read changes nothing.
    await reconcile([parsed(a, { status: 'cancelled', rescheduledFromUid: z, rescheduledToUid: b, updatedAt: '2026-09-30T13:00:00.000Z' })]);
    expect(await meetingsNamed([z, a, b])).toEqual([{ booking_uid: a, current_booking_uid: b, state: 'cancelled' }]);
  });

  it('folds B s row into A when B s cancellation came first and only A is listed (fold 3, item 6)', async () => {
    const [a, b] = [uid(), uid()];
    await webhook('BOOKING_CREATED', '2026-09-30T12:00:00.000Z', webhookBooking(a));
    await webhook('BOOKING_CANCELLED', '2026-09-30T14:00:00.000Z', webhookBooking(b));
    expect(await resolvedMeetings([a, b])).toHaveLength(2);
    await reconcile([parsed(a, { status: 'cancelled', rescheduledToUid: b, updatedAt: '2026-09-30T13:00:00.000Z' })]);
    expect(await meetingsNamed([a, b])).toEqual([{ booking_uid: a, current_booking_uid: b, state: 'cancelled' }]);
    expect(await resolvedMeetings([a, b])).toHaveLength(1);
  });

  it('does not take a successor from a snapshot older than the meeting s last event (fold 3, item 6)', async () => {
    const [a, b] = [uid(), uid()];
    await webhook('BOOKING_CREATED', '2026-09-30T15:00:00.000Z', webhookBooking(a));
    expect(await reconcile([parsed(a, { status: 'cancelled', rescheduledToUid: b, updatedAt: '2026-09-30T13:00:00.000Z' })])).toMatchObject({ successors: 0 });
    expect(await meetingsNamed([a, b])).toEqual([{ booking_uid: a, current_booking_uid: a, state: 'booked' }]);
  });

  // ---- review fold 3, finding 7: a fold never loses an attendee ------------------------
  async function deleteFirm(firmId: string, commandId: string): Promise<readonly string[]> {
    const admin = repositoryContext(
      workspaceScope(workspaceId(), { kind: 'user', userId: seeded.alpha.admin.userId, role: 'admin' }),
      database.session,
    );
    const preview = await withTransaction(database.session, async () => await previewDeletion(admin, { targetKind: 'firm', firmId }));
    const committed = await withTransaction(database.session, async () =>
      await commitDeletion(admin, {
        requestId: preview.value?.requestId ?? '',
        previewHash: preview.value?.previewHash ?? '',
        commandId,
        journal: recordingSuppressionJournal(),
      }),
    );
    expect(committed.ok, committed.ok ? '' : committed.reason).toBe(true);
    return preview.value?.tombstoneHandles ?? [];
  }

  it('keeps the attendee of a folded row, so deleting the firm keeps the person deleted (fold 3, item 7)', async () => {
    const [a, b] = [uid(), uid()];
    const attendee = 'person@fold-law.example';
    const { rows: firmRows } = await database.session.query<{ id: string }>(
      `INSERT INTO firms (workspace_id, name, website, assigned_user_id) VALUES ($1, 'Fold Law', 'https://fold-law.example', $2) RETURNING id`,
      [workspaceId(), seeded.alpha.salesperson.userId],
    );
    const firmId = firmRows[0]?.id ?? '';
    // A arrived with no attendee; A→B was lost; B's cancellation carries the person and is
    // matched to the firm by domain (no e-mail route holds the address).
    await webhook('BOOKING_CREATED', '2026-09-30T12:00:00.000Z', webhookBooking(a, { attendees: [] }));
    await webhook('BOOKING_CANCELLED', '2026-09-30T14:00:00.000Z', webhookBooking(b, { attendees: [{ email: attendee }] }));
    const snapshot = [
      parsed(a, { status: 'cancelled', rescheduledToUid: b, updatedAt: '2026-09-30T13:00:00.000Z', attendees: [] }),
      parsed(b, { status: 'cancelled', rescheduledFromUid: a, createdAt: '2026-09-30T13:00:00.000Z', updatedAt: '2026-09-30T14:00:00.000Z', attendees: [{ email: attendee, absent: false }] }),
    ];
    await reconcile(snapshot);
    const { rows: folded } = await database.session.query<{ attendee_email: string | null; firm_id: string | null }>(
      'SELECT attendee_email, firm_id FROM meetings WHERE workspace_id = $1 AND booking_uid = $2',
      [workspaceId(), a],
    );
    expect(folded).toEqual([{ attendee_email: attendee, firm_id: firmId }]);
    expect(await resolvedMeetings([a, b])).toHaveLength(1);

    expect(await deleteFirm(firmId, `delete-${a}`)).toContain(attendee);
    expect(await reconcile(snapshot)).toMatchObject({ tombstoned: 1, synthesized: 0 });
    expect(await meetingsNamed([a, b])).toEqual([]);
    const { rows } = await database.session.query<{ count: string }>('SELECT count(*) AS count FROM meetings WHERE workspace_id = $1 AND attendee_email = $2', [
      workspaceId(),
      attendee,
    ]);
    expect(Number(rows[0]?.count)).toBe(0);
  });

  it('does not fold rows booked by different attendees, and asks a person (fold 3, item 7)', async () => {
    const [a, b] = [uid(), uid()];
    await webhook('BOOKING_CREATED', '2026-09-30T12:00:00.000Z', webhookBooking(a, { attendees: [{ email: 'first.person@elsewhere.example' }] }));
    await webhook('BOOKING_CANCELLED', '2026-09-30T14:00:00.000Z', webhookBooking(b, { attendees: [{ email: 'Second.Person@elsewhere.example' }] }));
    const ids = async (): Promise<string[]> => {
      const { rows } = await database.session.query<{ id: string }>(
        'SELECT id FROM meetings WHERE workspace_id = $1 AND booking_uid = ANY($2::text[]) ORDER BY id',
        [workspaceId(), [a, b]],
      );
      return rows.map(row => row.id);
    };
    const before = await ids();
    expect(before).toHaveLength(2);

    // The webhook's own fold (A→B delivered late) and the reconciliation's both refuse.
    await webhook('BOOKING_RESCHEDULED', '2026-09-30T13:00:00.000Z', webhookBooking(b, { rescheduleUid: a, attendees: [{ email: 'second.person@elsewhere.example' }] }));
    const counts = await reconcile([
      parsed(a, { status: 'cancelled', rescheduledToUid: b, updatedAt: '2026-09-30T13:00:00.000Z', attendees: [{ email: 'first.person@elsewhere.example', absent: false }] }),
      parsed(b, { status: 'cancelled', rescheduledFromUid: a, createdAt: '2026-09-30T13:00:00.000Z', updatedAt: '2026-09-30T14:00:00.000Z', attendees: [{ email: 'second.person@elsewhere.example', absent: false }] }),
    ]);
    expect(counts).toMatchObject({ conflicted: 1, synthesized: 0 });
    expect(await ids()).toEqual(before);
    expect(await meetingsNamed([a, b])).toEqual([
      { booking_uid: a, current_booking_uid: a, state: 'booked' },
      { booking_uid: b, current_booking_uid: b, state: 'cancelled' },
    ].sort((left, right) => left.booking_uid.localeCompare(right.booking_uid)));
    // Each keeps its own uid.
    const { rows: aliases } = await database.session.query<{ booking_uid: string; meeting_id: string }>(
      'SELECT a.booking_uid, a.meeting_id FROM meeting_booking_uids a WHERE a.workspace_id = $1 AND a.booking_uid = ANY($2::text[])',
      [workspaceId(), [a, b]],
    );
    expect(new Set(aliases.map(row => row.meeting_id)).size).toBe(2);
    const { rows: items } = await database.session.query<{ evidence_id: string; detail: { meetingIds: string } }>(
      "SELECT evidence_id, detail FROM stage_review_items WHERE workspace_id = $1 AND evidence_kind = 'meeting.attendee_conflict' AND resolved_at IS NULL",
      [workspaceId()],
    );
    const item = items.find(row => row.detail.meetingIds === before.join(','));
    expect(item?.evidence_id).toMatch(/^c[0-9a-f]{64}$/u);
  });

  // ---- review fold 4: conflicts of any size, and a successor's own times ----------------
  /** `count` meetings booked by different people on one chain, each at a firm of its own. */
  async function conflictingChain(count: number, label: string, uidOf: (index: number) => string): Promise<{ uids: string[]; snapshot: CalcomBooking[] }> {
    const uids = Array.from({ length: count }, (_, index) => uidOf(index));
    for (const [index, id] of uids.entries()) {
      await database.session.query(
        `INSERT INTO firms (workspace_id, name, website, assigned_user_id) VALUES ($1, $2, $3, $4)`,
        [workspaceId(), `${label} ${String(index)} Law`, `https://${label}${String(index)}-law.example`, seeded.alpha.salesperson.userId],
      );
      await webhook('BOOKING_CREATED', '2026-09-30T12:00:00.000Z', webhookBooking(id, { attendees: [{ email: `person@${label}${String(index)}-law.example` }] }));
    }
    const snapshot = uids.map((id, index) =>
      parsed(id, {
        status: index === count - 1 ? 'accepted' : 'cancelled',
        rescheduledFromUid: index === 0 ? null : uids[index - 1],
        rescheduledToUid: index === count - 1 ? null : uids[index + 1],
        createdAt: '2026-09-30T13:00:00.000Z',
        updatedAt: '2026-09-30T13:00:00.000Z',
        attendees: [{ email: `person@${label}${String(index)}-law.example`, absent: false }],
      }),
    );
    return { uids, snapshot };
  }

  const conflictItems = async (): Promise<{ id: string; meetingIds: string[] }[]> => {
    const { rows } = await database.session.query<{ id: string; detail: { meetingIds: string } }>(
      "SELECT id, detail FROM stage_review_items WHERE workspace_id = $1 AND evidence_kind = 'meeting.attendee_conflict'",
      [workspaceId()],
    );
    return rows.map(row => ({ id: row.id, meetingIds: row.detail.meetingIds.split(',') }));
  };

  it('removes a six-member conflict item when the firm of its sixth member is deleted (fold 4, item 1)', async () => {
    const { uids, snapshot } = await conflictingChain(6, 'sixway', index => `six${String(index)}${uid()}`);
    expect(await reconcile(snapshot)).toMatchObject({ conflicted: 1, conflictsUnrecorded: 0 });
    const { rows } = await database.session.query<{ id: string; firm_id: string }>(
      'SELECT id, firm_id FROM meetings WHERE workspace_id = $1 AND booking_uid = ANY($2::text[]) ORDER BY id',
      [workspaceId(), uids],
    );
    expect(rows).toHaveLength(6);
    const item = (await conflictItems()).find(entry => entry.meetingIds.length === 6);
    expect(item?.meetingIds).toEqual(rows.map(row => row.id));
    // The member that sorts last: beyond any five-id key.
    await deleteFirm(rows[5]?.firm_id ?? '', `delete-six-${uids[0] ?? ''}`);
    expect((await conflictItems()).map(entry => entry.id)).not.toContain(item?.id);
  });

  it('records a thirteen-member conflict of 128-character uids and goes on with the run (fold 4, item 2)', async () => {
    const { uids, snapshot } = await conflictingChain(13, 'thirteen', index => `${String(index).padStart(2, '0')}${uid()}`.padEnd(128, 'u'));
    expect(uids.every(id => id.length === 128)).toBe(true);
    const other = uid();
    const counts = await reconcile([...snapshot, parsed(other, { attendees: [{ email: 'after.conflict@elsewhere.example', absent: false }] })]);
    expect(counts).toMatchObject({ conflicted: 1, conflictsUnrecorded: 0 });
    expect(await meetingsNamed([other])).toEqual([{ booking_uid: other, current_booking_uid: other, state: 'booked' }]);
    expect((await conflictItems()).some(entry => entry.meetingIds.length === 13)).toBe(true);
  });

  it('leaves apart and does not record a membership too large for a review item, without throwing (fold 4, item 2)', async () => {
    const rows = Array.from({ length: 60 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      firm_id: null,
      contact_id: null,
      opportunity_id: null,
      state: 'booked' as const,
      state_before_no_show: null,
      booking_uid: `big${String(index)}`,
      current_booking_uid: `big${String(index)}`,
      starts_at: new Date(),
      ends_at: new Date(),
      last_event_at: new Date(),
      attendee_email: `p${String(index)}@big.example`,
    }));
    const before = (await conflictItems()).length;
    const context = repositoryContext(workspaceScope(workspaceId(), { kind: 'system', component: 'worker' }), database.session);
    expect(await withTransaction(database.session, async () => await openAttendeeConflict(context, rows))).toBe(false);
    expect((await conflictItems()).length).toBe(before);
  });

  it('gives a meeting linked to an unlisted successor that booking s own times from its cancellation (fold 4, item 3)', async () => {
    const [a, b] = [uid(), uid()];
    await webhook('BOOKING_CREATED', '2026-09-30T12:00:00.000Z', webhookBooking(a));
    await reconcile([parsed(a, { status: 'cancelled', rescheduledToUid: b, updatedAt: '2026-09-30T13:00:00.000Z' })]);
    expect((await meeting(b))?.starts_at.toISOString()).toBe('2026-10-06T15:00:00.000Z');
    await webhook('BOOKING_CANCELLED', '2026-09-30T14:00:00.000Z', webhookBooking(b, { startTime: '2026-10-09T13:00:00.000Z', endTime: '2026-10-09T13:30:00.000Z' }));
    const after = await meeting(b);
    expect(after?.state).toBe('cancelled');
    expect(after?.starts_at.toISOString()).toBe('2026-10-09T13:00:00.000Z');
    // A later, older-dated event about B changes nothing: cancelled is terminal.
    await webhook('BOOKING_CANCELLED', '2026-09-30T13:30:00.000Z', webhookBooking(b, { startTime: '2026-10-10T13:00:00.000Z', endTime: '2026-10-10T13:30:00.000Z' }));
    expect((await meeting(b))?.starts_at.toISOString()).toBe('2026-10-09T13:00:00.000Z');
  });
});

describe('planChain', () => {
  const stored = (state: string, extra: Partial<{ current_booking_uid: string; starts_at: Date; ends_at: Date; last_event_at: Date }> = {}) => ({
    id: 'm',
    state: state as 'booked',
    current_booking_uid: 'u1x',
    starts_at: new Date('2026-10-06T15:00:00.000Z'),
    ends_at: new Date('2026-10-06T15:30:00.000Z'),
    last_event_at: new Date('2026-09-30T12:00:00.000Z'),
    ...extra,
  });
  const only = (booking: CalcomBooking) => {
    const chain = bookingChains([booking])[0];
    if (chain === undefined) throw new Error('no chain');
    return chain;
  };

  it('dates a cancellation by the booking s own updatedAt, and an end by its end', () => {
    const cancelled = parsed('u1x', { status: 'cancelled', updatedAt: '2026-09-30T13:00:00.000Z' });
    expect(planChain(only(cancelled), stored('booked'), NOW).map(event => [event.trigger, event.instant])).toEqual([
      ['BOOKING_CANCELLED', '2026-09-30T13:00:00.000Z'],
    ]);
    const past = { starts_at: new Date('2026-09-29T15:00:00.000Z'), ends_at: new Date('2026-09-29T15:30:00.000Z'), last_event_at: new Date('2026-09-28T12:00:00.000Z') };
    const ended = parsed('u1x', { start: '2026-09-29T15:00:00.000Z', end: '2026-09-29T15:30:00.000Z', updatedAt: '2026-09-28T12:00:00.000Z' });
    expect(planChain(only(ended), stored('booked', past), NOW).map(event => [event.trigger, event.instant])).toEqual([
      ['MEETING_ENDED', '2026-09-29T15:30:00.000Z'],
    ]);
  });

  it('plans nothing for a cancelled meeting, an unchanged one, or one that moved past the snapshot', () => {
    expect(planChain(only(parsed('u1x')), stored('cancelled'), NOW)).toEqual([]);
    expect(planChain(only(parsed('u1x')), stored('booked'), NOW)).toEqual([]);
    expect(planChain(only(parsed('u1x')), stored('rescheduled', { current_booking_uid: 'u2x' }), NOW)).toEqual([]);
  });

  it('plans no derived event from a snapshot older than the meeting s last event', () => {
    const past = { starts_at: new Date('2026-09-29T15:00:00.000Z'), ends_at: new Date('2026-09-29T15:30:00.000Z'), last_event_at: new Date('2026-09-30T00:00:00.000Z') };
    const old = parsed('u1x', { start: '2026-09-29T15:00:00.000Z', end: '2026-09-29T15:30:00.000Z', updatedAt: '2026-09-28T12:00:00.000Z' });
    expect(planChain(only(old), stored('booked', past), NOW)).toEqual([]);
  });
});

describe('fetchCalcomBookings', () => {
  function fakeClient(pages: readonly (readonly unknown[])[]): CalcomBookingsClient & { readonly queries: CalcomBookingsQuery[] } {
    const queries: CalcomBookingsQuery[] = [];
    return {
      queries,
      listBookings: async query => {
        queries.push(query);
        const index = query.cursor === null ? 0 : Number(query.cursor);
        return await Promise.resolve({ bookings: pages[index] ?? [], nextCursor: index + 1 < pages.length ? String(index + 1) : null });
      },
    };
  }

  it('asks for the window [now − 7 d, now + 60 d] and follows the cursor', async () => {
    const client = fakeClient([[apiBooking('p1x')], [apiBooking('p2x'), { uid: 'bad uid' }]]);
    const fetched = await fetchCalcomBookings(client, { now: NOW });
    expect(fetched).toMatchObject({ pages: 2, malformed: 1, truncated: false });
    expect(fetched.bookings.map(booking => booking.uid)).toEqual(['p1x', 'p2x']);
    expect(client.queries[0]).toMatchObject({ afterStart: '2026-09-24T12:00:00.000Z', beforeEnd: '2026-11-30T12:00:00.000Z', limit: 100, cursor: null });
    expect(client.queries[0]?.timeoutMs).toBeLessThanOrEqual(30_000);
    expect(client.queries[1]?.cursor).toBe('1');
  });

  it('stops at the page bound and at the deadline, and says so', async () => {
    const many = Array.from({ length: 20 }, (_, index) => [apiBooking(`m${String(index)}x`)]);
    expect(await fetchCalcomBookings(fakeClient(many), { now: NOW, maxPages: 3 })).toMatchObject({ pages: 3, truncated: true });
    let tick = 0;
    const clock = (): number => {
      tick += 20_000;
      return tick;
    };
    expect(await fetchCalcomBookings(fakeClient(many), { now: NOW, deadlineMs: 30_000, clock })).toMatchObject({ pages: 1, truncated: true });
  });

  it('hands each request what is left of the budget, and a request the deadline cut short truncates the run (fold 1, finding 6)', async () => {
    const budgets: number[] = [];
    let clockMs = 0;
    // A slow Cal.com on a fake clock: every page takes 40 ms, and a request gives up
    // when the budget it was handed runs out.
    const slow: CalcomBookingsClient = {
      listBookings: async query => {
        budgets.push(query.timeoutMs);
        const index = query.cursor === null ? 0 : Number(query.cursor);
        if (query.timeoutMs < 40) {
          clockMs += query.timeoutMs;
          throw new Error('aborted');
        }
        clockMs += 40;
        return await Promise.resolve({ bookings: [apiBooking(`slow${String(index)}x`)], nextCursor: String(index + 1) });
      },
    };
    const fetched = await fetchCalcomBookings(slow, { now: NOW, deadlineMs: 100, clock: () => clockMs });
    expect(fetched).toMatchObject({ pages: 2, truncated: true });
    expect(fetched.bookings.map(booking => booking.uid)).toEqual(['slow0x', 'slow1x']);
    // The third request was handed the twenty milliseconds that were left, not a full timeout.
    expect(budgets).toEqual([100, 60, 20]);
    // A failure that is not the deadline still fails the run.
    const broken: CalcomBookingsClient = { listBookings: async () => await Promise.reject(new Error('calcom_http_500')) };
    await expect(fetchCalcomBookings(broken, { now: NOW })).rejects.toThrow('calcom_http_500');
  });
});

describe('the calcom secret', () => {
  it('requires the webhook secret and treats the api key as optional', () => {
    expect(readCalcomSecret(undefined)).toEqual({ ok: false, problem: 'absent' });
    expect(readCalcomSecret('{}')).toEqual({ ok: false, problem: 'field:webhook_secret' });
    expect(readCalcomSecret('nope')).toEqual({ ok: false, problem: 'not_json' });
    expect(readCalcomSecret(JSON.stringify({ webhook_secret: 'w'.repeat(16) }))).toMatchObject({ ok: true, apiKey: null, apiKeyProblem: 'absent' });
    expect(readCalcomSecret(JSON.stringify({ webhook_secret: 'w'.repeat(16), api_key: 'not-a-key' }))).toMatchObject({
      ok: true,
      apiKey: null,
      apiKeyProblem: 'field:api_key',
    });
    const fakeKey = ['cal', 'live', 'FAKE', '0123456789'].join('_');
    expect(readCalcomSecret(JSON.stringify({ webhook_secret: 'w'.repeat(16), api_key: fakeKey }))).toMatchObject({
      ok: true,
      apiKey: fakeKey,
      apiKeyProblem: null,
    });
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { withTransaction } from '../../db/queryable.ts';
import { receiveCalcomEvent } from '../../meetings/calcom.ts';
import {
  fetchCalcomBookings,
  parseCalcomBooking,
  planBooking,
  reconcileCalcomBookings,
  type CalcomBooking,
  type CalcomBookingsClient,
  type CalcomBookingsQuery,
  type ReconcileCounts,
} from '../../meetings/reconcile.ts';
import { readCalcomSecret } from '../../meetings/calcomSecret.ts';
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
    expect(counts).toMatchObject({ synthesized: 1, applied: 1, unchanged: 1 });
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
    await reconcile([parsed(absent, { ...past, updatedAt: '2026-09-29T17:00:00.000Z' })]);
    expect((await meeting(absent))?.state).toBe('booked');
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

  it('records nothing for a pending, rejected or unknown cancelled booking', async () => {
    const pending = uid();
    const rejected = uid();
    const cancelled = uid();
    const counts = await reconcile([
      parsed(pending, { status: 'pending' }),
      parsed(rejected, { status: 'rejected' }),
      parsed(cancelled, { status: 'cancelled' }),
    ]);
    expect(counts).toMatchObject({ synthesized: 0, skipped: 2, unchanged: 1 });
    for (const id of [pending, rejected, cancelled]) expect(await meeting(id)).toBeUndefined();
  });
});

describe('planBooking', () => {
  const stored = (state: string, extra: Partial<{ current_booking_uid: string; starts_at: Date; ends_at: Date }> = {}) => ({
    state: state as 'booked',
    current_booking_uid: 'u1x',
    starts_at: new Date('2026-10-06T15:00:00.000Z'),
    ends_at: new Date('2026-10-06T15:30:00.000Z'),
    ...extra,
  });

  it('dates a state change by the booking s own updatedAt, and an end by its end', () => {
    const booking = parsed('u1x', { status: 'cancelled', updatedAt: '2026-09-30T13:00:00.000Z' });
    expect(planBooking(booking, stored('booked'), NOW)).toEqual([{ trigger: 'BOOKING_CANCELLED', instant: '2026-09-30T13:00:00.000Z', noShow: null }]);
    const ended = parsed('u1x', { start: '2026-09-29T15:00:00.000Z', end: '2026-09-29T15:30:00.000Z' });
    expect(planBooking(ended, stored('booked', { starts_at: new Date('2026-09-29T15:00:00.000Z'), ends_at: new Date('2026-09-29T15:30:00.000Z') }), NOW)).toEqual([
      { trigger: 'MEETING_ENDED', instant: '2026-09-29T15:30:00.000Z', noShow: null },
    ]);
  });

  it('plans nothing for a cancelled meeting (terminal) or an unchanged one', () => {
    expect(planBooking(parsed('u1x'), stored('cancelled'), NOW)).toEqual([]);
    expect(planBooking(parsed('u1x'), stored('booked'), NOW)).toEqual([]);
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
    expect(client.queries[0]).toEqual({ afterStart: '2026-09-24T12:00:00.000Z', beforeEnd: '2026-11-30T12:00:00.000Z', limit: 100, cursor: null });
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

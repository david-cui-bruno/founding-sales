import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { withTransaction } from '../../db/queryable.ts';
import { receiveCalcomEvent, type CalcomReceipt } from '../../meetings/calcom.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';

/**
 * The Cal.com state machine (call-to-booking slice W, acceptance 3), at the domain: one
 * application per delivery, ordered by the payload's own timestamp, a cancelled meeting
 * never restored, reschedule and no-show in order. The signature is the route's
 * (`apps/api/test/calcom.test.ts`).
 */
describe('Cal.com deliveries', () => {
  let database: TestDatabase;
  let seeded: TwoWorkspaces;
  let firmId = '';
  let counter = 0;

  const workspaceId = (): string => seeded.alpha.workspaceId;

  function delivery(trigger: string, createdAt: string, payload: Record<string, unknown>): { raw: Buffer; body: unknown } {
    const body = { triggerEvent: trigger, createdAt, payload };
    return { raw: Buffer.from(JSON.stringify(body)), body };
  }

  function booking(uid: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      uid,
      startTime: '2026-10-06T15:00:00.000Z',
      endTime: '2026-10-06T15:30:00.000Z',
      organizer: { email: 'David@UseCallie.example' },
      attendees: [{ email: 'Partner@Northwind-Law.example', name: 'A Partner' }],
      ...extra,
    };
  }

  async function send(event: { raw: Buffer; body: unknown }): Promise<CalcomReceipt> {
    return await withTransaction(database.session, async () =>
      await receiveCalcomEvent(database.session, { workspaceId: workspaceId(), rawBody: event.raw, body: event.body }),
    );
  }

  async function meetingOf(uid: string): Promise<{ state: string; starts_at: Date; current_booking_uid: string } | undefined> {
    const { rows } = await database.session.query<{ state: string; starts_at: Date; current_booking_uid: string }>(
      'SELECT state, starts_at, current_booking_uid FROM meetings WHERE workspace_id = $1 AND booking_uid = $2',
      [workspaceId(), uid],
    );
    return rows[0];
  }

  const uid = (): string => {
    counter += 1;
    return `bk${String(counter)}x`;
  };

  beforeAll(async () => {
    database = await createTestDatabase();
    seeded = await seedTwoWorkspaces(database.session);
    const { rows } = await database.session.query<{ id: string }>(
      `INSERT INTO firms (workspace_id, name, website, assigned_user_id) VALUES ($1, 'Northwind Law', 'https://www.northwind-law.example/', $2)
       RETURNING id`,
      [workspaceId(), seeded.alpha.salesperson.userId],
    );
    firmId = rows[0]?.id ?? '';
  });

  afterAll(async () => {
    await database.drop();
  });

  it('applies an exact redelivery once', async () => {
    const id = uid();
    const event = delivery('BOOKING_CREATED', '2026-09-30T12:00:00.000Z', booking(id));
    const first = await send(event);
    const second = await send(event);
    expect(first).toMatchObject({ duplicate: false, outcome: 'applied', meetingState: 'booked' });
    expect(second).toMatchObject({ duplicate: true, outcome: null });
    const { rows } = await database.session.query<{ count: string }>(
      'SELECT count(*) AS count FROM calcom_events WHERE workspace_id = $1 AND booking_uid = $2',
      [workspaceId(), id],
    );
    expect(Number(rows[0]?.count)).toBe(1);
  });

  it('matches the attendee by domain to the firm and moves no deal (lane M1, CC3)', async () => {
    const id = uid();
    const opportunities = async (): Promise<number> =>
      Number((await database.session.query<{ n: string }>('SELECT count(*) AS n FROM opportunities WHERE workspace_id = $1 AND firm_id = $2', [workspaceId(), firmId])).rows[0]?.n);
    const before = await opportunities();
    const receipt = await send(delivery('BOOKING_CREATED', '2026-09-30T12:05:00.000Z', booking(id)));
    expect(receipt).toMatchObject({ outcome: 'applied', meetingState: 'booked' });
    // No opportunity opened, no stage event, no evidence row: stage changes are a person's.
    expect(await opportunities()).toBe(before);
    const evidence = await database.session.query(
      "SELECT 1 FROM opportunity_stage_evidence WHERE workspace_id = $1 AND evidence_kind = 'meeting.booked' AND evidence_id = $2",
      [workspaceId(), receipt.meetingId],
    );
    expect(evidence.rows).toHaveLength(0);
    // The funnel fact is still written.
    const facts = await database.session.query(
      "SELECT 1 FROM funnel_facts WHERE workspace_id = $1 AND kind = 'meeting.booked' AND dedupe_key = $2",
      [workspaceId(), id],
    );
    expect(facts.rows).toHaveLength(1);
    const { rows } = await database.session.query<{ firm_id: string; attendee_email: string }>(
      'SELECT firm_id, attendee_email FROM meetings WHERE workspace_id = $1 AND booking_uid = $2',
      [workspaceId(), id],
    );
    expect(rows[0]).toEqual({ firm_id: firmId, attendee_email: 'partner@northwind-law.example' });
  });

  it('keeps a meeting cancelled when the create arrives after the cancel', async () => {
    const id = uid();
    const cancelled = await send(delivery('BOOKING_CANCELLED', '2026-09-30T13:00:00.000Z', booking(id)));
    const lateCreate = await send(delivery('BOOKING_CREATED', '2026-09-30T12:59:00.000Z', booking(id)));
    expect(cancelled).toMatchObject({ outcome: 'applied', meetingState: 'cancelled' });
    expect(lateCreate).toMatchObject({ outcome: 'stale', meetingState: 'cancelled' });
    expect((await meetingOf(id))?.state).toBe('cancelled');
  });

  it('records a reschedule with the new start and the new uid', async () => {
    const id = uid();
    const moved = uid();
    await send(delivery('BOOKING_CREATED', '2026-09-30T14:00:00.000Z', booking(id)));
    const receipt = await send(
      delivery(
        'BOOKING_RESCHEDULED',
        '2026-09-30T14:10:00.000Z',
        booking(moved, { rescheduleUid: id, startTime: '2026-10-08T17:00:00.000Z', endTime: '2026-10-08T17:30:00.000Z' }),
      ),
    );
    expect(receipt).toMatchObject({ outcome: 'applied', meetingState: 'rescheduled' });
    const meeting = await meetingOf(id);
    expect(meeting?.state).toBe('rescheduled');
    expect(meeting?.starts_at.toISOString()).toBe('2026-10-08T17:00:00.000Z');
    expect(meeting?.current_booking_uid).toBe(moved);
    // A later cancel naming the new uid finds the same meeting.
    await send(delivery('BOOKING_CANCELLED', '2026-09-30T14:20:00.000Z', booking(moved)));
    expect((await meetingOf(id))?.state).toBe('cancelled');
  });

  it('folds a replacement whose cancellation arrived before the reschedule naming it (review fold 1, finding 7)', async () => {
    const original = uid();
    const replacement = uid();
    // A is booked; A is rescheduled to B at 14:40; B is cancelled at 14:50. Cal.com
    // delivers the cancellation of B first, then the reschedule.
    await send(delivery('BOOKING_CREATED', '2026-09-30T14:30:00.000Z', booking(original)));
    const earlyCancel = await send(
      delivery(
        'BOOKING_CANCELLED',
        '2026-09-30T14:50:00.000Z',
        booking(replacement, { startTime: '2026-10-09T17:00:00.000Z', endTime: '2026-10-09T17:30:00.000Z' }),
      ),
    );
    const lateReschedule = await send(
      delivery(
        'BOOKING_RESCHEDULED',
        '2026-09-30T14:40:00.000Z',
        booking(replacement, { rescheduleUid: original, startTime: '2026-10-09T17:00:00.000Z', endTime: '2026-10-09T17:30:00.000Z' }),
      ),
    );
    expect(lateReschedule).toMatchObject({ outcome: 'applied', meetingState: 'cancelled' });
    const { rows } = await database.session.query<{ id: string; booking_uid: string; current_booking_uid: string; state: string }>(
      `SELECT id, booking_uid, current_booking_uid, state FROM meetings
        WHERE workspace_id = $1 AND (booking_uid IN ($2, $3) OR current_booking_uid IN ($2, $3))`,
      [workspaceId(), original, replacement],
    );
    expect(rows.map(row => ({ booking_uid: row.booking_uid, current_booking_uid: row.current_booking_uid, state: row.state }))).toEqual([
      { booking_uid: original, current_booking_uid: replacement, state: 'cancelled' },
    ]);
    // The early cancellation's delivery now names the surviving meeting.
    const events = await database.session.query<{ meeting_id: string }>(
      'SELECT meeting_id FROM calcom_events WHERE workspace_id = $1 AND booking_uid = $2',
      [workspaceId(), replacement],
    );
    expect(new Set(events.rows.map(row => row.meeting_id))).toEqual(new Set([rows[0]?.id]));
    expect(earlyCancel.meetingId).not.toBe(rows[0]?.id);
  });

  it('keeps a newer reschedule s uid and times when folding it (B→C before the delayed A→B, fold 2)', async () => {
    const a = uid();
    const b = uid();
    const c = uid();
    await send(delivery('BOOKING_CREATED', '2026-09-30T17:00:00.000Z', booking(a)));
    await send(
      delivery('BOOKING_RESCHEDULED', '2026-09-30T17:20:00.000Z', booking(c, { rescheduleUid: b, startTime: '2026-10-12T18:00:00.000Z', endTime: '2026-10-12T18:30:00.000Z' })),
    );
    const late = await send(
      delivery('BOOKING_RESCHEDULED', '2026-09-30T17:10:00.000Z', booking(b, { rescheduleUid: a, startTime: '2026-10-10T18:00:00.000Z', endTime: '2026-10-10T18:30:00.000Z' })),
    );
    expect(late).toMatchObject({ outcome: 'applied', meetingState: 'rescheduled' });
    const { rows } = await database.session.query<{ booking_uid: string; current_booking_uid: string; starts_at: Date; state: string }>(
      `SELECT booking_uid, current_booking_uid, starts_at, state FROM meetings
        WHERE workspace_id = $1 AND (booking_uid IN ($2, $3, $4) OR current_booking_uid IN ($2, $3, $4))`,
      [workspaceId(), a, b, c],
    );
    expect(rows.map(row => ({ ...row, starts_at: row.starts_at.toISOString() }))).toEqual([
      { booking_uid: a, current_booking_uid: c, starts_at: '2026-10-12T18:00:00.000Z', state: 'rescheduled' },
    ]);
    // C still resolves: its end marks the meeting ended (lane M1: never held).
    const ended = {
      triggerEvent: 'MEETING_ENDED',
      uid: c,
      startTime: '2026-10-12T18:00:00.000Z',
      endTime: '2026-10-12T18:30:00.000Z',
      createdAt: '2026-09-30T17:20:00.000Z',
      attendees: [{ email: 'partner@northwind-law.example', noShow: false }],
    };
    expect(await send({ raw: Buffer.from(JSON.stringify(ended)), body: ended })).toMatchObject({ outcome: 'applied', meetingState: 'ended' });
  });

  it('adopts the replacement row when the original was never ingested (the partial half of finding 7, fold 2)', async () => {
    const a = uid();
    const b = uid();
    const cancelled = await send(delivery('BOOKING_CANCELLED', '2026-09-30T18:20:00.000Z', booking(b)));
    const reschedule = await send(
      delivery('BOOKING_RESCHEDULED', '2026-09-30T18:10:00.000Z', booking(b, { rescheduleUid: a })),
    );
    expect(reschedule).toMatchObject({ meetingId: cancelled.meetingId, meetingState: 'cancelled' });
    // A late delivery about the original finds the same meeting instead of booking a second one.
    const lateCreate = await send(delivery('BOOKING_CREATED', '2026-09-30T18:00:00.000Z', booking(a)));
    expect(lateCreate).toMatchObject({ outcome: 'stale', meetingId: cancelled.meetingId });
    const { rows } = await database.session.query<{ booking_uid: string; current_booking_uid: string; state: string }>(
      `SELECT booking_uid, current_booking_uid, state FROM meetings
        WHERE workspace_id = $1 AND (booking_uid IN ($2, $3) OR current_booking_uid IN ($2, $3))`,
      [workspaceId(), a, b],
    );
    expect(rows).toEqual([{ booking_uid: a, current_booking_uid: b, state: 'cancelled' }]);
  });

  it('keeps an established original when a replayed reschedule is found by its current uid (fold 3)', async () => {
    const a = uid();
    const b = uid();
    const c = uid();
    await send(delivery('BOOKING_RESCHEDULED', '2026-09-30T19:10:00.000Z', booking(b, { rescheduleUid: a })));
    await send(delivery('BOOKING_RESCHEDULED', '2026-09-30T19:20:00.000Z', booking(c, { rescheduleUid: b })));
    await send(delivery('BOOKING_CANCELLED', '2026-09-30T19:30:00.000Z', booking(c)));
    // The B→C replay with different bytes: past the delivery dedupe, stale by its time.
    const replay = await send(
      delivery('BOOKING_RESCHEDULED', '2026-09-30T19:20:00.000Z', booking(c, { rescheduleUid: b, title: 'replayed' })),
    );
    expect(replay).toMatchObject({ outcome: 'stale', meetingState: 'cancelled' });
    const lateCreate = await send(delivery('BOOKING_CREATED', '2026-09-30T19:00:00.000Z', booking(a)));
    expect(lateCreate).toMatchObject({ outcome: 'stale', meetingId: replay.meetingId, meetingState: 'cancelled' });
    const { rows } = await database.session.query<{ booking_uid: string; current_booking_uid: string; state: string }>(
      `SELECT booking_uid, current_booking_uid, state FROM meetings
        WHERE workspace_id = $1 AND (booking_uid IN ($2, $3, $4) OR current_booking_uid IN ($2, $3, $4))`,
      [workspaceId(), a, b, c],
    );
    expect(rows).toEqual([{ booking_uid: a, current_booking_uid: c, state: 'cancelled' }]);
  });

  it('marks a meeting ended, not held, from Cal.com s flat MEETING_ENDED body, with no meeting.held fact (fold 1 finding 8; lane M1)', async () => {
    const id = uid();
    await send(delivery('BOOKING_CREATED', '2026-09-30T15:10:00.000Z', booking(id)));
    // The documented shape: booking fields at the top level, no `payload`, and
    // `createdAt` the booking's own creation — earlier than the booking delivery above.
    const body = {
      triggerEvent: 'MEETING_ENDED',
      id: 100,
      uid: id,
      idempotencyKey: '00000000-0000-0000-0000-000000000000',
      userPrimaryEmail: 'david@usecallie.example',
      title: 'Callie demo',
      startTime: '2026-10-06T15:00:00.000Z',
      endTime: '2026-10-06T15:30:00.000Z',
      createdAt: '2026-09-30T15:09:00.000Z',
      updatedAt: '2026-10-06T15:31:00.000Z',
      status: 'ACCEPTED',
      user: { email: 'david@usecallie.example', name: 'David', timeZone: 'UTC' },
      attendees: [{ id: 101, email: 'partner@northwind-law.example', name: 'A Partner', timeZone: 'UTC', noShow: false }],
    };
    const receipt = await send({ raw: Buffer.from(JSON.stringify(body)), body });
    expect(receipt).toMatchObject({ outcome: 'applied', meetingState: 'ended' });
    const facts = await database.session.query<{ kind: string }>(
      "SELECT kind FROM funnel_facts WHERE workspace_id = $1 AND dedupe_key = $2 AND kind = 'meeting.held'",
      [workspaceId(), id],
    );
    expect(facts.rows).toHaveLength(0);
  });

  it('applies a no-show mark and unmark in order, back to booked', async () => {
    const id = uid();
    // A meeting whose start has passed: a mark before the start records nothing (lane M1).
    await send(delivery('BOOKING_CREATED', '2026-09-30T15:00:00.000Z', booking(id, { startTime: '2026-09-29T15:00:00.000Z', endTime: '2026-09-29T15:30:00.000Z' })));
    const marked = await send(
      delivery('BOOKING_NO_SHOW_UPDATED', '2026-10-06T16:00:00.000Z', { bookingUid: id, attendees: [{ email: 'partner@northwind-law.example', noShow: true }] }),
    );
    expect(marked).toMatchObject({ meetingState: 'no_show' });
    const unmarked = await send(
      delivery('BOOKING_NO_SHOW_UPDATED', '2026-10-06T16:05:00.000Z', { bookingUid: id, attendees: [{ email: 'partner@northwind-law.example', noShow: false }] }),
    );
    expect(unmarked).toMatchObject({ meetingState: 'booked' });
    // An older mark arriving late is history, not state.
    const lateMark = await send(
      delivery('BOOKING_NO_SHOW_UPDATED', '2026-10-06T16:01:00.000Z', { bookingUid: id, attendees: [{ email: 'x@y.example', noShow: true }] }),
    );
    expect(lateMark).toMatchObject({ outcome: 'stale', meetingState: 'booked' });
  });

  it('records a meeting it cannot match and opens a review item', async () => {
    const id = uid();
    const receipt = await send(
      delivery('BOOKING_CREATED', '2026-09-30T16:00:00.000Z', booking(id, { attendees: [{ email: 'someone@elsewhere.example' }] })),
    );
    expect(receipt).toMatchObject({ outcome: 'unmatched', meetingState: 'booked' });
    const { rows } = await database.session.query<{ reason: string }>(
      "SELECT reason FROM stage_review_items WHERE workspace_id = $1 AND evidence_kind = 'meeting.booked' AND evidence_id = $2",
      [workspaceId(), receipt.meetingId],
    );
    expect(rows).toEqual([{ reason: 'firm_unmatched' }]);
  });
});

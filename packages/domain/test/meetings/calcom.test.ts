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

  it('matches the attendee by domain to the firm and moves its pipeline', async () => {
    const id = uid();
    const receipt = await send(delivery('BOOKING_CREATED', '2026-09-30T12:05:00.000Z', booking(id)));
    expect(receipt.stage === null ? null : receipt.stage.kind).not.toBeNull();
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

  it('applies a no-show mark and unmark in order, back to booked', async () => {
    const id = uid();
    await send(delivery('BOOKING_CREATED', '2026-09-30T15:00:00.000Z', booking(id)));
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

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { withTransaction } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { readPipelineBoardForActor } from '../../crm/board.ts';
import { funnelFacts } from '../../funnel/read.ts';
import { setMeetingAttendance } from '../../meetings/attendance.ts';
import { foldMeetings, MEETING_COLUMNS, receiveCalcomEvent, type MeetingRow } from '../../meetings/calcom.ts';
import { matchMeetingToFirm, readFirmStageSuggestion } from '../../meetings/match.ts';
import { parseCalcomBooking, planChain, bookingChains, reconcileCalcomBookings, type CalcomBooking } from '../../meetings/reconcile.ts';
import { readDemoBookedSuggestions } from '../../meetings/stageSuggestion.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';

/**
 * Lane M1: attendance is confirmed by a person, never assumed from Cal.com's scheduled end;
 * no Cal.com event overwrites a confirmation (contract check CC2, webhook and reconciliation);
 * no meeting event changes a deal's stage (CC3), which is offered as one click instead.
 *
 * Every firm here is its own `<name>.example` domain, so each test's bookings match only its
 * own firm. No real business or person.
 */

const PAST = { startTime: '2026-09-29T15:00:00.000Z', endTime: '2026-09-29T15:30:00.000Z' };
const FUTURE = { startTime: '2099-06-02T15:00:00.000Z', endTime: '2099-06-02T15:30:00.000Z' };
const NOW = '2026-10-01T12:00:00.000Z';

describe('meeting attendance', () => {
  let database: TestDatabase;
  let seeded: TwoWorkspaces;
  let counter = 0;
  let minute = 0;
  const workspaceId = (): string => seeded.alpha.workspaceId;

  const salesperson = (): RepositoryContext =>
    repositoryContext(workspaceScope(workspaceId(), { kind: 'user', userId: seeded.alpha.salesperson.userId, role: 'salesperson' }), database.session);
  const admin = (): RepositoryContext =>
    repositoryContext(workspaceScope(workspaceId(), { kind: 'user', userId: seeded.alpha.admin.userId, role: 'admin' }), database.session);
  const system = (): RepositoryContext =>
    repositoryContext(workspaceScope(workspaceId(), { kind: 'system', component: 'worker' }), database.session);

  const uid = (): string => {
    counter += 1;
    return `at${String(counter)}x`;
  };

  /** A firm on its own domain, assigned to the salesperson unless said otherwise. */
  async function firm(name: string, assignedUserId: string = seeded.alpha.salesperson.userId): Promise<{ id: string; domain: string }> {
    const domain = `${name.toLowerCase()}.example`;
    const { rows } = await database.session.query<{ id: string }>(
      'INSERT INTO firms (workspace_id, name, website, assigned_user_id) VALUES ($1, $2, $3, $4) RETURNING id',
      [workspaceId(), `${name} Law`, `https://www.${domain}/`, assignedUserId],
    );
    return { id: rows[0]?.id ?? '', domain };
  }

  async function opportunityAt(firmId: string, stageKey: string, status: 'open' | 'lost' = 'open'): Promise<string> {
    const { rows } = await database.session.query<{ id: string }>(
      `INSERT INTO opportunities (workspace_id, firm_id, stage_id, status, closed_at, close_reason, control_mode_changed_at)
       SELECT $1, $2, id, $4, CASE WHEN $4 = 'open' THEN NULL ELSE now() END, CASE WHEN $4 = 'open' THEN NULL ELSE 'went quiet' END, now()
         FROM pipeline_stages WHERE workspace_id = $1 AND key = $3
       RETURNING id`,
      [workspaceId(), firmId, stageKey, status],
    );
    return rows[0]?.id ?? '';
  }

  /** A webhook delivery, dated a minute after the last one unless `createdAt` says otherwise. */
  async function deliver(trigger: string, id: string, domain: string, times: typeof PAST, extra: Record<string, unknown> = {}, createdAt?: string): Promise<void> {
    minute += 1;
    const body = {
      triggerEvent: trigger,
      createdAt: createdAt ?? new Date(Date.UTC(2026, 8, 20, 0, minute)).toISOString(),
      payload: { uid: id, ...times, attendees: [{ email: `partner@${domain}`, name: 'A Partner' }], ...extra },
    };
    await withTransaction(database.session, async () =>
      await receiveCalcomEvent(database.session, { workspaceId: workspaceId(), rawBody: Buffer.from(JSON.stringify(body)), body }),
    );
  }

  async function meetingOf(id: string): Promise<MeetingRow> {
    const { rows } = await database.session.query<MeetingRow>(
      `SELECT ${MEETING_COLUMNS} FROM meetings WHERE workspace_id = $1 AND (booking_uid = $2 OR current_booking_uid = $2)`,
      [workspaceId(), id],
    );
    const row = rows[0];
    if (row === undefined) throw new Error(`no meeting for ${id}`);
    return row;
  }

  const set = async (context: RepositoryContext, meetingId: string, attendance: 'attended' | 'no_show' | 'unconfirmed') =>
    await withTransaction(database.session, async () => await setMeetingAttendance(context, { meetingId, attendance }));

  async function heldFacts(id: string): Promise<{ id: string; withdrawn_reason: string | null; occurred_at: Date }[]> {
    const { rows } = await database.session.query<{ id: string; withdrawn_reason: string | null; occurred_at: Date }>(
      "SELECT id, withdrawn_reason, occurred_at FROM funnel_facts WHERE workspace_id = $1 AND kind = 'meeting.held' AND dedupe_key = $2",
      [workspaceId(), id],
    );
    return rows;
  }

  /** A past booking at a new firm, ended by Cal.com's scheduled end. */
  async function endedMeeting(name: string): Promise<{ firm: { id: string; domain: string }; uid: string; meeting: MeetingRow }> {
    const owner = await firm(name);
    const id = uid();
    await deliver('BOOKING_CREATED', id, owner.domain, PAST);
    await deliver('MEETING_ENDED', id, owner.domain, PAST);
    const meeting = await meetingOf(id);
    expect(meeting.state).toBe('ended');
    return { firm: owner, uid: id, meeting };
  }

  function booking(id: string, extra: Record<string, unknown> = {}): CalcomBooking {
    const parsed = parseCalcomBooking({
      id: 1,
      uid: id,
      title: 'Callie demo',
      status: 'accepted',
      start: PAST.startTime,
      end: PAST.endTime,
      createdAt: '2026-09-20T00:00:00.000Z',
      updatedAt: '2026-09-30T00:00:00.000Z',
      hosts: [{ id: 1, name: 'Host', email: 'host@callie.example' }],
      attendees: [{ name: 'A Partner', email: extra['attendee'] ?? 'partner@nobody.example', timeZone: 'UTC', absent: false }],
      absentHost: false,
      ...extra,
    });
    if (parsed === null) throw new Error('fixture booking did not parse');
    return parsed;
  }

  const reconcile = async (bookings: readonly CalcomBooking[]) =>
    await withTransaction(database.session, async () => await reconcileCalcomBookings(database.session, { workspaceId: workspaceId(), bookings, now: NOW }));

  beforeAll(async () => {
    database = await createTestDatabase();
    seeded = await seedTwoWorkspaces(database.session);
  });

  afterAll(async () => {
    await database.drop();
  });

  // ------------------------------------------------------------------ the command
  describe('a person confirms', () => {
    it('attended: held, by them, with one meeting.held fact dated at the meeting s start, and an audit row of ids', async () => {
      const { uid: id, meeting } = await endedMeeting('Alder');
      // Nothing is written for ended.
      expect(await heldFacts(id)).toEqual([]);
      const answer = await set(salesperson(), meeting.id, 'attended');
      expect(answer).toEqual({ ok: true, value: { meetingId: meeting.id, state: 'held', attendanceSource: 'manual' } });
      const after = await meetingOf(id);
      expect(after).toMatchObject({ state: 'held', attendance_source: 'manual', attendance_confirmed_by: seeded.alpha.salesperson.userId });
      expect(after.attendance_confirmed_at).not.toBeNull();
      const facts = await heldFacts(id);
      expect(facts.map(fact => [fact.withdrawn_reason, fact.occurred_at.toISOString()])).toEqual([[null, PAST.startTime]]);
      const { rows } = await database.session.query<{ detail: Record<string, unknown> }>(
        "SELECT detail FROM audit_events WHERE workspace_id = $1 AND action = 'meeting.attendance_set' AND subject_id = $2",
        [workspaceId(), meeting.id],
      );
      expect(rows.map(row => row.detail)).toEqual([{ firmId: meeting.firm_id, attendance: 'attended', fromState: 'ended', fromSource: null, toState: 'held' }]);
      // The same choice again changes nothing and writes no second fact.
      expect(await set(salesperson(), meeting.id, 'attended')).toMatchObject({ ok: true, value: { state: 'held' } });
      expect(await heldFacts(id)).toHaveLength(1);
    });

    it('unconfirmed: back to ended, the fact withdrawn and uncounted; attended again reinstates the same fact', async () => {
      const { uid: id, meeting } = await endedMeeting('Birch');
      await set(salesperson(), meeting.id, 'attended');
      const [fact] = await heldFacts(id);
      const window = { from: '2026-09-01T00:00:00.000Z', to: '2026-10-31T00:00:00.000Z' };
      const counted = async (): Promise<number> =>
        (await funnelFacts(admin(), window, { onlyAssignedTo: null })).byKind.find(entry => entry.key === 'meeting.held')?.count ?? 0;
      const live = await counted();

      expect(await set(salesperson(), meeting.id, 'unconfirmed')).toEqual({ ok: true, value: { meetingId: meeting.id, state: 'ended', attendanceSource: null } });
      expect(await meetingOf(id)).toMatchObject({ state: 'ended', attendance_source: null, attendance_confirmed_at: null, attendance_confirmed_by: null });
      expect((await heldFacts(id)).map(row => row.withdrawn_reason)).toEqual(['attendance_unconfirmed']);
      expect(await counted()).toBe(live - 1);

      await set(salesperson(), meeting.id, 'attended');
      const again = await heldFacts(id);
      expect(again.map(row => [row.id, row.withdrawn_reason])).toEqual([[fact?.id, null]]);
      expect(await counted()).toBe(live);
    });

    it('no_show over their own attended: no_show remembering ended, the fact withdrawn; undo back to ended', async () => {
      const { uid: id, meeting } = await endedMeeting('Cedar');
      await set(salesperson(), meeting.id, 'attended');
      expect(await set(salesperson(), meeting.id, 'no_show')).toMatchObject({ ok: true, value: { state: 'no_show', attendanceSource: 'manual' } });
      expect(await meetingOf(id)).toMatchObject({ state: 'no_show', state_before_no_show: 'ended', attendance_source: 'manual' });
      expect((await heldFacts(id)).map(row => row.withdrawn_reason)).toEqual(['attendance_unconfirmed']);
      expect(await set(salesperson(), meeting.id, 'unconfirmed')).toMatchObject({ ok: true, value: { state: 'ended' } });
    });

    it('never undoes Cal.com s no-show, but a person may choose attended over it', async () => {
      const owner = await firm('Dogwood');
      const id = uid();
      await deliver('BOOKING_CREATED', id, owner.domain, PAST);
      await deliver('BOOKING_NO_SHOW_UPDATED', id, owner.domain, PAST, { attendees: [{ email: `partner@${owner.domain}`, noShow: true }] });
      const meeting = await meetingOf(id);
      expect(meeting).toMatchObject({ state: 'no_show', attendance_source: 'calcom_no_show', attendance_confirmed_by: null });
      expect(await set(salesperson(), meeting.id, 'unconfirmed')).toEqual({ ok: false, reason: 'attendance_from_calcom' });
      expect((await meetingOf(id)).state).toBe('no_show');
      expect(await set(salesperson(), meeting.id, 'attended')).toMatchObject({ ok: true, value: { state: 'held', attendanceSource: 'manual' } });
    });

    it('refuses a colleague s firm (an admin may), a meeting not started, a cancelled one, an unmatched one, and the system', async () => {
      const theirs = await firm('Elm', seeded.alpha.admin.userId);
      const id = uid();
      await deliver('BOOKING_CREATED', id, theirs.domain, PAST);
      const meeting = await meetingOf(id);
      expect(await set(salesperson(), meeting.id, 'attended')).toEqual({ ok: false, reason: 'not_assigned' });
      expect(await set(admin(), meeting.id, 'attended')).toMatchObject({ ok: true, value: { state: 'held' } });

      const later = await firm('Fir');
      const future = uid();
      await deliver('BOOKING_CREATED', future, later.domain, FUTURE);
      expect(await set(salesperson(), (await meetingOf(future)).id, 'attended')).toEqual({ ok: false, reason: 'meeting_not_started' });

      const gone = uid();
      await deliver('BOOKING_CREATED', gone, later.domain, PAST);
      await deliver('BOOKING_CANCELLED', gone, later.domain, PAST);
      expect(await set(salesperson(), (await meetingOf(gone)).id, 'attended')).toEqual({ ok: false, reason: 'meeting_cancelled' });

      const stray = uid();
      await deliver('BOOKING_CREATED', stray, 'nobody-knows.example', PAST);
      expect(await set(admin(), (await meetingOf(stray)).id, 'attended')).toEqual({ ok: false, reason: 'meeting_unmatched' });
      expect(await set(admin(), '00000000-0000-4000-8000-000000000000', 'attended')).toEqual({ ok: false, reason: 'meeting_unknown' });
      expect(await set(system(), meeting.id, 'no_show')).toEqual({ ok: false, reason: 'invalid_input' });
    });
  });

  // ------------------------------------------------------- CC2: the webhook replays
  describe('no Cal.com webhook overwrites a confirmation (CC2)', () => {
    it('a replayed end, a reschedule, a cancellation and a no-show flag leave a person s held as it was', async () => {
      const { firm: owner, uid: id, meeting } = await endedMeeting('Ginkgo');
      await set(salesperson(), meeting.id, 'attended');
      const confirmed = await meetingOf(id);
      // The same end again, with new bytes (so past the delivery dedupe), and newer.
      await deliver('MEETING_ENDED', id, owner.domain, PAST, { title: 'replayed' });
      await deliver('BOOKING_NO_SHOW_UPDATED', id, owner.domain, PAST, { attendees: [{ email: `partner@${owner.domain}`, noShow: true }] });
      await deliver('BOOKING_CANCELLED', id, owner.domain, PAST);
      const after = await meetingOf(id);
      expect(after).toMatchObject({
        state: 'held',
        attendance_source: 'manual',
        attendance_confirmed_by: confirmed.attendance_confirmed_by,
        attendance_confirmed_at: confirmed.attendance_confirmed_at,
      });
      // A reschedule moves the times and never the confirmation.
      const moved = uid();
      await deliver('BOOKING_RESCHEDULED', moved, owner.domain, { startTime: '2026-09-30T15:00:00.000Z', endTime: '2026-09-30T15:30:00.000Z' }, { rescheduleUid: id });
      const rescheduled = await meetingOf(id);
      expect(rescheduled).toMatchObject({ state: 'held', attendance_source: 'manual', current_booking_uid: moved });
      expect(rescheduled.starts_at.toISOString()).toBe('2026-09-30T15:00:00.000Z');
      expect((await heldFacts(id)).map(row => row.withdrawn_reason)).toEqual([null]);
    });

    it('a replayed end and Cal.com s unmark leave a person s no-show as it was', async () => {
      const { firm: owner, uid: id, meeting } = await endedMeeting('Hazel');
      await set(salesperson(), meeting.id, 'no_show');
      await deliver('MEETING_ENDED', id, owner.domain, PAST, { title: 'replayed' });
      await deliver('BOOKING_NO_SHOW_UPDATED', id, owner.domain, PAST, { attendees: [{ email: `partner@${owner.domain}`, noShow: false }] });
      expect(await meetingOf(id)).toMatchObject({ state: 'no_show', state_before_no_show: 'ended', attendance_source: 'manual' });
    });

    it('a reschedule moves booked and ended to rescheduled (the webhook)', async () => {
      const { firm: owner, uid: id } = await endedMeeting('Holly');
      const moved = uid();
      await deliver('BOOKING_RESCHEDULED', moved, owner.domain, FUTURE, { rescheduleUid: id });
      expect((await meetingOf(id)).state).toBe('rescheduled');
    });

    it('a fold of a replacement row keeps the confirmation the original held (webhook path)', async () => {
      const { firm: owner, uid: original, meeting } = await endedMeeting('Juniper');
      await set(salesperson(), meeting.id, 'attended');
      // The replacement's own event arrives first and makes a row of its own, newer than the reschedule.
      const replacement = uid();
      await deliver('BOOKING_CREATED', replacement, owner.domain, FUTURE, {}, '2026-09-28T00:00:00.000Z');
      await deliver('BOOKING_RESCHEDULED', replacement, owner.domain, FUTURE, { rescheduleUid: original }, '2026-09-27T00:00:00.000Z');
      const folded = await meetingOf(original);
      expect(folded.id).toBe(meeting.id);
      expect(folded).toMatchObject({ state: 'held', attendance_source: 'manual', current_booking_uid: replacement });
    });
  });

  // ------------------------------------------------- CC2: the reconciliation replays
  describe('no reconciliation overwrites a confirmation (CC2)', () => {
    it('a past accepted booking, with or without an absent attendee, leaves a person s held', async () => {
      const { firm: owner, uid: id, meeting } = await endedMeeting('Larch');
      await set(salesperson(), meeting.id, 'attended');
      const attendee = `partner@${owner.domain}`;
      await reconcile([booking(id, { attendee, updatedAt: '2026-09-30T01:00:00.000Z' })]);
      await reconcile([booking(id, { attendee, updatedAt: '2026-09-30T02:00:00.000Z', attendees: [{ name: 'A', email: attendee, absent: true }] })]);
      await reconcile([booking(id, { attendee, status: 'cancelled', updatedAt: '2026-09-30T03:00:00.000Z' })]);
      expect(await meetingOf(id)).toMatchObject({ state: 'held', attendance_source: 'manual' });
    });

    it('a booking whose attendee is not absent leaves a person s no-show; the planner plans nothing over confirmations', async () => {
      const { firm: owner, uid: id, meeting } = await endedMeeting('Maple');
      await set(salesperson(), meeting.id, 'no_show');
      const attendee = `partner@${owner.domain}`;
      await reconcile([booking(id, { attendee, updatedAt: '2026-09-30T01:00:00.000Z' })]);
      expect(await meetingOf(id)).toMatchObject({ state: 'no_show', attendance_source: 'manual' });

      const chain = bookingChains([booking(id, { attendee, status: 'cancelled', updatedAt: '2026-09-30T05:00:00.000Z' })])[0];
      if (chain === undefined) throw new Error('no chain');
      const stored = { ...(await meetingOf(id)), last_event_at: new Date('2026-09-20T00:00:00.000Z') };
      expect(planChain(chain, { ...stored, state: 'held', attendance_source: 'manual' }, NOW)).toEqual([]);
      const absent = bookingChains([booking(id, { attendee, attendees: [{ name: 'A', email: attendee, absent: true }], updatedAt: '2026-09-30T05:00:00.000Z' })])[0];
      if (absent === undefined) throw new Error('no chain');
      expect(planChain(absent, { ...stored, state: 'held', attendance_source: 'manual' }, NOW)).toEqual([]);
    });

    it('a reconciled end is ended, and a reconciled reschedule moves ended to rescheduled and held not at all', async () => {
      const owner = await firm('Oak');
      const attendee = `partner@${owner.domain}`;
      const [a, b] = [uid(), uid()];
      await deliver('BOOKING_CREATED', a, owner.domain, PAST);
      await reconcile([booking(a, { attendee, updatedAt: '2026-09-30T00:30:00.000Z' })]);
      expect((await meetingOf(a)).state).toBe('ended');
      await reconcile([
        booking(a, { attendee, status: 'cancelled', rescheduledToUid: b, updatedAt: '2026-09-30T06:00:00.000Z' }),
        booking(b, { attendee, start: FUTURE.startTime, end: FUTURE.endTime, rescheduledFromUid: a, createdAt: '2026-09-30T06:00:00.000Z', updatedAt: '2026-09-30T06:00:00.000Z' }),
      ]);
      expect((await meetingOf(a)).state).toBe('rescheduled');

      const { uid: c, meeting } = await endedMeeting('Olive');
      await set(salesperson(), meeting.id, 'attended');
      const d = uid();
      const olive = `partner@olive.example`;
      await reconcile([
        booking(c, { attendee: olive, status: 'cancelled', rescheduledToUid: d, updatedAt: '2026-09-30T07:00:00.000Z' }),
        booking(d, { attendee: olive, start: FUTURE.startTime, end: FUTURE.endTime, rescheduledFromUid: c, createdAt: '2026-09-30T07:00:00.000Z', updatedAt: '2026-09-30T07:00:00.000Z' }),
      ]);
      expect(await meetingOf(c)).toMatchObject({ state: 'held', attendance_source: 'manual' });
    });
  });

  // ---------------------------------------------------------------------- folds
  describe('folding duplicate rows', () => {
    it('keeps the confirmation whichever row is newer or survives', async () => {
      for (const survivorIsConfirmed of [true, false]) {
        const { uid: confirmedUid, meeting: confirmed } = await endedMeeting(survivorIsConfirmed ? 'Pine' : 'Poplar');
        await set(salesperson(), confirmed.id, 'attended');
        const other = uid();
        await deliver('BOOKING_CREATED', other, survivorIsConfirmed ? 'pine.example' : 'poplar.example', PAST, {}, '2026-09-29T23:00:00.000Z');
        await deliver('MEETING_ENDED', other, survivorIsConfirmed ? 'pine.example' : 'poplar.example', PAST);
        const rows = [await meetingOf(confirmedUid), await meetingOf(other)];
        // The unconfirmed row is the newer one: newest-row-wins would take `ended`.
        expect(rows[1]?.last_event_at.getTime()).toBeGreaterThan(rows[0]?.last_event_at.getTime() ?? 0);
        const survivorId = survivorIsConfirmed ? confirmed.id : (rows[1]?.id ?? '');
        const result = await withTransaction(database.session, async () => {
          const { rows: locked } = await database.session.query<MeetingRow>(
            `SELECT ${MEETING_COLUMNS} FROM meetings WHERE workspace_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE`,
            [workspaceId(), rows.map(row => row?.id)],
          );
          return await foldMeetings(system(), locked, survivorId);
        });
        expect(result).toMatchObject({ id: survivorId, state: 'held', attendance_source: 'manual', attendance_confirmed_by: seeded.alpha.salesperson.userId });
      }
    });
  });

  // ----------------------------------------------- CC3: meeting events move no stage
  describe('a meeting never moves a deal; the move is offered (CC3)', () => {
    async function stageOf(opportunityId: string): Promise<string> {
      const { rows } = await database.session.query<{ key: string }>(
        `SELECT s.key FROM opportunities o JOIN pipeline_stages s ON s.workspace_id = o.workspace_id AND s.id = o.stage_id
          WHERE o.workspace_id = $1 AND o.id = $2`,
        [workspaceId(), opportunityId],
      );
      return rows[0]?.key ?? '';
    }
    const stageEvents = async (firmId: string): Promise<number> =>
      Number((await database.session.query<{ n: string }>('SELECT count(*) AS n FROM opportunity_stage_events WHERE workspace_id = $1 AND firm_id = $2', [workspaceId(), firmId])).rows[0]?.n);

    it('webhook, reconciliation, match, end and attendance leave the deal in Interested, and the move is suggested', async () => {
      const owner = await firm('Quince');
      const opportunityId = await opportunityAt(owner.id, 'new');
      const events = await stageEvents(owner.id);
      const live = uid();
      await deliver('BOOKING_CREATED', live, owner.domain, FUTURE);
      await reconcile([booking(uid(), { attendee: `partner@${owner.domain}`, start: FUTURE.startTime, end: FUTURE.endTime })]);
      const { uid: past, meeting } = await (async () => {
        const id = uid();
        await deliver('BOOKING_CREATED', id, owner.domain, PAST);
        await deliver('MEETING_ENDED', id, owner.domain, PAST);
        return { uid: id, meeting: await meetingOf(id) };
      })();
      await set(salesperson(), meeting.id, 'attended');
      // An unmatched booking a person then matches to the firm.
      const stray = uid();
      await deliver('BOOKING_CREATED', stray, 'stranger.example', FUTURE);
      expect(await withTransaction(database.session, async () => await matchMeetingToFirm(salesperson(), { meetingId: (await meetingOf(stray)).id, firmId: owner.id }))).toMatchObject({
        ok: true,
        value: { stage: 'none' },
      });
      expect(past).not.toBe(live);
      expect(await stageOf(opportunityId)).toBe('new');
      expect(await stageEvents(owner.id)).toBe(events);

      const suggestion = { stageKey: 'demo_booked', opportunityId };
      expect((await readDemoBookedSuggestions(salesperson(), [owner.id])).get(owner.id)).toEqual(suggestion);
      expect(await readFirmStageSuggestion(salesperson(), owner.id)).toEqual(suggestion);
      expect((await readPipelineBoardForActor(salesperson())).cards[owner.id]?.stageSuggestion).toEqual(suggestion);
    });

    it('no module under meetings/ calls a stage writer (the grep half of CC3)', () => {
      const directory = join(import.meta.dirname, '..', '..', 'meetings');
      for (const file of readdirSync(directory).filter(name => name.endsWith('.ts'))) {
        const source = readFileSync(join(directory, file), 'utf8');
        for (const writer of ['applyStageEvidence(', 'moveOpportunityStage(', 'changeStage(', 'openOpportunity(', 'reopenOpportunity(']) {
          expect(source.includes(writer), `${file} calls ${writer}`).toBe(false);
        }
      }
    });

    it('suggests opening at Demo booked for a firm with no deal, and nothing for a closed deal, a later stage, an ended meeting or a colleague', async () => {
      const none = await firm('Redwood');
      await deliver('BOOKING_CREATED', uid(), none.domain, FUTURE);
      expect(await readFirmStageSuggestion(salesperson(), none.id)).toEqual({ stageKey: 'demo_booked', opportunityId: null });

      const lost = await firm('Rowan');
      await opportunityAt(lost.id, 'lost', 'lost');
      await deliver('BOOKING_CREATED', uid(), lost.domain, FUTURE);
      expect(await readFirmStageSuggestion(salesperson(), lost.id)).toBeNull();

      const later = await firm('Spruce');
      await opportunityAt(later.id, 'demo_booked');
      await deliver('BOOKING_CREATED', uid(), later.domain, FUTURE);
      expect(await readFirmStageSuggestion(salesperson(), later.id)).toBeNull();

      const past = await firm('Sumac');
      await opportunityAt(past.id, 'new');
      await deliver('BOOKING_CREATED', uid(), past.domain, PAST);
      expect(await readFirmStageSuggestion(salesperson(), past.id)).toBeNull();

      const colleague = await firm('Tamarack', seeded.alpha.admin.userId);
      await deliver('BOOKING_CREATED', uid(), colleague.domain, FUTURE);
      expect(await readFirmStageSuggestion(salesperson(), colleague.id)).toBeNull();
      expect(await readFirmStageSuggestion(admin(), colleague.id)).toEqual({ stageKey: 'demo_booked', opportunityId: null });
    });
  });
});

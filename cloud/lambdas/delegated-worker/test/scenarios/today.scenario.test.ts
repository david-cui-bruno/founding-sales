import { describe, expect, it } from 'vitest';
import { todayCardSchema, todayViewSchema, type TodayView } from '../../../../../src/shared/contracts/v1Contract';
import { CALL_WINDOW_FLOOR, evaluateDial, narrowCallWindow } from '../../src/v1/callWindow';
import { enrollFirm, listedRouteId, putCallEvidence, putFirm, putTerritoryPolicy, readDay, riFirm, setPosture, morningOf } from './firmFixtures';
import { v1Fixture } from './v1Fixture';

/**
 * GET /v1/today on the real handler (FSS target design section 3; slice S1): the four lanes as cards, with dialability
 * computed by the server at request time from the firm's zone and the code floor window, never by the Mac.
 */
const listOf = (view: TodayView) => { if (view.list === null) throw new Error(`no list: ${view.reason}`); return view.list; };
const emptyOf = (view: TodayView) => { if (view.list !== null) throw new Error('a list was served'); return view; };

describe('GET /v1/today', () => {
  it('answers not_built_yet before the morning build, no_posture when no state has a posture, and requires a device token', async () => {
    const f = v1Fixture('2026-09-18T08:00:00.000Z');
    const device = await f.pairDevice();
    expect((await f.request('GET', '/v1/today')).statusCode).toBe(401);
    await putTerritoryPolicy(f.store, '2026-09-01T12:00:00.000Z');
    await putFirm(f.store, riFirm(1));
    const noPosture = todayViewSchema.parse(f.json(await f.request('GET', '/v1/today', { authorization: device.bearer })));
    expect(noPosture).toMatchObject({ list: null, reason: 'no_posture', postures: [], statesWithoutPosture: ['RI'] });
    await setPosture(f, device.bearer, 'RI', 'calling');
    const early = todayViewSchema.parse(f.json(await f.request('GET', '/v1/today', { authorization: device.bearer })));
    expect(early).toMatchObject({ list: null, reason: 'not_built_yet', statesWithoutPosture: [] });
    expect(emptyOf(early).postures).toEqual([expect.objectContaining({ state: 'RI', posture: 'calling', reviewOverdue: false })]);
  });

  it('expands the lanes into cards that validate, with dialability from the firm\'s zone and the code floor, and a header with builtAt, poolSize, holds, the last tick and postures', async () => {
    const f = v1Fixture('2026-09-10T12:00:00.000Z');
    const store = f.store; const tick = morningOf(f);
    const policy = await putTerritoryPolicy(store, '2026-09-01T12:00:00.000Z');
    const device = await f.pairDevice();
    await setPosture(f, device.bearer, 'RI', 'calling');
    await setPosture(f, device.bearer, 'TX', 'calling');
    await putFirm(store, riFirm(1, { businessEmail: 'office@rifirm1.example' }));
    await putFirm(store, riFirm(2, { phoneVerification: 'published' }));
    await putFirm(store, { id: 'account-chi', name: 'Windy City Rentals', address: '1 N State St, Chicago, IL 60602, USA', phone: '+13125550270', researchedAt: '2026-09-16T12:00:00.000Z' });
    await putFirm(store, { id: 'account-tx', name: 'Lone Star Living', address: '500 W 2nd St, Austin, TX 78701, USA', phone: '+15125550271', researchedAt: '2026-09-16T12:00:00.000Z' });
    await putFirm(store, { id: 'account-ma', name: 'Bay State Homes', address: '1 Beacon St, Boston, MA 02108, USA', phone: '+16175550272', researchedAt: '2026-09-16T12:00:00.000Z' });
    // A Texas firm called once (voicemail on the 15th), now on its day-3 call, due the 18th.
    const mid = await enrollFirm(store, { firmId: 'account-tx', routeId: listedRouteId('account-tx', '+15125550271'), policy, startedAt: '2026-09-15T13:00:00.000Z', stepIndex: 1 });
    await putCallEvidence(store, { enrollment: mid.enrollment, version: mid.version, routeId: listedRouteId('account-tx', '+15125550271'), outcome: 'voicemail', observedAt: '2026-09-15T14:00:00.000Z' });

    // 07:00 Eastern on Friday 18 Sep: the list built at 05:05, Chicago reads 06:00, before the floor opens.
    f.advance('2026-09-18T09:05:00.000Z');
    await tick();
    f.advance('2026-09-18T11:00:00.000Z');
    const seven = todayViewSchema.parse(f.json(await f.request('GET', '/v1/today', { authorization: device.bearer })));
    const list = listOf(seven);
    expect(Object.keys(list.lanes)).toEqual(['replies', 'callbacks', 'due', 'new']);
    for (const lane of Object.values(list.lanes)) for (const card of lane) expect(todayCardSchema.safeParse(card).success).toBe(true);
    expect(list.lanes.replies).toEqual([]); expect(list.lanes.callbacks).toEqual([]);
    expect(list.lanes.due.map(card => card.firmId)).toEqual(['account-tx']);
    expect(list.lanes.new.map(card => card.firmId).sort()).toEqual(['account-ri-1', 'account-ri-2']);
    // Illinois has no fixed zone in this build (two-zone states aside, its zone is not recorded): held, not offered.
    expect(JSON.stringify(list.lanes)).not.toContain('account-chi');
    const tx = list.lanes.due[0]!;
    expect(tx).toMatchObject({ firmId: 'account-tx', lane: 'due', reason: 'step_due', name: 'Lone Star Living', phone: { number: '+15125550271', verification: 'listed' },
      website: 'accounttx.example', city: 'Austin', state: 'TX', timeZone: 'America/Chicago', localTime: '06:00', openNow: false,
      dialAllowed: false, holdReason: 'outside_hours', holdCode: 'outside_hours', offer: policy.offer,
      lastOutcome: { outcome: 'voicemail', at: '2026-09-15T14:00:00.000Z', note: null }, nextStep: { kind: 'call', stepIndex: 1, stepCount: 5, dueAt: '2026-09-18T13:00:00.000Z' } });
    const ri1 = list.lanes.new.find(card => card.firmId === 'account-ri-1')!;
    // 07:00 in Providence is also outside the floor; the RI firm was never called and has no step yet.
    expect(ri1).toMatchObject({ lane: 'new', reason: 'new_firm', state: 'RI', timeZone: 'America/New_York', localTime: '07:00', dialAllowed: false, holdReason: 'outside_hours',
      lastOutcome: null, nextStep: { kind: 'first_call' }, phone: { number: '+14015550201', verification: 'listed' } });
    expect(list.lanes.new.find(card => card.firmId === 'account-ri-2')!.phone).toEqual({ number: '+14015550202', verification: 'published' });
    expect(list.header).toMatchObject({ date: '2026-09-18', builtAt: '2026-09-18T09:05:00.000Z', poolSize: 2, counts: { replies: 0, callbacks: 0, due: 1, new: 2 },
      // Illinois has firms and no posture too, even though no posture could clear it while its zone is not recorded.
      lastTick: expect.objectContaining({ at: expect.any(String), status: expect.any(String) }), statesWithoutPosture: ['IL', 'MA'] });
    expect(list.header.holds).toEqual([{ reason: 'state_not_cleared', code: 'zone_unknown', count: 1 }, { reason: 'state_not_cleared', code: 'no_posture', count: 1 }]);
    expect(list.header.excluded).toEqual({ zone_unknown: 1, no_posture: 1 });
    expect(list.header.postures.map(posture => posture.state)).toEqual(['RI', 'TX']);
    expect(seven.asOf).toBe('2026-09-18T11:00:00.000Z');
    // Nothing of the addresses or excerpts travels, and nothing is called authority.
    expect(JSON.stringify(seven)).not.toMatch(/Hope St|W 2nd St|formattedAddress|authority/i);

    // 09:30 Eastern: Chicago reads 08:30, inside the code floor (Monday to Friday 08:00 to 20:00 firm-local); Providence too.
    f.advance('2026-09-18T13:30:00.000Z');
    const half = listOf(todayViewSchema.parse(f.json(await f.request('GET', '/v1/today', { authorization: device.bearer }))));
    expect(half.lanes.due[0]).toMatchObject({ firmId: 'account-tx', localTime: '08:30', dialAllowed: true, holdReason: null, holdCode: null, openNow: false });
    expect(half.lanes.new.every(card => card.dialAllowed && card.localTime === '09:30' && card.openNow)).toBe(true);
    // The same list is served all day: the lanes are the day record's, only the clock moves.
    expect(half.header.builtAt).toBe(seven.list!.header.builtAt);
    expect(readDay(f, '2026-09-18')!.lanes.new.map(entry => entry.firmId).sort()).toEqual(['account-ri-1', 'account-ri-2']);

    // Saturday 09:30 Eastern (the record of the 19th is built by the tick): the floor is Monday to Friday.
    f.advance('2026-09-19T09:05:00.000Z');
    await tick();
    f.advance('2026-09-19T13:30:00.000Z');
    const saturday = todayViewSchema.parse(f.json(await f.request('GET', '/v1/today', { authorization: device.bearer })));
    // Nothing new is left and the Texas firm is still due (uncalled): its card is held outside_hours on a Saturday.
    expect(listOf(saturday).lanes.due[0]).toMatchObject({ firmId: 'account-tx', dialAllowed: false, holdReason: 'outside_hours' });
  });

  it('a built day with nothing in any lane is no_candidates; a state whose posture is not calling is not without posture', async () => {
    const f = v1Fixture('2026-09-10T12:00:00.000Z');
    const device = await f.pairDevice(); const tick = morningOf(f);
    await putTerritoryPolicy(f.store, '2026-09-01T12:00:00.000Z');
    await setPosture(f, device.bearer, 'RI', 'not_calling');
    await putFirm(f.store, riFirm(1));
    f.advance('2026-09-18T09:05:00.000Z');
    await tick();
    const view = todayViewSchema.parse(f.json(await f.request('GET', '/v1/today', { authorization: device.bearer })));
    expect(view).toMatchObject({ list: null, reason: 'no_candidates', statesWithoutPosture: [] });
    expect(emptyOf(view).postures).toEqual([expect.objectContaining({ state: 'RI', posture: 'not_calling' })]);
  });

  it('the dial evaluation: code floor Monday to Friday 08:00 to 20:00 firm-local, narrowed only by hours inside it; no zone is a hold', () => {
    expect(CALL_WINDOW_FLOOR).toEqual({ startMinute: 8 * 60, endMinute: 20 * 60 });
    // Friday 18 Sep 2026, 11:00Z: 07:00 New York, 06:00 Chicago.
    expect(evaluateDial('2026-09-18T11:00:00.000Z', 'America/Chicago')).toEqual({ dialAllowed: false, holdReason: 'outside_hours', holdCode: 'outside_hours', localTime: '06:00', openNow: false });
    expect(evaluateDial('2026-09-18T13:30:00.000Z', 'America/Chicago')).toEqual({ dialAllowed: true, holdReason: null, holdCode: null, localTime: '08:30', openNow: false });
    expect(evaluateDial('2026-09-18T15:00:00.000Z', 'America/New_York')).toMatchObject({ dialAllowed: true, localTime: '11:00', openNow: true });
    // 19:59 is inside the floor, 20:00 is not; the weekend never is.
    expect(evaluateDial('2026-09-18T23:59:00.000Z', 'America/New_York')).toMatchObject({ dialAllowed: true, localTime: '19:59' });
    expect(evaluateDial('2026-09-19T00:00:00.000Z', 'America/New_York')).toMatchObject({ dialAllowed: false, localTime: '20:00', holdReason: 'outside_hours' });
    expect(evaluateDial('2026-09-19T15:00:00.000Z', 'America/New_York')).toMatchObject({ dialAllowed: false, localTime: '11:00', holdReason: 'outside_hours' });
    // Winter: 14:00Z is 09:00 New York under EST.
    expect(evaluateDial('2026-12-10T14:00:00.000Z', 'America/New_York')).toMatchObject({ dialAllowed: true, localTime: '09:00' });
    expect(evaluateDial('2026-09-18T15:00:00.000Z', null)).toEqual({ dialAllowed: false, holdReason: 'state_not_cleared', holdCode: 'zone_unknown', localTime: null, openNow: null });
    // Settings hours (S5) can only narrow the floor, never widen it.
    expect(narrowCallWindow({ startMinute: 9 * 60, endMinute: 17 * 60 })).toEqual({ startMinute: 9 * 60, endMinute: 17 * 60 });
    expect(narrowCallWindow({ startMinute: 6 * 60, endMinute: 22 * 60 })).toEqual(CALL_WINDOW_FLOOR);
    expect(evaluateDial('2026-09-18T13:30:00.000Z', 'America/Chicago', { startMinute: 9 * 60, endMinute: 17 * 60 })).toMatchObject({ dialAllowed: false, holdReason: 'outside_hours' });
  });
});

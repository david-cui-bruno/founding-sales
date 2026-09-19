import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TERRITORY_CLEARANCE_STATEMENTS, TERRITORY_RULES_REVISION } from '../../../../../src/shared/contracts/territoryClearanceContract';
import { diagnosticsViewSchema, settingsViewSchema, statePostureRecordSchema, type StatePostureRecord } from '../../../../../src/shared/contracts/v1Contract';
import { postureReviewAt, readPostures, stateClearance, stateKey } from '../../src/v1/postures';
import { putFirm, putTerritoryPolicy, readDay, riFirm, setPosture, tickOf } from './firmFixtures';
import { v1Fixture } from './v1Fixture';

/**
 * David's calling posture per state (FSS target design section 2, `STATE#<ST>`), recorded through the real
 * handler on the in-memory harness. Recording a posture confirms no clearance by itself: it is his decision,
 * with the registration and do-not-call status he checked, kept with every prior decision appended to history.
 * Nothing here dials.
 */
const AT = '2026-09-18T12:00:00.000Z';
const decision = (posture: 'calling' | 'not_calling') => ({
  kind: 'set_state_posture' as const, state: 'RI', posture,
  registration: { status: 'exempt' as const, citation: 'R.I. Gen. Laws § 5-61-2(10): exclusion relied on, checked 18 Sep 2026.' },
  dncList: { status: 'not_required' as const, citation: 'R.I. Gen. Laws § 5-61-3.5: own suppression list under 16 C.F.R. Part 310.' },
  referenceTextRevision: TERRITORY_RULES_REVISION,
});

describe('set_state_posture and the STATE# record', () => {
  it('records the posture with decidedAt, decidedBy, reviewAt twelve months on, and appends every prior record to history', async () => {
    const f = v1Fixture(AT);
    const device = await f.pairDevice('David MacBook');
    const first = randomUUID();
    const applied = await f.request('POST', '/v1/commands', { authorization: device.bearer, body: { commandId: first, ...decision('calling'),
      counsel: { name: 'Fictional Counsel LLP', date: '2026-09-10', memoRef: 'memo-2026-09-10-ri' } } });
    expect(applied.statusCode).toBe(200);
    expect(f.json(applied)).toEqual({ commandId: first, outcome: 'applied', reason: null });
    const stored = statePostureRecordSchema.parse(f.db.inspect(stateKey('RI')));
    expect(stored).toMatchObject({ state: 'RI', posture: 'calling', decidedAt: AT, decidedBy: 'David MacBook', reviewAt: '2027-09-18T12:00:00.000Z',
      referenceTextRevision: TERRITORY_RULES_REVISION, counsel: { name: 'Fictional Counsel LLP', date: '2026-09-10', memoRef: 'memo-2026-09-10-ri' }, history: [] });
    expect(postureReviewAt(AT)).toBe('2027-09-18T12:00:00.000Z');
    expect(postureReviewAt('2028-02-29T09:00:00.000Z')).toBe('2029-03-01T09:00:00.000Z');

    // A later decision replaces the record and keeps the first one, whole, at the head of history.
    f.advance('2026-10-01T09:00:00.000Z');
    const second = randomUUID();
    const changed = await f.request('POST', '/v1/commands', { authorization: device.bearer, body: { commandId: second, ...decision('not_calling') } });
    expect(f.json(changed)).toEqual({ commandId: second, outcome: 'applied', reason: null });
    const replaced = statePostureRecordSchema.parse(f.db.inspect(stateKey('RI')));
    expect(replaced).toMatchObject({ posture: 'not_calling', decidedAt: '2026-10-01T09:00:00.000Z', reviewAt: '2027-10-01T09:00:00.000Z' });
    expect(replaced.counsel).toBeUndefined();
    const { history: _first, ...firstWithoutHistory } = stored; void _first;
    expect(replaced.history).toEqual([firstWithoutHistory]);

    // Diagnostics exposes the summary for now (Settings is S5).
    const view = diagnosticsViewSchema.parse(f.json(await f.request('GET', '/v1/diagnostics', { authorization: device.bearer })));
    expect(view.postures).toEqual([{ state: 'RI', posture: 'not_calling', decidedAt: '2026-10-01T09:00:00.000Z', decidedBy: 'David MacBook', reviewAt: '2027-10-01T09:00:00.000Z', reviewOverdue: false }]);
    // Every state posture is one row per state; a second state is its own record.
    const ma = randomUUID();
    await f.request('POST', '/v1/commands', { authorization: device.bearer, body: { commandId: ma, ...decision('calling'), state: 'MA' } });
    expect((await readPostures(f.store)).map(record => record.state)).toEqual(['MA', 'RI']);
  });

  it('GET /v1/settings serves the postures summary and the revision 2 reference texts beside every S5 section, behind the device token', async () => {
    const f = v1Fixture(AT);
    expect((await f.request('GET', '/v1/settings')).statusCode).toBe(401);
    const device = await f.pairDevice();
    const raw = f.json(await f.request('GET', '/v1/settings', { authorization: device.bearer }));
    // The whole Settings inventory (S5 added every key but the first two). A section added here without a page to
    // read it is a control David cannot reach, which is why this list is pinned rather than counted.
    expect(Object.keys(raw as object).sort()).toEqual(['calls', 'devices', 'google', 'paused', 'phone', 'postureHistory', 'postures', 'referenceTexts', 'research', 'sending', 'templates']);
    const empty = settingsViewSchema.parse(raw);
    expect(empty.postures).toEqual([]);
    expect(empty.referenceTexts.revision).toBe(TERRITORY_RULES_REVISION);
    expect(empty.referenceTexts.statements).toEqual({ ...TERRITORY_CLEARANCE_STATEMENTS });
    expect(empty.referenceTexts.states.map(entry => entry.state)).toEqual(['RI', 'MA', 'TX']);
    for (const entry of empty.referenceTexts.states) { expect(entry.citation.url).toMatch(/^https:\/\//); expect(entry.summary.length).toBeGreaterThan(100); }
    await f.request('POST', '/v1/commands', { authorization: device.bearer, body: { commandId: randomUUID(), ...decision('calling') } });
    const view = settingsViewSchema.parse(f.json(await f.request('GET', '/v1/settings', { authorization: device.bearer })));
    expect(view.postures).toEqual([{ state: 'RI', posture: 'calling', decidedAt: AT, decidedBy: 'David MacBook', reviewAt: '2027-09-18T12:00:00.000Z', reviewOverdue: false }]);
    // No citation David typed leaves the worker through this view: the summary carries the decision and its dates only.
    expect(JSON.stringify(view.postures)).not.toContain('checked 18 Sep 2026');
  });

  it('a repeated commandId returns the first receipt as duplicate and writes nothing more; another payload under the same id is a conflict', async () => {
    const f = v1Fixture(AT);
    const device = await f.pairDevice();
    const commandId = randomUUID();
    const body = { commandId, ...decision('calling') };
    expect(f.json(await f.request('POST', '/v1/commands', { authorization: device.bearer, body }))).toEqual({ commandId, outcome: 'applied', reason: null });
    const before = f.db.dump().length;
    expect(f.json(await f.request('POST', '/v1/commands', { authorization: device.bearer, body }))).toEqual({ commandId, outcome: 'duplicate', reason: 'applied' });
    const stored = statePostureRecordSchema.parse(f.db.inspect(stateKey('RI')));
    expect(stored.history).toEqual([]);
    // The duplicate wrote only its attempt record.
    expect(f.db.dump().length).toBe(before + 1);
    expect(f.json(await f.request('POST', '/v1/commands', { authorization: device.bearer, body: { ...body, posture: 'not_calling' } }))).toEqual({ commandId, outcome: 'refused', reason: 'command_conflict' });
  });

  it('refuses a posture the contract does not admit: a non-US state, an over-long citation, an unknown status, a missing revision', async () => {
    const f = v1Fixture(AT);
    const device = await f.pairDevice();
    for (const body of [
      { commandId: randomUUID(), ...decision('calling'), state: 'ZZ' },
      { commandId: randomUUID(), ...decision('calling'), registration: { status: 'exempt', citation: 'x'.repeat(401) } },
      { commandId: randomUUID(), ...decision('calling'), dncList: { status: 'maybe', citation: '' } },
      { commandId: randomUUID(), ...decision('calling'), referenceTextRevision: undefined },
      { commandId: randomUUID(), ...decision('calling'), extra: true },
    ]) {
      const response = await f.request('POST', '/v1/commands', { authorization: device.bearer, body });
      expect([body, response.statusCode, f.json(response)]).toEqual([body, 400, { error: 'invalid_request' }]);
    }
    expect(f.db.inspect(stateKey('RI'))).toBeUndefined();
    expect(f.db.inspect('STATE#ZZ')).toBeUndefined();
  });

  it('a posture older than twelve months no longer clears its state: the build excludes every firm there as state_not_cleared / posture_review_overdue', async () => {
    const f = v1Fixture('2025-09-01T12:00:00.000Z');
    const store = f.store; const tick = tickOf(f);
    await putTerritoryPolicy(store, '2025-08-01T12:00:00.000Z');
    // Decided a year and seventeen days before the morning in question.
    await setPosture(f, (await f.pairDevice('Old MacBook')).bearer, 'RI', 'calling');
    for (let n = 1; n <= 4; n++) await putFirm(store, riFirm(n));
    f.advance('2026-09-18T09:05:00.000Z');
    await tick();
    const day = readDay(f, '2026-09-18')!;
    expect(day.lanes.new).toEqual([]);
    expect(day.excluded).toEqual({ posture_review_overdue: 4 });
    expect(stateClearance(new Map((await readPostures(store)).map(record => [record.state, record])), 'RI', '2026-09-18T09:05:00.000Z')).toEqual({ cleared: false, code: 'posture_review_overdue' });
  });

  it('clearance: calling and inside twelve months is cleared; not_calling, review overdue and no record each name their code', () => {
    const base: StatePostureRecord = { state: 'RI', posture: 'calling', registration: { status: 'exempt', citation: 'checked' }, dncList: { status: 'not_required', citation: 'checked' },
      referenceTextRevision: TERRITORY_RULES_REVISION, decidedAt: '2025-09-01T12:00:00.000Z', decidedBy: 'David MacBook', reviewAt: postureReviewAt('2025-09-01T12:00:00.000Z'), history: [] };
    const postures = new Map<string, StatePostureRecord>([['RI', base], ['MA', { ...base, state: 'MA', posture: 'not_calling' }]]);
    expect(stateClearance(postures, 'RI', '2026-08-31T12:00:00.000Z')).toEqual({ cleared: true, code: null });
    // Twelve months after the decision the posture is due for review and no longer clears the state.
    expect(stateClearance(postures, 'RI', '2026-09-01T12:00:00.000Z')).toEqual({ cleared: false, code: 'posture_review_overdue' });
    expect(stateClearance(postures, 'MA', '2026-08-31T12:00:00.000Z')).toEqual({ cleared: false, code: 'posture_not_calling' });
    expect(stateClearance(postures, 'TX', '2026-08-31T12:00:00.000Z')).toEqual({ cleared: false, code: 'no_posture' });
  });
});

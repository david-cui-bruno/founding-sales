import { describe, expect, it } from 'vitest';
import { attemptRecordSchema } from '../../../../../src/shared/contracts/v1Contract';
import { listAttempts } from '../../src/v1/attempts';
import { backfillDuePointers, dueKey, duePointerSchema, LIST_BUILT_EVENT, NEW_FIRMS_PER_DAY, readDuePointers } from '../../src/v1/dayBuild';
import { createAccountFirmSource, parseUsAddress } from '../../src/v1/firms';
import { enrollFirm, listedRouteId, putCallEvidence, putDay, putFirm, putMailSuppression, putRetiredRoute, putTerritoryPolicy, readDay, riFirm, setPosture, tickOf } from './firmFixtures';
import { v1Fixture } from './v1Fixture';

const AT = '2026-09-17T15:00:00.000Z';

describe('day.build inside the existing tick (S1 item 4): one list per Eastern day, four lanes, nothing repeated', () => {
  it('builds at the first tick at or after 05:00 Eastern, not before; the second tick does nothing; the next day is disjoint (EDT)', async () => {
    const f = v1Fixture('2026-09-10T12:00:00.000Z');
    const store = f.store; const tick = tickOf(f);
    const policy = await putTerritoryPolicy(store, '2026-09-01T12:00:00.000Z');
    const device = await f.pairDevice();
    await setPosture(f, device.bearer, 'RI', 'calling');
    // 40 candidate firms: 36 Rhode Island firms with addresses, one Massachusetts, one Texas, two with no address at all.
    const suppressed = ['account-ri-1', 'account-ri-2', 'account-ri-3'];
    const yesterday = ['account-ri-4', 'account-ri-5', 'account-ri-6', 'account-ri-7', 'account-ri-8'];
    const calledDueToday = ['account-ri-9', 'account-ri-10']; const calledDueLater = ['account-ri-11', 'account-ri-12'];
    const enrolledNotCalled = 'account-ri-13';
    for (let n = 1; n <= 36; n++) await putFirm(store, riFirm(n, n % 5 === 0 ? { businessEmail: `office@rifirm${n}.example` } : {}));
    await putFirm(store, { id: 'account-ma-1', name: 'Bay State Homes', address: '1 Beacon St, Boston, MA 02108, USA', phone: '+16175550260', researchedAt: AT });
    await putFirm(store, { id: 'account-tx-1', name: 'Lone Star Living', address: '500 W 2nd St, Austin, TX 78701, USA', phone: '+15125550261', researchedAt: AT });
    await putFirm(store, { id: 'account-unknown-1', name: 'Nowhere One', address: null, phone: '+14015550262', researchedAt: AT });
    await putFirm(store, { id: 'account-unknown-2', name: 'Nowhere Two', address: null, phone: '+14015550263', researchedAt: AT });
    for (const firmId of suppressed) await putMailSuppression(store, firmId, '2026-09-12T10:00:00.000Z');
    await putDay(store, { date: '2026-09-17', builtAt: '2026-09-17T09:01:00.000Z', newFirmIds: yesterday });
    for (const [firmId, stepIndex] of [...calledDueToday.map(id => [id, 1] as const), ...calledDueLater.map(id => [id, 3] as const)]) {
      const phone = riFirm(Number(firmId.split('-')[2])).phone!;
      const mid = await enrollFirm(store, { firmId, routeId: listedRouteId(firmId, phone), policy, startedAt: stepIndex === 1 ? '2026-09-15T13:00:00.000Z' : '2026-09-16T13:00:00.000Z', stepIndex });
      await putCallEvidence(store, { enrollment: mid.enrollment, version: mid.version, routeId: listedRouteId(firmId, phone), outcome: 'voicemail', observedAt: '2026-09-15T14:00:00.000Z' });
    }
    await enrollFirm(store, { firmId: enrolledNotCalled, routeId: listedRouteId(enrolledNotCalled, riFirm(13).phone!), policy, startedAt: '2026-09-17T13:00:00.000Z' });

    // 04:55 EDT (08:55Z): the list is not due yet. Nothing is written, no attempt, no line.
    f.advance('2026-09-18T08:55:00.000Z');
    const early = await tick();
    expect(readDay(f, '2026-09-18')).toBeNull();
    expect(early.lines.some(line => line.includes(LIST_BUILT_EVENT))).toBe(false);
    expect(await listAttempts(store, { kind: 'list' })).toEqual([]);

    // 05:05 EDT (09:05Z): the first tick at or after 05:00 builds the day.
    f.advance('2026-09-18T09:05:00.000Z');
    const built = await tick();
    const day = readDay(f, '2026-09-18');
    expect(day).not.toBeNull();
    expect(day!.builtAt).toBe('2026-09-18T09:05:00.000Z');
    expect(day!.lanes.replies).toEqual([]); expect(day!.lanes.callbacks).toEqual([]);
    expect(day!.lanes.due.map(entry => entry.firmId).sort()).toEqual([...calledDueToday].sort());
    expect(day!.lanes.due.every(entry => entry.reason === 'step_due')).toBe(true);
    const fresh = day!.lanes.new.map(entry => entry.firmId);
    expect(fresh.length).toBeLessThanOrEqual(NEW_FIRMS_PER_DAY);
    expect(fresh).toHaveLength(24);
    expect(new Set(fresh).size).toBe(fresh.length);
    for (const firmId of fresh) {
      expect(firmId).toMatch(/^account-ri-\d+$/);
      expect([...suppressed, ...yesterday, ...calledDueToday, ...calledDueLater, 'account-unknown-1', 'account-unknown-2', 'account-ma-1', 'account-tx-1']).not.toContain(firmId);
    }
    // Enrolled by the backfill but never called: still new, never due.
    expect(fresh).toContain(enrolledNotCalled);
    expect(day!.lanes.due.map(entry => entry.firmId)).not.toContain(enrolledNotCalled);
    // Ordered by research recency, then evidence richness, then name.
    const firms = new Map((await createAccountFirmSource(store).listFirms()).map(firm => [firm.firmId, firm]));
    const ordering = fresh.map(firmId => { const firm = firms.get(firmId)!; return [firm.researchedAt, firm.evidenceScore, firm.name] as const; });
    const sorted = [...ordering].sort((a, b) => a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : b[1] - a[1] || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0));
    expect(ordering).toEqual(sorted);
    expect(day!.poolSize).toBe(24);
    // The two called firms due today sit in the due lane, so only the two due later are "excluded from new" as called before.
    expect(day!.excluded).toEqual({ suppressed: 3, already_listed: 5, called_before: 2, state_unknown: 2, no_posture: 2 });
    // The list attempt carries the counts, and the one log line carries counts only.
    const attempts = await listAttempts(store, { kind: 'list' });
    expect(attempts).toHaveLength(1);
    expect(attemptRecordSchema.parse(attempts[0])).toMatchObject({ kind: 'list', outcome: 'ok', reason: null, ref: 'day:2026-09-18',
      detail: { code: 'list_built', count: 26, lanes: { replies: 0, callbacks: 0, due: 2, new: 24 } } });
    const line = built.lines.find(entry => entry.includes(LIST_BUILT_EVENT));
    expect(line).toBeDefined();
    expect(JSON.parse(line!)).toEqual({ event: LIST_BUILT_EVENT, version: 1, at: '2026-09-18T09:05:00.000Z', date: '2026-09-18', count: 26, lanes: { replies: 0, callbacks: 0, due: 2, new: 24 }, poolSize: 24 });
    expect(line).not.toMatch(/account-|Hope St|\+1401|Rhode Island Firm/);

    // 05:10 EDT: the same day is built once. Nothing changes, no second attempt.
    f.advance('2026-09-18T09:10:00.000Z');
    const again = await tick();
    expect(readDay(f, '2026-09-18')).toEqual(day);
    expect(await listAttempts(store, { kind: 'list' })).toHaveLength(1);
    expect(again.lines.some(entry => entry.includes(LIST_BUILT_EVENT))).toBe(false);

    // The next morning: five firms research found overnight are the new lane; nothing from the 18th repeats.
    for (let n = 41; n <= 45; n++) await putFirm(store, riFirm(n, { researchedAt: '2026-09-18T20:00:00.000Z' }));
    f.advance('2026-09-19T09:05:00.000Z');
    await tick();
    const next = readDay(f, '2026-09-19');
    expect(next!.lanes.new.map(entry => entry.firmId).sort()).toEqual(['account-ri-41', 'account-ri-42', 'account-ri-43', 'account-ri-44', 'account-ri-45']);
    for (const entry of next!.lanes.new) expect(fresh).not.toContain(entry.firmId);
    expect(next!.excluded.already_listed).toBe(29);
  });

  it('caps the new lane at 30 and counts the rest as over_cap', async () => {
    const f = v1Fixture('2026-09-10T12:00:00.000Z');
    const store = f.store; const tick = tickOf(f);
    await putTerritoryPolicy(store, '2026-09-01T12:00:00.000Z');
    await setPosture(f, (await f.pairDevice()).bearer, 'RI', 'calling');
    for (let n = 1; n <= 34; n++) await putFirm(store, riFirm(n));
    f.advance('2026-09-18T09:05:00.000Z');
    await tick();
    const day = readDay(f, '2026-09-18')!;
    expect(day.lanes.new).toHaveLength(NEW_FIRMS_PER_DAY);
    expect(NEW_FIRMS_PER_DAY).toBe(30);
    expect(day.poolSize).toBe(34);
    expect(day.excluded).toEqual({ over_cap: 4 });
  });

  it('builds under the winter offset too: 04:55 EST does nothing, 05:05 EST builds', async () => {
    const f = v1Fixture('2026-12-01T12:00:00.000Z');
    const store = f.store; const tick = tickOf(f);
    await putTerritoryPolicy(store, '2026-09-01T12:00:00.000Z');
    await setPosture(f, (await f.pairDevice()).bearer, 'RI', 'calling');
    await putFirm(store, riFirm(1, { researchedAt: '2026-11-30T12:00:00.000Z' }));
    f.advance('2026-12-10T09:55:00.000Z');
    await tick();
    expect(readDay(f, '2026-12-10')).toBeNull();
    f.advance('2026-12-10T10:05:00.000Z');
    await tick();
    expect(readDay(f, '2026-12-10')).toMatchObject({ date: '2026-12-10', builtAt: '2026-12-10T10:05:00.000Z', lanes: { new: [{ firmId: 'account-ri-1', reason: 'new_firm' }] } });
  });

  it('with no posture anywhere the list still builds, empty, and every firm is counted under no_posture', async () => {
    const f = v1Fixture('2026-09-10T12:00:00.000Z');
    const store = f.store; const tick = tickOf(f);
    await putTerritoryPolicy(store, '2026-09-01T12:00:00.000Z');
    for (let n = 1; n <= 3; n++) await putFirm(store, riFirm(n));
    f.advance('2026-09-18T09:05:00.000Z');
    await tick();
    expect(readDay(f, '2026-09-18')).toMatchObject({ lanes: { replies: [], callbacks: [], due: [], new: [] }, poolSize: 0, excluded: { no_posture: 3 } });
  });
});

describe('DUE#<nextDueAt>#<firmId> pointers (S1 item 3): maintained from the enrollment records until S3 writes them transactionally', () => {
  it('backfills one pointer per active enrollment with a due instant, idempotently, and the range read verifies each against its enrollment', async () => {
    const f = v1Fixture(AT);
    const store = f.store;
    const policy = await putTerritoryPolicy(store, '2026-09-01T12:00:00.000Z');
    for (const [id, phone] of [['account-a', '+14015550220'], ['account-b', '+14015550221'], ['account-c', '+14015550222']] as const) {
      await putFirm(store, { id, name: `Firm ${id}`, address: `1 Hope St, Providence, RI 02906, USA`, phone, researchedAt: AT });
    }
    const a = await enrollFirm(store, { firmId: 'account-a', routeId: listedRouteId('account-a', '+14015550220'), policy, startedAt: '2026-09-17T13:00:00.000Z' });
    const b = await enrollFirm(store, { firmId: 'account-b', routeId: listedRouteId('account-b', '+14015550221'), policy, startedAt: '2026-09-15T13:00:00.000Z', stepIndex: 1 });
    await enrollFirm(store, { firmId: 'account-c', routeId: listedRouteId('account-c', '+14015550222'), policy, startedAt: '2026-09-10T13:00:00.000Z', state: 'paused', nextDueAt: null, restingUntil: '2027-03-01T00:00:00.000Z' });
    const firms = await createAccountFirmSource(store).listFirms();
    expect(await backfillDuePointers(store, firms)).toEqual({ written: 2, present: 0 });
    const keys = () => f.db.dump().map(item => item.sk!.S!).filter(sk => sk.startsWith('DUE#')).sort();
    expect(keys()).toEqual([dueKey('2026-09-17T13:00:00.000Z', 'account-a'), dueKey('2026-09-18T13:00:00.000Z', 'account-b')].sort());
    expect(duePointerSchema.parse(f.db.inspect(dueKey('2026-09-18T13:00:00.000Z', 'account-b')))).toEqual({ version: 1, firmId: 'account-b', enrollmentId: b.enrollment.id,
      stepId: b.version.steps[1]!.id, nextDueAt: '2026-09-18T13:00:00.000Z', writtenAt: AT });
    // A second pass writes nothing: the pointers are already there.
    expect(await backfillDuePointers(store, firms)).toEqual({ written: 0, present: 2 });
    expect(keys()).toHaveLength(2);
    // The range read to the end of the Eastern day of the 17th sees only A; to the end of the 18th, both.
    expect((await readDuePointers(store, firms, '2026-09-18T03:59:59.999Z')).map(entry => entry.firmId)).toEqual(['account-a']);
    expect((await readDuePointers(store, firms, '2026-09-19T03:59:59.999Z')).map(entry => entry.firmId)).toEqual(['account-a', 'account-b']);
    // A pointer whose enrollment has since moved on is stale: skipped, never offered. (Old keys cannot be deleted: the role has no DeleteItem.)
    await store.transact([store.put(dueKey('2026-09-16T13:00:00.000Z', 'account-a'), { version: 1, firmId: 'account-a', enrollmentId: a.enrollment.id, stepId: a.version.steps[0]!.id,
      nextDueAt: '2026-09-16T13:00:00.000Z', writtenAt: '2026-09-16T12:00:00.000Z' }, null)]);
    const read = await readDuePointers(store, firms, '2026-09-19T03:59:59.999Z');
    expect(read.map(entry => [entry.firmId, entry.nextDueAt])).toEqual([['account-a', '2026-09-17T13:00:00.000Z'], ['account-b', '2026-09-18T13:00:00.000Z']]);
  });
});

describe('the firm read adapter (S1 item 1): a FirmCard from today\'s records', () => {
  it('parses the state and city out of a Places formatted address, or says it could not', () => {
    expect(parseUsAddress('12 Weybosset St, Providence, RI 02903, USA')).toEqual({ city: 'Providence', state: 'RI' });
    expect(parseUsAddress('1 Beacon St Suite 4, Boston, MA 02108, United States')).toEqual({ city: 'Boston', state: 'MA' });
    expect(parseUsAddress('500 W 2nd St, Austin, TX 78701')).toEqual({ city: 'Austin', state: 'TX' });
    expect(parseUsAddress('Austin, TX, USA')).toEqual({ city: 'Austin', state: 'TX' });
    expect(parseUsAddress('Somewhere, ZZ 00000, USA')).toEqual({ city: null, state: null });
    expect(parseUsAddress('10 Downing St, London SW1A 2AA, UK')).toEqual({ city: null, state: null });
    expect(parseUsAddress('')).toEqual({ city: null, state: null });
  });

  it('derives state and zone from the Places address and the state zone maps, records how, and holds an unknown state as state_not_cleared / state_unknown', async () => {
    const f = v1Fixture(AT);
    const store = f.store;
    await putFirm(store, { id: 'account-ri', name: 'Providence Property Group', address: '12 Weybosset St, Providence, RI 02903, USA', phone: '+14015550201', researchedAt: AT });
    await putFirm(store, { id: 'account-ma', name: 'Beacon Hill Management', address: '1 Beacon St, Boston, MA 02108, USA', phone: '+16175550202', businessEmail: 'office@beaconhillmgmt.example', researchedAt: AT });
    await putFirm(store, { id: 'account-tx', name: 'Lone Star Residential', address: '500 W 2nd St, Austin, TX 78701, USA', phone: '+15125550203', researchedAt: AT });
    await putFirm(store, { id: 'account-ct', name: 'Nutmeg Homes', address: '9 Elm St, Hartford, CT 06103, USA', phone: '+18605550204', researchedAt: AT });
    await putFirm(store, { id: 'account-fl', name: 'Sunshine Rentals', address: '1 Ocean Dr, Miami, FL 33139, USA', phone: '+13055550205', researchedAt: AT });
    await putFirm(store, { id: 'account-none', name: 'No Address Ltd', address: null, phone: '+14015550206', researchedAt: AT });
    await putFirm(store, { id: 'account-nophone', name: 'Quiet Partners', address: '3 Main St, Warwick, RI 02886, USA', phone: null, researchedAt: AT });
    const firms = await createAccountFirmSource(store).listFirms();
    const byId = new Map(firms.map(firm => [firm.firmId, firm]));
    expect([...byId.keys()].sort()).toEqual(['account-ct', 'account-fl', 'account-ma', 'account-none', 'account-nophone', 'account-ri', 'account-tx']);

    const ri = byId.get('account-ri')!;
    expect(ri).toMatchObject({ name: 'Providence Property Group', city: 'Providence', state: 'RI', timeZone: 'America/New_York', hold: null, website: 'accountri.example',
      phone: { number: '+14015550201', verification: 'listed', routeId: listedRouteId('account-ri', '+14015550201') }, businessEmail: null, researchedAt: AT, enrollment: null, suppressed: null, calls: 0, lastCall: null });
    expect(ri.derivation).toEqual({ source: 'places_formatted_address', sourceId: expect.stringMatching(/^place-/), state: 'RI', zoneFrom: 'territory_state_map' });
    // The fixed territory map wins for Texas (David's decision of 17 Sep 2026) even though Texas observes two zones.
    expect(byId.get('account-tx')).toMatchObject({ state: 'TX', timeZone: 'America/Chicago', hold: null, derivation: expect.objectContaining({ zoneFrom: 'territory_state_map' }) });
    // An addable state carries the single zone the contract records for it.
    expect(byId.get('account-ct')).toMatchObject({ state: 'CT', timeZone: 'America/New_York', hold: null, derivation: expect.objectContaining({ zoneFrom: 'addable_state_map' }) });
    // A state that observes two zones and is not in the fixed map has a known state but no zone: held, and the hold says why.
    expect(byId.get('account-fl')).toMatchObject({ state: 'FL', timeZone: null, hold: { reason: 'state_not_cleared', code: 'zone_unknown' } });
    expect(byId.get('account-fl')!.derivation).toEqual({ source: 'places_formatted_address', sourceId: expect.stringMatching(/^place-/), state: 'FL', zoneFrom: null, reason: 'state_spans_two_zones' });
    // No address in the listing: unknown state, held as state_not_cleared with the closed code state_unknown.
    expect(byId.get('account-none')).toMatchObject({ state: null, city: null, timeZone: null, hold: { reason: 'state_not_cleared', code: 'state_unknown' } });
    expect(byId.get('account-none')!.derivation).toEqual({ source: 'places_formatted_address', sourceId: expect.stringMatching(/^place-/), state: null, zoneFrom: null, reason: 'address_missing' });
    expect(byId.get('account-nophone')).toMatchObject({ state: 'RI', phone: null });
    // Evidence richness: a business email and a verified phone route each count; nothing is called "authority".
    expect(byId.get('account-ma')).toMatchObject({ businessEmail: 'office@beaconhillmgmt.example', evidenceScore: 2 });
    expect(ri.evidenceScore).toBe(0);
    expect(JSON.stringify(firms)).not.toMatch(/authority/i);
  });

  it('reads the enrollment, old-key call outcomes, retired routes and mail suppression beside the firm', async () => {
    const f = v1Fixture(AT);
    const store = f.store;
    const policy = await putTerritoryPolicy(store, '2026-09-01T12:00:00.000Z');
    const fresh = await putFirm(store, { id: 'account-fresh', name: 'Fresh Firm', address: '1 Hope St, Providence, RI 02906, USA', phone: '+14015550210', researchedAt: AT });
    const called = await putFirm(store, { id: 'account-called', name: 'Called Firm', address: '2 Hope St, Providence, RI 02906, USA', phone: '+14015550211', researchedAt: AT });
    const wrong = await putFirm(store, { id: 'account-wrong', name: 'Wrong Number Firm', address: '3 Hope St, Providence, RI 02906, USA', phone: '+14015550212', researchedAt: AT });
    await putFirm(store, { id: 'account-optout', name: 'Opted Out Firm', address: '4 Hope St, Providence, RI 02906, USA', phone: '+14015550213', researchedAt: AT });
    const freshRoute = fresh.routes[0]!.id; const calledRoute = called.routes[0]!.id; const wrongRoute = wrong.routes[0]!.id;
    await enrollFirm(store, { firmId: 'account-fresh', routeId: freshRoute, policy, startedAt: '2026-09-15T13:00:00.000Z' });
    const mid = await enrollFirm(store, { firmId: 'account-called', routeId: calledRoute, policy, startedAt: '2026-09-15T13:00:00.000Z', stepIndex: 1 });
    await putCallEvidence(store, { enrollment: mid.enrollment, version: mid.version, routeId: calledRoute, outcome: 'voicemail', observedAt: '2026-09-15T14:00:00.000Z' });
    await enrollFirm(store, { firmId: 'account-wrong', routeId: wrongRoute, policy, startedAt: '2026-09-15T13:00:00.000Z', state: 'paused', nextDueAt: null, restingUntil: '2027-03-14T13:00:00.000Z' });
    await putRetiredRoute(store, { firmId: 'account-wrong', routeId: wrongRoute, retiredAt: '2026-09-15T14:05:00.000Z' });
    await putMailSuppression(store, 'account-optout', '2026-09-16T09:00:00.000Z');
    const byId = new Map((await createAccountFirmSource(store).listFirms()).map(firm => [firm.firmId, firm]));
    // Enrolled and still on the first call: not yet called, so no call outcome and the enrollment says step 1.
    expect(byId.get('account-fresh')).toMatchObject({ calls: 0, lastCall: null, enrollment: expect.objectContaining({ currentStepIndex: 0, currentStepChannel: 'call', state: 'active', nextDueAt: '2026-09-15T13:00:00.000Z', stepCount: 5 }) });
    // One old-key voicemail moved the firm to the day-3 call.
    expect(byId.get('account-called')).toMatchObject({ calls: 1, lastCall: { outcome: 'voicemail', at: '2026-09-15T14:00:00.000Z' },
      enrollment: expect.objectContaining({ currentStepIndex: 1, currentStepChannel: 'call', nextDueAt: '2026-09-18T13:00:00.000Z' }) });
    // A retired route is never offered again; with no other phone the firm has none.
    expect(byId.get('account-wrong')).toMatchObject({ phone: null, suppressed: null, enrollment: expect.objectContaining({ state: 'paused', restingUntil: '2027-03-14T13:00:00.000Z' }) });
    expect(byId.get('account-optout')).toMatchObject({ suppressed: 'mail_suppression' });
  });
});

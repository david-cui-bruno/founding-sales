import { describe, expect, it } from 'vitest';
import { createAccountFirmSource, parseUsAddress } from '../../src/v1/firms';
import { enrollFirm, listedRouteId, putCallEvidence, putFirm, putMailSuppression, putRetiredRoute, putTerritoryPolicy } from './firmFixtures';
import { v1Fixture } from './v1Fixture';

const AT = '2026-09-17T15:00:00.000Z';

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

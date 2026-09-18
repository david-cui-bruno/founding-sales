import { describe, expect, it } from 'vitest';
import { deriveStateFromPlacesExcerpt, resolveTerritoryJurisdiction, type TerritoryClearanceRecord } from '../../src/main/domain/compliance/territoryJurisdiction';
import { territoryHoldMessage, territoryReviewAt, territoryStateStatus, TERRITORY_STATES, TERRITORY_STATE_RULES, TERRITORY_STATE_TIME_ZONES,
  TERRITORY_FEDERAL_CITATIONS, territoryCitationSchema, TERRITORY_CLEARANCE_STATEMENTS, confirmTerritoryClearanceSchema } from '../../src/shared/contracts/territoryClearanceContract';

const NOW = '2026-09-18T14:00:00.000Z';
const place = (id: string, formattedAddress: string | null, extra: Record<string, unknown> = {}) =>
  ({ id, excerpt: JSON.stringify({ id: id.replace(/^place-/, ''), displayName: 'Fictional PM', ...(formattedAddress === null ? {} : { formattedAddress }), nationalPhoneNumber: '(401) 555-0100', ...extra }) });
const clearance = (state: string, extra: Partial<TerritoryClearanceRecord> = {}): TerritoryClearanceRecord =>
  ({ state: state as TerritoryClearanceRecord['state'], revision: 1, timezone: (TERRITORY_STATE_TIME_ZONES as Record<string, string>)[state] as TerritoryClearanceRecord['timezone'] ?? 'America/New_York',
    confirmedAt: '2026-09-17T12:00:00.000Z', reviewAt: '2027-09-17T12:00:00.000Z', revokedAt: null, ...extra });

describe('deriveStateFromPlacesExcerpt', () => {
  it.each([
    ['380 Broadway, Providence, RI 02909, USA', 'RI'],
    ['1 Main St, Boston, MA 02108, United States', 'MA'],
    ['2200 Ross Ave Suite 100, Dallas, TX 75201', 'TX'],
    ['100 Congress Ave, Austin, TX 78701-4042, USA', 'TX'],
    ['5 Fictional Way, Hartford, CT 06103, USA', 'CT'],
  ])('reads %s as %s', (address, state) => {
    expect(deriveStateFromPlacesExcerpt(place('place-a', address).excerpt)).toBe(state);
  });
  it.each([
    ['no address', place('place-a', null).excerpt],
    ['no ZIP', place('place-a', '380 Broadway, Providence, RI, USA').excerpt],
    ['lowercase state', place('place-a', '380 Broadway, Providence, ri 02909, USA').excerpt],
    ['not a state', place('place-a', '380 Broadway, Providence, ZZ 02909, USA').excerpt],
    ['non-US', place('place-a', '10 Downing St, London SW1A 2AA, UK').excerpt],
    ['not JSON', 'Lenox Management\n380 Broadway Providence, Rhode Island 02909'],
    ['address not a string', place('place-a', null, { formattedAddress: 12345 }).excerpt],
    ['JSON array', '["RI 02909"]'],
  ])('refuses to guess when the excerpt is %s', (_label, excerpt) => {
    expect(deriveStateFromPlacesExcerpt(excerpt)).toBeNull();
  });
});

describe('resolveTerritoryJurisdiction', () => {
  const ri = place('place-ri', '380 Broadway, Providence, RI 02909, USA');
  it('derives jurisdiction, time zone and an allowed clearance from a confirmed state', () => {
    expect(resolveTerritoryJurisdiction({ sources: [ri], routeEvidenceIds: ['place-ri'], clearances: [clearance('RI', { revision: 3 })], now: NOW })).toEqual({
      kind: 'derived', state: 'RI', sourceId: 'place-ri', clearanceRevision: 3,
      jurisdiction: { regionCode: 'RI', timezone: 'America/New_York', reviewAt: '2027-09-17T12:00:00.000Z' },
      clearance: { decision: 'allowed', registrationConfirmed: true, stateDncSubscriptionConfirmed: true, consentRuleConfirmed: true, effectiveAt: '2026-09-17T12:00:00.000Z', expiresAt: '2027-09-17T12:00:00.000Z' },
    });
  });
  it('maps TX to Central time and MA to Eastern from the fixed state map', () => {
    const tx = place('place-tx', '2200 Ross Ave, Dallas, TX 75201, USA'), ma = place('place-ma', '1 Main St, Boston, MA 02108, USA');
    expect(resolveTerritoryJurisdiction({ sources: [tx], routeEvidenceIds: [], clearances: [clearance('TX')], now: NOW })).toMatchObject({ kind: 'derived', jurisdiction: { regionCode: 'TX', timezone: 'America/Chicago' } });
    expect(resolveTerritoryJurisdiction({ sources: [ma], routeEvidenceIds: [], clearances: [clearance('MA')], now: NOW })).toMatchObject({ kind: 'derived', jurisdiction: { regionCode: 'MA', timezone: 'America/New_York' } });
  });
  it('holds with state_clearance_missing when the state has no clearance, a revoked one, a review-due one, a future one, or a zone mismatch', () => {
    const held = { kind: 'held', reason: 'state_clearance_missing', state: 'RI' };
    expect(resolveTerritoryJurisdiction({ sources: [ri], routeEvidenceIds: [], clearances: [], now: NOW })).toEqual(held);
    expect(resolveTerritoryJurisdiction({ sources: [ri], routeEvidenceIds: [], clearances: [clearance('MA')], now: NOW })).toEqual(held);
    expect(resolveTerritoryJurisdiction({ sources: [ri], routeEvidenceIds: [], clearances: [clearance('RI', { revokedAt: NOW })], now: NOW })).toEqual(held);
    expect(resolveTerritoryJurisdiction({ sources: [ri], routeEvidenceIds: [], clearances: [clearance('RI', { reviewAt: NOW })], now: NOW })).toEqual(held);
    expect(resolveTerritoryJurisdiction({ sources: [ri], routeEvidenceIds: [], clearances: [clearance('RI', { confirmedAt: '2026-09-19T00:00:00.000Z', reviewAt: '2027-09-19T00:00:00.000Z' })], now: NOW })).toEqual(held);
    expect(resolveTerritoryJurisdiction({ sources: [ri], routeEvidenceIds: [], clearances: [clearance('RI', { timezone: 'America/Chicago' })], now: NOW })).toEqual(held);
  });
  it('answers none without any listing, and holds with jurisdiction_unknown when the state cannot be read, is outside the territory map, or two listings disagree', () => {
    expect(resolveTerritoryJurisdiction({ sources: [], routeEvidenceIds: [], clearances: [clearance('RI')], now: NOW })).toEqual({ kind: 'none' });
    // A website excerpt is not a listing: with no Places source at all there is nothing to derive from.
    expect(resolveTerritoryJurisdiction({ sources: [{ id: 'website', excerpt: ri.excerpt }], routeEvidenceIds: ['website'], clearances: [clearance('RI')], now: NOW })).toEqual({ kind: 'none' });
    expect(resolveTerritoryJurisdiction({ sources: [place('place-a', null)], routeEvidenceIds: [], clearances: [clearance('RI')], now: NOW })).toEqual({ kind: 'held', reason: 'jurisdiction_unknown', state: null });
    expect(resolveTerritoryJurisdiction({ sources: [place('place-ct', '5 Fictional Way, Hartford, CT 06103, USA')], routeEvidenceIds: [], clearances: [clearance('CT')], now: NOW })).toEqual({ kind: 'held', reason: 'jurisdiction_unknown', state: 'CT' });
    expect(resolveTerritoryJurisdiction({ sources: [ri, place('place-ma', '1 Main St, Boston, MA 02108, USA')], routeEvidenceIds: [], clearances: [clearance('RI'), clearance('MA')], now: NOW })).toEqual({ kind: 'held', reason: 'jurisdiction_unknown', state: null });
  });
  it('prefers the route\'s own Places evidence over another listing on the account', () => {
    const ma = place('place-ma', '1 Main St, Boston, MA 02108, USA');
    expect(resolveTerritoryJurisdiction({ sources: [ri, ma], routeEvidenceIds: ['place-ma'], clearances: [clearance('RI'), clearance('MA')], now: NOW })).toMatchObject({ kind: 'derived', state: 'MA', sourceId: 'place-ma' });
    expect(resolveTerritoryJurisdiction({ sources: [ri, ma], routeEvidenceIds: ['place-ma'], clearances: [clearance('RI')], now: NOW })).toEqual({ kind: 'held', reason: 'state_clearance_missing', state: 'MA' });
  });
});

describe('territory clearance contract', () => {
  it('lists exactly the approved territory with explicit zones and a citation per state', () => {
    expect(TERRITORY_STATES).toEqual(['RI', 'MA', 'TX']);
    expect(TERRITORY_STATE_TIME_ZONES).toEqual({ RI: 'America/New_York', MA: 'America/New_York', TX: 'America/Chicago' });
    for (const state of TERRITORY_STATES) {
      expect(TERRITORY_STATE_RULES[state].state).toBe(state);
      expect(territoryCitationSchema.parse(TERRITORY_STATE_RULES[state].citation)).toEqual(TERRITORY_STATE_RULES[state].citation);
    }
    for (const citation of TERRITORY_FEDERAL_CITATIONS) expect(territoryCitationSchema.parse(citation)).toEqual(citation);
    expect(Object.keys(TERRITORY_CLEARANCE_STATEMENTS)).toEqual(['businessToBusiness', 'registrationStatusChecked', 'stateDncSubscriptionChecked', 'consentRuleConfirmed']);
  });
  it('sets review one year after confirmation and derives status from revocation and review', () => {
    expect(territoryReviewAt('2026-09-18T14:00:00.000Z')).toBe('2027-09-18T14:00:00.000Z');
    expect(territoryReviewAt('2028-02-29T00:00:00.000Z')).toBe('2029-03-01T00:00:00.000Z');
    const row = { ...clearance('RI'), statements: { businessToBusiness: true as const, registrationStatusChecked: true as const, stateDncSubscriptionChecked: true as const, consentRuleConfirmed: true as const, rulesRevision: 1 }, citation: TERRITORY_STATE_RULES.RI.citation };
    expect(territoryStateStatus(null, NOW)).toBe('unconfirmed');
    expect(territoryStateStatus(row, NOW)).toBe('confirmed');
    expect(territoryStateStatus({ ...row, revokedAt: NOW }, NOW)).toBe('revoked');
    expect(territoryStateStatus({ ...row, reviewAt: NOW }, NOW)).toBe('review_due');
  });
  it('refuses a confirmation that did not accept the disclosure, repeats a state, or shows another rules revision', () => {
    expect(confirmTerritoryClearanceSchema.safeParse({ states: ['RI', 'MA', 'TX'], disclosureAccepted: true, rulesRevision: 1 }).success).toBe(true);
    expect(confirmTerritoryClearanceSchema.safeParse({ states: ['RI'], disclosureAccepted: false, rulesRevision: 1 }).success).toBe(false);
    expect(confirmTerritoryClearanceSchema.safeParse({ states: ['RI', 'RI'], disclosureAccepted: true, rulesRevision: 1 }).success).toBe(false);
    expect(confirmTerritoryClearanceSchema.safeParse({ states: ['RI'], disclosureAccepted: true, rulesRevision: 2 }).success).toBe(false);
    expect(confirmTerritoryClearanceSchema.safeParse({ states: [], disclosureAccepted: true, rulesRevision: 1 }).success).toBe(false);
    expect(confirmTerritoryClearanceSchema.safeParse({ states: ['XX'], disclosureAccepted: true, rulesRevision: 1 }).success).toBe(false);
  });
  it('phrases the hold for Today', () => {
    expect(territoryHoldMessage({ reason: 'state_clearance_missing', state: 'MA' })).toBe('Held: no clearance confirmed for MA');
    expect(territoryHoldMessage({ reason: 'jurisdiction_unknown', state: null })).toBe('Held: this firm\'s state could not be read from its listing');
  });
});

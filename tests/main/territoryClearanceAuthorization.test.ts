import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { AccountRepository } from '../../src/main/domain/accounts/accountRepository';
import { authorizeAccountRoute, createSqlAccountRoutePolicy, isAccountRoutePolicyHold, type AccountRoutePolicyEvidence } from '../../src/main/domain/accounts/accountOutreach';
import { PLAYBOOK_CHANNEL_POLICIES_V2 } from '../../src/main/domain/cadence/cadenceScheduler';
import { evaluateOutboundAuthorization } from '../../src/main/domain/compliance/outboundAuthorization';
import { TerritoryClearanceRepository } from '../../src/main/domain/compliance/territoryClearanceRepository';
import { AccountRoutePolicyStore, type RoutePolicyReceipt } from '../../src/main/delegation/accountRoutePolicyStore';
import { DelegationRepository } from '../../src/main/delegation/delegationRepository';
import type { ContactComplianceEvidence } from '../../src/main/domain/compliance/contactComplianceTypes';
import { createTempDatabase, createTestWorkspaceKey } from '../fixtures/tempDatabase';

/** Tuesday 22 Sep 2026, 13:30Z: 09:30 in Providence and Boston (EDT), 08:30 in Dallas (CDT). */
const TUESDAY_1330Z = '2026-09-22T13:30:00.000Z';
const CONFIRMED_AT = '2026-09-18T12:00:00.000Z';
const ADDRESSES = { RI: '380 Broadway, Providence, RI 02909, USA', MA: '1 Main St, Boston, MA 02108, USA', TX: '2200 Ross Ave, Dallas, TX 75201, USA', CT: '5 Fictional Way, Hartford, CT 06103, USA' };
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).reverse().forEach(fn => fn()); });

async function fixture(state: keyof typeof ADDRESSES, options: { phone?: string; extraPlace?: keyof typeof ADDRESSES; routeEvidence?: 'website' } = {}) {
  const temp = createTempDatabase(), key = createTestWorkspaceKey(), db = openDatabase({ path: temp.path, key });
  cleanups.push(() => { closeDatabase(db); key.bytes.fill(0); temp.cleanup(); });
  let at = CONFIRMED_AT; const clock = { now: () => at };
  await migrateToLatest(db, { workspaceKey: key, backupDirectory: `${temp.path}.backups` });
  const workspaceId = randomUUID();
  const accounts = new AccountRepository({ database: db, clock, ids: { next: randomUUID }, sourcePolicy: { attest: () => true } });
  const account = accounts.create({ commandId: randomUUID(), name: `Fictional ${state} PM`, domain: null });
  const phone = options.phone ?? '+14015723322';
  const placeId = `place-${state.toLowerCase()}-fictional`;
  const source = (id: string, address: string, sha = 'a') => ({ id, url: 'https://places.googleapis.com/v1/places:searchText', fetchedAt: '2026-09-18T11:00:00.000Z', sha256: sha.repeat(64),
    excerpt: JSON.stringify({ id: id.replace(/^place-/, ''), displayName: `Fictional ${state} PM`, formattedAddress: address, nationalPhoneNumber: phone }), permitted: true });
  const website = { id: 'website', url: 'https://fictional-pm.example/contact', fetchedAt: '2026-09-18T11:00:00.000Z', sha256: 'c'.repeat(64), excerpt: `Contact us: ${phone}`, permitted: true };
  accounts.admitEvidence({ commandId: randomUUID(), accountId: account.id, expectedVersion: 1, claims: [],
    sources: [source(placeId, ADDRESSES[state]), ...(options.extraPlace ? [source(`place-${options.extraPlace.toLowerCase()}-other`, ADDRESSES[options.extraPlace], 'b')] : []), ...(options.routeEvidence ? [website] : [])],
    routes: [{ id: 'listed-route', accountId: account.id, personId: null, channel: 'phone', value: phone, purpose: 'business', evidenceIds: [options.routeEvidence ? website.id : placeId], verification: options.routeEvidence ? 'published' : 'listed' }] });
  new DelegationRepository({ database: db, workspaceId, clock }).initializeLocalAuthority(account.id);
  const snapshot = accounts.snapshot(account.id, at);
  const route = snapshot.routes.find(entry => entry.id === 'listed-route')!;
  const clearances = new TerritoryClearanceRepository({ database: db, clock });
  const port = createSqlAccountRoutePolicy({ database: db, clock, expectedWorkspaceId: workspaceId });
  const read = () => db.raw.transaction(() => port.read(snapshot, route)).immediate();
  const authorize = (now: string) => {
    at = now;
    return db.raw.transaction(() => {
      const policy = port.read(snapshot, route);
      const expectedOwnerGeneration = policy && !isAccountRoutePolicyHold(policy) ? policy.ownerGeneration : null;
      return authorizeAccountRoute({ request: { commandId: randomUUID(), accountId: account.id, routeId: route.id, expectedRouteVersion: route.version, expectedEvidenceFingerprint: snapshot.fingerprint, channel: 'call' },
        route, evidenceFingerprint: snapshot.fingerprint, policy, expectedOwnerGeneration, now, windows: PLAYBOOK_CHANNEL_POLICIES_V2 });
    }).immediate();
  };
  const receipt = (policy: RoutePolicyReceipt['policy']): RoutePolicyReceipt => ({ id: randomUUID(), accountId: account.id, routeId: route.id, routeVersion: route.version, canonicalTarget: route.value,
    evidenceFingerprint: snapshot.fingerprint, revision: 1, evidenceRef: placeId, evidenceIds: [placeId], provenance: 'fictional-compliance-attestor', observedAt: CONFIRMED_AT, effectiveAt: CONFIRMED_AT, expiresAt: '2026-10-18T12:00:00.000Z', policy });
  const admitReceipt = (policy: RoutePolicyReceipt['policy']) => new AccountRoutePolicyStore({ database: db, clock, admission: { attest: () => true } }).admit(receipt(policy));
  return { db, account, route, snapshot, clearances, read, authorize, admitReceipt, placeId, setTime: (value: string) => { at = value; } };
}
const confirmAll = (f: Awaited<ReturnType<typeof fixture>>, states: ('RI' | 'MA' | 'TX')[] = ['RI', 'MA', 'TX'], at = CONFIRMED_AT) => { f.setTime(at); return f.clearances.confirm({ states, disclosureAccepted: true, rulesRevision: 1 }); };
const evidence = (value: ReturnType<Awaited<ReturnType<typeof fixture>>['read']>): AccountRoutePolicyEvidence => {
  if (!value || isAccountRoutePolicyHold(value)) throw new Error(`Expected derived evidence, got ${JSON.stringify(value)}`);
  return value;
};

describe('state clearance fallback beside the per-route receipt', () => {
  it('holds a listed RI route with state_clearance_missing until David confirms the state, then derives jurisdiction and clearance from the Places listing', async () => {
    const f = await fixture('RI');
    expect(f.read()).toEqual({ held: 'state_clearance_missing', state: 'RI', suppression: { account: false, person: false, handle: false } });
    expect(f.authorize(TUESDAY_1330Z)).toEqual({ kind: 'blocked', reason: 'state_clearance_missing' });
    confirmAll(f, ['RI']);
    const derived = evidence(f.read());
    expect(derived).toMatchObject({ accountId: f.account.id, routeId: 'listed-route', routeVersion: 1, evidenceRef: f.placeId, ownerEnabled: true, federalBasis: 'business_to_business',
      jurisdiction: { regionCode: 'RI', timezone: 'America/New_York', reviewAt: '2027-09-18T12:00:00.000Z' },
      clearance: { decision: 'allowed', registrationConfirmed: true, stateDncSubscriptionConfirmed: true, consentRuleConfirmed: true, effectiveAt: CONFIRMED_AT, expiresAt: '2027-09-18T12:00:00.000Z' },
      territory: { state: 'RI', clearanceRevision: 1, sourceId: f.placeId },
      contact: { kind: 'phone', normalizedValue: '+14015723322', validationState: 'valid', evidence: { federalStatus: 'unknown', tcpaFlag: null, source: 'legacy' } } });
    expect(f.authorize(TUESDAY_1330Z)).toMatchObject({ kind: 'allowed', canonicalTarget: '+14015723322' });
  });
  it('keeps the recipient window in the recipient\'s zone: TX at 08:30 local is outside while RI at 09:30 local is inside, at the same instant', async () => {
    const tx = await fixture('TX', { phone: '+12145551234' }), ri = await fixture('RI');
    confirmAll(tx); confirmAll(ri);
    expect(evidence(tx.read()).jurisdiction).toEqual({ regionCode: 'TX', timezone: 'America/Chicago', reviewAt: '2027-09-18T12:00:00.000Z' });
    expect(tx.authorize(TUESDAY_1330Z)).toEqual({ kind: 'blocked', reason: 'outside_recipient_window' });
    expect(ri.authorize(TUESDAY_1330Z)).toMatchObject({ kind: 'allowed' });
    expect(tx.authorize('2026-09-22T14:30:00.000Z')).toMatchObject({ kind: 'allowed' }); // 09:30 in Dallas.
    expect(ri.authorize('2026-09-22T16:30:00.000Z')).toEqual({ kind: 'blocked', reason: 'outside_recipient_window' }); // 12:30 in Providence: the midday gap.
    expect(ri.authorize('2026-09-22T17:30:00.000Z')).toMatchObject({ kind: 'allowed' }); // 13:30 in Providence: the afternoon window.
  });
  it('folds the derived jurisdiction into contextRevision so a re-confirmed clearance is a new context', async () => {
    const f = await fixture('MA', { phone: '+16175550200' });
    confirmAll(f, ['MA']);
    const first = f.authorize(TUESDAY_1330Z);
    expect(first).toMatchObject({ kind: 'allowed' });
    confirmAll(f, ['MA'], '2026-09-19T12:00:00.000Z');
    expect(evidence(f.read()).territory).toEqual({ state: 'MA', clearanceRevision: 2, sourceId: f.placeId });
    const second = f.authorize(TUESDAY_1330Z);
    expect(second).toMatchObject({ kind: 'allowed' });
    if (first.kind !== 'allowed' || second.kind !== 'allowed') throw new Error('unreachable');
    expect(second.contextRevision).not.toBe(first.contextRevision);
  });
  it('holds again after revocation and while the review is due', async () => {
    const f = await fixture('RI');
    confirmAll(f, ['RI']);
    expect(f.authorize(TUESDAY_1330Z)).toMatchObject({ kind: 'allowed' });
    f.setTime('2026-09-19T12:00:00.000Z'); f.clearances.revoke({ state: 'RI', expectedRevision: 1 });
    expect(f.read()).toMatchObject({ held: 'state_clearance_missing', state: 'RI' });
    expect(f.authorize(TUESDAY_1330Z)).toEqual({ kind: 'blocked', reason: 'state_clearance_missing' });
    confirmAll(f, ['RI'], '2026-09-20T12:00:00.000Z');
    expect(f.authorize(TUESDAY_1330Z)).toMatchObject({ kind: 'allowed' });
    expect(f.authorize('2027-09-21T13:30:00.000Z')).toEqual({ kind: 'blocked', reason: 'state_clearance_missing' }); // Review fell due 2027-09-20.
  });
  it('holds jurisdiction_unknown for a state outside the territory map and when two listings disagree', async () => {
    const ct = await fixture('CT', { phone: '+18605550200' });
    confirmAll(ct);
    expect(ct.read()).toMatchObject({ held: 'jurisdiction_unknown', state: 'CT' });
    expect(ct.authorize(TUESDAY_1330Z)).toEqual({ kind: 'blocked', reason: 'jurisdiction_unknown' });
    const mixed = await fixture('RI', { extraPlace: 'MA' });
    confirmAll(mixed);
    expect(evidence(mixed.read()).territory?.state).toBe('RI'); // The route's own listing wins over the other one.
    const ambiguous = await fixture('RI', { extraPlace: 'MA', routeEvidence: 'website' });
    confirmAll(ambiguous);
    expect(ambiguous.read()).toEqual({ held: 'jurisdiction_unknown', state: null, suppression: { account: false, person: false, handle: false } });
    expect(ambiguous.authorize(TUESDAY_1330Z)).toEqual({ kind: 'blocked', reason: 'jurisdiction_unknown' });
    const website = await fixture('RI', { routeEvidence: 'website' });
    confirmAll(website);
    expect(evidence(website.read()).territory).toEqual({ state: 'RI', clearanceRevision: 1, sourceId: website.placeId }); // The account's only listing still names the state.
  });
  it('checks suppression before the clearance and never clears a suppressed number', async () => {
    const f = await fixture('RI');
    f.db.raw.prepare('INSERT INTO pm_account_suppression_tombstones VALUES(?,?,?,?,?,?)').run(randomUUID(), f.account.id, CONFIRMED_AT, 'fictional-optout', f.placeId, CONFIRMED_AT);
    expect(f.read()).toMatchObject({ held: 'state_clearance_missing', suppression: { account: true } });
    expect(f.authorize(TUESDAY_1330Z)).toEqual({ kind: 'blocked', reason: 'account_or_route_opted_out' });
    confirmAll(f, ['RI']);
    expect(f.authorize(TUESDAY_1330Z)).toEqual({ kind: 'blocked', reason: 'account_or_route_opted_out' });
  });
  it('lets a hand-cited receipt win, even one that the state clearance would have relaxed', async () => {
    const f = await fixture('RI');
    confirmAll(f, ['RI']);
    const contact = { kind: 'phone' as const, normalizedValue: f.route.value, validationState: 'valid' as const, evidence: { federalStatus: 'verified_clear' as const, tcpaFlag: false, coveredAreaCode: '401', source: 'ftc_download' as const, scrubbedAt: CONFIRMED_AT, expiresAt: '2026-10-18T12:00:00.000Z' } };
    f.admitReceipt({ contact, jurisdiction: null, clearance: null });
    const fromReceipt = evidence(f.read());
    expect(fromReceipt.jurisdiction).toBeNull(); expect(fromReceipt.territory).toBeUndefined(); expect(fromReceipt.federalBasis).toBeUndefined();
    expect(f.authorize(TUESDAY_1330Z)).toEqual({ kind: 'blocked', reason: 'jurisdiction_unknown' });
  });
  it('returns nothing for an account without a delegated authority row, exactly as before', async () => {
    const f = await fixture('RI');
    confirmAll(f, ['RI']);
    f.db.raw.prepare('DELETE FROM delegated_authorities WHERE account_id=?').run(f.account.id);
    expect(f.read()).toBeNull();
    expect(f.authorize(TUESDAY_1330Z)).toEqual({ kind: 'blocked', reason: 'account_policy_evidence_unavailable' });
  });
});

describe('business-to-business basis inside evaluateOutboundAuthorization', () => {
  const unknown: ContactComplianceEvidence = { federalStatus: 'unknown', tcpaFlag: null, coveredAreaCode: null, source: 'legacy', scrubbedAt: null, expiresAt: null };
  const base = { channel: 'call' as const, now: TUESDAY_1330Z, personOrHandleOptedOut: false,
    contact: { kind: 'phone' as const, normalizedValue: '+14015723322', validationState: 'valid' as const, evidence: unknown },
    jurisdiction: { regionCode: 'RI', timezone: 'America/New_York', reviewAt: '2027-09-18T12:00:00.000Z' },
    clearance: { decision: 'allowed' as const, registrationConfirmed: true, stateDncSubscriptionConfirmed: true, consentRuleConfirmed: true, effectiveAt: CONFIRMED_AT, expiresAt: '2027-09-18T12:00:00.000Z' },
    windows: PLAYBOOK_CHANNEL_POLICIES_V2 };
  it('still refuses an unscrubbed number without the basis, exactly as before', () => {
    expect(evaluateOutboundAuthorization(base)).toEqual({ kind: 'refused', reasonCode: 'federal_status_unknown' });
  });
  it('allows the unscrubbed listed business number only under the explicit basis', () => {
    expect(evaluateOutboundAuthorization({ ...base, federalBasis: 'business_to_business' })).toEqual({ kind: 'allowed' });
  });
  it('keeps a known listing or TCPA flag blocking under the basis', () => {
    expect(evaluateOutboundAuthorization({ ...base, federalBasis: 'business_to_business', contact: { ...base.contact, evidence: { ...unknown, federalStatus: 'listed' } } })).toEqual({ kind: 'refused', reasonCode: 'federal_dnc_listed' });
    expect(evaluateOutboundAuthorization({ ...base, federalBasis: 'business_to_business', contact: { ...base.contact, evidence: { ...unknown, tcpaFlag: true } } })).toEqual({ kind: 'refused', reasonCode: 'tcpa_blocked' });
    expect(evaluateOutboundAuthorization({ ...base, federalBasis: 'business_to_business', contact: { ...base.contact, evidence: { ...unknown, federalStatus: 'verified_clear', tcpaFlag: false, source: 'ftc_download', coveredAreaCode: '401', scrubbedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-20T00:00:00.000Z' } } }))
      .toEqual({ kind: 'refused', reasonCode: 'federal_evidence_stale' });
    // Scrub evidence that exists but is incomplete is not the never-scrubbed record; it refuses on its own terms.
    expect(evaluateOutboundAuthorization({ ...base, federalBasis: 'business_to_business', contact: { ...base.contact, evidence: { ...unknown, tcpaFlag: false } } })).toEqual({ kind: 'refused', reasonCode: 'federal_status_unknown' });
    expect(evaluateOutboundAuthorization({ ...base, federalBasis: 'business_to_business', contact: { ...base.contact, evidence: { ...unknown, federalStatus: 'verified_clear', source: 'ftc_download', coveredAreaCode: '401', scrubbedAt: '2026-09-01T00:00:00.000Z', expiresAt: '2026-09-30T00:00:00.000Z' } } })).toEqual({ kind: 'refused', reasonCode: 'tcpa_status_unknown' });
  });
  it('keeps every later gate: jurisdiction, clearance and the recipient window', () => {
    expect(evaluateOutboundAuthorization({ ...base, federalBasis: 'business_to_business', jurisdiction: null })).toEqual({ kind: 'refused', reasonCode: 'jurisdiction_unknown' });
    expect(evaluateOutboundAuthorization({ ...base, federalBasis: 'business_to_business', clearance: null })).toEqual({ kind: 'refused', reasonCode: 'jurisdiction_unknown' });
    expect(evaluateOutboundAuthorization({ ...base, federalBasis: 'business_to_business', now: '2026-09-22T12:30:00.000Z' })).toEqual({ kind: 'refused', reasonCode: 'outside_recipient_window' });
  });
});

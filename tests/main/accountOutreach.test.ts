import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { authorizeAccountRoute, type AccountRoutePolicyEvidence } from '../../src/main/domain/accounts/accountOutreach';
import { PLAYBOOK_CHANNEL_POLICIES_V2 } from '../../src/main/domain/cadence/cadenceScheduler';
import { accountFingerprint } from '../../src/main/domain/accounts/accountEvidence';
import type { AccountRoute } from '../../src/shared/contracts/accountContract';

const accountId = randomUUID();
const route: AccountRoute = { id: randomUUID(), accountId, personId: null, channel: 'phone', value: '+14015550100', purpose: 'business', evidenceIds: [randomUUID()], verification: 'published', version: 1 };
const fingerprint = accountFingerprint(route);
const request = { commandId: randomUUID(), accountId, routeId: route.id, expectedRouteVersion: 1, expectedEvidenceFingerprint: fingerprint, channel: 'call' as const };
const now = '2026-09-08T14:00:00.000Z';
function policy(): AccountRoutePolicyEvidence {
  return { accountId, routeId: route.id, routeVersion: 1, evidenceFingerprint: fingerprint,
    evidenceRef: 'fictional-policy-receipt', ownerGeneration: 'fictional-owner-1', ownerEnabled: true,
    suppression: { account: false, person: false, handle: false },
    contact: { kind: 'phone', normalizedValue: route.value, validationState: 'valid', evidence: {
      federalStatus: 'verified_clear', tcpaFlag: false, coveredAreaCode: '401', source: 'ftc_download', scrubbedAt: '2026-09-01T00:00:00.000Z', expiresAt: '2026-10-01T00:00:00.000Z' } },
    jurisdiction: { regionCode: 'RI', timezone: 'America/New_York', reviewAt: null },
    clearance: { decision: 'allowed', registrationConfirmed: true, stateDncSubscriptionConfirmed: true, consentRuleConfirmed: true, effectiveAt: '2026-09-01T00:00:00.000Z', expiresAt: '2026-10-01T00:00:00.000Z' } };
}
function decide(change: Partial<Parameters<typeof authorizeAccountRoute>[0]> = {}) {
  return authorizeAccountRoute({ request, route, evidenceFingerprint: fingerprint, policy: policy(), now, expectedOwnerGeneration: 'fictional-owner-1', windows: PLAYBOOK_CHANNEL_POLICIES_V2, ...change });
}
describe('account business route authorization', () => {
  it('allows genuine company-only published switchboard with separately evidenced compliance', () => {
    expect(decide()).toMatchObject({ kind: 'allowed', canonicalTarget: route.value });
    expect(route.personId).toBeNull();
  });
  it.each(['tenant_emergency', 'unknown'] as const)('refuses %s purpose', purpose => {
    expect(decide({ route: { ...route, purpose } })).toMatchObject({ kind: 'blocked', reason: 'route_not_business' });
  });
  it.each(['account', 'person', 'handle'] as const)('blocks %s suppression', scope => {
    const evidence = policy(); evidence.suppression[scope] = true;
    expect(decide({ policy: evidence })).toMatchObject({ kind: 'blocked', reason: 'account_or_route_opted_out' });
  });
  it('never treats publication as compliance clearance', () => {
    expect(decide({ policy: null })).toEqual({ kind: 'blocked', reason: 'account_policy_evidence_unavailable' });
  });
  it('keeps email execution unavailable', () => {
    expect(decide({ request: { ...request, channel: 'email' }, route: { ...route, channel: 'email', value: 'office@example.invalid' } })).toEqual({ kind: 'blocked', reason: 'email_execution_unavailable' });
  });
  it('binds exact route and evidence versions', () => {
    expect(decide({ route: { ...route, version: 2 } })).toMatchObject({ reason: 'stale_route' });
    expect(decide({ evidenceFingerprint: '0'.repeat(64) })).toMatchObject({ reason: 'stale_evidence' });
    expect(decide({ policy: { ...policy(), routeVersion: 2 } })).toMatchObject({ reason: 'account_policy_evidence_stale' });
  });
  it('binds owner generation and enabled state', () => {
    expect(decide({ expectedOwnerGeneration: 'old' })).toMatchObject({ reason: 'account_owner_changed' });
    expect(decide({ policy: { ...policy(), ownerEnabled: false } })).toMatchObject({ reason: 'account_owner_changed' });
  });
  it('reuses genuine DNC, validation, jurisdiction, and recipient-local policy', () => {
    const evidence = policy(); evidence.contact.evidence = { ...evidence.contact.evidence, federalStatus: 'listed' };
    expect(decide({ policy: evidence })).toMatchObject({ reason: 'federal_dnc_listed' });
    expect(decide({ policy: { ...policy(), contact: { ...policy().contact, validationState: 'unverified' } } })).toMatchObject({ reason: 'contact_validation_unusable' });
    expect(decide({ policy: { ...policy(), jurisdiction: null } })).toMatchObject({ reason: 'jurisdiction_unknown' });
    expect(decide({ now: '2026-09-08T23:00:00.000Z' })).toMatchObject({ reason: 'outside_recipient_window' });
  });
});

import { describe, expect, it } from 'vitest';

import { rankAccount } from '../../src/shared/accounts/accountRanking';
import type { AccountEvidenceSnapshot } from '../../src/shared/contracts/accountContract';

const asOf = '2026-09-08T15:00:00.000Z';

function snapshot(overrides: Partial<AccountEvidenceSnapshot> = {}): AccountEvidenceSnapshot {
  return {
    account: { id: 'pm-account', name: 'Regional PM', domain: 'regional.example', version: 2 },
    claims: [],
    routes: [],
    portfolio: [],
    unknowns: [],
    conflicts: [],
    fingerprint: 'source-fingerprint',
    ...overrides,
  };
}

describe('rankAccount', () => {
  it('ranks supported residential regional PM evidence ahead of operating relevance and geography bonus', () => {
    const result = rankAccount(snapshot({
      claims: [
        { kind: 'fact', key: 'residential_scope', value: 'Residential multifamily property management', evidenceIds: ['scope'] },
        { kind: 'fact', key: 'operating_footprint', value: 'Regional manager serving Albany and nearby markets', evidenceIds: ['footprint'] },
        { kind: 'fact', key: 'maintenance_workflow', value: 'Handles maintenance coordination for tenants', evidenceIds: ['maintenance'] },
      ],
      routes: [
        { id: 'route-phone', accountId: 'pm-account', personId: null, channel: 'phone', value: '+15555550100', purpose: 'business', evidenceIds: ['route'], verification: 'published', version: 2 },
      ],
      unknowns: ['portfolio'],
    }), asOf);

    expect(result).toEqual({
      accountId: 'pm-account',
      fit: 'supported',
      contactable: true,
      reasons: [
        { text: 'Evidence supports residential or multifamily property management fit.', evidenceIds: ['scope'] },
        { text: 'Evidence supports a regional operating footprint.', evidenceIds: ['footprint'] },
        { text: 'Evidence supports property management operating relevance.', evidenceIds: ['maintenance'] },
        { text: 'Published business route is available for a company-level call.', evidenceIds: ['route'] },
      ],
      unknowns: ['portfolio'],
      fingerprint: 'source-fingerprint',
    });
  });

  it('preserves claim provenance and does not infer pain from advertised 24/7 marketing', () => {
    const result = rankAccount(snapshot({
      claims: [
        { kind: 'fact', key: 'maintenance_workflow', value: '24/7 emergency maintenance hotline', evidenceIds: ['marketing'] },
        { kind: 'hypothesis', key: 'pain', value: 'May need better after-hours call handling', evidenceIds: [] },
      ],
      unknowns: ['residential_scope', 'operating_footprint'],
    }), asOf);

    expect(result.fit).toBe('uncertain');
    expect(result.contactable).toBe(false);
    expect(result.reasons).toEqual([
      { text: 'Evidence supports property management operating relevance.', evidenceIds: ['marketing'] },
    ]);
    expect(result.unknowns).toEqual(['residential_scope', 'operating_footprint', 'business_route']);
  });
});

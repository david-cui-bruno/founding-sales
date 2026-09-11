import { describe, expect, it } from 'vitest';

import {
  comparePhoneCandidates,
  isPositivelyBlocked,
  selectPrimaryPhone,
} from '../../../../src/main/domain/contacts/contactPresentation';
import type { ContactMethod } from '../../../../src/shared/contracts/leadDetailContract';

type PhoneComplianceStatus = NonNullable<ContactMethod['compliance']>['status'];

function candidate(id: string, overrides: Partial<ContactMethod> = {}): ContactMethod {
  return {
    contactSnapshot: 'a'.repeat(64),
    id, kind: 'phone', value: '+14015550100', label: null, valid: false,
    validationState: 'unverified', reachability: 'direct', sourceLabel: 'vendor',
    vendorRank: null, phoneKind: 'mobile', ownershipState: 'vendor_candidate',
    evidenceObservedAt: '2026-08-30T12:00:00.000Z',
    compliance: {
      status: 'compliance_unknown', label: 'Compliance unknown', expiresAt: null,
      callRefusalReason: 'federal_status_unknown', textRefusalReason: 'federal_status_unknown',
    },
    ...overrides,
  };
}

function compliance(status: PhoneComplianceStatus): ContactMethod['compliance'] {
  const reason: Record<PhoneComplianceStatus, NonNullable<ContactMethod['compliance']>['callRefusalReason']> = {
    verified_clear: null,
    federal_dnc_listed: 'federal_dnc_listed',
    tcpa_blocked: 'tcpa_blocked',
    compliance_unknown: 'federal_status_unknown',
    scrub_expired: 'federal_evidence_stale',
    area_code_not_covered: 'federal_area_code_mismatch',
    state_clearance_required: 'jurisdiction_unknown',
    outside_recipient_window: 'outside_recipient_window',
  } as const;
  return {
    status, label: status,
    expiresAt: status === 'verified_clear' ? '2026-09-15T00:00:00.000Z' : null,
    callRefusalReason: reason[status], textRefusalReason: reason[status],
  };
}

const statusCases: [PhoneComplianceStatus, boolean][] = [
  ['verified_clear', false],
  ['federal_dnc_listed', true],
  ['tcpa_blocked', true],
  ['compliance_unknown', false],
  ['scrub_expired', false],
  ['area_code_not_covered', false],
  ['state_clearance_required', false],
  ['outside_recipient_window', false],
];

describe('isPositivelyBlocked', () => {
  it.each(statusCases)('classifies %s as a positive block only when listed or TCPA-blocked', (status, blocked) => {
    expect(isPositivelyBlocked(status)).toBe(blocked);
  });
});

describe('comparePhoneCandidates', () => {
  it.each(statusCases.filter(([, blocked]) => !blocked))('orders %s before both positive blocks regardless of ownership or rank', (status) => {
    const nonpositive = candidate('nonpositive', {
      compliance: compliance(status), ownershipState: 'conflicting_identity', vendorRank: null,
    });
    for (const blocked of ['federal_dnc_listed', 'tcpa_blocked'] as const) {
      const listed = candidate('listed', {
        compliance: compliance(blocked), ownershipState: 'verified_person', vendorRank: 1,
      });
      expect(comparePhoneCandidates(nonpositive, listed)).toBeLessThan(0);
      expect(comparePhoneCandidates(listed, nonpositive)).toBeGreaterThan(0);
    }
  });

  it.each(statusCases.filter(([status, blocked]) => !blocked && status !== 'verified_clear'))('orders verified clear before %s despite lower ownership confidence and rank', (status) => {
    const clear = candidate('clear', {
      compliance: compliance('verified_clear'), ownershipState: 'conflicting_identity',
    });
    const other = candidate('other', {
      compliance: compliance(status), ownershipState: 'verified_person', vendorRank: 1,
    });
    expect(comparePhoneCandidates(clear, other)).toBeLessThan(0);
    expect(comparePhoneCandidates(other, clear)).toBeGreaterThan(0);
  });

  it.each([
    ['verified_person', 'vendor_candidate'],
    ['vendor_candidate', 'unknown'],
    ['unknown', 'conflicting_identity'],
  ] as const)('orders ownership %s before %s ahead of vendor rank', (first, second) => {
    expect(comparePhoneCandidates(
      candidate('z', { ownershipState: first, vendorRank: null }),
      candidate('a', { ownershipState: second, vendorRank: 1 }),
    )).toBeLessThan(0);
  });

  it.each([[1, 2], [2, 10], [10, null]] as const)('orders vendor rank %s before %s ahead of normalized phone', (first, second) => {
    expect(comparePhoneCandidates(
      candidate('z', { vendorRank: first, value: '+14015550999' }),
      candidate('a', { vendorRank: second, value: '+14015550000' }),
    )).toBeLessThan(0);
  });

  it('uses normalized phone then binary stable ID to break duplicate-rank ties', () => {
    const phones = [
      candidate('a', { vendorRank: 2, value: '+14015550200' }),
      candidate('a', { vendorRank: 2 }),
      candidate('Z', { vendorRank: 2 }),
    ];
    expect(phones.sort(comparePhoneCandidates).map(({ id, value }) => [id, value])).toEqual([
      ['Z', '+14015550100'], ['a', '+14015550100'], ['a', '+14015550200'],
    ]);
    expect(comparePhoneCandidates(phones[0], { ...phones[0] })).toBe(0);
  });

  it('treats absent compliance conservatively as non-clear, not a positive block', () => {
    const missing = candidate('missing', { compliance: null });
    expect(comparePhoneCandidates(candidate('clear', { compliance: compliance('verified_clear') }), missing)).toBeLessThan(0);
    expect(comparePhoneCandidates(missing, candidate('blocked', { compliance: compliance('federal_dnc_listed') }))).toBeLessThan(0);
    expect(comparePhoneCandidates(missing, candidate('missing'))).toBe(0);
  });

  it('keeps the full ordering identical across deterministic shuffles without mutating contacts', () => {
    const phones = [
      candidate('blocked-dnc', { compliance: compliance('federal_dnc_listed'), vendorRank: 1 }),
      candidate('blocked-tcpa', { compliance: compliance('tcpa_blocked'), ownershipState: 'verified_person' }),
      candidate('unknown-conflict', { ownershipState: 'conflicting_identity', vendorRank: 1 }),
      candidate('unknown-owner', { ownershipState: 'unknown', vendorRank: 1 }),
      candidate('unknown-vendor-null'),
      candidate('unknown-vendor-rank2', { vendorRank: 2 }),
      candidate('unknown-verified', { ownershipState: 'verified_person' }),
      candidate('clear-conflict', { compliance: compliance('verified_clear'), ownershipState: 'conflicting_identity' }),
      candidate('clear-vendor', { compliance: compliance('verified_clear') }),
      candidate('clear-verified', { compliance: compliance('verified_clear'), ownershipState: 'verified_person' }),
    ];
    const original = structuredClone(phones);
    for (const phone of phones) {
      Object.freeze(phone.compliance);
      Object.freeze(phone);
    }
    Object.freeze(phones);
    const want = [
      'clear-verified', 'clear-vendor', 'clear-conflict', 'unknown-verified',
      'unknown-vendor-rank2', 'unknown-vendor-null', 'unknown-owner',
      'unknown-conflict', 'blocked-tcpa', 'blocked-dnc',
    ];
    for (let offset = 0; offset < phones.length; offset += 1) {
      const shuffled = [...phones.slice(offset), ...phones.slice(0, offset)];
      if (offset % 2 === 0) shuffled.reverse();
      expect(shuffled.sort(comparePhoneCandidates).map(({ id }) => id)).toEqual(want);
    }
    expect(phones).toEqual(original);
  });
});

describe('selectPrimaryPhone', () => {
  it('returns no primary and no alternatives for an empty list', () => {
    expect(selectPrimaryPhone(Object.freeze([]))).toEqual({ primary: null, alternatives: [] });
  });

  it('keeps an unverified rank-one vendor candidate as presentation only, without changing permission or ownership', () => {
    const rankOne = candidate('rank-one', { vendorRank: 1 });
    const clear = candidate('clear', {
      compliance: compliance('verified_clear'), ownershipState: 'verified_person', vendorRank: 2,
    });
    const result = selectPrimaryPhone([clear, rankOne]);
    expect(result.primary).toBe(rankOne);
    expect(result.primary).toMatchObject({
      validationState: 'unverified', valid: false, ownershipState: 'vendor_candidate',
      compliance: { callRefusalReason: 'federal_status_unknown', textRefusalReason: 'federal_status_unknown' },
    });
    expect(result.alternatives).toEqual([clear]);
  });

  it('selects a sole nonpositive phone without changing it', () => {
    const phone = candidate('only');
    expect(selectPrimaryPhone([phone])).toEqual({ primary: phone, alternatives: [] });
  });

  it('chooses among duplicate eligible rank-one candidates using the exact comparator', () => {
    const phones = [
      candidate('listed', { vendorRank: 1, compliance: compliance('federal_dnc_listed') }),
      candidate('unknown', { vendorRank: 1, ownershipState: 'verified_person' }),
      candidate('clear-z', { vendorRank: 1, compliance: compliance('verified_clear') }),
      candidate('clear-a', { vendorRank: 1, compliance: compliance('verified_clear') }),
    ];
    for (const input of [phones, [...phones].reverse()]) {
      const result = selectPrimaryPhone(input);
      expect(result.primary?.id).toBe('clear-a');
      expect(result.alternatives.map(({ id }) => id)).toEqual(['clear-z', 'unknown', 'listed']);
    }
  });

  it.each(['federal_dnc_listed', 'tcpa_blocked'] as const)('falls back to the highest ordered safe candidate when rank one is %s', (status) => {
    const blocked = candidate('blocked', { vendorRank: 1, compliance: compliance(status) });
    const unknown = candidate('unknown', { vendorRank: 2, ownershipState: 'verified_person' });
    const clear = candidate('clear', { vendorRank: 3, compliance: compliance('verified_clear') });
    expect(selectPrimaryPhone([blocked, unknown, clear])).toEqual({
      primary: clear, alternatives: [unknown, blocked],
    });
  });

  it('uses the comparator fallback when no rank-one candidate exists without mutating the input', () => {
    const phones = Object.freeze([
      Object.freeze(candidate('z', { vendorRank: 3 })),
      Object.freeze(candidate('a', { vendorRank: 2 })),
    ]);
    const original = structuredClone(phones);
    const result = selectPrimaryPhone(phones);
    expect(result.primary).toBe(phones[1]);
    expect(result.alternatives).toEqual([phones[0]]);
    expect(phones).toEqual(original);
    expect(result.alternatives).not.toBe(phones);
  });

  it('returns null primary and every sorted alternative when all candidates are positively blocked', () => {
    const phones = Object.freeze([
      candidate('dnc', { vendorRank: 1, compliance: compliance('federal_dnc_listed') }),
      candidate('tcpa', { vendorRank: 2, ownershipState: 'verified_person', compliance: compliance('tcpa_blocked') }),
    ]);
    expect(selectPrimaryPhone(phones)).toEqual({ primary: null, alternatives: [phones[1], phones[0]] });
    expect(selectPrimaryPhone([phones[0]])).toEqual({ primary: null, alternatives: [phones[0]] });
    expect(phones.map(({ id }) => id)).toEqual(['dnc', 'tcpa']);
  });
});

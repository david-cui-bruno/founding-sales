import { describe, expect, it } from 'vitest';

import { BUILTIN_PRIORITIZATION_RULE_V1 } from '../../src/main/domain/prioritization/builtinPrioritizationRules';
import {
  calculateConfidence,
  calculateFit,
  deriveReachability,
  deriveVerifyFirst,
  evaluateQualification,
  parseMaintenanceProfileV1,
} from '../../src/main/domain/prioritization/qualificationEngine';
import type {
  ContactMethodFact,
  PropertyFact,
  QualificationInputSnapshot,
} from '../../src/main/domain/prioritization/prioritizationTypes';
import { PrioritizationInputCorruptionError } from '../../src/main/domain/support/domainErrors';

const RULE = BUILTIN_PRIORITIZATION_RULE_V1;
const EVALUATED_AT = '2026-08-31T12:00:00.000Z';
const ALLOWED = { kind: 'allowed' } as const;

function snapshot(overrides: Partial<QualificationInputSnapshot> = {}): QualificationInputSnapshot {
  return {
    prospectId: 'prospect-1',
    personId: 'person-1',
    qualificationState: 'eligible',
    qualificationGateReason: null,
    personDeletedAt: null,
    originalSourceEventId: 'source-1',
    ...overrides,
  };
}

function property(overrides: Partial<PropertyFact> = {}): PropertyFact {
  return {
    id: overrides.id ?? 'property-1',
    doorCount: null,
    countryCode: 'US',
    region: 'RI',
    locality: 'Providence',
    verifiedAt: null,
    maintenanceProfile: null,
    ...overrides,
  };
}

function contact(overrides: Partial<ContactMethodFact> = {}): ContactMethodFact {
  return {
    id: overrides.id ?? 'contact-1',
    kind: 'phone',
    validationState: 'valid',
    reachability: 'direct',
    ...overrides,
  };
}

describe('evaluateQualification', () => {
  it('maps every gate/state combination exactly', () => {
    expect(evaluateQualification({ snapshot: snapshot(), permission: ALLOWED }))
      .toEqual({
        kind: 'qualified',
        prospectId: 'prospect-1',
        evidenceIds: ['prospect-1', 'source-1'],
      });
    expect(evaluateQualification({
      snapshot: snapshot({ qualificationState: 'unreviewed' }), permission: ALLOWED,
    })).toMatchObject({ kind: 'pending_review', qualificationState: 'unreviewed' });
    expect(evaluateQualification({
      snapshot: snapshot({
        qualificationState: 'disqualified', qualificationGateReason: 'out_of_area',
      }),
      permission: ALLOWED,
    })).toMatchObject({ kind: 'gated', reasons: ['out_of_area'] });
    expect(evaluateQualification({
      snapshot: snapshot({ qualificationState: 'merge_review' }), permission: ALLOWED,
    })).toMatchObject({ kind: 'gated', reasons: ['unresolved_duplicate'] });
  });

  it('short-circuits deleted Persons before opt-out inspection evidence', () => {
    expect(evaluateQualification({
      snapshot: snapshot({ personDeletedAt: EVALUATED_AT }),
      permission: { kind: 'blocked', tombstoneIds: ['tomb-1'] },
    })).toEqual({
      kind: 'operationally_blocked',
      prospectId: 'prospect-1',
      reason: 'person_deleted',
      evidenceIds: ['prospect-1'],
    });
  });

  it('returns the exact handle-wide operational block with sorted tombstone evidence', () => {
    expect(evaluateQualification({
      snapshot: snapshot(),
      permission: { kind: 'blocked', tombstoneIds: ['tomb-b', 'tomb-a'] },
    })).toEqual({
      kind: 'operationally_blocked',
      prospectId: 'prospect-1',
      reason: 'person_opted_out',
      evidenceIds: ['tomb-a', 'tomb-b'],
    });
  });

  it('treats a contradictory stored gate relation as corruption, not silently qualified', () => {
    expect(() => evaluateQualification({
      snapshot: snapshot({ qualificationState: 'disqualified', qualificationGateReason: null }),
      permission: ALLOWED,
    })).toThrow(PrioritizationInputCorruptionError);
    expect(() => evaluateQualification({
      snapshot: snapshot({ qualificationState: 'eligible', qualificationGateReason: 'out_of_area' }),
      permission: ALLOWED,
    })).toThrow(PrioritizationInputCorruptionError);
  });
});

describe('parseMaintenanceProfileV1', () => {
  it('fails closed on unknown keys or malformed values', () => {
    expect(() => parseMaintenanceProfileV1({
      formatVersion: 1, management: 'self_managed', relevantProfile: true,
      evidenceRefs: [], extra: true,
    })).toThrow(PrioritizationInputCorruptionError);
    expect(() => parseMaintenanceProfileV1({
      formatVersion: 2, management: 'self_managed', relevantProfile: true, evidenceRefs: [],
    })).toThrow(PrioritizationInputCorruptionError);
    expect(() => parseMaintenanceProfileV1('not-json-object'))
      .toThrow(PrioritizationInputCorruptionError);
    expect(parseMaintenanceProfileV1({
      formatVersion: 1, management: 'unknown', relevantProfile: 'unknown', evidenceRefs: ['r'],
    })).toEqual({
      formatVersion: 1, management: 'unknown', relevantProfile: 'unknown', evidenceRefs: ['r'],
    });
  });
});

describe('calculateFit', () => {
  const selfManaged = parseMaintenanceProfileV1({
    formatVersion: 1, management: 'self_managed', relevantProfile: 'unknown', evidenceRefs: ['ref-1'],
  });

  it.each([
    [0, 0], [1, 0], [2, 6], [4, 6], [5, 15], [30, 15], [31, 6], [50, 6], [51, 0],
  ])('door sum %i awards %i points', (doorSum, expected) => {
    const result = calculateFit({
      properties: [property({ id: 'p1', doorCount: doorSum })],
      rule: RULE,
    });
    expect(result.reasons.find((reason) => reason.category === 'door_count')?.points)
      .toBe(expected);
  });

  it('sums known door counts across unique linked properties', () => {
    const result = calculateFit({
      properties: [
        property({ id: 'p1', doorCount: 3 }),
        property({ id: 'p2', doorCount: 4 }),
        property({ id: 'p3', doorCount: null }),
      ],
      rule: RULE,
    });
    expect(result.fitPoints).toBe(15);
  });

  it('awards no door points when no linked property has a known count', () => {
    const result = calculateFit({ properties: [property({ id: 'p1' })], rule: RULE });
    expect(result.fitPoints).toBe(0);
    expect(result.fitBand).toBe('low');
  });

  it('awards management only for agreed self_managed strict V1 claims', () => {
    expect(calculateFit({
      properties: [property({ id: 'p1', maintenanceProfile: selfManaged })],
      rule: RULE,
    }).fitPoints).toBe(8);
    const thirdParty = parseMaintenanceProfileV1({
      formatVersion: 1, management: 'third_party', relevantProfile: 'unknown', evidenceRefs: [],
    });
    expect(calculateFit({
      properties: [property({ id: 'p1', maintenanceProfile: thirdParty })],
      rule: RULE,
    }).fitPoints).toBe(0);
  });

  it('treats conflicting non-unknown management claims as corruption, not first-row-wins', () => {
    const thirdParty = parseMaintenanceProfileV1({
      formatVersion: 1, management: 'third_party', relevantProfile: 'unknown', evidenceRefs: [],
    });
    expect(() => calculateFit({
      properties: [
        property({ id: 'p1', maintenanceProfile: selfManaged }),
        property({ id: 'p2', maintenanceProfile: thirdParty }),
      ],
      rule: RULE,
    })).toThrow(PrioritizationInputCorruptionError);
  });

  it('agrees identical claims and unknown contributes zero without vetoing', () => {
    const unknownProfile = parseMaintenanceProfileV1({
      formatVersion: 1, management: 'unknown', relevantProfile: 'unknown', evidenceRefs: [],
    });
    expect(calculateFit({
      properties: [
        property({ id: 'p1', maintenanceProfile: selfManaged }),
        property({ id: 'p2', maintenanceProfile: unknownProfile }),
        property({ id: 'p3', maintenanceProfile: selfManaged }),
      ],
      rule: RULE,
    }).fitPoints).toBe(8);
  });

  it('awards route density only for two verified same normalized locality properties', () => {
    expect(calculateFit({
      properties: [
        property({ id: 'p1', verifiedAt: EVALUATED_AT, locality: '  Provi\u0301dence ' }),
        property({ id: 'p2', verifiedAt: EVALUATED_AT, locality: 'PROVI\u0301DENCE' }),
      ],
      rule: RULE,
    }).fitPoints).toBe(4);
    expect(calculateFit({
      properties: [
        property({ id: 'p1', verifiedAt: EVALUATED_AT, locality: 'Providence' }),
        property({ id: 'p2', verifiedAt: null, locality: 'Providence' }),
      ],
      rule: RULE,
    }).fitPoints).toBe(0);
    expect(calculateFit({
      properties: [
        property({ id: 'p1', verifiedAt: EVALUATED_AT, locality: 'Providence' }),
        property({ id: 'p2', verifiedAt: EVALUATED_AT, locality: 'Warwick' }),
      ],
      rule: RULE,
    }).fitPoints).toBe(0);
  });

  it('awards relevant profile only for agreed true claims', () => {
    const relevant = parseMaintenanceProfileV1({
      formatVersion: 1, management: 'unknown', relevantProfile: true, evidenceRefs: [],
    });
    expect(calculateFit({
      properties: [property({ id: 'p1', maintenanceProfile: relevant })],
      rule: RULE,
    }).fitPoints).toBe(3);
    const irrelevant = parseMaintenanceProfileV1({
      formatVersion: 1, management: 'unknown', relevantProfile: false, evidenceRefs: [],
    });
    expect(calculateFit({
      properties: [property({ id: 'p1', maintenanceProfile: irrelevant })],
      rule: RULE,
    }).fitPoints).toBe(0);
  });

  it.each([
    [0, 'low'], [9, 'low'], [10, 'medium'], [19, 'medium'], [22, 'high'], [30, 'high'],
  ] as const)('maps %i points to the %s band', (points, band) => {
    const properties: PropertyFact[] = [];
    let remaining = points;
    if (remaining >= 15) { properties.push(property({ id: 'p-door', doorCount: 10 })); remaining -= 15; }
    else if (remaining >= 6) { properties.push(property({ id: 'p-door', doorCount: 2 })); remaining -= 6; }
    if (remaining >= 8) {
      properties.push(property({ id: 'p-mgmt', maintenanceProfile: selfManaged }));
      remaining -= 8;
    }
    if (remaining >= 4) {
      properties.push(
        property({ id: 'p-route-1', verifiedAt: EVALUATED_AT }),
        property({ id: 'p-route-2', verifiedAt: EVALUATED_AT }),
      );
      remaining -= 4;
    }
    if (remaining >= 3) {
      properties.push(property({
        id: 'p-rel',
        maintenanceProfile: parseMaintenanceProfileV1({
          formatVersion: 1, management: 'unknown', relevantProfile: true, evidenceRefs: [],
        }),
      }));
      remaining -= 3;
    }
    expect(remaining).toBe(0);
    const result = calculateFit({ properties, rule: RULE });
    expect(result.fitPoints).toBe(points);
    expect(result.fitBand).toBe(band);
  });

  it('rejects duplicate property IDs with different facts and negative door counts', () => {
    expect(() => calculateFit({
      properties: [
        property({ id: 'p1', doorCount: 5 }),
        property({ id: 'p1', doorCount: 6 }),
      ],
      rule: RULE,
    })).toThrow(PrioritizationInputCorruptionError);
    expect(() => calculateFit({
      properties: [property({ id: 'p1', doorCount: -1 })],
      rule: RULE,
    })).toThrow(PrioritizationInputCorruptionError);
  });

  it('is order- and exact-duplicate-insensitive', () => {
    const rows = [
      property({ id: 'p1', doorCount: 6, verifiedAt: EVALUATED_AT }),
      property({ id: 'p2', doorCount: 4, verifiedAt: EVALUATED_AT }),
      property({ id: 'p3', maintenanceProfile: selfManaged }),
    ];
    const forward = calculateFit({ properties: rows, rule: RULE });
    const shuffled = calculateFit({
      properties: [rows[2]!, rows[0]!, rows[1]!, rows[0]!],
      rule: RULE,
    });
    expect(JSON.stringify(shuffled)).toBe(JSON.stringify(forward));
  });
});

describe('deriveReachability', () => {
  it('requires a valid direct phone for Direct', () => {
    expect(deriveReachability([contact()])).toBe('direct');
    expect(deriveReachability([contact({ validationState: 'unverified' })])).toBe('none');
    expect(deriveReachability([contact({ validationState: 'invalid' })])).toBe('none');
  });

  it('treats a valid direct email as Indirect for this rule', () => {
    expect(deriveReachability([
      contact({ id: 'c1', kind: 'email', reachability: 'direct' }),
    ])).toBe('indirect');
  });

  it('maps valid indirect phone to Indirect and nothing valid to None', () => {
    expect(deriveReachability([
      contact({ id: 'c1', reachability: 'indirect' }),
    ])).toBe('indirect');
    expect(deriveReachability([])).toBe('none');
    expect(deriveReachability([
      contact({ id: 'c1', kind: 'phone', reachability: 'none' }),
    ])).toBe('none');
  });
});

describe('calculateConfidence', () => {
  const registrySource = {
    id: 'source-1', channel: 'registry', observedAt: '2026-08-30T12:00:00.000Z', evidenceRef: 'ref',
  };

  it('awards the exact independent components and caps at 10', () => {
    const result = calculateConfidence({
      snapshot: {
        originalSource: registrySource,
        properties: [property({
          id: 'p1',
          verifiedAt: '2026-08-01T00:00:00.000Z',
          maintenanceProfile: parseMaintenanceProfileV1({
            formatVersion: 1, management: 'self_managed', relevantProfile: true, evidenceRefs: ['ref'],
          }),
        })],
        contactMethods: [contact()],
      },
      evaluatedAt: EVALUATED_AT,
      rule: RULE,
    });
    // 4 (registry+ref) + 2 (fresh source) + 2 (fresh verification) + 1 (contact) + 1 (profile) = 10
    expect(result.dataConfidence).toBe(10);
    expect(result.reasons).toEqual([
      { kind: 'confidence', component: 'source_evidence', points: 4 },
      { kind: 'confidence', component: 'source_age', points: 2 },
      { kind: 'confidence', component: 'property_verification', points: 2 },
      { kind: 'confidence', component: 'contact_method', points: 1 },
      { kind: 'confidence', component: 'profile_evidence', points: 1 },
    ]);
  });

  it.each([
    ['registry with ref', 'registry', 'ref', 4],
    ['other with ref', 'frbo', 'ref', 3],
    ['supported without ref', 'frbo', null, 1],
    ['blank ref counts as absent', 'registry', '   ', 1],
  ])('source evidence: %s', (_label, channel, evidenceRef, expected) => {
    const result = calculateConfidence({
      snapshot: {
        originalSource: { id: 's', channel, observedAt: EVALUATED_AT, evidenceRef },
        properties: [],
        contactMethods: [],
      },
      evaluatedAt: EVALUATED_AT,
      rule: RULE,
    });
    expect(result.reasons.find((reason) => reason.component === 'source_evidence')?.points)
      .toBe(expected);
  });

  it('applies exact source-age and verification-age boundaries', () => {
    const at = (daysAgo: number): string => (
      new Date(Date.parse(EVALUATED_AT) - daysAgo * 86_400_000).toISOString()
    );
    const ageCase = (observedAt: string): number => calculateConfidence({
      snapshot: {
        originalSource: { id: 's', channel: 'registry', observedAt, evidenceRef: null },
        properties: [],
        contactMethods: [],
      },
      evaluatedAt: EVALUATED_AT,
      rule: RULE,
    }).reasons.find((reason) => reason.component === 'source_age')!.points;
    expect(ageCase(at(0))).toBe(2);
    expect(ageCase(at(30))).toBe(2);
    expect(ageCase(at(31))).toBe(1);
    expect(ageCase(at(180))).toBe(1);
    expect(ageCase(at(181))).toBe(0);

    const verificationCase = (verifiedAt: string | null): number => calculateConfidence({
      snapshot: {
        originalSource: { id: 's', channel: 'registry', observedAt: EVALUATED_AT, evidenceRef: null },
        properties: verifiedAt === null ? [property({ id: 'p1' })] : [property({ id: 'p1', verifiedAt })],
        contactMethods: [],
      },
      evaluatedAt: EVALUATED_AT,
      rule: RULE,
    }).reasons.find((reason) => reason.component === 'property_verification')!.points;
    expect(verificationCase(at(180))).toBe(2);
    expect(verificationCase(at(181))).toBe(1);
    expect(verificationCase(null)).toBe(0);
  });

  it('fails closed on future observed_at or verified_at', () => {
    const future = '2026-09-01T00:00:00.000Z';
    expect(() => calculateConfidence({
      snapshot: {
        originalSource: { id: 's', channel: 'registry', observedAt: future, evidenceRef: null },
        properties: [],
        contactMethods: [],
      },
      evaluatedAt: EVALUATED_AT,
      rule: RULE,
    })).toThrow(PrioritizationInputCorruptionError);
    expect(() => calculateConfidence({
      snapshot: {
        originalSource: registrySource,
        properties: [property({ id: 'p1', verifiedAt: future })],
        contactMethods: [],
      },
      evaluatedAt: EVALUATED_AT,
      rule: RULE,
    })).toThrow(PrioritizationInputCorruptionError);
  });

  it('rejects noncanonical timestamps', () => {
    expect(() => calculateConfidence({
      snapshot: {
        originalSource: { id: 's', channel: 'registry', observedAt: '2026-08-30T12:00:00Z', evidenceRef: null },
        properties: [],
        contactMethods: [],
      },
      evaluatedAt: EVALUATED_AT,
      rule: RULE,
    })).toThrow(PrioritizationInputCorruptionError);
  });
});

describe('deriveVerifyFirst', () => {
  it('is true only for P0/P1 with confidence 0-6', () => {
    expect(deriveVerifyFirst({ priority: 'p0', dataConfidence: 6, rule: RULE })).toBe(true);
    expect(deriveVerifyFirst({ priority: 'p1', dataConfidence: 0, rule: RULE })).toBe(true);
    expect(deriveVerifyFirst({ priority: 'p0', dataConfidence: 7, rule: RULE })).toBe(false);
    expect(deriveVerifyFirst({ priority: 'p2', dataConfidence: 0, rule: RULE })).toBe(false);
    expect(deriveVerifyFirst({ priority: 'p3', dataConfidence: 6, rule: RULE })).toBe(false);
  });
});

describe('metamorphic independence', () => {
  it('changing only a Fit fact cannot alter confidence source components', () => {
    const base = {
      originalSource: {
        id: 's', channel: 'registry' as const, observedAt: '2026-08-30T12:00:00.000Z', evidenceRef: 'ref',
      },
      contactMethods: [contact()],
    };
    const lowFit = calculateConfidence({
      snapshot: { ...base, properties: [property({ id: 'p1', doorCount: 1 })] },
      evaluatedAt: EVALUATED_AT,
      rule: RULE,
    });
    const highFit = calculateConfidence({
      snapshot: { ...base, properties: [property({ id: 'p1', doorCount: 20 })] },
      evaluatedAt: EVALUATED_AT,
      rule: RULE,
    });
    expect(lowFit.dataConfidence).toBe(highFit.dataConfidence);
  });

  it('contact changes affect reachability, never Fit', () => {
    const properties = [property({ id: 'p1', doorCount: 10 })];
    const fitBefore = calculateFit({ properties, rule: RULE });
    expect(deriveReachability([contact()])).toBe('direct');
    expect(deriveReachability([contact({ validationState: 'invalid' })])).toBe('none');
    const fitAfter = calculateFit({ properties, rule: RULE });
    expect(JSON.stringify(fitAfter)).toBe(JSON.stringify(fitBefore));
  });

  it('pure calls with identical inputs produce byte-identical output and mutate no inputs', () => {
    const properties = [property({ id: 'p1', doorCount: 10, verifiedAt: EVALUATED_AT })];
    const frozenCopy = JSON.stringify(properties);
    const first = calculateFit({ properties, rule: RULE });
    const second = calculateFit({ properties, rule: RULE });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.stringify(properties)).toBe(frozenCopy);
  });
});

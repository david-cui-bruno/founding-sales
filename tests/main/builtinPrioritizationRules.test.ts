import { describe, expect, it } from 'vitest';

import {
  BUILTIN_PRIORITIZATION_RULE_V1,
  canonicalRuleJson,
  computeRuleContentHash,
} from '../../src/main/domain/prioritization/builtinPrioritizationRules';

const DAY_SECONDS = 86_400;

describe('BUILTIN_PRIORITIZATION_RULE_V1', () => {
  it('asserts the full canonical V1 document, not selected fields', () => {
    const { contentHash, ...body } = BUILTIN_PRIORITIZATION_RULE_V1;
    expect(body).toEqual({
      formatVersion: 1,
      id: 'founder-priority-v1',
      version: 1,
      fit: {
        doorCount: {
          fullRange: [5, 30],
          fullPoints: 15,
          partialRanges: [[2, 4], [31, 50]],
          partialPoints: 6,
        },
        managementSelfManagedPoints: 8,
        routeDensityPoints: 4,
        relevantProfilePoints: 3,
        bands: { lowMax: 9, mediumMax: 19, max: 30 },
      },
      confidence: {
        registrySourcePoints: 4,
        otherSourceWithEvidencePoints: 3,
        sourceWithoutEvidencePoints: 1,
        sourceAgeFreshDays: 30,
        sourceAgeFreshPoints: 2,
        sourceAgeStaleDays: 180,
        sourceAgeStalePoints: 1,
        propertyVerificationFreshDays: 180,
        propertyVerificationFreshPoints: 2,
        propertyVerificationStalePoints: 1,
        contactMethodPoints: 1,
        profileEvidencePoints: 1,
        cap: 10,
        verifyFirstMaxConfidence: 6,
      },
      timing: {
        activationThresholdMilliPoints: 1_000,
        capMilliPoints: 40_000,
        bands: { coldMaxMilliPoints: 7_999, warmMaxMilliPoints: 19_999 },
        unverifiedMultiplier: 0.6,
        triggers: {
          live_vacancy: { base: 15, rule: { function: 'decay', halfLifeSeconds: 14 * DAY_SECONDS } },
          recent_acquisition: { base: 15, rule: { function: 'decay', halfLifeSeconds: 180 * DAY_SECONDS } },
          compliance_deadline: {
            base: 10,
            rule: {
              function: 'approaching',
              controlPoints: [[90, 0.25], [30, 1]],
              holdAfterDeadlineDays: 14,
            },
          },
          recent_permit_maintenance: { base: 5, rule: { function: 'decay', halfLifeSeconds: 30 * DAY_SECONDS } },
          heating_season: { base: 5, rule: { function: 'window' } },
          student_turnover: { base: 5, rule: { function: 'window' } },
          post_storm: { base: 5, rule: { function: 'decay', halfLifeSeconds: 10 * DAY_SECONDS } },
          tax_season: { base: 3, rule: { function: 'window' } },
          inbound_demo: { base: 30, rule: { function: 'decay', halfLifeSeconds: 2 * DAY_SECONDS } },
          direct_referral: { base: 25, rule: { function: 'decay', halfLifeSeconds: 7 * DAY_SECONDS } },
          rireig_connection: { base: 15, rule: { function: 'decay', halfLifeSeconds: 7 * DAY_SECONDS } },
          recent_lead_engagement: { base: 15, rule: { function: 'decay', halfLifeSeconds: 7 * DAY_SECONDS } },
          nurture_resurrection: { base: 10, rule: { function: 'window' } },
        },
        nurtureResurrectionWindowDays: 14,
        customBaseRange: [0, 40],
        customHalfLifeSecondsRange: [3_600, 730 * DAY_SECONDS],
        customStrengthRange: [0, 2],
      },
    });
    expect(contentHash).toBe(computeRuleContentHash({ ...body }));
    expect(contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes canonical JSON with recursively sorted keys, retained array order, and no hash field', () => {
    expect(canonicalRuleJson({ b: 1, a: [2, { z: 3, y: 4 }] }))
      .toBe('{"a":[2,{"y":4,"z":3}],"b":1}');
    const reordered = JSON.parse(JSON.stringify({
      version: BUILTIN_PRIORITIZATION_RULE_V1.version,
      id: BUILTIN_PRIORITIZATION_RULE_V1.id,
      formatVersion: BUILTIN_PRIORITIZATION_RULE_V1.formatVersion,
      timing: BUILTIN_PRIORITIZATION_RULE_V1.timing,
      confidence: BUILTIN_PRIORITIZATION_RULE_V1.confidence,
      fit: BUILTIN_PRIORITIZATION_RULE_V1.fit,
      contentHash: 'should-be-ignored',
    })) as Record<string, unknown>;
    expect(computeRuleContentHash(reordered))
      .toBe(BUILTIN_PRIORITIZATION_RULE_V1.contentHash);
  });

  it('is deeply frozen so catalog state cannot escape mutably', () => {
    expect(Object.isFrozen(BUILTIN_PRIORITIZATION_RULE_V1)).toBe(true);
    expect(Object.isFrozen(BUILTIN_PRIORITIZATION_RULE_V1.timing.triggers)).toBe(true);
    expect(Object.isFrozen(BUILTIN_PRIORITIZATION_RULE_V1.timing.triggers.live_vacancy)).toBe(true);
    expect(Object.isFrozen(BUILTIN_PRIORITIZATION_RULE_V1.fit.doorCount.partialRanges)).toBe(true);
    expect(() => {
      (BUILTIN_PRIORITIZATION_RULE_V1.timing as { capMilliPoints: number }).capMilliPoints = 1;
    }).toThrow(TypeError);
  });
});

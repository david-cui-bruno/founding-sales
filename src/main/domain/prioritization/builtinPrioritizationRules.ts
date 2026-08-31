import { createHash } from 'node:crypto';



export type TriggerRuleFunction =
  | Readonly<{ function: 'decay'; halfLifeSeconds: number }>
  | Readonly<{
      function: 'approaching';
      /** Sorted unique control points as [daysBeforeDeadline, fractionOfBase]. */
      controlPoints: readonly (readonly [number, number])[];
      /** Days after the deadline during which the value holds at 100%. */
      holdAfterDeadlineDays: number;
    }>
  | Readonly<{ function: 'window' }>;

export type TriggerRuleEntry = Readonly<{
  base: number;
  rule: TriggerRuleFunction;
}>;

export type PrioritizationRuleDocument = Readonly<{
  formatVersion: 1;
  id: string;
  version: number;
  fit: Readonly<{
    doorCount: Readonly<{
      fullRange: readonly [number, number];
      fullPoints: number;
      partialRanges: readonly (readonly [number, number])[];
      partialPoints: number;
    }>;
    managementSelfManagedPoints: number;
    routeDensityPoints: number;
    relevantProfilePoints: number;
    bands: Readonly<{ lowMax: number; mediumMax: number; max: number }>;
  }>;
  confidence: Readonly<{
    registrySourcePoints: number;
    otherSourceWithEvidencePoints: number;
    sourceWithoutEvidencePoints: number;
    sourceAgeFreshDays: number;
    sourceAgeFreshPoints: number;
    sourceAgeStaleDays: number;
    sourceAgeStalePoints: number;
    propertyVerificationFreshDays: number;
    propertyVerificationFreshPoints: number;
    propertyVerificationStalePoints: number;
    contactMethodPoints: number;
    profileEvidencePoints: number;
    cap: number;
    verifyFirstMaxConfidence: number;
  }>;
  timing: Readonly<{
    activationThresholdMilliPoints: number;
    capMilliPoints: number;
    bands: Readonly<{ coldMaxMilliPoints: number; warmMaxMilliPoints: number }>;
    unverifiedMultiplier: number;
    triggers: Readonly<Record<string, TriggerRuleEntry>>;
    nurtureResurrectionWindowDays: number;
    customBaseRange: readonly [number, number];
    customHalfLifeSecondsRange: readonly [number, number];
    customStrengthRange: readonly [number, number];
  }>;
}>;

const DAY_SECONDS = 86_400;

const documentBody = {
  formatVersion: 1 as const,
  id: 'founder-priority-v1',
  version: 1,
  fit: {
    doorCount: {
      fullRange: [5, 30] as [number, number],
      fullPoints: 15,
      partialRanges: [[2, 4], [31, 50]] as [number, number][],
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
      live_vacancy: { base: 15, rule: { function: 'decay' as const, halfLifeSeconds: 14 * DAY_SECONDS } },
      recent_acquisition: { base: 15, rule: { function: 'decay' as const, halfLifeSeconds: 180 * DAY_SECONDS } },
      compliance_deadline: {
        base: 10,
        rule: {
          function: 'approaching' as const,
          controlPoints: [[90, 0.25], [30, 1]] as (readonly [number, number])[],
          holdAfterDeadlineDays: 14,
        },
      },
      recent_permit_maintenance: { base: 5, rule: { function: 'decay' as const, halfLifeSeconds: 30 * DAY_SECONDS } },
      heating_season: { base: 5, rule: { function: 'window' as const } },
      student_turnover: { base: 5, rule: { function: 'window' as const } },
      post_storm: { base: 5, rule: { function: 'decay' as const, halfLifeSeconds: 10 * DAY_SECONDS } },
      tax_season: { base: 3, rule: { function: 'window' as const } },
      inbound_demo: { base: 30, rule: { function: 'decay' as const, halfLifeSeconds: 2 * DAY_SECONDS } },
      direct_referral: { base: 25, rule: { function: 'decay' as const, halfLifeSeconds: 7 * DAY_SECONDS } },
      rireig_connection: { base: 15, rule: { function: 'decay' as const, halfLifeSeconds: 7 * DAY_SECONDS } },
      recent_lead_engagement: { base: 15, rule: { function: 'decay' as const, halfLifeSeconds: 7 * DAY_SECONDS } },
      nurture_resurrection: { base: 10, rule: { function: 'window' as const } },
    },
    nurtureResurrectionWindowDays: 14,
    customBaseRange: [0, 40] as [number, number],
    customHalfLifeSecondsRange: [3_600, 730 * DAY_SECONDS] as [number, number],
    customStrengthRange: [0, 2] as [number, number],
  },
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    const result: Record<string, unknown> = {};
    for (const [key, entryValue] of entries) result[key] = canonicalize(entryValue);
    return result;
  }
  return value;
}

/** Canonical JSON: recursively sorted object keys, retained array order. */
export function canonicalRuleJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** SHA-256 over canonical JSON; never includes the hash field itself. */
export function computeRuleContentHash(body: Record<string, unknown>): string {
  const withoutHash: Record<string, unknown> = { ...body };
  delete withoutHash.contentHash;
  return createHash('sha256').update(canonicalRuleJson(withoutHash)).digest('hex');
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

export const BUILTIN_PRIORITIZATION_RULE_V1: PrioritizationRuleDocument & {
  readonly contentHash: string;
} = deepFreeze({
  ...documentBody,
  contentHash: computeRuleContentHash(documentBody),
});

export const CUSTOM_TRIGGER_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

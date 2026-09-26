import type { RouteEligibility, RouteSource, TechnicalValidation } from './types.ts';

/**
 * The versioned route-eligibility policy (specification 7.4).
 *
 * "Email and phone routes become `usable` only when a versioned provider/source
 * policy satisfies both technical-validation and association-confidence thresholds.
 * Weaker routes remain `candidate`."
 *
 * Two thresholds and a source table, versioned together. The version string is
 * written onto the route, so a route that was made usable under `route-policy.1` can
 * be found and re-decided when a later policy raises a threshold — which is the whole
 * reason the specification says "versioned" rather than "configured".
 *
 * The database enforces the shape of the promise (a usable route has passed
 * validation, a recorded confidence and a policy version) and this enforces its
 * content. Neither is sufficient alone: the CHECK cannot know a threshold, and this
 * cannot stop a row inserted by a migration.
 */

export const ROUTE_ELIGIBILITY_POLICY_VERSION = 'route-policy.1';

export interface RouteEligibilityPolicy {
  readonly version: string;
  /** Below this, an otherwise valid route stays a candidate. */
  readonly minimumAssociationConfidence: number;
  /**
   * Sources whose association a salesperson has personally vouched for. They still
   * need technical validation; what they skip is the confidence threshold, because a
   * salesperson typing a number off a firm's own website is not a probability.
   */
  readonly trustedSources: readonly RouteSource[];
}

export const ROUTE_ELIGIBILITY_POLICY: RouteEligibilityPolicy = Object.freeze({
  version: ROUTE_ELIGIBILITY_POLICY_VERSION,
  minimumAssociationConfidence: 0.8,
  trustedSources: Object.freeze(['salesperson', 'reply'] as const),
});

export interface RouteEligibilityInput {
  readonly source: RouteSource;
  readonly technicalValidation: TechnicalValidation;
  /** Null when the source did not supply one. A null confidence is never usable. */
  readonly associationConfidence: number | null;
}

export interface RouteEligibilityDecision {
  readonly eligibility: RouteEligibility;
  /** The version to store on the route, or null when the route is not usable. */
  readonly policyVersion: string | null;
}

/**
 * The eligibility a route takes under `policy`. Fails closed: anything the policy does
 * not positively make usable is a candidate, never a usable route with a shrug.
 */
export function decideRouteEligibility(
  input: RouteEligibilityInput,
  policy: RouteEligibilityPolicy = ROUTE_ELIGIBILITY_POLICY,
): RouteEligibilityDecision {
  // A route that failed technical validation is invalid, not weak: retrying it is a
  // new retrieval, not a higher confidence.
  if (input.technicalValidation === 'failed') return { eligibility: 'invalid', policyVersion: null };
  if (input.technicalValidation !== 'passed') return { eligibility: 'candidate', policyVersion: null };

  const confidence = input.associationConfidence;
  if (confidence === null || !Number.isFinite(confidence)) {
    return { eligibility: 'candidate', policyVersion: null };
  }
  const trusted = policy.trustedSources.includes(input.source);
  if (!trusted && confidence < policy.minimumAssociationConfidence) {
    return { eligibility: 'candidate', policyVersion: null };
  }
  return { eligibility: 'usable', policyVersion: policy.version };
}

/**
 * The policy version a phone number takes on entry (wave 2, S4.4).
 *
 * A call is a `tel:` handoff from the Mac: nothing Callie runs sees the line, so there is
 * no provider to validate a phone number and no confidence to wait for. A number the
 * founder typed, imported or took from a reply is usable the moment it is recorded, and
 * `phone_routes_usable_is_evidenced` (0004) is satisfied with the defaults this names:
 * validation `passed`, a confidence of 1 unless the source supplied one, and this
 * version. A number that failed validation is still `invalid`.
 */
export const PHONE_ON_ENTRY_POLICY_VERSION = 'phone-on-entry.1';

/** The evidence and eligibility a phone route is written with (wave 2, S4.4). */
export function decidePhoneOnEntry(input: {
  readonly technicalValidation: TechnicalValidation;
  readonly associationConfidence: number | null;
}): RouteEligibilityDecision & {
  readonly technicalValidation: TechnicalValidation;
  readonly associationConfidence: number | null;
} {
  if (input.technicalValidation === 'failed') {
    return {
      eligibility: 'invalid',
      policyVersion: null,
      technicalValidation: 'failed',
      associationConfidence: input.associationConfidence,
    };
  }
  const confidence = input.associationConfidence;
  return {
    eligibility: 'usable',
    policyVersion: PHONE_ON_ENTRY_POLICY_VERSION,
    technicalValidation: 'passed',
    associationConfidence: confidence === null || !Number.isFinite(confidence) ? 1 : confidence,
  };
}

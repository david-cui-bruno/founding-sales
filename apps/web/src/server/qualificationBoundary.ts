import { z } from 'zod';

export const QUALIFICATION_BROWSER_PATHS = new Set([
  '/sourcing/qualification/read', '/sourcing/qualification/request', '/sourcing/qualification/admit',
]);
const refusalSchema = z.strictObject({
  status: z.literal('refused'), replayed: z.boolean(), reason: z.string(),
});
// Only existing product-state refusals are presentation results. Authentication,
// role, command custody conflicts and unrecognized failures retain generic refusal.
const productReasons = new Set([
  'not_found', 'candidate_format_not_supported', 'candidate_changed', 'candidate_dismissed',
  'identity_review_required', 'research_disabled', 'research_held', 'daily_firm_ceiling',
  'evidence_unavailable', 'firm_identity_unsupported', 'firm_identity_unresolved',
  'residential_fit_unknown', 'target_geography_unsupported', 'business_phone_unresolved',
  'evidence_needs_refresh', 'source_incomplete_or_unverified', 'zone_unresolved',
  'calling_state_not_enabled', 'firm_identity_ambiguous', 'firm_merged',
  'phone_or_firm_stopped', 'phone_association_ambiguous', 'firm_already_enrolled',
  'calling_held', 'route_unavailable',
]);

/** Transport presentation only. Existing domain policy and receipts are unchanged. */
export function qualificationBrowserResult(path: string, status: number, body: unknown): { status: number; body: unknown } | null {
  if (path === '/sourcing/qualification/read' && status === 404
    && z.strictObject({ error: z.literal('not_found') }).safeParse(body).success) {
    // Absence is unavailable evidence, not an assertion that a candidate exists.
    return { status: 200, body: null };
  }
  if (!['/sourcing/qualification/request', '/sourcing/qualification/admit'].includes(path) || status !== 409) return null;
  const refusal = refusalSchema.safeParse(body);
  return refusal.success && productReasons.has(refusal.data.reason) ? { status: 200, body: refusal.data } : null;
}

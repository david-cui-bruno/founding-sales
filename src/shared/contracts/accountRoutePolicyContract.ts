import { z } from 'zod';
import { accountIdSchema as id, accountInstantSchema as instant } from './accountContract';
const timezone = z.string().min(1).max(100).refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } });
export const accountRoutePolicySchema = z.strictObject({
  contact: z.strictObject({ kind: z.enum(['phone','email']), normalizedValue: z.string().min(1).max(2048), validationState: z.enum(['unverified','valid','invalid']),
    evidence: z.strictObject({ federalStatus: z.enum(['unknown','verified_clear','listed']), tcpaFlag: z.boolean().nullable(), coveredAreaCode: z.string().regex(/^\d{3}$/).nullable(),
      source: z.enum(['ftc_download','enrichment_vendor','manual_import','legacy']), scrubbedAt: instant.nullable(), expiresAt: instant.nullable() }) }),
  jurisdiction: z.strictObject({ regionCode: z.string().min(1).max(100), timezone, reviewAt: instant.nullable() }).nullable(),
  clearance: z.strictObject({ decision: z.enum(['unknown','allowed','blocked']), registrationConfirmed: z.boolean().nullable(), stateDncSubscriptionConfirmed: z.boolean().nullable(),
    consentRuleConfirmed: z.boolean().nullable(), effectiveAt: instant, expiresAt: instant.nullable() }).nullable(),
});
export const routePolicyReceiptSchema = z.strictObject({ id, accountId: id, routeId: id, routeVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  canonicalTarget: z.string().min(1).max(2048), evidenceFingerprint: z.string().regex(/^[a-f0-9]{64}$/), revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  evidenceRef: id, evidenceIds: z.array(id).min(1).max(100), provenance: id, observedAt: instant, effectiveAt: instant, expiresAt: instant, policy: accountRoutePolicySchema });
export type RoutePolicyReceipt = z.infer<typeof routePolicyReceiptSchema>;

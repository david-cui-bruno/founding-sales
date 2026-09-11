import { z } from 'zod';
import { personIdSchema, salesCycleIdSchema, outboundAuthorizationReasonCodeSchema } from './commonContract.ts';

export const leadTriageSnapshotRequestSchema = z.object({
  limit: z.number().int().min(20).max(30),
}).strict();

export const triageRecommendationSchema = z.enum([
  'ready_candidate', 'needs_identity', 'needs_compliance',
  'needs_contact', 'watch', 'dismiss_candidate',
]);

export const triageEvidenceCodeSchema = z.enum([
  'organization_property_match',
  'organization_residence_match',
  'organization_business_match',
  'organization_relationship_unknown',
  'fit_low',
  'fit_medium',
  'fit_high',
  'fit_evidence_missing',
  'timing_trigger_active',
  'timing_trigger_stale',
  'timing_evidence_missing',
  'cloud_signal_present',
  'direct_contact_present',
  'no_usable_direct_contact',
  'contact_validation_unknown',
  'contact_validation_invalid',
  'contact_ownership_unverified',
  'compliance_clear',
  'compliance_blocked',
  'compliance_unknown',
  'identity_collision',
  'identity_relationship_unknown',
  'identity_address_missing',
  'enrichment_rate_limited',
]);
export type TriageEvidenceCode = z.infer<typeof triageEvidenceCodeSchema>;

export const triageTriggerCodeSchema = z.enum([
  'assessment_change',
  'permit_activity',
  'tax_activity',
  'rental_activity',
  'property_transfer',
  'other_sanitized',
]);

export const triageCloudSignalCodeSchema = z.enum([
  'assessment',
  'permit',
  'tax',
  'rent',
  'property',
  'portfolio',
  'business',
  'recency',
  'other_sanitized',
]);

export const leadTriageEvidenceSchema = z.object({
  rank: z.number().int().positive(),
  queueIndex: z.number().int().nonnegative(),
  personId: personIdSchema,
  salesCycleId: salesCycleIdSchema,
  personName: z.string().min(1),
  locality: z.string().nullable(),
  region: z.string().nullable(),
  postalCode: z.string().nullable(),
  organization: z.object({
    label: z.string().nullable(),
    relationship: z.enum([
      'property_owner', 'resident', 'business_principal',
      'mailing_contact', 'unknown',
    ]).nullable(),
    evidenceCodes: z.array(triageEvidenceCodeSchema),
  }).strict(),
  fit: z.object({
    points: z.number().int().nullable(),
    band: z.enum(['low','medium','high']).nullable(),
    evidenceCodes: z.array(triageEvidenceCodeSchema),
  }).strict(),
  timing: z.object({
    value: z.number().int().nullable(),
    band: z.enum(['cold','warm','hot']).nullable(),
    triggers: z.array(z.object({
      code: triageTriggerCodeSchema,
      observedAt: z.string().datetime({ offset: true }),
      expiresAt: z.string().datetime({ offset: true }).nullable(),
    }).strict()),
  }).strict(),
  cloud: z.object({
    fit: z.number().nullable(),
    timing: z.number().nullable(),
    contributions: z.array(z.object({
      signalCode: triageCloudSignalCodeSchema,
      contribution: z.number(),
    }).strict()),
  }).strict(),
  reachability: z.enum(['direct','indirect','none']).nullable(),
  dataConfidence: z.number().int().nullable(),
  contacts: z.object({
    phoneCount: z.number().int().nonnegative(),
    emailCount: z.number().int().nonnegative(),
    usableDirectCount: z.number().int().nonnegative(),
    maskedPrimaryPhone: z.string().nullable(),
    evidenceCodes: z.array(triageEvidenceCodeSchema),
  }).strict(),
  compliance: z.object({
    status: z.enum(['verified_clear','blocked','unknown','mixed']),
    refusalReasonCodes: z.array(outboundAuthorizationReasonCodeSchema),
  }).strict(),
  identityConcernCodes: z.array(triageEvidenceCodeSchema),
}).strict().superRefine(privacyRefinement);

export const leadTriageSnapshotSchema = z.object({
  generatedAt: z.string().datetime({ offset: true }),
  requestedLimit: z.number().int().min(20).max(30),
  scannedQueueRows: z.number().int().nonnegative(),
  leads: z.array(leadTriageEvidenceSchema).max(30),
  revisionBefore: z.number().int().nonnegative(),
  revisionAfter: z.number().int().nonnegative(),
  privacyScanPassed: z.literal(true),
}).strict().refine((value) => value.revisionBefore === value.revisionAfter, {
  message: 'Read-only triage collection changed application revision.',
}).superRefine((value, context) => {
  privacyRefinement(value, context);
  const people = new Set<string>();
  const cycles = new Set<string>();
  let previousIndex = -1;
  let coherent = value.leads.length <= value.requestedLimit
    && value.scannedQueueRows >= value.leads.length
    && (value.leads.length !== 0 || value.scannedQueueRows === 0);
  value.leads.forEach((lead, index) => {
    coherent &&= !people.has(lead.personId) && !cycles.has(lead.salesCycleId)
      && lead.rank === index + 1 && lead.queueIndex > previousIndex
      && lead.queueIndex < value.scannedQueueRows
      && (index !== 0 || lead.queueIndex === 0);
    people.add(lead.personId);
    cycles.add(lead.salesCycleId);
    previousIndex = lead.queueIndex;
  });
  if (value.leads.length === value.requestedLimit) {
    coherent &&= previousIndex === value.scannedQueueRows - 1;
  }
  if (!coherent) context.addIssue({ code: 'custom', message: 'Incoherent triage identities, ranks or scan counts.' });
});

export const leadTriageAssessmentSchema = z.object({
  personId: personIdSchema,
  salesCycleId: salesCycleIdSchema,
  recommendation: triageRecommendationSchema,
  likelyPriority: z.enum(['P0','P1']).nullable(),
  evidenceCodes: z.array(triageEvidenceCodeSchema).min(1),
  suggestedReviewOrder: z.number().int().positive(),
}).strict().superRefine(privacyRefinement);

export type LeadTriageSnapshotRequest = z.infer<typeof leadTriageSnapshotRequestSchema>;
export type LeadTriageEvidence = z.infer<typeof leadTriageEvidenceSchema>;
export type LeadTriageSnapshot = z.infer<typeof leadTriageSnapshotSchema>;
export type LeadTriageAssessment = z.infer<typeof leadTriageAssessmentSchema>;

/** Bind a strict response to the actual request, not a provider-chosen limit. */
export function parseLeadTriageSnapshotResponse(
  request: LeadTriageSnapshotRequest,
  value: unknown,
): LeadTriageSnapshot {
  const input = leadTriageSnapshotRequestSchema.parse(request);
  const snapshot = leadTriageSnapshotSchema.parse(value);
  if (snapshot.requestedLimit !== input.limit) throw new Error('Triage response does not match the request.');
  return snapshot;
}

const forbiddenKeys = new Set([
  'phone', 'email', 'streetaddress', 'providerpayload', 'rawpayload', 'messagebody', 'messagesubject',
]);
const maskedPhone = /^••• ••• [0-9]{4}$/;
const email = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/i;
const nanpPhone = /(?<!\d)(?:\+?1[\s().-]*)?\(?[2-9]\d{2}\)?[\s.-]*[2-9]\d{2}[\s.-]*\d{4}(?!\d)/;
const internationalPhone = /\+[1-9](?:[\s().-]*\d){6,14}(?!\d)/;
const streetAddress = /\b\d{1,6}\s+(?:[\p{L}\d.'-]+\s+){1,6}(?:st(?:reet)?|ave(?:nue)?|rd|road|blvd|boulevard|ln|lane|dr(?:ive)?|ct|court|way|pl(?:ace)?|ter(?:race)?|pkwy|parkway|cir(?:cle)?)\b/iu;

/** Conservative screening, not proof against arbitrary sensitive text or obfuscation.
 * Walk every key/value, including allowed labels and array entries. Fail closed
 * on unsupported/cyclic structures. Errors deliberately contain no input text.
 */
export function assertTriageArtifactSafe(value: unknown): void {
  const ancestors = new Set<object>();
  const fail = () => { throw new Error('Unsafe triage artifact.'); };
  const scanText = (text: string) => {
    if (email.test(text) || nanpPhone.test(text) || internationalPhone.test(text) || streetAddress.test(text)) fail();
  };
  const walk = (entry: unknown): void => {
    if (typeof entry === 'string') { scanText(entry); return; }
    if (entry === null || typeof entry === 'boolean') return;
    if (typeof entry === 'number') { if (!Number.isFinite(entry)) fail(); return; }
    if (typeof entry !== 'object' || entry === null || ancestors.has(entry)) return fail();
    if (!Array.isArray(entry) && Object.getPrototypeOf(entry) !== Object.prototype
      && Object.getPrototypeOf(entry) !== null) return fail();
    ancestors.add(entry);
    for (const [key, child] of Object.entries(entry)) {
      scanText(key);
      if (forbiddenKeys.has(key.replace(/[_-]/g, '').toLowerCase())) fail();
      if (key === 'maskedPrimaryPhone' && child !== null
        && (typeof child !== 'string' || !maskedPhone.test(child))) fail();
      walk(child);
    }
    ancestors.delete(entry);
  };
  walk(value);
}

function privacyRefinement(value: unknown, context: z.RefinementCtx): void {
  try { assertTriageArtifactSafe(value); }
  catch { context.addIssue({ code: 'custom', message: 'Unsafe triage artifact.' }); }
}

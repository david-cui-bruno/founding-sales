import { z } from 'zod';

const identifier = z.string().trim().min(1).max(200);
/** Historical settings compatibility only. No runtime booking policy or writer remains. */
export const bookingPolicyBindingsSchema = z.strictObject({
  ownerUserId: z.uuid(),
  account: z.strictObject({ provider: z.literal('calcom'), accountId: identifier, email: z.email(), generation: z.number().int().positive() }),
  event: z.strictObject({ eventTypeId: z.number().int().positive(), bookingUrl: z.url().refine(v => { const u = new URL(v); return u.protocol === 'https:' && u.hostname === 'cal.com' && !u.username && !u.password && !u.search && !u.hash; }), configurationRevision: identifier }),
  calendars: z.array(z.strictObject({ credentialId: z.number().int().positive(), externalId: identifier })).min(1).max(20).refine(v => new Set(v.map(c => `${c.credentialId}:${c.externalId}`)).size === v.length),
  source: z.strictObject({ scopeRevision: identifier, dataScope: z.literal('necessary_booking_context_attendee_selected_freebusy'), dataHandlingVersion: identifier }),
  sender: z.strictObject({ channel: z.enum(['email','linkedin']), accountId: identifier, authorityRevision: identifier }),
  model: z.strictObject({ providerKey: z.enum(['aws_bedrock','google_vertex']), route: identifier, modelVersion: identifier, accountBinding: identifier, consentRevision: identifier, purpose: z.literal('booking_interpretation'), qualityReviewRevision: identifier.nullable(), selection: z.enum(['initial_haiku','reviewed_candidate']) }).superRefine((v,ctx) => {
    if (v.selection === 'initial_haiku' && (v.providerKey !== 'aws_bedrock' || v.route !== 'us.anthropic.claude-haiku-4-5-20251001-v1:0' || v.modelVersion !== 'anthropic.claude-haiku-4-5-20251001-v1:0')) ctx.addIssue({code:'custom',message:'The initial route is the exact existing Bedrock Haiku4.5 route.'});
    if (v.selection === 'reviewed_candidate') {
      const knownSonnet = v.providerKey === 'aws_bedrock' && ['us.anthropic.claude-sonnet-4-6','us.anthropic.claude-sonnet-5-5'].includes(v.modelVersion) && v.route === v.modelVersion;
      const knownGemini = v.providerKey === 'google_vertex' && v.modelVersion === 'gemini-3.8-flash' && /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u.test(v.accountBinding) && v.route === `vertex.us/${v.accountBinding}`;
      if (v.qualityReviewRevision === null || (!knownSonnet && !knownGemini)) ctx.addIssue({code:'custom',message:'A configured exact Sonnet/Gemini route and quality revision are required. Actual consent and acceptance are checked separately.'});
    }
  }),
  budget: z.strictObject({ lane: z.literal('booking'), timeZone: z.literal('America/New_York'), dailyCeilingCents: z.number().int().min(0).max(200), monthlyCeilingCents: z.number().int().min(0).max(2500) }),
});
export type BookingPolicyBindings = z.infer<typeof bookingPolicyBindingsSchema>;
export const bookingPolicySettingSchema = z.strictObject({ status: z.enum(['saved','disabled','revoked']), enabled: z.literal(false), bindings: bookingPolicyBindingsSchema.nullable() });
export const DEFAULT_BOOKING_POLICY = {status:'disabled',enabled:false,bindings:null} as const;
export type BookingPolicySetting = z.infer<typeof bookingPolicySettingSchema>;

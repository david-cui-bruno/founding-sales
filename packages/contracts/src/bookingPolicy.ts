import { z } from 'zod';
import { commandIdSchema } from './auth.ts';
import { semanticVersionSchema } from './clientVersion.ts';

const identifier = z.string().trim().min(1).max(200);
/** Exact configured bindings, not evidence that the provider is usable. No tokens or message bodies. */
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
export const bookingPolicyCommandSchema = z.discriminatedUnion('action',[
  z.strictObject({commandId:commandIdSchema,clientVersion:semanticVersionSchema,action:z.literal('save'),expectedRevision:z.number().int().nonnegative(),bindings:bookingPolicyBindingsSchema}),
  z.strictObject({commandId:commandIdSchema,clientVersion:semanticVersionSchema,action:z.enum(['disable','revoke']),expectedRevision:z.number().int().nonnegative()}),
]);
export type BookingPolicyCommand = z.infer<typeof bookingPolicyCommandSchema>;
export const BOOKING_BUSINESS_RULES = Object.freeze({
  durationMinutes:20,afterBufferMinutes:10,weekdays:[1,2,3,4,5],startHour:9,endHour:18,timeZone:'America/New_York',minimumNoticeMinutes:120,horizonDays:14,callCountCap:null,
  directCreate:'explicit_supported_slot_agreement',attendeeChanges:'verified_attendee_explicit_request',mixedReply:'unconditional_logistics_only_separate_david_handoff',conditionalAgreement:'pause_david_handoff',substantiveReplies:false,
  confirmations:1,emailReminders:1,reminderMinutesBefore:60,reminderOwner:'verified_provider_only',sms:false,duplicateReminders:false,
  nudgeDays:[3,7],maximumNudges:2,manualNudgesIncluded:true,anyReplyStopsNudges:true,rebooking:'david_confirmed_no_show_one_next_business_day',
  calendarData:'selected_authorized_freebusy_only',prospectPrivateCalendar:false,privateEventDescriptions:false,uncertainActions:'inspect_never_replay',
} as const);
export interface BookingPolicyView {
  revision:number; setting:BookingPolicySetting; rules:typeof BOOKING_BUSINESS_RULES;
  businessPolicyValid:boolean; enabled:false;
  readiness:{ready:boolean;reasons:string[];evidenceKind:'unavailable'|'controlled'|'actual'};
  budget:{lane:'booking';timeZone:'America/New_York';businessDate:string;calendarMonth:string;dailyCeilingCents:number;monthlyCeilingCents:number;observedDailyCents:number;observedMonthlyCents:number;allowance:'unknown'|'blocked'|'available';remainingDailyCents:number|null;remainingMonthlyCents:number|null};
}
export const bookingPolicyViewSchema = z.strictObject({
  revision:z.number().int().nonnegative(),setting:bookingPolicySettingSchema,
  rules:z.custom<typeof BOOKING_BUSINESS_RULES>(value=>JSON.stringify(value)===JSON.stringify(BOOKING_BUSINESS_RULES)),
  businessPolicyValid:z.boolean(),enabled:z.literal(false),
  readiness:z.strictObject({ready:z.boolean(),reasons:z.array(identifier).max(30),evidenceKind:z.enum(['unavailable','controlled','actual'])}),
  budget:z.strictObject({lane:z.literal('booking'),timeZone:z.literal('America/New_York'),businessDate:z.iso.date(),calendarMonth:z.string().regex(/^\d{4}-\d{2}$/u),dailyCeilingCents:z.number().int().min(0).max(200),monthlyCeilingCents:z.number().int().min(0).max(2500),observedDailyCents:z.number().int().nonnegative(),observedMonthlyCents:z.number().int().nonnegative(),allowance:z.enum(['unknown','blocked','available']),remainingDailyCents:z.number().int().nonnegative().nullable(),remainingMonthlyCents:z.number().int().nonnegative().nullable()}),
});
export const bookingPolicySettingsViewSchema=z.strictObject({policy:bookingPolicyViewSchema,configuration:z.strictObject({choices:z.array(z.strictObject({id:z.string().regex(/^[a-f0-9]{64}$/u),label:z.string().min(1).max(500),bindings:bookingPolicyBindingsSchema})).max(20),reasons:z.array(identifier).max(10)})});
export type BookingPolicySettingsView=z.infer<typeof bookingPolicySettingsViewSchema>;
export const bookingPolicyChangeSchema=z.discriminatedUnion('action',[bookingPolicyCommandSchema.options[0].omit({clientVersion:true}),bookingPolicyCommandSchema.options[1].omit({clientVersion:true})]);
export type BookingPolicyChange=z.infer<typeof bookingPolicyChangeSchema>;
export const bookingPolicyChangedSchema=z.strictObject({revision:z.number().int().positive()});

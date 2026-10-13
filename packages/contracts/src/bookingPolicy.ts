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
    if (v.selection === 'reviewed_candidate' && (v.qualityReviewRevision === null || !/sonnet|gemini/i.test(v.modelVersion))) ctx.addIssue({code:'custom',message:'An exact consented Sonnet/Gemini candidate requires quality review.'});
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

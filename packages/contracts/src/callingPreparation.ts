/** Closed company-preparation interface for ADR0028/#820. Current retained
 * evidence grants neither acquisition nor contact authority. */
import {z} from 'zod';
import {commandIdSchema} from './auth.ts';
import {semanticVersionSchema} from './clientVersion.ts';
import {uuid} from './foundationRows.ts';
import {manualPhoneChoiceSchema,manualPhoneSchema} from './manualProspects.ts';

export const CALLING_PREPARATION_PATHS={
 read:'/calling/preparation/read',
 confirm:'/calling/preparation/confirm',
 receipt:'/calling/preparation/receipt',
} as const;
// All three paths are POST. read/receipt are read-only, exact closed adapters.
export const CALLING_PREPARATION_COMMAND_KIND='calling.preparation_confirm';

const positive=z.number().int().positive();
const nullableText=(max:number)=>z.string().trim().min(1).max(max).nullable();
const website=z.url().max(500).refine(value=>/^https?:\/\//u.test(value));
const timeZone=z.string().min(1).max(100).regex(/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){1,2}$/u);
// Domain additionally requires an actual known IANA zone through the existing rule.
export const callingPreparationZoneSchema=z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('unknown')}),
 z.strictObject({kind:z.literal('reviewed'),timeZone}),
]);
/** Explicitly reviewed UNVERIFIED observations. Null means unknown, not a default.
 * Explicit same-choice review keeps these fields preparation-owned; ordinary
 * CRM profile/route changes are refused.
 * No Person, notes, contact claim, route evidence/eligibility, source URL or budget.
 */
export const callingPreparationProfileSchema=z.strictObject({
 companyName:z.string().trim().min(1).max(300),
 website:website.nullable(),
 addressLine:nullableText(300),locality:nullableText(120),
 regionCode:z.string().regex(/^[A-Z]{2}$/u).nullable(),
 postalCode:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 -]{1,11}$/u).nullable(),
 countryCode:z.literal('US').nullable(),
 timeZone:callingPreparationZoneSchema,
});
/** Never accepts an endpoint, new source, extended expiry or qualification bit. */
export const callingPreparationSelectionSchema=z.strictObject({
 candidateId:uuid,expectedCandidateRevision:positive,choice:manualPhoneChoiceSchema,
});
export const callingPreparationReadInputSchema=callingPreparationSelectionSchema;
const binding=z.strictObject({preparationId:uuid,revision:positive,firmId:uuid,routeId:uuid,routeVersion:positive});
const duplicateStatus=z.strictObject({
 possibleDuplicateFirmIds:z.array(uuid).max(20),possibleDuplicateCount:z.number().int().nonnegative(),
 nextAction:z.enum(['review_preparation','select_recorded_company']),
});
const unknowns=z.array(z.enum([
 'company_identity_unverified','residential_fit_unverified','office_address_unknown',
 'phone_type_unverified','time_zone_unknown','decision_maker_unknown',
])).max(6);
export const CALLING_PREPARATION_REFUSALS=[
 'admin_only','candidate_unavailable','candidate_changed','choice_not_kept','choice_changed',
 'source_withdrawn','creator_inactive','authority_changed','preparation_version_conflict',
 'preparation_terminal','profile_invalid','duplicate_recorded_company','office_country_unresolved',
 'firm_changed','route_changed',
] as const;
const refusal=z.enum(CALLING_PREPARATION_REFUSALS);

/** Every returned number/URL/profile is freshly authorized. Terminal/refused DTOs
 * omit phone/source/profile handles entirely. Source deadline is server-derived.
 * available is preparation availability, never permission to call or acquire.
 */
export const callingPreparationReadSchema=z.discriminatedUnion('state',[
 z.strictObject({
  state:z.literal('available'),selection:callingPreparationSelectionSchema,
  phone:manualPhoneSchema,profile:callingPreparationProfileSchema,binding:binding.nullable(),
  duplicates:duplicateStatus,unknowns,
  qualification:z.literal('unverified'),contactAuthority:z.literal('not_granted'),
  fieldOwnership:z.literal('source_bound'),
  researchPolicy:z.enum(['required_before_enqueue','paused_before_enqueue']),
 }),
 z.strictObject({
  state:z.literal('withdrawn'),preparationId:uuid,revision:positive,
  reason:z.literal('source_withdrawn'),
 }),
 z.strictObject({state:z.literal('refused'),reason:refusal}),
]).superRefine((value,ctx)=>{
 if(value.state==='available'&&((value.binding===null)!==(value.researchPolicy==='required_before_enqueue')))
  ctx.addIssue({code:'custom',message:'An unconfirmed preview cannot claim that its research pause exists.'});
});

const expected=z.discriminatedUnion('state',[
 z.strictObject({state:z.literal('absent')}),
 z.strictObject({state:z.literal('live'),preparationId:uuid,revision:positive,routeVersion:positive}),
]);
/** expected=absent creates; expected=live explicitly replaces reviewed profile
 * against the SAME still-live exact choice. Terminal/source rebind is refused.
 * No existingFirmId input: reuse happens only through Recorded companies.
 */
export const callingPreparationInputSchema=z.strictObject({
 selection:callingPreparationSelectionSchema,expected,
 reviewedProfile:callingPreparationProfileSchema.extend({countryCode:z.literal('US')}),
 acknowledgeUnqualifiedSourceOwnership:z.literal(true),
});
export const callingPreparationCommandSchema=callingPreparationInputSchema.extend({
 commandId:commandIdSchema,clientVersion:semanticVersionSchema,
});
/** Historical receipt only. These IDs cannot issue a ticket, session or handoff. */
export const callingPreparationSavedSchema=z.strictObject({
 preparationId:uuid,revision:positive,firmId:uuid,routeId:uuid,
 historicalState:z.literal('prepared'),
});
export const callingPreparationAnswerSchema=z.discriminatedUnion('status',[
 z.strictObject({status:z.literal('accepted'),replayed:z.boolean(),result:callingPreparationSavedSchema}),
 z.strictObject({status:z.literal('refused'),replayed:z.boolean(),reason:refusal}),
]);
export const callingPreparationReceiptInputSchema=z.strictObject({
 commandId:commandIdSchema,payloadSHA256:z.string().regex(/^[a-f0-9]{64}$/u),
});
export const callingPreparationReceiptSchema=z.discriminatedUnion('state',[
 z.strictObject({state:z.literal('unknown')}),
 z.strictObject({state:z.literal('refused'),reason:refusal}),
 z.strictObject({state:z.literal('accepted'),result:callingPreparationSavedSchema}),
]);

export type CallingPreparationSelection=z.infer<typeof callingPreparationSelectionSchema>;
export type CallingPreparationProfile=z.infer<typeof callingPreparationProfileSchema>;
export type CallingPreparationRead=z.infer<typeof callingPreparationReadSchema>;
export type CallingPreparationInput=z.infer<typeof callingPreparationInputSchema>;
export type CallingPreparationSaved=z.infer<typeof callingPreparationSavedSchema>;
export type CallingPreparationReceipt=z.infer<typeof callingPreparationReceiptSchema>;

// Browser custody: persist original UUID + normalized semantic input hash before
// dispatch. A lost response preserves UNKNOWN; receipt lookup never remints or
// executes. Historical acceptance requires an explicit fresh read before Current.
// Actor/device/session/workspace are always authenticated server state. Domain
// derives number, source URL set, creator/run and min(original source expiries).
// Preview profile may be changed only as explicit source-bound reviewed input;
// neither equality nor a changed value makes any field independently owned.
// Unknown country may preview; confirmation requires explicitly reviewed US.
// Erased stored profile country uses reserved unavailable ZZ, never a US fallback.

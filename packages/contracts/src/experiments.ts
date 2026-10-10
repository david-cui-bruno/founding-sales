import {z} from 'zod';
import {uuid} from './foundationRows.ts';
import {commandIdSchema} from './auth.ts';
import {semanticVersionSchema} from './clientVersion.ts';
import {learningInputSchema} from './sourcingLearning.ts';
const text=z.string().trim().min(1).max(2000);
export const experimentContentSchema=z.strictObject({
 change:z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('discovery_query'),basePolicyVersion:z.string().min(1).max(80),queryId:z.string().min(1).max(100),query:z.string().trim().min(5).max(400)}),
 z.strictObject({kind:z.literal('email_wording'),baseTemplateVersionId:uuid,subject:z.string().min(1).max(998),body:z.string().min(1).max(10000)})]),
 interval:learningInputSchema, rationale:text,counterexamples:z.array(text).max(10),uncertainty:text,successMeasures:z.array(text).min(1).max(10)
});
export type ExperimentContent=z.infer<typeof experimentContentSchema>;
export const experimentSaveSchema=z.strictObject({id:uuid.optional(),expectedRevision:z.number().int().nonnegative(),status:z.enum(['accepted','dismissed']),content:experimentContentSchema});
export const experimentSaveCommandSchema=experimentSaveSchema.extend({commandId:commandIdSchema,clientVersion:semanticVersionSchema});
export const experimentActivateSchema=z.strictObject({id:uuid,expectedRevision:z.number().int().positive(),targetingDecision:z.boolean(),sequenceVersionId:uuid.optional()});
export const experimentActivateCommandSchema=experimentActivateSchema.extend({commandId:commandIdSchema,clientVersion:semanticVersionSchema});
export const experimentStopSchema=z.strictObject({activationId:uuid,reason:text});
export const experimentStopCommandSchema=experimentStopSchema.extend({commandId:commandIdSchema,clientVersion:semanticVersionSchema});

export const experimentEraseSchema=z.strictObject({id:uuid,expectedRevision:z.number().int().positive()});
export const experimentEraseCommandSchema=experimentEraseSchema.extend({commandId:commandIdSchema,clientVersion:semanticVersionSchema});
const n=z.number().int().nonnegative();
const cohort=z.strictObject({hypothesis:z.string(),policyVersion:z.string(),acquisition:z.string(),firms:n,contacted:n,reached:n,confirmedPain:n,booked:n,held:n,qualified:n,won:n,unreached:n,unknownQualification:n,email:z.strictObject({sent:n,genuineReplies:n,positiveReplies:n,bounces:n,deferrals:n}).optional(),interactions:z.strictObject({answeredCalls:n,confirmedPainCalls:n}),researchGrossCents:n,researchCashCents:n});
export const experimentAggregateReportSchema=z.strictObject({from:z.iso.datetime(),to:z.iso.datetime(),asOf:z.iso.datetime(),cohorts:z.array(cohort),maturity:z.array(z.strictObject({ageBand:z.string(),firms:n})),coverage:z.strictObject({candidates:n,qualified:n,admitted:n,unavailable:n}),search:z.strictObject({attempts:n,creditsReserved:n}),discovery:z.strictObject({retainedHits:n,supportedProspects:n,admissions:n,manualStaged:n,unavailable:n}).nullable(),cutoffSemantics:z.literal('current_accepted_facts_through_cutoff'),rawProviderResults:z.null(),duplicates:z.null()});
const activationResult=z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('discovery_query'),basePolicyVersion:z.string(),policyVersion:z.string(),queryId:z.string()}),
 z.strictObject({kind:z.literal('email_wording'),baseSequenceVersionId:uuid,sequenceVersionId:uuid,controlRevision:z.string().regex(/^\d+$/u)})
]);
const outcomes=z.discriminatedUnion('semantics',[
 z.strictObject({semantics:z.literal('exact_policy_query_attempts_only'),attempts:n,retainedUniqueUrls:n,rawProviderResults:z.null(),duplicates:z.null(),supportedProspects:z.null(),conversionDenominator:z.null()}),
 z.strictObject({semantics:z.literal('exact_sequence_new_enrollments_only'),attempts:n,sent:n,retainedUniqueUrls:z.null(),rawProviderResults:z.null(),duplicates:z.null(),supportedProspects:z.null(),conversionDenominator:z.null()})
]);
export const experimentViewSchema=z.strictObject({id:uuid,revision:n,status:z.enum(['accepted','dismissed','erased']),coverage:z.strictObject({proposalsTruncated:z.boolean(),versionsTruncated:z.boolean(),activationsTruncated:z.boolean()}),versions:z.array(z.strictObject({revision:n,content:experimentContentSchema,report:experimentAggregateReportSchema,createdAt:z.iso.datetime()})).max(20),report:experimentAggregateReportSchema.nullable(),activations:z.array(z.strictObject({activationId:uuid,revision:n,result:activationResult,startedAt:z.iso.datetime(),stoppedAt:z.iso.datetime().nullable(),stopReason:z.string().nullable(),outcomes})).max(20)});
export type ExperimentView=z.infer<typeof experimentViewSchema>;
export const experimentsReadSchema=z.strictObject({});
export const experimentsViewSchema=z.array(experimentViewSchema).max(30);
export const experimentSaveResultSchema=z.strictObject({id:uuid,revision:n});
export const experimentActivateResultSchema=z.strictObject({activationId:uuid});
export const experimentStopResultSchema=z.strictObject({stopped:z.boolean()});
export const experimentEraseResultSchema=z.strictObject({erased:z.boolean()});

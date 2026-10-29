import {z} from 'zod';
import {commandIdSchema} from './auth.ts';
import {semanticVersionSchema} from './clientVersion.ts';
import {instant,uuid} from './foundationRows.ts';
import {manualProspectSchema} from './manualProspects.ts';
const revision=z.number().int().nonnegative(),positive=z.number().int().positive();
const hash=z.string().regex(/^[a-f0-9]{64}$/u);
const envelope={commandId:commandIdSchema,clientVersion:semanticVersionSchema};
export const prospectPriorityRoleSchema=z.strictObject({personId:uuid,relationshipId:uuid,relationshipRevision:positive,
 role:z.enum(['workflow_owner','budget_approver','advocate','implementation']),basis:z.enum(['hypothesis','source_supported','directly_confirmed']).default('hypothesis')});
const dimensions={fit:z.enum(['positive','unknown','negative']),value:z.enum(['positive','unknown']),timing:z.enum(['positive','unknown'])};
export const prospectPriorityReviewSchema=z.strictObject({policyVersion:z.literal('prospect-priority-v1'),
 band:z.enum(['evidence_supported','ordinary','wrong_fit']),...dimensions,
 roleCandidates:z.array(z.strictObject({personId:uuid,personName:z.string().min(1).max(240),relationshipId:uuid,relationshipRevision:positive})).max(20),roleCandidatesHasMore:z.boolean(),
 roles:z.array(prospectPriorityRoleSchema).max(8),roleState:z.enum(['supported','hypothesis','unknown']),
 nextAction:z.enum(['review_fit','research_person','research_route','review_contact_readiness','review_wrong_fit']),
 assessmentRevision:revision,lastConsideredAt:instant.nullable(),consideredCount:z.number().int().nonnegative(),
 reasons:z.array(z.strictObject({code:z.enum(['human_fit','human_value','human_timing','human_wrong_fit']),sourceUrl:z.string().url().max(2000),decidedAt:instant})).max(3),
});
export type ProspectPriorityReview=z.infer<typeof prospectPriorityReviewSchema>;
export const prospectPriorityListInputSchema=z.strictObject({state:z.enum(['all','new','kept','skipped','wrong_number']),
 offset:z.number().int().min(0).max(1000000),viewRevision:hash.optional(),includeManualPhone:z.boolean().optional()}).refine(v=>v.offset===0||v.viewRevision!==undefined,'Continuation requires the current view revision');
export const prospectPriorityListSchema=z.strictObject({prospects:z.array(z.strictObject({prospect:manualProspectSchema,priority:prospectPriorityReviewSchema})).max(50),hasMore:z.boolean(),viewRevision:hash});
export const prospectPrioritySaveInputSchema=z.strictObject({candidateId:uuid,expectedCandidateRevision:positive,
 expectedAssessmentRevision:revision,...dimensions,sourceUrl:z.string().url().max(2000),roles:z.array(prospectPriorityRoleSchema).max(8).default([])});
export const prospectPrioritySaveCommandSchema=prospectPrioritySaveInputSchema.safeExtend(envelope);
export const prospectPriorityConsiderInputSchema=z.strictObject({candidateId:uuid,expectedCandidateRevision:positive,
 expectedAssessmentRevision:revision,disposition:z.enum(['considered','selected'])});
export const prospectPriorityConsiderCommandSchema=prospectPriorityConsiderInputSchema.extend(envelope);
export const prospectPrioritySavedSchema=z.strictObject({candidateId:uuid,candidateRevision:positive,assessmentRevision:revision});
export const prospectPriorityConsideredSchema=prospectPrioritySavedSchema.extend({considerationId:uuid});
export const prospectPriorityReceiptInputSchema=z.strictObject({commandId:commandIdSchema,payloadSHA256:hash,operation:z.enum(['save','consider'])});
export const prospectPriorityReceiptSchema=z.discriminatedUnion('state',[
 z.strictObject({state:z.literal('unknown')}),z.strictObject({state:z.literal('refused'),reason:z.string()}),
 z.strictObject({state:z.literal('accepted'),result:z.union([prospectPrioritySavedSchema,prospectPriorityConsideredSchema])}),
]);
export const prospectPriorityLearningInputSchema=z.strictObject({from:instant,to:instant}).refine(v=>Date.parse(v.from)<Date.parse(v.to),'Use an increasing observation window');
export const prospectPriorityLearningSchema=z.strictObject({from:instant,to:instant,reportedAttempts:z.number().int().nonnegative(),unplacedReportedAttempts:z.number().int().nonnegative(),elapsedMinutes:z.literal('unavailable'),considered:z.number().int().nonnegative(),selected:z.number().int().nonnegative(),
 observations:z.strictObject({conversation:z.number().int().nonnegative(),no_answer:z.number().int().nonnegative(),callback_requested:z.number().int().nonnegative(),not_interested:z.number().int().nonnegative(),unknown:z.number().int().nonnegative()}),
 coverage:z.literal('current_retained_only'),appropriatePerson:z.literal('unavailable'),
 cohorts:z.array(z.strictObject({...dimensions,reportedAttempts:z.number().int().nonnegative(),unplacedReportedAttempts:z.number().int().nonnegative(),roles:z.array(z.enum(['workflow_owner','budget_approver','advocate','implementation'])).max(4),considered:z.number().int().nonnegative(),selected:z.number().int().nonnegative(),conversation:z.number().int().nonnegative(),noAnswer:z.number().int().nonnegative(),unknown:z.number().int().nonnegative()})).max(100),cohortsHasMore:z.boolean(),
 paidAdoption:z.literal('unavailable'),retention:z.literal('unavailable')});
export type ProspectPrioritySaveInput=z.infer<typeof prospectPrioritySaveInputSchema>;
export type ProspectPriorityConsiderInput=z.infer<typeof prospectPriorityConsiderInputSchema>;

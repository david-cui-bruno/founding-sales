import {z} from 'zod';
import {uuid} from './foundationRows.ts';
import {commandIdSchema} from './auth.ts';
import {semanticVersionSchema} from './clientVersion.ts';
export const qualificationAnswerSchema=z.enum(['yes','no','unknown']);
export type QualificationAnswer=z.infer<typeof qualificationAnswerSchema>;
export const qualificationFieldSchema=z.enum(['buyingParticipant','maintenanceNeed','openToPaying']);
export type QualificationField=z.infer<typeof qualificationFieldSchema>;
export const meetingQualificationEvidenceSchema=z.strictObject({field:qualificationFieldSchema,sourceKind:z.enum(['meeting_item','call_item','user_note','user_confirmation']),sourceId:z.string().min(1).max(240),sourceRevision:z.number().int().nonnegative()});
export type QualificationEvidence=z.infer<typeof meetingQualificationEvidenceSchema>;
export const saveMeetingQualificationSchema=z.strictObject({meetingId:uuid,expectedRevision:z.number().int().nonnegative(),commandId:commandIdSchema,
 buyingParticipant:qualificationAnswerSchema,maintenanceNeed:qualificationAnswerSchema,openToPaying:qualificationAnswerSchema,evidence:z.array(meetingQualificationEvidenceSchema).max(3)
}).refine(v=>new Set(v.evidence.map(e=>e.field)).size===v.evidence.length,'One reference per field');
export type SaveMeetingQualification=z.infer<typeof saveMeetingQualificationSchema>;
export const saveMeetingQualificationCommandSchema=saveMeetingQualificationSchema.safeExtend({clientVersion:semanticVersionSchema});
export const meetingQualificationViewSchema=z.strictObject({meetingId:uuid,revision:z.number().int().nonnegative(),buyingParticipant:qualificationAnswerSchema,maintenanceNeed:qualificationAnswerSchema,openToPaying:qualificationAnswerSchema,
 attendanceConfirmed:z.boolean(),qualified:z.boolean(),sourceLinks:z.array(z.strictObject({field:qualificationFieldSchema,target:z.enum(['meeting_notes','call']),id:uuid})).max(3),evidence:z.array(meetingQualificationEvidenceSchema).max(3),staleFields:z.array(qualificationFieldSchema).max(3)});
export type MeetingQualificationView=z.infer<typeof meetingQualificationViewSchema>;

export interface LearningCohort {
 hypothesis:string;policyVersion:string;acquisition:string;
 firms:number;contacted:number;reached:number;confirmedPain:number;booked:number;held:number;qualified:number;won:number;unreached:number;unknownQualification:number;
 email?:{sent:number;genuineReplies:number;positiveReplies:number;bounces:number;deferrals:number}|undefined;
 interactions:{answeredCalls:number;confirmedPainCalls:number};researchGrossCents:number;researchCashCents:number;
}
export const automaticEmailLearningSchema=z.strictObject({
 control:z.strictObject({enabled:z.boolean(),revision:z.number().int().nonnegative(),lastBatchAt:z.iso.datetime().nullable(),lastBatchReason:z.string().nullable(),lastBatchControlRevision:z.number().int().nonnegative().nullable()}).nullable(),
 discovery:z.strictObject({retainedHits:z.number().int().nonnegative(),supportedProspects:z.number().int().nonnegative(),admissions:z.number().int().nonnegative(),manualStaged:z.number().int().nonnegative(),unavailable:z.number().int().nonnegative()}),
 outcomes:z.strictObject({admissions:z.number().int().nonnegative(),attempts:z.number().int().nonnegative(),sent:z.number().int().nonnegative(),replies:z.number().int().nonnegative(),deliveryFailures:z.number().int().nonnegative(),optOuts:z.number().int().nonnegative(),unsettled:z.number().int().nonnegative(),booked:z.number().int().nonnegative(),heldQualified:z.number().int().nonnegative(),unknownQualification:z.number().int().nonnegative()}),
 attention:z.array(z.strictObject({firmId:uuid,firmName:z.string(),needsReply:z.number().int().nonnegative(),bookings:z.number().int().nonnegative(),heldQualified:z.number().int().nonnegative()})),
 decisions:z.array(z.strictObject({candidateId:uuid,runId:uuid,candidateRevision:z.number().int().positive(),firmName:z.string(),reason:z.string(),status:z.enum(['enrolled','held','deferred','exhausted']),checks:z.number().int().nonnegative(),retryAt:z.iso.datetime().nullable(),decidedAt:z.iso.datetime(),
 firmId:uuid.nullable(),contactId:uuid.nullable(),routeId:uuid.nullable(),planId:uuid.nullable(),enrollmentId:uuid.nullable(),ownerUserId:uuid.nullable(),mailboxId:uuid.nullable(),sequenceVersionId:uuid.nullable(),controlRevision:z.number().int().nonnegative(),
 rank:z.string().nullable(),policyVersion:z.string().nullable(),promptVersion:z.string().nullable(),evaluationSha256:z.string().nullable(),implementationCommit:z.string().nullable(),configurationSha256:z.string().nullable(),
 evidence:z.array(z.strictObject({observationId:uuid,url:z.string(),blockIds:z.array(z.string()),retrievedAt:z.iso.datetime(),contentHash:z.string()}))}))
});
export type AutomaticEmailLearning=z.infer<typeof automaticEmailLearningSchema>;
export interface LearningReport {
 automation?:AutomaticEmailLearning|undefined;
 from:string;to:string;asOf:string;cohorts:LearningCohort[];maturity:{ageBand:string;firms:number}[];
 firms:{firmId:string;firmName:string;candidateId:string|null;candidateRevision:number|null;hypothesis:string;policyVersion:string;acquisition:string;firstContactedAt:string}[];
 coverage:{candidates:number;qualified:number;admitted:number;unavailable:number};
 search:{attempts:number;creditsReserved:number};
}
export const targetingRanks=['help_request','operational_burden','investigation','fit_only'] as const;
export const targetingQuerySchema=z.strictObject({id:z.string().regex(/^[a-z0-9_.-]{1,100}$/u),query:z.string().trim().min(5).max(400),locality:z.string().trim().min(1).max(120),region:z.enum(['TX','RI','MA'])});
export type TargetingQuery=z.infer<typeof targetingQuerySchema>;
export const targetingProposalSchema=z.strictObject({basePolicyVersion:z.string().min(1).max(80),queryChanges:z.array(targetingQuerySchema).max(30),rankOrder:z.array(z.enum(targetingRanks)).length(4),evidenceIds:z.array(uuid).max(30),rationale:z.string().trim().min(5).max(2000)}).refine(v=>new Set(v.rankOrder).size===4&&new Set(v.queryChanges.map(q=>q.id)).size===v.queryChanges.length&&new Set(v.evidenceIds).size===v.evidenceIds.length);
export const targetingApplySchema=z.strictObject({id:uuid,expectedRevision:z.number().int().positive()});
export const targetingProposalCommandSchema=targetingProposalSchema.safeExtend({commandId:commandIdSchema,clientVersion:semanticVersionSchema});
export const targetingApplyCommandSchema=targetingApplySchema.extend({commandId:commandIdSchema,clientVersion:semanticVersionSchema});
export interface TargetingPolicy {version:string;queries:TargetingQuery[];rankOrder:string[]}
const count=z.number().int().nonnegative();
export const learningInputSchema=z.strictObject({from:z.iso.datetime(),to:z.iso.datetime(),asOf:z.iso.datetime()}).refine(v=>Date.parse(v.from)<=Date.parse(v.to));
export const learningReportSchema:z.ZodType<LearningReport>=z.strictObject({automation:automaticEmailLearningSchema.optional(),from:z.iso.datetime(),to:z.iso.datetime(),asOf:z.iso.datetime(),cohorts:z.array(z.strictObject({hypothesis:z.string(),policyVersion:z.string(),acquisition:z.string(),firms:count,contacted:count,reached:count,confirmedPain:count,booked:count,held:count,qualified:count,won:count,unreached:count,unknownQualification:count,email:z.strictObject({sent:count,genuineReplies:count,positiveReplies:count,bounces:count,deferrals:count}).optional(),interactions:z.strictObject({answeredCalls:count,confirmedPainCalls:count}),researchGrossCents:count,researchCashCents:count})),maturity:z.array(z.strictObject({ageBand:z.string(),firms:count})),firms:z.array(z.strictObject({firmId:uuid,firmName:z.string(),candidateId:uuid.nullable(),candidateRevision:count.nullable(),hypothesis:z.string(),policyVersion:z.string(),acquisition:z.string(),firstContactedAt:z.iso.datetime()})),coverage:z.strictObject({candidates:count,qualified:count,admitted:count,unavailable:count}),search:z.strictObject({attempts:count,creditsReserved:count})});
export const targetingPolicySchema:z.ZodType<TargetingPolicy>=z.strictObject({version:z.string(),queries:z.array(targetingQuerySchema).min(1).max(30),rankOrder:z.array(z.string()).length(4)});
export const targetingViewSchema=z.strictObject({policy:targetingPolicySchema,proposals:z.array(z.strictObject({id:uuid,revision:count,changes:targetingProposalSchema,appliedVersion:z.string().nullable()})),canEdit:z.boolean()});
export const callNeedReadSchema=z.union([z.strictObject({callLogId:uuid}),z.strictObject({sessionId:uuid})]);
export const callNeedViewSchema=z.strictObject({callLogId:uuid,revision:count,sourceRevision:count,answer:qualificationAnswerSchema,stale:z.boolean(),canConfirm:z.boolean()});
export type CallNeedView=z.infer<typeof callNeedViewSchema>;
export const callNeedSaveSchema=z.strictObject({callLogId:uuid,expectedRevision:count,expectedSourceRevision:count,answer:qualificationAnswerSchema,commandId:commandIdSchema});
export type CallNeedSave=z.infer<typeof callNeedSaveSchema>;
export const callNeedCommandSchema=callNeedSaveSchema.extend({clientVersion:semanticVersionSchema});

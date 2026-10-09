import {z} from 'zod';
import {commandIdSchema} from './auth.ts';
import {semanticVersionSchema} from './clientVersion.ts';
import {crmEvidenceClaimTargetSchema} from './crmEvidenceDecisions.ts';
import {canonicalSourceReferenceSchema} from './people.ts';
const millisecondInstant=z.iso.datetime().regex(/T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,3})?Z$/u);
const zone=z.string().max(100).refine(value=>{try{new Intl.DateTimeFormat('en',{timeZone:value});return true;}catch{return false;}},'Known time zone required');
export const crmCommitmentDueSchema=z.union([z.null(),z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('instant'),at:millisecondInstant,zone,expression:z.string().trim().min(1).max(200)}),
 z.strictObject({kind:z.literal('date'),date:z.iso.date(),zone,expression:z.string().trim().min(1).max(200)}),
])]);
export const crmCommitmentReviewSchema=crmEvidenceClaimTargetSchema.extend({commandId:commandIdSchema,clientVersion:semanticVersionSchema,expectedCommitmentRevision:z.number().int().min(0),classification:z.enum(['internal_promise','commercial','ambiguous']),actor:z.enum(['self','counterparty','unknown']),actionLabel:z.string().trim().min(1).max(300),due:crmCommitmentDueSchema,sourceZoneReceipt:z.strictObject({sourceRevision:z.number().int().positive(),sourceHash:z.string().regex(/^[a-f0-9]{64}$/u),zone,eventAt:millisecondInstant}).optional()}).strict();
export const crmCommitmentReadSchema=z.strictObject({scope:z.discriminatedUnion('kind',[z.strictObject({kind:z.literal('person'),personId:z.uuid()}),z.strictObject({kind:z.literal('firm'),firmId:z.uuid()}),z.strictObject({kind:z.literal('source'),sourceId:z.uuid(),sourceKind:canonicalSourceReferenceSchema.shape.kind}),z.strictObject({kind:z.literal('today')}),z.strictObject({kind:z.literal('history')})]),afterId:z.uuid().optional(),limit:z.number().int().min(1).max(50).default(50)});
export const crmCommitmentQueuedSchema=z.strictObject({commitmentId:z.uuid(),revision:z.number().int().positive(),status:z.literal('queued')});
export const crmCommitmentPageSchema=z.strictObject({items:z.array(z.strictObject({commitmentId:z.uuid(),revision:z.number().int().positive(),basis:z.enum(['human','verified_original']).nullable(),state:z.enum(['pending','applied','suggestion','review_required','redacted']),todayEligibility:z.enum(['current','historical','unknown']).nullable(),actor:z.enum(['self','counterparty','unknown']).nullable(),actionLabel:z.string().max(300).nullable(),due:crmCommitmentDueSchema,quote:z.string().max(2000).nullable(),source:canonicalSourceReferenceSchema.nullable(),task:z.strictObject({taskId:z.uuid(),status:z.enum(['open','done','cancelled']),version:z.number().int().positive(),completedAt:z.iso.datetime().nullable()}).nullable()}).refine(value=>(value.state==='redacted')===(value.basis===null),'Basis is required for active reviews and erased for redacted reviews')).max(50),nextAfterId:z.uuid().nullable()});
export type CrmCommitmentReview=z.infer<typeof crmCommitmentReviewSchema>;
export type CrmCommitmentRead=z.infer<typeof crmCommitmentReadSchema>;

export const crmCommitmentCompleteSchema=z.strictObject({commandId:commandIdSchema,clientVersion:semanticVersionSchema,taskId:z.uuid(),expectedVersion:z.number().int().positive()});
export const crmCommitmentCompletedSchema=z.strictObject({taskId:z.uuid(),version:z.number().int().positive(),completedAt:z.iso.datetime()});
export type CrmCommitmentComplete=z.infer<typeof crmCommitmentCompleteSchema>;

export const crmCommitmentHistoryPageSchema=z.strictObject({items:z.array(z.strictObject({taskId:z.uuid(),status:z.enum(['done','cancelled']),version:z.number().int().positive(),completedAt:z.iso.datetime().nullable()})).max(50),nextAfterId:z.uuid().nullable()});

export const crmCommitmentReviewPayloadSchema=crmCommitmentReviewSchema.omit({commandId:true,clientVersion:true});
export const crmCommitmentCompletePayloadSchema=crmCommitmentCompleteSchema.omit({commandId:true,clientVersion:true});
export const crmCommitmentReviewStatusSchema=crmEvidenceClaimTargetSchema;
export const crmCommitmentReviewStatusResultSchema=z.strictObject({current:z.strictObject({commitmentId:z.uuid(),revision:z.number().int().positive(),basis:z.enum(['human','verified_original']),state:z.enum(['pending','applied','suggestion','review_required'])}).nullable()});

import {z} from 'zod';
import {uuid} from './foundationRows.ts';
import {commandIdSchema} from './auth.ts';
import {semanticVersionSchema} from './clientVersion.ts';
import {answerBlockSchema,prospectingAuthorizationSaveSchema,saveAnswerBlockCommandSchema,answerBlockApprovalCommandSchema} from './outreach.ts';
const envelope={commandId:commandIdSchema,clientVersion:semanticVersionSchema};
export const routineSettingsSchema=z.strictObject({revision:z.number().int().nonnegative(),enabled:z.boolean(),sequenceVersionId:uuid.nullable(),bookingUrl:z.string().nullable()});
export const routineSettingsSaveSchema=z.strictObject({expectedRevision:z.number().int().nonnegative(),enabled:z.boolean(),sequenceVersionId:uuid.nullable(),bookingUrl:z.string().trim().max(2000).nullable()});
export const routineSettingsCommandSchema=routineSettingsSaveSchema.extend(envelope);
export const emailAdmissionEvaluationSchema=z.strictObject({policyVersion:z.string().min(1).max(100),promptVersion:z.string().min(1).max(100),implementationCommit:z.string().regex(/^[a-f0-9]{40}$/),reportSha256:z.string().regex(/^[a-f0-9]{64}$/),configurationSha256:z.string().regex(/^[a-f0-9]{64}$/),reviewedEligible:z.number().int().nonnegative(),falseEligible:z.number().int().nonnegative()});
export const emailAdmissionControlSchema=z.strictObject({revision:z.number().int().nonnegative(),enabled:z.boolean(),ownerUserId:uuid.nullable(),mailboxId:uuid.nullable(),sequenceVersionId:uuid.nullable(),evaluation:emailAdmissionEvaluationSchema.nullable(),configurationSha256:z.string().nullable(),ready:z.boolean(),reasons:z.array(z.string())});
export const emailAdmissionSaveSchema=emailAdmissionControlSchema.omit({revision:true,configurationSha256:true,ready:true,reasons:true}).extend({expectedRevision:z.number().int().nonnegative()});
export const emailAdmissionCommandSchema=emailAdmissionSaveSchema.extend(envelope);
export const outreachControlSchema=z.strictObject({
 emailAdmission:emailAdmissionControlSchema,settings:routineSettingsSchema,blocks:z.array(answerBlockSchema),
 senders:z.array(z.strictObject({id:uuid,address:z.string(),ownerUserId:uuid,connected:z.boolean(),authorized:z.boolean(),authorizationRevision:z.number().int().nonnegative(),sendingEnabled:z.boolean(),dailyCap:z.number().int().nullable()})),
 sequences:z.array(z.strictObject({id:uuid,label:z.string(),kind:z.enum(['reply','email_first','call_first'])})),
 candidates:z.array(z.strictObject({id:uuid,revision:z.number().int().positive(),qualificationRunId:uuid,name:z.string(),location:z.string()})),
 replies:z.array(z.strictObject({id:uuid,revision:z.number().int().positive(),firmId:uuid,firmName:z.string(),state:z.string(),reason:z.string().nullable(),createdAt:z.string()})),
});
export type OutreachControl=z.infer<typeof outreachControlSchema>;
export const outreachCohortInputSchema=z.strictObject({mailboxId:uuid,candidateIds:z.array(uuid).min(1).max(25).refine(ids=>new Set(ids).size===ids.length),emailSequenceVersionId:uuid.nullable(),callSequenceVersionId:uuid.nullable()});
export const outreachCohortPreviewSchema=z.strictObject({hash:z.string().regex(/^[a-f0-9]{64}$/),rows:z.array(z.strictObject({candidateId:uuid,name:z.string(),revision:z.number().int().positive(),qualificationRunId:uuid,address:z.string().nullable(),lane:z.enum(['email_first','call_first']).nullable(),reviewRequired:z.boolean(),reason:z.string().nullable()}))});
export type OutreachCohortInput=z.infer<typeof outreachCohortInputSchema>;
export type OutreachCohortPreview=z.infer<typeof outreachCohortPreviewSchema>;
export const outreachCohortEnableSchema=outreachCohortInputSchema.extend({expectedHash:z.string().regex(/^[a-f0-9]{64}$/),reviewed:z.boolean()});
export const outreachCohortCommandSchema=outreachCohortEnableSchema.extend(envelope);
export const routineManualCommandSchema=z.strictObject({id:uuid,expectedRevision:z.number().int().positive(),...envelope});

export const outreachMutationSchema=z.discriminatedUnion('action',[
 emailAdmissionCommandSchema.omit({clientVersion:true}).extend({action:z.literal('email_admission')}),
 prospectingAuthorizationSaveSchema.omit({clientVersion:true}).extend({action:z.literal('authorization')}),
 routineSettingsCommandSchema.omit({clientVersion:true}).extend({action:z.literal('policy')}),
 z.strictObject({...saveAnswerBlockCommandSchema.shape,clientVersion:z.undefined().optional(),action:z.literal('fact_save')}),
 answerBlockApprovalCommandSchema.omit({clientVersion:true}).extend({action:z.literal('fact_approve')}),
 answerBlockApprovalCommandSchema.omit({clientVersion:true}).extend({action:z.literal('fact_retire')}),
 outreachCohortCommandSchema.omit({clientVersion:true}).extend({action:z.literal('cohort_enable')}),
 routineManualCommandSchema.omit({clientVersion:true}).extend({action:z.literal('reply_manual')}),
]);
export type OutreachMutation=z.infer<typeof outreachMutationSchema>;

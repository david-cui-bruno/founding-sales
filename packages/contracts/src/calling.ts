import {z} from 'zod';
import {commandIdSchema} from './auth.ts';
import {semanticVersionSchema} from './clientVersion.ts';
import {instant,uuid} from './foundationRows.ts';
import {logCallOutcomeCommandSchema} from './dial.ts';
import {manualProspectActivityContentSchema,manualProspectActivitySavedSchema} from './manualProspectActivity.ts';

const positive=z.number().int().positive();
const envelope={commandId:commandIdSchema,clientVersion:semanticVersionSchema};
const candidate=z.strictObject({kind:z.literal('candidate'),candidateId:uuid,expectedCandidateRevision:positive});
const firm=z.strictObject({kind:z.literal('firm'),firmId:uuid,itemId:uuid.optional(),opportunityId:uuid.optional()});
/** Explicit subject identity. No inferred candidate-to-Firm association. */
export const callingSubjectSchema=z.discriminatedUnion('kind',[candidate,firm]);
const text=(characters:number,bytes:number)=>z.string().min(1).max(characters)
 .refine(value=>value.trim().length>0,'Nonblank text required')
 .refine(value=>new TextEncoder().encode(value).byteLength<=bytes,'Text exceeds byte limit');
export const callingFollowUpContentSchema=z.strictObject({subject:text(160,640),body:text(4000,16000)});
const promisedEmail=callingFollowUpContentSchema.extend({draftId:uuid,nextAction:z.literal('promised_email')});
/** Reuse actual canonical outcome vocabulary without template consent or live dial reservation. */
export const callingCanonicalReportSchema=logCallOutcomeCommandSchema.pick({
 outcome:true,contactId:true,routeId:true,occurredAt:true,note:true,direction:true,
 durationSeconds:true,callback:true,doNotCall:true,
}).extend({performedByUser:z.literal(true)});
const candidateWrap=candidate.extend({attemptId:uuid,report:manualProspectActivityContentSchema,
 promisedEmail:promisedEmail.optional()}).superRefine((value,ctx)=>{
 if(value.promisedEmail&&!['conversation','callback_requested','not_interested'].includes(value.report.result))
  ctx.addIssue({code:'custom',path:['promisedEmail'],message:'A reported conversation is required for promised preparation.'});
});
const firmWrap=firm.extend({report:callingCanonicalReportSchema,promisedEmail:promisedEmail.optional()})
 .superRefine((value,ctx)=>{
  if(value.promisedEmail&&!['interested','referral_or_wrong_person','callback_requested','not_interested'].includes(value.report.outcome))
   ctx.addIssue({code:'custom',path:['promisedEmail'],message:'A reached call is required for promised preparation.'});
 });
export const callingWrapInputSchema=z.discriminatedUnion('kind',[candidateWrap,firmWrap]);
export const callingWrapCommandSchema=z.discriminatedUnion('kind',[
 candidateWrap.safeExtend(envelope),firmWrap.safeExtend(envelope),
]);
export const callingFollowUpSourceSchema=z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('candidate'),candidateId:uuid,candidateRevision:positive,attemptId:uuid}),
 z.strictObject({kind:z.literal('firm'),firmId:uuid,callLogId:uuid}),
]);
export const callingFollowUpSavedSchema=z.strictObject({draftId:uuid,revision:positive});
const followUp=z.discriminatedUnion('state',[
 z.strictObject({state:z.literal('not_requested')}),
 callingFollowUpSavedSchema.extend({state:z.literal('queued_for_review')}),
 z.strictObject({state:z.literal('not_queued'),reason:z.enum([
  'effects_not_applied','source_unavailable','draft_conflict','draft_unavailable',
 ])}),
]);
/** Historical acceptance only: no note, draft text, recipient or current authority. */
export const callingWrapResultSchema=z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('candidate'),activity:manualProspectActivitySavedSchema,
  staleIntroductions:z.literal('not_applicable'),followUp}),
 z.strictObject({kind:z.literal('firm'),firmId:uuid,callLogId:uuid,
  staleIntroductions:z.enum(['stopped','not_applicable','not_confirmed']),
  attention:z.array(z.enum(['callback_time_needed','route_not_named','effects_not_applied'])).max(3),followUp}),
]);
export const callingFollowUpListInputSchema=z.strictObject({afterId:uuid.optional()});
export const callingFollowUpReadInputSchema=z.strictObject({draftId:uuid,expectedRevision:positive});
const edit=callingFollowUpContentSchema.extend({operation:z.literal('update'),draftId:uuid,expectedRevision:positive});
const withdraw=z.strictObject({operation:z.literal('withdraw'),draftId:uuid,expectedRevision:positive});
export const callingFollowUpSaveInputSchema=z.discriminatedUnion('operation',[edit,withdraw]);
export const callingFollowUpSaveCommandSchema=z.discriminatedUnion('operation',[
 edit.extend(envelope),withdraw.extend(envelope),
]);
export const callingFollowUpMetadataSchema=z.strictObject({draftId:uuid,revision:positive,
 source:callingFollowUpSourceSchema,availability:z.enum(['available','withdrawn','unavailable']),
 createdAt:instant,updatedAt:instant});
export const callingFollowUpListSchema=z.strictObject({drafts:z.array(callingFollowUpMetadataSchema).max(20),nextAfterId:uuid.nullable()});
export const callingFollowUpViewSchema=z.discriminatedUnion('availability',[
 callingFollowUpMetadataSchema.extend({availability:z.literal('available'),content:callingFollowUpContentSchema,
  state:z.literal('queued_for_review'),recipient:z.literal('unresolved'),sendAuthority:z.literal('not_granted')}),
 callingFollowUpMetadataSchema.extend({availability:z.literal('withdrawn')}),
 callingFollowUpMetadataSchema.extend({availability:z.literal('unavailable'),reason:z.enum([
  'source_changed_or_unavailable','source_revision_changed','removed',
 ])}),
]);
export const callingFollowUpReadSchema=z.strictObject({draft:callingFollowUpViewSchema});
export const callingReceiptInputSchema=z.strictObject({operation:z.enum(['wrap','save']),
 commandId:commandIdSchema,payloadSHA256:z.string().regex(/^[a-f0-9]{64}$/u)});
const accepted=z.discriminatedUnion('operation',[
 z.strictObject({operation:z.literal('wrap'),result:callingWrapResultSchema}),
 z.strictObject({operation:z.literal('save'),result:callingFollowUpSavedSchema}),
]);
export const callingReceiptSchema=z.discriminatedUnion('state',[
 z.strictObject({state:z.literal('accepted'),acceptance:accepted}),
 z.strictObject({state:z.literal('refused'),reason:z.string().regex(/^[a-z][a-z0-9_]{0,79}$/u)}),
 z.strictObject({state:z.literal('unknown')}),
]);
export type CallingSubject=z.infer<typeof callingSubjectSchema>;
export type CallingWrapInput=z.infer<typeof callingWrapInputSchema>;
export type CallingWrapCommand=z.infer<typeof callingWrapCommandSchema>;
export type CallingWrapResult=z.infer<typeof callingWrapResultSchema>;
export type CallingFollowUpContent=z.infer<typeof callingFollowUpContentSchema>;
export type CallingFollowUpSource=z.infer<typeof callingFollowUpSourceSchema>;
export type CallingFollowUpSaveInput=z.infer<typeof callingFollowUpSaveInputSchema>;
export type CallingFollowUpSaveCommand=z.infer<typeof callingFollowUpSaveCommandSchema>;
export type CallingFollowUpMetadata=z.infer<typeof callingFollowUpMetadataSchema>;
export type CallingFollowUpView=z.infer<typeof callingFollowUpViewSchema>;
export type CallingFollowUpList=z.infer<typeof callingFollowUpListSchema>;
export type CallingReceipt=z.infer<typeof callingReceiptSchema>;

import {z} from 'zod';
import {commandIdSchema} from './auth.ts';
import {semanticVersionSchema} from './clientVersion.ts';
import {instant,uuid} from './foundationRows.ts';

/** User reports only. Never a CallOutcome, reservation, consent or execution permission. */
export const manualProspectActivityResultSchema=z.enum([
 'unknown','no_answer','busy','voicemail_left','conversation','callback_requested',
 'not_interested','wrong_number','do_not_call','technical_failure',
]);
const positive=z.number().int().positive();
const hash=z.string().regex(/^[a-f0-9]{64}$/u);
const boundedText=(characters:number,bytes:number)=>z.string().max(characters)
 .refine(value=>new TextEncoder().encode(value).byteLength<=bytes,'Text exceeds byte limit');
export const manualProspectOccurrenceSchema=z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('unknown')}),
 z.strictObject({kind:z.literal('known'),occurredAt:instant}),
]);
/** Domain owner must reject future occurrence and inconsistent/ambiguous civil times. */
export const manualProspectCallbackTimingSchema=z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('unknown')}),
 z.strictObject({kind:z.literal('confirmed'),localDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  localTime:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u),
  sourceTimeZone:z.string().min(1).max(64),dueAt:instant}),
]);
export const manualProspectActivityContentSchema=z.strictObject({
 performedByUser:z.literal(true),channel:z.literal('manual_phone'),
 occurrence:manualProspectOccurrenceSchema,result:manualProspectActivityResultSchema,
 note:boundedText(1000,4000).nullable(),
 callback:z.strictObject({note:boundedText(500,2000).nullable(),
  timing:manualProspectCallbackTimingSchema}).nullable(),
}).superRefine((value,ctx)=>{
 if((value.result==='callback_requested')!==(value.callback!==null))
  ctx.addIssue({code:'custom',message:'Callback content exists exactly for a reported callback request.'});
});
const binding={candidateId:uuid,expectedCandidateRevision:positive,attemptId:uuid};
const create=manualProspectActivityContentSchema.safeExtend({...binding,operation:z.literal('create')});
const update=manualProspectActivityContentSchema.safeExtend({...binding,operation:z.literal('update'),
 expectedActivityRevision:positive});
const withdraw=z.strictObject({...binding,operation:z.literal('withdraw'),expectedActivityRevision:positive});
export const manualProspectActivitySaveInputSchema=z.discriminatedUnion('operation',[create,update,withdraw]);
const envelope={commandId:commandIdSchema,clientVersion:semanticVersionSchema};
export const manualProspectActivitySaveCommandSchema=z.discriminatedUnion('operation',[
 create.safeExtend(envelope),update.safeExtend(envelope),withdraw.extend(envelope),
]);
export const manualProspectActivityListInputSchema=z.strictObject({candidateId:uuid,
 expectedCandidateRevision:positive,afterId:uuid.optional()});
export const manualProspectActivityReadInputSchema=z.strictObject(binding);
export const manualProspectActivityReceiptInputSchema=z.strictObject({commandId:commandIdSchema,payloadSHA256:hash});
/** Opaque historical acceptance, not current content/source authority. */
export const manualProspectActivitySavedSchema=z.strictObject({candidateId:uuid,
 candidateRevision:positive,attemptId:uuid,activityRevision:positive});
const metadata={candidateId:uuid,candidateRevision:positive,attemptId:uuid,activityRevision:positive,
 recordedAt:instant,updatedAt:instant};
export const manualProspectActivityMetadataSchema=z.strictObject({...metadata,
 availability:z.enum(['available','withdrawn','unavailable'])});
export const manualProspectActivityListSchema=z.strictObject({
 activities:z.array(manualProspectActivityMetadataSchema).max(20),nextAfterId:uuid.nullable()});
export const manualProspectActivityViewSchema=z.discriminatedUnion('availability',[
 manualProspectActivityContentSchema.safeExtend({...metadata,availability:z.literal('available'),
  qualification:z.literal('unverified'),contactAuthority:z.literal('not_granted'),
  reportBasis:z.literal('user_reported_unverified')}),
 z.strictObject({...metadata,availability:z.literal('withdrawn')}),
 z.strictObject({...metadata,availability:z.literal('unavailable'),
  reason:z.enum(['source_changed_or_unavailable','candidate_revision_changed','removed'])}),
]);
export const manualProspectActivityReadSchema=z.strictObject({activity:manualProspectActivityViewSchema});
export const manualProspectActivityReceiptSchema=z.discriminatedUnion('state',[
 z.strictObject({state:z.literal('accepted'),result:manualProspectActivitySavedSchema}),
 z.strictObject({state:z.literal('refused'),reason:z.string().min(1).max(100)}),
 z.strictObject({state:z.literal('unknown')}),
]);
export type ManualProspectActivityContent=z.infer<typeof manualProspectActivityContentSchema>;
export type ManualProspectActivitySaveInput=z.infer<typeof manualProspectActivitySaveInputSchema>;
export type ManualProspectActivitySaveCommand=z.infer<typeof manualProspectActivitySaveCommandSchema>;
export type ManualProspectActivityMetadata=z.infer<typeof manualProspectActivityMetadataSchema>;
export type ManualProspectActivityView=z.infer<typeof manualProspectActivityViewSchema>;
export type ManualProspectActivityList=z.infer<typeof manualProspectActivityListSchema>;
export type ManualProspectActivityReceipt=z.infer<typeof manualProspectActivityReceiptSchema>;

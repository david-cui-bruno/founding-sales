import {z} from 'zod';
import {uuid,instant} from './foundationRows.ts';
import {commandIdSchema} from './auth.ts';
import {semanticVersionSchema} from './clientVersion.ts';
import {socialPrivateDraftTextSchema,socialPrivateDraftReceiptInputSchema} from './socialPrivateDrafts.ts';
import {socialVoiceSaveInputSchema} from './socialVoicePreferences.ts';
export const SOCIAL_FOUNDER_INPUT_PROCESSING_SCOPE='bedrock_haiku_founder_inputs_v1' as const;
export const socialFounderInputProcessingScopeSchema=z.literal(SOCIAL_FOUNDER_INPUT_PROCESSING_SCOPE);
export const socialFounderInputRefSchema=z.strictObject({inputId:uuid,revision:z.number().int().positive()});
export const socialFounderFormatSchema=z.enum(['story','opinion','technical','college']);
const content={bullets:socialPrivateDraftTextSchema,context:z.string().max(1000).refine(v=>new TextEncoder().encode(v).byteLength<=4000),experienceDate:z.iso.date().nullable(),publicSafe:z.boolean()};
const boundedContent=(value:{bullets:string;context:string})=>value.bullets.length+value.context.length<=10000&&new TextEncoder().encode(value.bullets+value.context).byteLength<=40000;
const create=z.strictObject({operation:z.literal('create'),...content}).refine(boundedContent,'Combined input exceeds private composition limit');
const update=z.strictObject({operation:z.literal('update'),inputId:uuid,expectedRevision:z.number().int().positive(),...content}).refine(boundedContent,'Combined input exceeds private composition limit');
const remove=z.strictObject({operation:z.literal('remove'),inputId:uuid,expectedRevision:z.number().int().positive()});
const envelope={commandId:commandIdSchema,clientVersion:semanticVersionSchema};
export const socialFounderInputSaveSchema=z.discriminatedUnion('operation',[create,update,remove]);
export const socialFounderInputSaveCommandSchema=z.discriminatedUnion('operation',[create.safeExtend(envelope),update.safeExtend(envelope),remove.extend(envelope)]);
export const socialFounderInputReadInputSchema=z.strictObject({inputId:uuid});
export const socialFounderInputListInputSchema=z.strictObject({afterId:uuid.optional()});
export const socialFounderReceiptInputSchema=socialPrivateDraftReceiptInputSchema.extend({kind:z.enum(['input','calibration'])});
export const socialFounderInputSavedSchema=socialFounderInputRefSchema;
const metadata={inputId:uuid,revision:z.number().int().positive(),createdAt:instant,expiresAt:instant};
export const socialFounderInputViewSchema=z.discriminatedUnion('state',[
 z.strictObject({state:z.literal('available'),...metadata,...content}).refine(boundedContent,'Combined input exceeds private composition limit'),
 z.strictObject({state:z.literal('unavailable'),...metadata,reason:z.enum(['removed','expired','owner_unavailable'])}),
]);
export const socialFounderInputListSchema=z.strictObject({inputs:z.array(socialFounderInputViewSchema).max(20),nextAfterId:uuid.nullable()});
export const socialCalibrationExampleSchema=z.strictObject({draftId:uuid,revision:z.number().int().positive()});
export const socialCalibrationFinishSchema=z.strictObject({examples:z.array(socialCalibrationExampleSchema).length(3).refine(v=>new Set(v.map(e=>e.draftId)).size===3,'Distinct drafts required'),expectedGuide:z.strictObject({guideId:uuid,revision:z.number().int().positive()}).nullable(),finalGuide:socialVoiceSaveInputSchema.optional()});
export const socialCalibrationFinishCommandSchema=socialCalibrationFinishSchema.extend(envelope);
export const socialCalibrationResultSchema=z.strictObject({calibrationId:uuid,completedAt:instant,guideRef:z.strictObject({guideId:uuid,revision:z.number().int().positive()}).nullable()});
export const socialCalibrationReadInputSchema=z.strictObject({});
export const socialCalibrationReadSchema=z.strictObject({completion:socialCalibrationResultSchema.nullable()});
export const socialFounderReceiptSchema=z.discriminatedUnion('state',[
 z.strictObject({state:z.literal('accepted'),result:z.union([socialFounderInputSavedSchema,socialCalibrationResultSchema])}),
 z.strictObject({state:z.literal('refused'),reason:z.string().min(1).max(100)}),z.strictObject({state:z.literal('unknown')}),
]);
export type SocialFounderInputSave=z.infer<typeof socialFounderInputSaveSchema>;
export type SocialFounderInputView=z.infer<typeof socialFounderInputViewSchema>;
export type SocialCalibrationFinish=z.infer<typeof socialCalibrationFinishSchema>;
export type SocialCalibrationResult=z.infer<typeof socialCalibrationResultSchema>;

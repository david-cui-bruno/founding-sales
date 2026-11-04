import {z} from 'zod';
import {commandIdSchema} from './auth.ts';
import {uuid} from './foundationRows.ts';
import {socialDraftRequestSchema} from './social.ts';

/** Browser selection contains only current approved references, never guidance
 * or source prose. Native legacy request modes keep their existing contract. */
export const socialGuidedRequestInputSchema=socialDraftRequestSchema.safeExtend({
 mode:z.enum(['linkedin_grounded','linkedin_founder']),
 sourceRefs:z.array(z.strictObject({kind:z.literal('public'),id:uuid,revision:z.number().int().positive()})).max(10),
 standingPlanRef:z.never().optional(),
}).refine(value=>value.mode!=='linkedin_grounded'||(value.factBlocks.length>0&&value.voiceGuideRef!==undefined),'Grounded generation requires approved facts and current guide');
export const socialGuidedRequestSavedSchema=z.strictObject({requestId:uuid});
export const socialGuidedRequestReceiptInputSchema=z.strictObject({
 commandId:commandIdSchema,payloadSHA256:z.string().regex(/^[a-f0-9]{64}$/u),
});
/** History only: acceptance requires a separate authorized current draft read.
 * Missing receipt remains UNKNOWN and never authorizes replacement dispatch. */
export const socialGuidedRequestReceiptSchema=z.discriminatedUnion('state',[
 z.strictObject({state:z.literal('accepted'),result:socialGuidedRequestSavedSchema}),
 z.strictObject({state:z.literal('refused'),reason:z.string().min(1).max(100)}),
 z.strictObject({state:z.literal('unknown')}),
]);
export type SocialGuidedRequestInput=z.infer<typeof socialGuidedRequestInputSchema>;
export type SocialGuidedRequestReceipt=z.infer<typeof socialGuidedRequestReceiptSchema>;

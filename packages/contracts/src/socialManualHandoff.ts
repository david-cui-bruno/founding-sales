import {z} from 'zod';
import {uuid} from './foundationRows.ts';
import {commandIdSchema} from './auth.ts';
import {semanticVersionSchema} from './clientVersion.ts';
import {socialPlatformSchema,socialPostImageSchema} from './social.ts';
export const socialManualHandoffInputSchema=z.strictObject({postId:uuid,expectedRevision:z.number().int().positive()});
export const socialManualHandoffSnapshotSchema=z.strictObject({
 account:z.strictObject({id:uuid,platform:socialPlatformSchema,externalId:z.string().min(1).max(300),displayName:z.string().max(200),accountKind:z.enum(['profile','page']),revision:z.number().int().positive()}),
 text:z.string().max(10000),images:z.array(socialPostImageSchema.extend({sha256:z.string().regex(/^[a-f0-9]{64}$/u),mime:z.string().max(100),width:z.number().int().positive().nullable(),height:z.number().int().positive().nullable()})).max(20),publishAt:z.string().datetime(),zone:z.string().max(80)
});
export const socialManualHandoffViewSchema=z.strictObject({postId:uuid,revision:z.number().int().positive(),fingerprint:z.string().regex(/^[a-f0-9]{64}$/u),snapshot:socialManualHandoffSnapshotSchema,approvalId:uuid.nullable(),approvedAt:z.string().datetime().nullable(),state:z.enum(['review_required','manual_needed']),accountEvidence:z.literal('human_review_required')});
export type SocialManualHandoffSnapshot=z.infer<typeof socialManualHandoffSnapshotSchema>;
export type SocialManualHandoffView=z.infer<typeof socialManualHandoffViewSchema>;
export const socialManualHandoffConfirmSchema=socialManualHandoffInputSchema.extend({fingerprint:z.string().regex(/^[a-f0-9]{64}$/u),reviewedDestination:z.literal(true)});
export const socialManualHandoffConfirmCommandSchema=socialManualHandoffConfirmSchema.extend({commandId:commandIdSchema,clientVersion:semanticVersionSchema});
export const socialManualHandoffApprovalSchema=z.strictObject({approvalId:uuid});
export const socialManualHandoffUseSchema=socialManualHandoffInputSchema.extend({fingerprint:z.string().regex(/^[a-f0-9]{64}$/u),approvalId:uuid,action:z.enum(['copy','open','save_image']),image:socialPostImageSchema.pick({assetId:true,version:true}).optional()}).refine(v=>v.action==='save_image'?v.image!==undefined:v.image===undefined,'Image only for explicit image saving');

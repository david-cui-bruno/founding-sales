import {z} from 'zod';
import {commandIdSchema} from './auth.ts';
import {semanticVersionSchema} from './clientVersion.ts';
import {instant,uuid} from './foundationRows.ts';

/** Private composition only, never a publishing post, approval or generation request. */
export const socialPrivateDraftKindSchema=z.enum(['post','comment']);
export const socialPrivateDraftHashSchema=z.string().regex(/^[a-f0-9]{64}$/u);
export const socialPrivateDraftTextSchema=z.string().min(1).max(10000)
 .refine(value=>value.trim().length>0,'Nonblank text required')
 .refine(value=>new TextEncoder().encode(value).byteLength<=40000,'Text exceeds byte limit');
export const socialPrivateDraftOriginSchema=z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('manual')}),
 z.strictObject({kind:z.literal('suggestion'),requestId:uuid,
  conceptIndex:z.number().int().min(0).max(2),variantIndex:z.number().int().min(0).max(2),
  selectionSHA256:socialPrivateDraftHashSchema}),
]);
const createSchema=z.strictObject({operation:z.literal('create'),kind:socialPrivateDraftKindSchema,
 text:socialPrivateDraftTextSchema,origin:socialPrivateDraftOriginSchema});
const updateSchema=z.strictObject({operation:z.literal('update'),draftId:uuid,
 expectedRevision:z.number().int().positive(),kind:socialPrivateDraftKindSchema,text:socialPrivateDraftTextSchema});
export const socialPrivateDraftSaveInputSchema=z.discriminatedUnion('operation',[createSchema,updateSchema]);
const envelope={commandId:commandIdSchema,clientVersion:semanticVersionSchema};
export const socialPrivateDraftSaveCommandSchema=z.discriminatedUnion('operation',[
 createSchema.extend(envelope),updateSchema.extend(envelope),
]);
export const socialPrivateDraftListInputSchema=z.strictObject({afterId:uuid.optional()});
export const socialPrivateDraftReadInputSchema=z.strictObject({draftId:uuid});
/** Fingerprint follows runCommand canonical parsed-payload hashing, not a second algorithm. */
export const socialPrivateDraftReceiptInputSchema=z.strictObject({commandId:commandIdSchema,
 payloadSHA256:socialPrivateDraftHashSchema});
export const socialPrivateDraftSavedSchema=z.strictObject({draftId:uuid,revision:z.number().int().positive()});
export const socialPrivateDraftMetadataSchema=z.strictObject({draftId:uuid,revision:z.number().int().positive(),
 kind:socialPrivateDraftKindSchema,originKind:z.enum(['manual','suggestion']),
 availability:z.enum(['available','unavailable']),createdAt:instant,updatedAt:instant,expiresAt:instant});
export const socialPrivateDraftListSchema=z.strictObject({drafts:z.array(socialPrivateDraftMetadataSchema).max(20),
 nextAfterId:uuid.nullable()});
export const socialPrivateDraftViewSchema=z.discriminatedUnion('availability',[
 socialPrivateDraftMetadataSchema.extend({availability:z.literal('available'),text:socialPrivateDraftTextSchema,
  origin:socialPrivateDraftOriginSchema,reviewRequired:z.literal(true)}),
 socialPrivateDraftMetadataSchema.extend({availability:z.literal('unavailable'),reason:z.enum([
  'expired','source_changed_or_unavailable','removed',
 ])}),
]);
export const socialPrivateDraftReadSchema=z.strictObject({draft:socialPrivateDraftViewSchema});
/** Historical result is not current source or content authority. Always explicitly reread. */
export const socialPrivateDraftReceiptSchema=z.discriminatedUnion('state',[
 z.strictObject({state:z.literal('accepted'),result:socialPrivateDraftSavedSchema}),
 z.strictObject({state:z.literal('refused'),reason:z.string().min(1).max(100)}),
 z.strictObject({state:z.literal('unknown')}),
]);
export type SocialPrivateDraftOrigin=z.infer<typeof socialPrivateDraftOriginSchema>;
export type SocialPrivateDraftSaveInput=z.infer<typeof socialPrivateDraftSaveInputSchema>;
export type SocialPrivateDraftSaveCommand=z.infer<typeof socialPrivateDraftSaveCommandSchema>;
export type SocialPrivateDraftMetadata=z.infer<typeof socialPrivateDraftMetadataSchema>;
export type SocialPrivateDraftView=z.infer<typeof socialPrivateDraftViewSchema>;
export type SocialPrivateDraftList=z.infer<typeof socialPrivateDraftListSchema>;
export type SocialPrivateDraftReceipt=z.infer<typeof socialPrivateDraftReceiptSchema>;

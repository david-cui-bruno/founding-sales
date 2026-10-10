import {z} from 'zod';
import {uuid} from './foundationRows.ts';
export const socialPlatformSchema=z.enum(['linkedin','facebook','x']);
export const socialAssetOriginSchema=z.strictObject({kind:z.enum(['upload','phone','web','screenshot']),sourceUrl:z.string().url().max(2048).refine(v=>new URL(v).protocol==='https:','HTTPS required').nullable(),usageNote:z.string().trim().max(1000).nullable()});
export const registerSocialAssetSchema=z.strictObject({assetId:uuid.optional(),expectedVersion:z.number().int().positive().optional(),sha256:z.string().regex(/^[a-f0-9]{64}$/u),bytes:z.number().int().positive().max(20*1024*1024),mime:z.enum(['image/png','image/jpeg','image/webp','image/heic']),origin:socialAssetOriginSchema,width:z.number().int().positive().max(4096).optional(),height:z.number().int().positive().max(4096).optional()}).refine(v=>v.assetId===undefined?v.expectedVersion===undefined:v.expectedVersion!==undefined&&v.width!==undefined&&v.height!==undefined&&v.bytes<=5*1024*1024&&['image/png','image/jpeg'].includes(v.mime),'Invalid derivative');
export type RegisterSocialAsset=z.infer<typeof registerSocialAssetSchema>;
export type AssetOrigin=z.infer<typeof socialAssetOriginSchema>;
export interface SocialAssetView{id:string;state:'uploading'|'ready'|'deleted';version:number;origin:AssetOrigin;objects:{version:number;kind:'original'|'derivative';state:'uploading'|'ready'|'deleted';sha256:string;bytes:number;mime:string;width:number|null;height:number|null}[]}

import {commandIdSchema} from './auth.ts';
import {semanticVersionSchema} from './clientVersion.ts';
export const socialAssetRegisterCommandSchema=registerSocialAssetSchema.safeExtend({commandId:commandIdSchema,clientVersion:semanticVersionSchema});
export const socialAssetCompleteCommandSchema=z.strictObject({assetId:uuid,uploadId:uuid,commandId:commandIdSchema,clientVersion:semanticVersionSchema});
export const socialAssetDeleteCommandSchema=z.strictObject({assetId:uuid,commandId:commandIdSchema,clientVersion:semanticVersionSchema});
export const socialPostStateSchema=z.enum(['draft','approved','submitting','scheduled','published','cancellation_pending','cancelled','failed','unknown']);
export const socialPostImageSchema=z.strictObject({assetId:uuid,version:z.number().int().positive(),altText:z.string().trim().min(1).max(1000)});
export const saveSocialPostSchema=z.strictObject({postId:uuid.optional(),expectedRevision:z.number().int().nonnegative().optional(),accountId:uuid,text:z.string().trim().min(1).max(10000),images:z.array(socialPostImageSchema).max(20),publishAt:z.string().datetime({offset:true}).nullable(),zone:z.string().min(1).max(80).refine(v=>{try{new Intl.DateTimeFormat('en-US',{timeZone:v});return true;}catch{return false;}},'IANA timezone required')}).refine(v=>v.postId===undefined?v.expectedRevision===undefined:v.expectedRevision!==undefined,'Existing post needs revision');
export type SaveSocialPost=z.infer<typeof saveSocialPostSchema>;
export const socialPostRevisionSchema=z.strictObject({postId:uuid,revision:z.number().int().positive(),accountId:uuid,text:z.string(),images:z.array(socialPostImageSchema),publishAt:z.string().nullable(),zone:z.string(),state:socialPostStateSchema,reason:z.string().nullable()});
export type PostRevision=z.infer<typeof socialPostRevisionSchema>;
export const socialPostSaveCommandSchema=saveSocialPostSchema.safeExtend({commandId:commandIdSchema,clientVersion:semanticVersionSchema});
export const socialPostActionCommandSchema=z.strictObject({postId:uuid,expectedRevision:z.number().int().positive(),commandId:commandIdSchema,clientVersion:semanticVersionSchema});
export const socialDeliveryHoldReasonSchema=z.enum(['schedule_missed','account_identity_changed','account_not_verified','adapter_unavailable','approved_image_changed','staging_failed','preparation_unavailable','claim_expired']);
export const socialDeliveryHoldCommandSchema=socialPostActionCommandSchema.extend({reason:socialDeliveryHoldReasonSchema});
export const socialBeginCommandSchema=z.strictObject({claimId:uuid,approvalId:uuid,fingerprint:z.string().regex(/^[a-f0-9]{64}$/u),commandId:commandIdSchema,clientVersion:semanticVersionSchema});
/** Original submission's approved-byte to native-media mapping, never inferred on restart. */
export const socialMediaBindingSchema=z.strictObject({receiptId:z.string().min(1).max(500),fingerprint:z.string().regex(/^[a-f0-9]{64}$/u),images:z.array(z.strictObject({sha256:z.string().regex(/^[a-f0-9]{64}$/u),platformId:z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u)})).min(1).max(20)}).refine(v=>new Set(v.images.map(i=>i.platformId)).size===v.images.length,'Duplicate native media');
export type SocialMediaBinding=z.infer<typeof socialMediaBindingSchema>;
export const socialInspectionSchema=z.strictObject({state:z.enum(['scheduled','published','cancelled','absent','unknown']),receiptId:z.string().min(1).max(500).nullable(),permalink:z.string().url().max(2048).nullable(),observedAt:z.string().datetime({offset:true}),accountExternalId:z.string().max(300).nullable(),observedFingerprint:z.string().regex(/^[a-f0-9]{64}$/u).nullable(),complete:z.boolean(),mediaBinding:socialMediaBindingSchema.nullable().optional()});
export const socialObservationCommandSchema=z.strictObject({submissionId:uuid,observation:socialInspectionSchema,commandId:commandIdSchema,clientVersion:semanticVersionSchema});
export const socialAccountViewSchema=z.strictObject({id:uuid,platform:socialPlatformSchema,displayName:z.string(),externalId:z.string(),accountKind:z.enum(['profile','page']),state:z.enum(['connected','reconnect','unsupported','disconnected']),adapterVersion:z.string().nullable(),verifiedAt:z.string().nullable()});
export const socialWorkspaceSchema=z.strictObject({accounts:z.array(socialAccountViewSchema),posts:z.array(socialPostRevisionSchema)});
export type SocialWorkspace=z.infer<typeof socialWorkspaceSchema>;
export const socialPostMutationSchema=z.discriminatedUnion('action',[
 saveSocialPostSchema.safeExtend({action:z.literal('save'),commandId:commandIdSchema}),
 z.strictObject({action:z.literal('approve'),postId:uuid,expectedRevision:z.number().int().positive(),commandId:commandIdSchema}),
 z.strictObject({action:z.literal('cancel'),postId:uuid,expectedRevision:z.number().int().positive(),commandId:commandIdSchema}),
]);
export type SocialPostMutation=z.infer<typeof socialPostMutationSchema>;

export const socialAssetViewSchema = z.strictObject({
 id: uuid,
 state: z.enum(['uploading', 'ready', 'deleted']),
 version: z.number().int().nonnegative(),
 origin: socialAssetOriginSchema,
 objects: z.array(z.strictObject({
  version: z.number().int().nonnegative(),
  kind: z.enum(['original', 'derivative']),
  state: z.enum(['uploading', 'ready', 'deleted']),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  bytes: z.number().int().positive(),
  mime: z.string().max(100),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
 })),
});
export const socialAssetLibrarySchema = z.strictObject({assets: z.array(socialAssetViewSchema)});
export const socialConnectionSchema=z.strictObject({accountId:uuid,platform:socialPlatformSchema,externalId:z.string().trim().min(1).max(300),displayName:z.string().trim().min(1).max(200),accountKind:z.enum(['profile','page'])});
export type SocialConnection=z.infer<typeof socialConnectionSchema>;
export const socialConnectionCommandSchema=socialConnectionSchema.extend({commandId:commandIdSchema,clientVersion:semanticVersionSchema});
export const socialDisconnectCommandSchema=z.strictObject({accountId:uuid,commandId:commandIdSchema,clientVersion:semanticVersionSchema});
/** Call IDs name immutable call transcripts (revision 1); meeting IDs name a
 * versioned meeting transcript; public IDs name sourcing candidate revisions. */
export const socialDraftRequestSchema=z.strictObject({sourceRefs:z.array(z.strictObject({kind:z.enum(['call','meeting','public']),id:uuid,revision:z.number().int().positive()})).min(1).max(10),factBlocks:z.array(z.strictObject({id:uuid,version:z.number().int().positive()})).max(20)});
export type SocialDraftRequest=z.infer<typeof socialDraftRequestSchema>;
export const socialDraftRequestCommandSchema=socialDraftRequestSchema.extend({commandId:commandIdSchema,clientVersion:semanticVersionSchema});
export const socialDraftConceptSchema=z.strictObject({theme:z.enum(['after_hours','small_team','manual_entry','vendor_follow_up','tenant_phone','maintenance_coordination']),factRefs:z.array(z.strictObject({id:uuid,version:z.number().int().positive()})).max(20),variants:z.array(z.strictObject({platform:socialPlatformSchema,text:z.string().min(1).max(3000)})).length(3)});
export const socialDraftViewSchema=z.strictObject({id:uuid,state:z.enum(['queued','calling','ready','review','expired']),sourceRefs:socialDraftRequestSchema.shape.sourceRefs,factBlocks:socialDraftRequestSchema.shape.factBlocks,concepts:z.array(socialDraftConceptSchema).max(3).nullable(),reason:z.string().nullable(),createdAt:z.string().datetime(),deadlineAt:z.string().datetime()});
export const socialDraftWorkspaceSchema=z.strictObject({sources:z.array(z.strictObject({kind:z.enum(['call','meeting','public']),id:uuid,revision:z.number().int().positive(),label:z.string(),observedAt:z.string().datetime()})).max(60),facts:z.array(z.strictObject({id:uuid,version:z.number().int().positive(),text:z.string()})).max(20),requests:z.array(socialDraftViewSchema).max(20)});
export type SocialDraftWorkspace=z.infer<typeof socialDraftWorkspaceSchema>;
export type SocialDraftView=z.infer<typeof socialDraftViewSchema>;
export const socialWeeklySchema=z.strictObject({enabled:z.boolean(),revision:z.number().int().nonnegative(),nextAt:z.string().datetime().nullable(),lastAt:z.string().datetime().nullable(),lastResult:z.enum(['queued','no_new_sources','sources_unavailable','requests_pending']).nullable()});
export type SocialWeekly=z.infer<typeof socialWeeklySchema>;
export const socialWeeklySaveSchema=z.strictObject({enabled:z.boolean(),expectedRevision:z.number().int().nonnegative()});
export const socialWeeklyCommandSchema=socialWeeklySaveSchema.extend({commandId:commandIdSchema,clientVersion:semanticVersionSchema});
/** Immutable approved bytes/metadata, never storage keys or local file paths. */
export const socialApprovalSnapshotSchema=z.strictObject({
 account:z.strictObject({id:uuid,platform:socialPlatformSchema,externalId:z.string().max(300),revision:z.number().int().positive(),adapterVersion:z.string()}),
 text:z.string().max(10000),images:z.array(socialPostImageSchema.extend({sha256:z.string().regex(/^[a-f0-9]{64}$/u),mime:z.string(),width:z.number().int().positive().nullable(),height:z.number().int().positive().nullable()})).max(20),
 publishAt:z.string().datetime(),zone:z.string(),
});
export const socialDeliveryQueueSchema=z.strictObject({items:z.array(z.strictObject({
 deliveryId:uuid,postId:uuid,revision:z.number().int().positive(),action:z.enum(['submit','inspect','cancel']),
 submissionId:uuid.nullable(),receiptId:z.string().nullable(),mediaBinding:socialMediaBindingSchema.nullable().optional(),fingerprint:z.string().regex(/^[a-f0-9]{64}$/u),snapshot:socialApprovalSnapshotSchema,
})).max(25)});
export type SocialDeliveryQueue=z.infer<typeof socialDeliveryQueueSchema>;

/** Version of the built-in native LinkedIn scheduler. Other destinations remain unavailable. */
export const LINKEDIN_ADAPTER_VERSION='linkedin-native-v1';

import {z} from 'zod';
import {socialPublisherBindingSchema} from './socialPublisher.ts';
import {commandIdSchema} from './auth.ts';
import {semanticVersionSchema} from './clientVersion.ts';
const command={commandId:commandIdSchema,clientVersion:semanticVersionSchema};
export const socialStandingRefSchema=z.object({planId:z.uuid(),revision:z.number().int().positive(),slotId:z.uuid()}).strict();
export type SocialStandingRef=z.infer<typeof socialStandingRefSchema>;
const guide=z.object({guideId:z.uuid(),revision:z.number().int().positive()}).strict().nullable();
export const socialStandingPlanSaveSchema=z.object({expectedRevision:z.number().int().nonnegative(),binding:socialPublisherBindingSchema,guideRef:guide,calibrationId:z.uuid(),inputIds:z.array(z.uuid()).min(1).max(30),mediaScope:z.enum(['none','approved_pool']),timezone:z.string().min(1).max(64),cadence:z.array(z.object({weekday:z.number().int().min(1).max(7),time:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)}).strict()).length(3),scheduledGenerationGrant:z.literal('bedrock_haiku_founder_scheduled_v1'),publicationGrant:z.literal('linkedin_personal_standing_v1'),cancelRemoteOnPause:z.boolean()}).strict();
export type SocialStandingPlanSave=z.infer<typeof socialStandingPlanSaveSchema>;
export const socialStandingCommandSchema=z.discriminatedUnion('operation',[
 z.object({operation:z.literal('save'),plan:socialStandingPlanSaveSchema,...command}).strict(),
 z.object({operation:z.literal('pause'),planId:z.uuid(),expectedRevision:z.number().int().positive(),...command}).strict(),
 z.object({operation:z.literal('skip'),slotId:z.uuid(),expectedRevision:z.number().int().positive(),...command}).strict(),
 z.object({operation:z.literal('edit'),slotId:z.uuid(),expectedRevision:z.number().int().positive(),text:z.string().trim().min(1).max(3000),...command}).strict(),
]);
export interface SocialStandingPlanView {planId:string;revision:number;state:'active'|'paused';configuration:SocialStandingPlanSave}
export interface SocialStandingActivityItem {slotId:string;revision:number;publishAt:string|null;localTarget:string|null;localWeek:string;state:string;reason:string|null;text:string|null;permalink:string|null;inputRefs:{inputId:string;revision:number}[];image:null|{assetId:string;version:number;sha256:string;altText:string;approvalRevision:number;mime:'image/jpeg'|'image/png'}}
export interface SocialStandingActivity {items:SocialStandingActivityItem[];remainingThisWeek:number}
export const socialStandingReceiptInputSchema=z.object({commandId:commandIdSchema,payloadSHA256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const socialStandingPlanReadSchema=z.object({plan:z.object({planId:z.uuid(),revision:z.number().int().positive(),state:z.enum(['active','paused']),configuration:socialStandingPlanSaveSchema}).strict().nullable()}).strict();
export const socialStandingOptionsSchema=z.object({binding:socialPublisherBindingSchema.nullable(),intendedAccountId:z.uuid().nullable(),calibrationId:z.uuid().nullable(),guideRef:guide,inputIds:z.array(z.uuid()).max(30)}).strict();
export const socialStandingActivitySchema=z.object({items:z.array(z.object({slotId:z.uuid(),revision:z.number().int().positive(),publishAt:z.iso.datetime().nullable(),localTarget:z.string().nullable(),localWeek:z.iso.date(),state:z.enum(['preparing','queued','skipped','held','submitting','scheduled','published','cancellation_pending','cancelled','failed_known_not_submitted','unknown']),reason:z.string().nullable(),text:z.string().nullable(),permalink:z.string().url().nullable(),inputRefs:z.array(z.object({inputId:z.uuid(),revision:z.number().int().positive()}).strict()),image:z.object({assetId:z.uuid(),version:z.number().int().positive(),sha256:z.string(),altText:z.string(),approvalRevision:z.number().int().positive(),mime:z.enum(['image/jpeg','image/png'])}).strict().nullable()}).strict()).max(60),remainingThisWeek:z.number().int().min(0).max(3)}).strict();

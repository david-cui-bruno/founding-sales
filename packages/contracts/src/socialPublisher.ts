import {z} from 'zod';
export const SOCIAL_PUBLISHER_ADAPTER='buffer-linkedin-v1' as const;
const bufferId=z.string().regex(/^[a-fA-F0-9]{24}$/u);
const externalId=z.string().min(1).max(300);
export const socialPublisherBindingSchema=z.object({adapter:z.literal(SOCIAL_PUBLISHER_ADAPTER),workspaceId:z.uuid(),ownerUserId:z.uuid(),accountId:z.uuid(),accountRevision:z.number().int().positive(),credentialId:z.uuid(),credentialRevision:z.number().int().positive(),organizationId:bufferId,channelId:bufferId,externalId}).strict();
export type SocialPublisherBinding=z.infer<typeof socialPublisherBindingSchema>;
export const socialPublisherConnectionInputSchema=z.discriminatedUnion('operation',[
 z.object({operation:z.literal('discover'),apiKey:z.string().min(1).max(4096)}).strict(),
 z.object({operation:z.literal('connect'),accountId:z.uuid(),apiKey:z.string().min(1).max(4096),organizationId:bufferId,channelId:bufferId}).strict(),
 z.object({operation:z.literal('disconnect'),accountId:z.uuid()}).strict(),
]);
export type SocialPublisherConnectionInput=z.infer<typeof socialPublisherConnectionInputSchema>;
export const socialPublisherChannelSchema=z.object({organizationId:bufferId,channelId:bufferId,externalId,displayName:z.string().max(200),profileUrl:z.string().url().max(2048).nullable()}).strict();
export type SocialPublisherChannel=z.infer<typeof socialPublisherChannelSchema>;
export const socialPublisherConnectionResultSchema=z.discriminatedUnion('state',[
 z.object({state:z.literal('channels'),channels:z.array(socialPublisherChannelSchema).max(100)}).strict(),
 z.object({state:z.literal('connected'),accountId:z.uuid(),revision:z.number().int().positive(),externalId,displayName:z.string().max(200)}).strict(),
 z.object({state:z.literal('closed')}).strict(),
]);
export type SocialPublisherConnectionResult=z.infer<typeof socialPublisherConnectionResultSchema>;
export interface SocialPublisherAttempt {
 binding:SocialPublisherBinding;attemptId:string;fingerprint:string;text:string|null;textSHA256?:string;publishAt:string;submittedAt:string|null;mediaReceiptId:string|null;
 image:null|{mime:'image/jpeg'|'image/png';sha256:string;altText:string;byteLength:number};
}
/** No private prose, credentials, URLs or image bytes in durable observations. */
export interface SocialPublisherObservation {
 state:'scheduled'|'published'|'cancelled'|'unknown'|'rejected';receiptId:string|null;mediaReceiptId:string|null;permalink:string|null;
 observedAt:string;accountExternalId:string|null;fingerprint:string;imageCount:number;mediaMatched:boolean;
 reason:'matched'|'credential_unavailable'|'credential_revoked'|'account_mismatch'|'readback_incomplete'|'cancel_race'|'remote_unavailable'|'provider_rejected'|'queue_paused'|'channel_unavailable';
}
export interface SocialPublisherPrepared {attemptId:string;fingerprint:string;expiresAt:string}
export interface SocialPublisherPort {
 verify(binding:SocialPublisherBinding):Promise<{usable:boolean;externalId:string|null;adapter:typeof SOCIAL_PUBLISHER_ADAPTER;reason:null|'credential_revoked'|'unavailable'}>;
 prepare(attempt:SocialPublisherAttempt,authority:()=>Promise<void>):Promise<SocialPublisherPrepared>;
 /** Commit the immutable attempt BEFORE the first possible create request. */
 submit(attempt:SocialPublisherAttempt,authority:()=>Promise<void>,durableMarker:()=>Promise<boolean>):Promise<SocialPublisherObservation>;
 inspect(attempt:SocialPublisherAttempt,receiptId:string|null,authority:()=>Promise<void>):Promise<SocialPublisherObservation>;
 cancel(attempt:SocialPublisherAttempt,receiptId:string,authority:()=>Promise<void>):Promise<SocialPublisherObservation>;
}

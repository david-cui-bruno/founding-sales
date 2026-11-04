import {z} from 'zod';

export const SOCIAL_BROWSER_ADAPTER='linkedin-web-chromium-v1' as const;
export const socialPublisherBindingSchema=z.object({workspaceId:z.uuid(),ownerUserId:z.uuid(),accountId:z.uuid(),accountRevision:z.number().int().positive(),sessionId:z.uuid(),sessionRevision:z.number().int().positive(),externalId:z.string().url().max(300)}).strict();
export type SocialPublisherBinding=z.infer<typeof socialPublisherBindingSchema>;
export const socialPublisherConnectionInputSchema=z.discriminatedUnion('operation',[
 z.object({operation:z.literal('start'),accountId:z.uuid()}).strict(),
 z.object({operation:z.literal('frame'),connectionId:z.uuid()}).strict(),
 z.object({operation:z.literal('input'),connectionId:z.uuid(),event:z.discriminatedUnion('kind',[
  z.object({kind:z.literal('click'),x:z.number().int().min(0).max(1279),y:z.number().int().min(0).max(899)}).strict(),
  z.object({kind:z.literal('text'),text:z.string().min(1).max(2000)}).strict(),
  z.object({kind:z.literal('key'),key:z.enum(['Enter','Tab','Backspace','Escape','ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Control+A','Meta+A'])}).strict(),
  z.object({kind:z.literal('scroll'),deltaY:z.number().int().min(-900).max(900)}).strict(),
 ])}).strict(),
 z.object({operation:z.literal('complete'),connectionId:z.uuid()}).strict(),
 z.object({operation:z.literal('abort'),connectionId:z.uuid()}).strict(),
 z.object({operation:z.literal('disconnect'),accountId:z.uuid()}).strict(),
]);
export type SocialPublisherConnectionInput=z.infer<typeof socialPublisherConnectionInputSchema>;
export const socialPublisherConnectionResultSchema=z.discriminatedUnion('state',[
 z.object({state:z.literal('connecting'),connectionId:z.uuid(),expiresAt:z.iso.datetime()}).strict(),
 z.object({state:z.literal('frame'),connectionId:z.uuid(),image:z.string().min(4).max(600000).regex(/^[A-Za-z0-9+/]+={0,2}$/u).refine(value=>value.length%4===0),width:z.literal(1280),height:z.literal(900)}).strict(),
 z.object({state:z.literal('connected'),accountId:z.uuid(),revision:z.number().int().positive(),externalId:z.string().url(),displayName:z.string().max(200)}).strict(),
 z.object({state:z.literal('closed')}).strict(),
]);
export type SocialPublisherConnectionResult=z.infer<typeof socialPublisherConnectionResultSchema>;
export interface SocialPublisherAttempt {
 binding:SocialPublisherBinding;attemptId:string;fingerprint:string;text:string|null;textSHA256?:string;publishAt:string;
 image:null|{bytes?:Uint8Array;mime:'image/jpeg'|'image/png';sha256:string;altText:string};
}
/** No private prose, browser state or image bytes in observations or durable receipts. */
export interface SocialPublisherObservation {
 state:'scheduled'|'published'|'cancelled'|'unknown';receiptId:string|null;permalink:string|null;
 observedAt:string;accountExternalId:string|null;fingerprint:string;imageCount:number;loadedPreview:boolean;
 reason:'matched'|'session_unavailable'|'account_mismatch'|'readback_incomplete'|'cancel_race'|'remote_unavailable';
}
export interface SocialPublisherPrepared {attemptId:string;fingerprint:string;expiresAt:string}
export interface SocialPublisherPort {
 verify(binding:SocialPublisherBinding):Promise<{usable:boolean;externalId:string|null;adapter:typeof SOCIAL_BROWSER_ADAPTER}>;
 prepare(attempt:SocialPublisherAttempt,authority:()=>Promise<void>):Promise<SocialPublisherPrepared>;
 /** durableMarker must commit the immutable attempt BEFORE the first possible final click. */
 submit(attempt:SocialPublisherAttempt,authority:()=>Promise<void>,durableMarker:()=>Promise<boolean>):Promise<SocialPublisherObservation>;
 inspect(attempt:SocialPublisherAttempt,receiptId:string|null,authority:()=>Promise<void>):Promise<SocialPublisherObservation>;
 cancel(attempt:SocialPublisherAttempt,receiptId:string,authority:()=>Promise<void>):Promise<SocialPublisherObservation>;
}

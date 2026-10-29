import {z} from 'zod';
import {instant,uuid} from './foundationRows.ts';

export const SOCIAL_PUBLIC_THREAD_MAX_BYTES=64000;
export const socialPublicThreadUrlSchema=z.string().regex(/^https:\/\/www\.linkedin\.com\/feed\/update\/urn:li:activity:[0-9]{1,40}\/$/u);
const sourceId=z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/u);
const hash=z.string().regex(/^[a-f0-9]{64}$/u);
const bytes=(value:string)=>new TextEncoder().encode(value).byteLength;
export const socialPublicThreadMessageSchema=z.strictObject({
 messageId:sourceId,
 parent:z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('root')}),
  z.strictObject({kind:z.literal('retained'),messageId:sourceId}),
  z.strictObject({kind:z.literal('unavailable'),messageId:sourceId.nullable()}),
 ]),
 author:z.discriminatedUnion('status',[
  z.strictObject({status:z.literal('known'),displayName:z.string().trim().min(1).max(200)}),
  z.strictObject({status:z.literal('unknown')}),
 ]),
 publishedAt:z.discriminatedUnion('status',[
  z.strictObject({status:z.literal('known'),at:instant}),z.strictObject({status:z.literal('unknown')}),
 ]),
 text:z.string().min(1).max(2000).refine(value=>value.trim().length>0&&bytes(value)<=8000,'Bounded nonblank text required'),
 textSHA256:hash,textCoverage:z.enum(['complete','truncated','unknown']),
 locator:z.strictObject({threadUrl:socialPublicThreadUrlSchema,messageId:sourceId}),
});
export const socialPublicThreadSnapshotSchema=z.strictObject({
 platform:z.literal('linkedin'),visibility:z.literal('public_web'),url:socialPublicThreadUrlSchema,
 coverage:z.enum(['partial','unknown']),messages:z.array(socialPublicThreadMessageSchema).min(1).max(50),
}).superRefine((snapshot,ctx)=>{
 const prior=new Set<string>();
 for(const [index,message] of snapshot.messages.entries()){
  if(prior.has(message.messageId))ctx.addIssue({code:'custom',path:['messages',index,'messageId'],message:'Duplicate source message identity'});
  if(message.parent.kind==='retained'&&!prior.has(message.parent.messageId))ctx.addIssue({code:'custom',path:['messages',index,'parent'],message:'Retained parent must appear earlier'});
  if(message.locator.threadUrl!==snapshot.url||message.locator.messageId!==message.messageId)ctx.addIssue({code:'custom',path:['messages',index,'locator'],message:'Locator must match this thread and source message'});
  prior.add(message.messageId);
 }
 if(bytes(JSON.stringify(snapshot))>SOCIAL_PUBLIC_THREAD_MAX_BYTES)ctx.addIssue({code:'custom',message:'Snapshot exceeds byte limit'});
});
/** Internal retention owner input only. No acquisition or HTTP writer is defined. */
export const socialPublicThreadRetainInputSchema=z.strictObject({threadId:uuid,capturedAt:instant,
 sourceExpiresAt:instant.nullable(),snapshot:socialPublicThreadSnapshotSchema});
export const socialPublicThreadListInputSchema=z.strictObject({afterId:uuid.optional()});
export const socialPublicThreadReadInputSchema=z.strictObject({threadId:uuid,expectedRevision:z.number().int().positive()});
const base={threadId:uuid,revision:z.number().int().positive(),capturedAt:instant,expiresAt:instant};
export const socialPublicThreadMetadataSchema=z.discriminatedUnion('availability',[
 z.strictObject({...base,availability:z.literal('available'),coverage:z.enum(['partial','unknown']),messageCount:z.number().int().min(1).max(50)}),
 z.strictObject({...base,availability:z.literal('unavailable'),reason:z.enum(['expired','removed','revision_changed'])}),
]);
export const socialPublicThreadListSchema=z.strictObject({threads:z.array(socialPublicThreadMetadataSchema).max(20),nextAfterId:uuid.nullable()});
export const socialPublicThreadViewSchema=z.discriminatedUnion('availability',[
 z.strictObject({...base,availability:z.literal('available'),snapshot:socialPublicThreadSnapshotSchema}),
 z.strictObject({...base,availability:z.literal('unavailable'),reason:z.enum(['expired','removed','revision_changed'])}),
]);
export const socialPublicThreadReadSchema=z.strictObject({thread:socialPublicThreadViewSchema});
export type SocialPublicThreadSnapshot=z.infer<typeof socialPublicThreadSnapshotSchema>;
export type SocialPublicThreadRetainInput=z.infer<typeof socialPublicThreadRetainInputSchema>;
export type SocialPublicThreadMetadata=z.infer<typeof socialPublicThreadMetadataSchema>;
export type SocialPublicThreadList=z.infer<typeof socialPublicThreadListSchema>;
export type SocialPublicThreadView=z.infer<typeof socialPublicThreadViewSchema>;

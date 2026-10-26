import {z} from 'zod';
import {instant,uuid,socialGuidedRequestInputSchema,type SocialGuidedRequestInput} from '@fss/contracts';
import type {BrowserClient} from './BrowserClient.ts';
import {privateDraftCanonicalJson,privateDraftSHA256} from './PrivateDraftCustody.ts';
export const SOCIAL_GENERATION_PENDING_PREFIX='callie.browser.pending-social-generation.v1:';
export const socialGenerationPendingSchema=z.strictObject({identity:z.string().min(1),expiresAt:instant,commandId:uuid,payloadSHA256:z.string().regex(/^[a-f0-9]{64}$/u)});
export type SocialGenerationPending=z.infer<typeof socialGenerationPendingSchema>;
export type SocialGenerationStorage=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
const browserStorage:SocialGenerationStorage={getItem:key=>globalThis.localStorage.getItem(key),setItem:(key,value)=>globalThis.localStorage.setItem(key,value),removeItem:key=>globalThis.localStorage.removeItem(key)};
/** Stable principal key survives role/revision changes. A mismatched/expired
 * binding holds replacement rather than treating uncertain work as absent. */
export class SocialGenerationCustody{
 constructor(private readonly client:BrowserClient,private readonly storage:SocialGenerationStorage=browserStorage){}
 binding():{key:string;identity:string;expiresAt:string}|null{
  const s=this.client.current;if(s?.status!=='signed_in'||!this.client.isCurrent(this.client.epoch))return null;
  return {key:SOCIAL_GENERATION_PENDING_PREFIX+JSON.stringify([s.workspaceId,s.userId,s.deviceId]),identity:JSON.stringify([s.workspaceId,s.userId,s.deviceId,s.role,s.revision]),expiresAt:s.expiresAt};
 }
 read():SocialGenerationPending|null{
  const binding=this.binding();if(!binding)return null;
  if(!globalThis.navigator?.locks)throw Error('Social generation lock unavailable');
  const raw=this.storage.getItem(binding.key);if(raw===null)return null;
  const held=socialGenerationPendingSchema.parse(JSON.parse(raw));
  if(held.identity!==binding.identity||Date.parse(held.expiresAt)<=Date.now()||Date.parse(held.expiresAt)>Date.parse(binding.expiresAt))throw Error('Social generation custody requires original current binding');
  return held;
 }
 async exclusive<T>(work:()=>Promise<T>):Promise<T>{
  const binding=this.binding();if(!binding||!globalThis.navigator?.locks)throw Error('Social generation lock unavailable');
  return navigator.locks.request(binding.key,{mode:'exclusive'},async()=>{
   if(this.binding()?.identity!==binding.identity)throw Error('Social authority changed');
   return work();
  });
 }
 async prepare(raw:SocialGuidedRequestInput,current:()=>boolean):Promise<{held:SocialGenerationPending;payload:SocialGuidedRequestInput}>{
  const payload=socialGuidedRequestInputSchema.parse(raw),binding=this.binding();
  if(!binding||!current()||this.read())throw Error('Reconcile Social generation first');
  const payloadSHA256=await privateDraftSHA256(privateDraftCanonicalJson(payload));
  if(!current()||this.binding()?.identity!==binding.identity||this.read())throw Error('Social generation authority changed');
  const held=socialGenerationPendingSchema.parse({identity:binding.identity,expiresAt:binding.expiresAt,commandId:crypto.randomUUID(),payloadSHA256});
  const bytes=JSON.stringify(held);this.storage.setItem(binding.key,bytes);
  if(this.storage.getItem(binding.key)!==bytes)throw Error('Social generation storage unavailable');
  return {held,payload};
 }
 assert(held:SocialGenerationPending):void{if(JSON.stringify(this.read())!==JSON.stringify(held))throw Error('Social generation custody changed');}
 complete(held:SocialGenerationPending):void{
  this.assert(held);const binding=this.binding();if(!binding)throw Error('Social authority unavailable');
  this.storage.removeItem(binding.key);if(this.storage.getItem(binding.key)!==null)throw Error('Social generation storage unavailable');
 }
}
/** App-lifetime observation only. Never remove uncertain custody on navigation,
 * logout, expiry or another identity's login, and never replay/poll a request. */
export function installSocialGenerationCustody(client:BrowserClient,storage?:SocialGenerationStorage):()=>void{
 const custody=new SocialGenerationCustody(client,storage);
 const observe=():void=>{try{custody.read();}catch{/* UI must explicitly reconcile or fail closed. */}};
 observe();return client.subscribe(observe);
}

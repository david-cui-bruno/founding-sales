import {z} from 'zod';
import {uuid,instant} from '@fss/contracts';
import type {BrowserClient} from './BrowserClient.ts';
export const SOCIAL_FACTS_PENDING_PREFIX='callie.browser.pending-social-facts.v1:';
const markerSchema=z.strictObject({identity:z.string().min(1),expiresAt:instant,commandId:uuid,action:z.enum(['fact_save','fact_approve','fact_retire'])});
export type SocialFactMarker=z.infer<typeof markerSchema>;
type StoragePort=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
const storage:StoragePort={getItem:key=>localStorage.getItem(key),setItem:(key,value)=>localStorage.setItem(key,value),removeItem:key=>localStorage.removeItem(key)};
/** Custody contains no prose. An unknown write is never replayed or silently replaced,
 * including after remount, another tab, revision change or session expiration. */
export class BrowserSocialFactsCustody{
 constructor(private readonly client:BrowserClient,private readonly port:StoragePort=storage){}
 binding():{key:string;identity:string;expiresAt:string}|null{
  const s=this.client.current;if(s?.status!=='signed_in'||s.role!=='admin'||!this.client.isCurrent(this.client.epoch))return null;
  return {key:SOCIAL_FACTS_PENDING_PREFIX+JSON.stringify([s.workspaceId,s.userId,s.deviceId]),identity:JSON.stringify([s.workspaceId,s.userId,s.deviceId,s.role,s.revision]),expiresAt:s.expiresAt};
 }
 read():SocialFactMarker|null{
  const b=this.binding();if(!b)throw Error('Current admin required');
  if(!navigator.locks)throw Error('Fact lock unavailable');
  const raw=this.port.getItem(b.key);if(raw===null)return null;
  const marker=markerSchema.parse(JSON.parse(raw));
  if(marker.identity!==b.identity||Date.parse(marker.expiresAt)<=Date.now()||Date.parse(marker.expiresAt)>Date.parse(b.expiresAt))throw Error('Original fact authority required');
  return marker;
 }
 async exclusive<T>(work:()=>Promise<T>):Promise<T>{
  const b=this.binding();if(!b||!navigator.locks)throw Error('Fact lock unavailable');
  return navigator.locks.request(b.key,{mode:'exclusive'},()=>{if(this.binding()?.identity!==b.identity)throw Error('Fact authority changed');return work();});
 }
 prepare(action:SocialFactMarker['action'],commandId:string):SocialFactMarker{
  const b=this.binding();if(!b||this.read())throw Error('Unknown fact write held');
  const marker=markerSchema.parse({identity:b.identity,expiresAt:b.expiresAt,commandId,action}),bytes=JSON.stringify(marker);
  this.port.setItem(b.key,bytes);if(this.port.getItem(b.key)!==bytes)throw Error('Fact custody unavailable');
  return marker;
 }
 assert(marker:SocialFactMarker):void{if(JSON.stringify(this.read())!==JSON.stringify(marker))throw Error('Fact custody changed');}
 complete(marker:SocialFactMarker):void{
  this.assert(marker);const b=this.binding();if(!b)throw Error('Fact authority unavailable');
  this.port.removeItem(b.key);if(this.port.getItem(b.key)!==null)throw Error('Fact custody unavailable');
 }
}

import {z} from 'zod';
import {uuid,instant} from '@fss/contracts';
import type {BrowserClient} from './BrowserClient.ts';
import {privateDraftCanonicalJson,privateDraftSHA256} from './PrivateDraftCustody.ts';
export const socialOpaquePendingSchema=z.strictObject({identity:z.string(),expiresAt:instant,commandId:uuid,kind:z.string().regex(/^[a-z_]{1,40}$/u),payloadSHA256:z.string().regex(/^[a-f0-9]{64}$/u)});
export type SocialOpaquePending=z.infer<typeof socialOpaquePendingSchema>;
/** Current identity and an opaque receipt pointer only; never a replayable prose payload. */
export class SocialCommandCustody{
 constructor(private readonly client:BrowserClient,private readonly key:string,private readonly storage:Pick<Storage,'getItem'|'setItem'|'removeItem'>=localStorage){}
 private binding(){const s=this.client.current;return s?.status==='signed_in'&&this.client.isCurrent(this.client.epoch)?{identity:JSON.stringify([s.workspaceId,s.userId,s.deviceId,s.role,s.revision]),expiresAt:s.expiresAt}:null;}
 clear():void{try{this.storage.removeItem(this.key);}catch{/* A stale binding cannot dispatch. */}}
 read():SocialOpaquePending|null{
  const binding=this.binding();if(!binding)return null;
  const raw=this.storage.getItem(this.key);if(raw===null)return null;
  const parsed=socialOpaquePendingSchema.safeParse(JSON.parse(raw));
  if(!parsed.success)throw Error('Social custody unavailable');
  if(parsed.data.identity!==binding.identity||Date.parse(parsed.data.expiresAt)<=Date.now()||Date.parse(parsed.data.expiresAt)>Date.parse(binding.expiresAt)){this.clear();return null;}
  return parsed.data;
 }
 async exclusive<T>(work:()=>Promise<T>):Promise<T>{
  const binding=this.binding(),epoch=this.client.epoch;
  if(!binding||!navigator.locks)throw Error('Social command custody unavailable');
  return navigator.locks.request(`callie.social:${this.key}:${binding.identity}`,{mode:'exclusive'},async()=>{
   if(!this.client.isCurrent(epoch)||this.binding()?.identity!==binding.identity)throw Error('Social authority changed');
   return work();
  });
 }
 async prepare(kind:string,payload:unknown,current:()=>void):Promise<SocialOpaquePending>{
  const binding=this.binding(),epoch=this.client.epoch;if(!binding||this.read())throw Error('Reconcile pending Social command');
  current();
  const payloadSHA256=await privateDraftSHA256(privateDraftCanonicalJson(payload));
  current();
  if(!this.client.isCurrent(epoch)||this.binding()?.identity!==binding.identity||this.read())throw Error('Social authority changed');
  const held=socialOpaquePendingSchema.parse({...binding,commandId:crypto.randomUUID(),kind,payloadSHA256});
  const raw=JSON.stringify(held);this.storage.setItem(this.key,raw);if(this.storage.getItem(this.key)!==raw)throw Error('Social custody unavailable');return held;
 }
 assert(held:SocialOpaquePending):void{if(JSON.stringify(this.read())!==JSON.stringify(held))throw Error('Social custody changed');}
 complete(held:SocialOpaquePending):void{this.assert(held);this.storage.removeItem(this.key);if(this.storage.getItem(this.key)!==null)throw Error('Social custody unavailable');}
}

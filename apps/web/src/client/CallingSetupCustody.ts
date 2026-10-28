import {z} from 'zod';
import {instant,uuid,callingSetupInputSchema,callingSetupAnswerSchema,callingSetupReceiptSchema,type CallingSetupInput,type CallingSetupReceipt,type CallingSetupSaved} from '@fss/contracts';
import type {BrowserClient} from './BrowserClient.ts';
import {privateDraftCanonicalJson,privateDraftSHA256} from './PrivateDraftCustody.ts';

export const CALLING_SETUP_PENDING_KEY='callie.browser.calling-setup.v1';
const pending=z.strictObject({identity:z.string().max(1024),expiresAt:instant,commandId:uuid,payloadSHA256:z.string().regex(/^[a-f0-9]{64}$/u),...callingSetupInputSchema.shape});
const records=z.array(pending).max(20).refine(values=>new Set(values.map(p=>p.identity)).size===values.length&&new Set(values.map(p=>p.commandId)).size===values.length);
type Pending=z.infer<typeof pending>;
type StoragePort=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
const registryLock='callie.calling-setup-records';
/** Opaque command custody shared across tabs. No transport error permits reminting. */
export class CallingSetupCustody{
 constructor(readonly client:BrowserClient,private readonly storage:StoragePort=globalThis.localStorage){}
 binding(){const s=this.client.current;return s?.status==='signed_in'&&s.role==='admin'&&this.client.isCurrent(this.client.epoch)?{identity:JSON.stringify([s.workspaceId,s.userId,s.deviceId,s.role,s.revision]),expiresAt:s.expiresAt}:null;}
 private stored():Pending[]{const raw=this.storage.getItem(CALLING_SETUP_PENDING_KEY);if(raw===null)return [];if(raw.length>32768)throw Error('Setup custody unavailable');return records.parse(JSON.parse(raw));}
 read():Pending|null{const binding=this.binding();return binding?this.stored().find(p=>p.identity===binding.identity&&Date.parse(p.expiresAt)>Date.now())??null:null;}
 private write(values:Pending[]):void{const bytes=JSON.stringify(records.parse(values));this.storage.setItem(CALLING_SETUP_PENDING_KEY,bytes);if(this.storage.getItem(CALLING_SETUP_PENDING_KEY)!==bytes)throw Error('Setup custody unavailable');}
 private async mutate<T>(current:()=>boolean,work:()=>T):Promise<T>{
  const binding=this.binding(),epoch=this.client.epoch;if(!binding||!current()||!navigator.locks)throw Error('Setup authority unavailable');
  return navigator.locks.request(registryLock,{mode:'exclusive'},()=>{if(!current()||!this.client.isCurrent(epoch)||this.binding()?.identity!==binding.identity)throw Error('Setup authority changed');return work();});
 }
 private async exclusive<T>(current:()=>boolean,work:()=>Promise<T>):Promise<T>{
  const binding=this.binding(),epoch=this.client.epoch;if(!binding||!navigator.locks)throw Error('Setup custody unavailable');
  return navigator.locks.request(`callie.calling-setup:${binding.identity}`,{mode:'exclusive'},()=>{if(!current()||!this.client.isCurrent(epoch)||this.binding()?.identity!==binding.identity)throw Error('Setup authority changed');return work();});
 }
 private assert(held:Pending):void{if(JSON.stringify(this.read())!==JSON.stringify(held))throw Error('Setup custody changed');}
 private async complete(held:Pending,current:()=>boolean){await this.mutate(current,()=>{this.assert(held);this.write(this.stored().filter(p=>p.commandId!==held.commandId));});}
 private acceptance(held:Pending,result:CallingSetupSaved):void{if(result.provider!==held.provider||result.version!==held.expectedVersion+1)throw Error('Setup receipt changed');}
 async change(raw:CallingSetupInput,current:()=>boolean):Promise<CallingSetupReceipt>{
  const payload=callingSetupInputSchema.parse(raw);
  return this.exclusive(current,async()=>{
   if(this.read())return {state:'unknown'};
   const binding=this.binding()!;
   const payloadSHA256=await privateDraftSHA256(privateDraftCanonicalJson(payload));
   const held=await this.mutate(current,()=>{if(this.read())throw Error('Reconcile pending setup');const value=pending.parse({...binding,...payload,payloadSHA256,commandId:crypto.randomUUID()});this.write([...this.stored().filter(p=>Date.parse(p.expiresAt)>Date.now()),value]);return value;});
   try{
    const answer=await this.client.request('/calling/setup/provider',callingSetupAnswerSchema,{...payload,commandId:held.commandId},()=>{if(!current())throw Error('Setup view changed');this.assert(held);});
    if(!current())return {state:'unknown'};
    if(answer.status==='accepted')this.acceptance(held,answer.result);
    await this.complete(held,current);
    return answer.status==='accepted'?{state:'accepted',result:answer.result}:{state:'refused',reason:answer.reason};
   }catch{return {state:'unknown'};}
  });
 }
 async recover(current:()=>boolean):Promise<CallingSetupReceipt>{
  return this.exclusive(current,async()=>{
   const held=this.read();if(!held)throw Error('No pending setup');
   const receipt=await this.client.request('/calling/setup/receipt',callingSetupReceiptSchema,{commandId:held.commandId,payloadSHA256:held.payloadSHA256},()=>{if(!current())throw Error('Setup view changed');this.assert(held);});
   if(!current())throw Error('Setup view changed');
   if(receipt.state==='accepted')this.acceptance(held,receipt.result);
   if(receipt.state!=='unknown')await this.complete(held,current);
   return receipt;
  });
 }
 async clear(identity:string):Promise<void>{try{if(navigator.locks)await navigator.locks.request(registryLock,{mode:'exclusive'},()=>{const values=this.stored().filter(p=>p.identity!==identity);if(values.length)this.write(values);else this.storage.removeItem(CALLING_SETUP_PENDING_KEY);});}catch{/* Invalid authority cannot consume custody. */}}
}
export function installCallingSetupCustody(client:BrowserClient,storage:StoragePort=globalThis.localStorage):()=>void{
 const custody=new CallingSetupCustody(client,storage);let identity=custody.binding()?.identity??null;
 return client.subscribe(()=>{const next=custody.binding()?.identity??null;if(identity!==null&&identity!==next)void custody.clear(identity);identity=next;});
}

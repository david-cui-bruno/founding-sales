import {z} from 'zod';
import {instant,uuid,createCallSessionCommandSchema,createAudioTestSessionCommandSchema} from '@fss/contracts';
import type {BrowserClient} from './BrowserClient.ts';
import {privateDraftCanonicalJson,privateDraftSHA256} from './PrivateDraftCustody.ts';
export const CALLING_EXECUTION_KEY='callie.browser.calling-execution.v1';
const registryLock='callie.calling-execution.registry';
const changed='callie-calling-execution-changed';
const common={identity:z.string().max(1024),expiresAt:instant,commandId:uuid,payloadSHA256:z.string().regex(/^[a-f0-9]{64}$/u),callingIdentityId:uuid,sessionId:uuid.optional()};
export const callingExecutionPendingSchema=z.discriminatedUnion('operation',[
 z.strictObject({...common,operation:z.literal('create_session'),firmId:uuid,routeId:uuid,routeVersion:z.number().int().positive(),contactId:uuid.optional()}),
 z.strictObject({...common,operation:z.literal('create_audio_test_session')}),
]);
export type CallingExecutionPending=z.infer<typeof callingExecutionPendingSchema>;
export type CallingBusinessPayload=Omit<z.infer<typeof createCallSessionCommandSchema>,'commandId'|'clientVersion'>;
export type CallingAudioTestPayload=Omit<z.infer<typeof createAudioTestSessionCommandSchema>,'commandId'|'clientVersion'>&{purpose:'audio_test'};
export type CallingExecutionPayload=CallingBusinessPayload|CallingAudioTestPayload;
export type ExecutionStorage=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
const records=z.array(callingExecutionPendingSchema).max(100).refine(value=>new Set(value.map(v=>v.identity)).size===value.length,'One execution per identity');
export class CallingExecutionCustody{
 constructor(readonly client:BrowserClient,private readonly storage:ExecutionStorage=globalThis.localStorage){}
 binding():{identity:string;expiresAt:string}|null{const s=this.client.current;return s?.status==='signed_in'&&this.client.isCurrent(this.client.epoch)?{identity:JSON.stringify([s.workspaceId,s.userId,s.deviceId,s.role,s.revision]),expiresAt:s.expiresAt}:null;}
 private stored():CallingExecutionPending[]{const raw=this.storage.getItem(CALLING_EXECUTION_KEY);if(raw===null)return [];if(raw.length>131072)throw Error('Execution custody unavailable');return records.parse(JSON.parse(raw));}
 read():CallingExecutionPending|null{const binding=this.binding();if(!binding)return null;return this.stored().find(p=>p.identity===binding.identity&&Date.parse(p.expiresAt)>Date.now()&&Date.parse(p.expiresAt)<=Date.parse(binding.expiresAt))??null;}
 private write(values:CallingExecutionPending[]):void{const bytes=JSON.stringify(records.parse(values));this.storage.setItem(CALLING_EXECUTION_KEY,bytes);if(this.storage.getItem(CALLING_EXECUTION_KEY)!==bytes)throw Error('Execution custody unavailable');globalThis.dispatchEvent?.(new Event(changed));}
 async lifecycle<T>(work:()=>Promise<T>):Promise<T>{
  const binding=this.binding(),epoch=this.client.epoch;if(!binding||!navigator.locks)throw Error('Execution locks unavailable');
  return navigator.locks.request(`callie.calling-execution:${binding.identity}`,{mode:'exclusive',ifAvailable:true},async lock=>{if(!lock||!this.client.isCurrent(epoch)||this.binding()?.identity!==binding.identity)throw Error('Another call is active or uncertain');return work();});
 }
 private async mutate<T>(current:()=>boolean,work:()=>T):Promise<T>{const binding=this.binding(),epoch=this.client.epoch;if(!binding||!current()||!navigator.locks)throw Error('Execution custody unavailable');return navigator.locks.request(registryLock,{mode:'exclusive'},()=>{if(!current()||!this.client.isCurrent(epoch)||this.binding()?.identity!==binding.identity)throw Error('Execution authority changed');return work();});}
 async prepare(raw:CallingExecutionPayload,current:()=>boolean):Promise<CallingExecutionPending>{
  const audio='purpose'in raw;
  const payload=audio?createAudioTestSessionCommandSchema.omit({commandId:true,clientVersion:true}).parse({e164:raw.e164,callingIdentityId:raw.callingIdentityId}):createCallSessionCommandSchema.omit({commandId:true,clientVersion:true}).parse(raw);
  const binding=this.binding();if(!binding||!current())throw Error('Execution authority changed');
  const payloadSHA256=await privateDraftSHA256(privateDraftCanonicalJson(payload));
  return this.mutate(current,()=>{if(this.read())throw Error('Reconcile existing execution');
   const storedPayload=audio?{operation:'create_audio_test_session',callingIdentityId:payload.callingIdentityId}:{operation:'create_session',...payload};
   const held=callingExecutionPendingSchema.parse({...binding,...storedPayload,commandId:crypto.randomUUID(),payloadSHA256});
   this.write([...this.stored().filter(p=>Date.parse(p.expiresAt)>Date.now()),held]);return held;});
 }
 assert(held:CallingExecutionPending):void{const current=this.read();if(!current||current.commandId!==held.commandId||current.payloadSHA256!==held.payloadSHA256||current.operation!==held.operation||current.operation==='create_session'&&held.operation==='create_session'&&current.firmId!==held.firmId)throw Error('Execution custody changed');}
 async session(held:CallingExecutionPending,sessionId:string,current:()=>boolean):Promise<CallingExecutionPending>{return this.mutate(current,()=>{this.assert(held);const next=callingExecutionPendingSchema.parse({...held,sessionId});this.write(this.stored().map(p=>p.identity===held.identity?next:p));return next;});}
 async complete(held:CallingExecutionPending,current:()=>boolean):Promise<void>{await this.mutate(current,()=>{this.assert(held);this.write(this.stored().filter(p=>p.identity!==held.identity));});}
 async clear(identity:string):Promise<void>{try{if(!navigator.locks)return;await navigator.locks.request(registryLock,{mode:'exclusive'},()=>{this.write(this.stored().filter(p=>p.identity!==identity));});}catch{/* No stale authority can consume retained state. */}}
 subscribe(listener:()=>void):()=>void{const onStorage=(event:StorageEvent):void=>{if(event.key===CALLING_EXECUTION_KEY)listener();};globalThis.addEventListener?.('storage',onStorage);globalThis.addEventListener?.(changed,listener);return()=>{globalThis.removeEventListener?.('storage',onStorage);globalThis.removeEventListener?.(changed,listener);};}
}
/** Root installs for app lifetime. Unmounting a screen does not discard uncertainty. */
export function installCallingExecutionCustody(client:BrowserClient,storage:ExecutionStorage=globalThis.localStorage):()=>void{
 const custody=new CallingExecutionCustody(client,storage);let identity=custody.binding()?.identity??null;
 return client.subscribe(()=>{const next=custody.binding()?.identity??null;if(identity!==null&&identity!==next)void custody.clear(identity);identity=next;});
}

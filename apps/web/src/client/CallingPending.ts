import {z} from 'zod';
import {callingSubjectSchema,uuid,instant,type CallingSubject,type CallingWrapInput,type CallingFollowUpSaveInput} from '@fss/contracts';
import type {BrowserClient} from './BrowserClient.ts';
import {privateDraftCanonicalJson,privateDraftSHA256} from './PrivateDraftCustody.ts';
export const CALLING_PENDING_KEY='callie.browser.calling-pending.v1';
export const callingPendingSchema=z.strictObject({identity:z.string().min(1).max(1024),expiresAt:instant,commandId:uuid,payloadSHA256:z.string().regex(/^[a-f0-9]{64}$/u),target:z.string().min(1).max(128),operation:z.enum(['wrap','save']),subject:callingSubjectSchema.optional(),attemptId:uuid.optional(),draftId:uuid.optional(),expectedRevision:z.number().int().positive().optional()}).refine(p=>p.operation==='wrap'
 ?p.subject!==undefined&&p.target===callingTarget(p.subject)&&p.expectedRevision===undefined&&(p.subject.kind==='candidate'?p.attemptId!==undefined:p.attemptId===undefined)
 :p.subject===undefined&&p.attemptId===undefined&&p.draftId!==undefined&&p.expectedRevision!==undefined&&p.target===`draft:${p.draftId}`,'Exact Calling custody required');
export type CallingPending=z.infer<typeof callingPendingSchema>;
export type CallingStorage=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
const records=z.array(callingPendingSchema).max(100).refine(values=>new Set(values.map(v=>JSON.stringify([v.identity,v.target]))).size===values.length&&new Set(values.map(v=>v.commandId)).size===values.length,'Duplicate Calling custody');
export function callingTarget(subject:CallingSubject):string{return subject.kind==='candidate'?`candidate:${subject.candidateId}:${subject.expectedCandidateRevision}`:`firm:${subject.firmId}`;}
const storageLock='callie.calling-records';
/** Cross-tab IDs/hash custody. Target locks own dispatch, short storage locks own mutations. */
export class CallingCustody{
 constructor(readonly client:BrowserClient,private readonly storage:CallingStorage=globalThis.localStorage){}
 binding():{identity:string;expiresAt:string}|null{const s=this.client.current;return s?.status==='signed_in'&&this.client.isCurrent(this.client.epoch)?{identity:JSON.stringify([s.workspaceId,s.userId,s.deviceId,s.role,s.revision]),expiresAt:s.expiresAt}:null;}
 private stored():CallingPending[]{
  const bytes=this.storage.getItem(CALLING_PENDING_KEY);if(bytes===null)return [];if(bytes.length>131072)throw Error('Calling custody exceeds finite bound');
  return records.parse(JSON.parse(bytes));
 }
 all():CallingPending[]{
  const binding=this.binding();if(!binding)return [];
  // Reads never rewrite the shared array. Another tab may have a longer current lease.
  return this.stored().filter(p=>p.identity===binding.identity&&Date.parse(p.expiresAt)>Date.now());
 }
 read(target:string):CallingPending|null{return this.all().find(p=>p.target===target)??null;}
 private write(value:CallingPending[]):void{const bytes=JSON.stringify(records.parse(value));if(bytes.length>131072)throw Error('Calling custody exceeds finite bound');this.storage.setItem(CALLING_PENDING_KEY,bytes);if(this.storage.getItem(CALLING_PENDING_KEY)!==bytes)throw Error('Calling custody storage unavailable');}
 async exclusive<T>(target:string,work:()=>Promise<T>):Promise<T>{const binding=this.binding(),epoch=this.client.epoch;if(!binding||!globalThis.navigator?.locks)throw Error('Calling custody unavailable');return navigator.locks.request(`callie.calling:${binding.identity}:${target}`,{mode:'exclusive'},()=>{if(!this.client.isCurrent(epoch)||this.binding()?.identity!==binding.identity)throw Error('Calling authority changed');return work();});}
 private async mutate<T>(current:()=>boolean,work:()=>T):Promise<T>{
  const binding=this.binding(),epoch=this.client.epoch;if(!binding||!current()||!globalThis.navigator?.locks)throw Error('Calling custody unavailable');
  return navigator.locks.request(storageLock,{mode:'exclusive'},()=>{
   if(!current()||!this.client.isCurrent(epoch)||this.binding()?.identity!==binding.identity)throw Error('Calling authority changed');
   return work();
  });
 }
 async prepare(operation:'wrap'|'save',payload:CallingWrapInput|CallingFollowUpSaveInput,current:()=>boolean):Promise<CallingPending>{
  const binding=this.binding(),epoch=this.client.epoch;if(!binding||!current())throw Error('Calling authority changed');
  const wrap=operation==='wrap'?payload as CallingWrapInput:null,save=operation==='save'?payload as CallingFollowUpSaveInput:null;
  const subject:CallingSubject|undefined=wrap?(wrap.kind==='candidate'?{kind:'candidate',candidateId:wrap.candidateId,expectedCandidateRevision:wrap.expectedCandidateRevision}:{kind:'firm',firmId:wrap.firmId,...(wrap.itemId?{itemId:wrap.itemId}:{}),...(wrap.opportunityId?{opportunityId:wrap.opportunityId}:{})}):undefined;
  const target=subject?callingTarget(subject):`draft:${save!.draftId}`;
  if(this.read(target))throw Error('Reconcile pending Calling command');
  const payloadSHA256=await privateDraftSHA256(privateDraftCanonicalJson(payload));
  return this.mutate(current,()=>{
   if(!this.client.isCurrent(epoch)||this.binding()?.identity!==binding.identity||this.read(target))throw Error('Calling authority changed');
   const held=callingPendingSchema.parse({...binding,commandId:crypto.randomUUID(),payloadSHA256,target,operation,...(subject?{subject}:{}),...(wrap?.kind==='candidate'?{attemptId:wrap.attemptId}:{}),...(wrap?.promisedEmail?{draftId:wrap.promisedEmail.draftId}:{}),...(save?{draftId:save.draftId,expectedRevision:save.expectedRevision}:{})});
   this.write([...this.stored().filter(p=>Date.parse(p.expiresAt)>Date.now()),held]);return held;
  });
 }
 assert(held:CallingPending):void{if(JSON.stringify(this.read(held.target))!==JSON.stringify(held))throw Error('Calling custody changed');}
 async complete(held:CallingPending,current:()=>boolean):Promise<void>{await this.mutate(current,()=>{this.assert(held);this.write(this.stored().filter(p=>p.commandId!==held.commandId&&Date.parse(p.expiresAt)>Date.now()));});}
 async clear(identity:string):Promise<void>{
  // Authentication invalidates consumption synchronously. Physical removal joins the
  // same storage order, without erasing a later identity's newly prepared command.
  try{if(!globalThis.navigator?.locks)return;await navigator.locks.request(storageLock,{mode:'exclusive'},()=>{
   const bytes=this.storage.getItem(CALLING_PENDING_KEY);if(bytes===null)return;
   if(bytes.length>131072)throw Error('Calling custody exceeds finite bound');
   const retained=records.parse(JSON.parse(bytes)).filter(p=>p.identity!==identity);
   if(retained.length)this.write(retained);else this.storage.removeItem(CALLING_PENDING_KEY);
  });}catch{/* Invalid authority cannot consume stored custody. */}
 }
}
/** App lifetime observer, not screen lifetime. Unmount must never discard uncertainty. */
export function installCallingCustody(client:BrowserClient,storage:CallingStorage=globalThis.localStorage):()=>void{
 const custody=new CallingCustody(client,storage);let identity=custody.binding()?.identity??null;
 return client.subscribe(()=>{const next=custody.binding()?.identity??null;if(identity!==null&&identity!==next)void custody.clear(identity);identity=next;});
}

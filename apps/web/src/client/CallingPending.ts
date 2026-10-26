import {z} from 'zod';
import {callingSubjectSchema,uuid,instant,type CallingSubject,type CallingWrapInput,type CallingFollowUpSaveInput} from '@fss/contracts';
import type {BrowserClient} from './BrowserClient.ts';
import {privateDraftCanonicalJson,privateDraftSHA256} from './PrivateDraftCustody.ts';
export const CALLING_PENDING_KEY='callie.browser.calling-pending.v1';
export const callingPendingSchema=z.strictObject({identity:z.string(),expiresAt:instant,commandId:uuid,payloadSHA256:z.string().regex(/^[a-f0-9]{64}$/u),target:z.string().min(1),operation:z.enum(['wrap','save']),subject:callingSubjectSchema.optional(),attemptId:uuid.optional(),draftId:uuid.optional(),expectedRevision:z.number().int().positive().optional()});
export type CallingPending=z.infer<typeof callingPendingSchema>;
export type CallingStorage=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
const records=z.array(callingPendingSchema).max(100);
export function callingTarget(subject:CallingSubject):string{return subject.kind==='candidate'?`candidate:${subject.candidateId}:${subject.expectedCandidateRevision}`:`firm:${subject.firmId}`;}
/** Per-tab IDs/hash custody only. All mutations occur inside an exact-target WebLock. */
export class CallingCustody{
 constructor(readonly client:BrowserClient,private readonly storage:CallingStorage=globalThis.sessionStorage){}
 binding():{identity:string;expiresAt:string}|null{const s=this.client.current;return s?.status==='signed_in'&&this.client.isCurrent(this.client.epoch)?{identity:JSON.stringify([s.workspaceId,s.userId,s.deviceId,s.role,s.revision]),expiresAt:s.expiresAt}:null;}
 all():CallingPending[]{
  const binding=this.binding();if(!binding)return [];
  const bytes=this.storage.getItem(CALLING_PENDING_KEY);if(bytes===null)return [];
  const parsed=records.parse(JSON.parse(bytes)),current=parsed.filter(p=>p.identity===binding.identity&&Date.parse(p.expiresAt)>Date.now()&&Date.parse(p.expiresAt)<=Date.parse(binding.expiresAt));
  if(current.length!==parsed.length)this.write(current);return current;
 }
 read(target:string):CallingPending|null{return this.all().find(p=>p.target===target)??null;}
 private write(value:CallingPending[]):void{const bytes=JSON.stringify(value);this.storage.setItem(CALLING_PENDING_KEY,bytes);if(this.storage.getItem(CALLING_PENDING_KEY)!==bytes)throw Error('Calling custody storage unavailable');}
 async exclusive<T>(target:string,work:()=>Promise<T>):Promise<T>{const binding=this.binding();if(!binding||!globalThis.navigator?.locks)throw Error('Calling custody unavailable');return navigator.locks.request(`callie.calling:${binding.identity}:${target}`,{mode:'exclusive'},work);}
 async prepare(operation:'wrap'|'save',payload:CallingWrapInput|CallingFollowUpSaveInput,current:()=>boolean):Promise<CallingPending>{
  const binding=this.binding();if(!binding||!current())throw Error('Calling authority changed');
  const wrap=operation==='wrap'?payload as CallingWrapInput:null,save=operation==='save'?payload as CallingFollowUpSaveInput:null;
  const subject:CallingSubject|undefined=wrap?(wrap.kind==='candidate'?{kind:'candidate',candidateId:wrap.candidateId,expectedCandidateRevision:wrap.expectedCandidateRevision}:{kind:'firm',firmId:wrap.firmId,...(wrap.itemId?{itemId:wrap.itemId}:{}),...(wrap.opportunityId?{opportunityId:wrap.opportunityId}:{})}):undefined;
  const target=subject?callingTarget(subject):`draft:${save!.draftId}`;
  if(this.read(target))throw Error('Reconcile pending Calling command');
  const payloadSHA256=await privateDraftSHA256(privateDraftCanonicalJson(payload));
  if(!current()||this.binding()?.identity!==binding.identity||this.read(target))throw Error('Calling authority changed');
  const held=callingPendingSchema.parse({...binding,commandId:crypto.randomUUID(),payloadSHA256,target,operation,...(subject?{subject}:{}),...(wrap?.kind==='candidate'?{attemptId:wrap.attemptId}:{}),...(wrap?.promisedEmail?{draftId:wrap.promisedEmail.draftId}:{}),...(save?{draftId:save.draftId,expectedRevision:save.expectedRevision}:{})});
  this.write([...this.all(),held]);return held;
 }
 assert(held:CallingPending):void{if(JSON.stringify(this.read(held.target))!==JSON.stringify(held))throw Error('Calling custody changed');}
 complete(held:CallingPending):void{this.assert(held);this.write(this.all().filter(p=>p.commandId!==held.commandId));}
 clear():void{try{this.storage.removeItem(CALLING_PENDING_KEY);}catch{/* Invalid authority cannot consume stored custody. */}}
}
/** App lifetime observer, not screen lifetime. Unmount must never discard uncertainty. */
export function installCallingCustody(client:BrowserClient,storage:CallingStorage=globalThis.sessionStorage):()=>void{
 const custody=new CallingCustody(client,storage);let identity=custody.binding()?.identity??null;
 return client.subscribe(()=>{const next=custody.binding()?.identity??null;if(next===null||(identity!==null&&identity!==next))custody.clear();identity=next;});
}

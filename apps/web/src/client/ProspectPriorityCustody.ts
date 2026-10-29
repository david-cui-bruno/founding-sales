import {z} from 'zod';
import {instant,uuid,prospectPrioritySaveInputSchema,prospectPriorityConsiderInputSchema,type ProspectPrioritySaveInput,type ProspectPriorityConsiderInput} from '@fss/contracts';
import {privateDraftCanonicalJson,privateDraftSHA256} from './PrivateDraftCustody.ts';
export const PRIORITY_PENDING_KEY='workspace.browser.pending-prospect-priority.v1';
const pendingSchema=z.strictObject({identity:z.string(),expiresAt:instant,commandId:uuid,operation:z.enum(['save','consider']),candidateId:uuid,candidateRevision:z.number().int().positive(),expectedAssessmentRevision:z.number().int().nonnegative(),payloadSHA256:z.string().regex(/^[a-f0-9]{64}$/u)});
export type PriorityPending=z.infer<typeof pendingSchema>;
export type PriorityPayload={operation:'save';input:ProspectPrioritySaveInput}|{operation:'consider';input:ProspectPriorityConsiderInput};
/** Exact command custody only: no copied evidence, assessment or Person details. */
export class ProspectPriorityCustody{
 constructor(private readonly storage:Pick<Storage,'getItem'|'setItem'|'removeItem'>,private readonly binding:()=>{identity:string;expiresAt:string}|null,private readonly uuid:()=>string){}
 clear():void{try{this.storage.removeItem(PRIORITY_PENDING_KEY);}catch{/* Stale binding never authorizes old custody. */}}
 read():PriorityPending|null{
  const binding=this.binding();if(!binding)return null;
  const raw=this.storage.getItem(PRIORITY_PENDING_KEY);if(raw===null)return null;
  const held=pendingSchema.parse(JSON.parse(raw));
  if(held.identity!==binding.identity||Date.parse(held.expiresAt)<=Date.now()||Date.parse(held.expiresAt)>Date.parse(binding.expiresAt)){this.clear();return null;}
  return held;
 }
 async exclusive<T>(work:()=>Promise<T>):Promise<T>{
  const binding=this.binding();if(!binding||!navigator.locks)throw Error('Priority command custody unavailable');
  return navigator.locks.request(`workspace.prospect-priority:${binding.identity}`,{mode:'exclusive'},async()=>{
   if(this.binding()?.identity!==binding.identity)throw Error('Priority identity changed');return work();
  });
 }
 async prepare(raw:PriorityPayload,current:()=>boolean):Promise<PriorityPending>{
  const input=raw.operation==='save'?prospectPrioritySaveInputSchema.parse(raw.input):prospectPriorityConsiderInputSchema.parse(raw.input),binding=this.binding();
  if(!binding||!current()||this.read())throw Error('Reconcile exact pending priority command');
  const payloadSHA256=await privateDraftSHA256(privateDraftCanonicalJson(input));
  if(!current()||this.binding()?.identity!==binding.identity||this.read())throw Error('Priority command custody changed');
  const held=pendingSchema.parse({...binding,commandId:this.uuid(),operation:raw.operation,candidateId:input.candidateId,candidateRevision:input.expectedCandidateRevision,expectedAssessmentRevision:input.expectedAssessmentRevision,payloadSHA256});
  const bytes=JSON.stringify(held);this.storage.setItem(PRIORITY_PENDING_KEY,bytes);if(this.storage.getItem(PRIORITY_PENDING_KEY)!==bytes)throw Error('Priority command custody unavailable');return held;
 }
 assert(held:PriorityPending):void{if(JSON.stringify(this.read())!==JSON.stringify(held))throw Error('Priority command custody changed');}
 complete(held:PriorityPending):void{this.assert(held);this.storage.removeItem(PRIORITY_PENDING_KEY);if(this.storage.getItem(PRIORITY_PENDING_KEY)!==null)throw Error('Priority command custody unavailable');}
}

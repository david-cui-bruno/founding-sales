import {z} from 'zod';
import {instant,uuid,manualProspectActivitySaveInputSchema,type ManualProspectActivitySaveInput} from '@fss/contracts';
import {privateDraftCanonicalJson,privateDraftSHA256} from './PrivateDraftCustody.ts';
export const MANUAL_ACTIVITY_PENDING_KEY='callie.browser.pending-manual-activity.v1';
export const manualActivityPendingSchema=z.strictObject({identity:z.string(),expiresAt:instant,commandId:uuid,attemptId:uuid,candidateId:uuid,candidateRevision:z.number().int().positive(),expectedActivityRevision:z.number().int().positive().optional(),operation:z.enum(['create','update','withdraw']),payloadSHA256:z.string().regex(/^[a-f0-9]{64}$/u)});
export type ManualActivityPending=z.infer<typeof manualActivityPendingSchema>;
/** Only opaque custody survives refresh. No result, note or civil/occurrence time. */
export class ManualProspectActivityCustody{
 constructor(private readonly storage:Pick<Storage,'getItem'|'setItem'|'removeItem'>,private readonly binding:()=>{identity:string;expiresAt:string}|null,private readonly uuid:()=>string){}
 clear():void{try{this.storage.removeItem(MANUAL_ACTIVITY_PENDING_KEY);}catch{/* A missing live binding always refuses old bytes. */}}
 read():ManualActivityPending|null{
  const binding=this.binding();if(!binding)return null;
  const raw=this.storage.getItem(MANUAL_ACTIVITY_PENDING_KEY);if(raw===null)return null;
  const held=manualActivityPendingSchema.parse(JSON.parse(raw));
  if(held.identity!==binding.identity||Date.parse(held.expiresAt)<=Date.now()||Date.parse(held.expiresAt)>Date.parse(binding.expiresAt)){this.clear();return null;}
  return held;
 }
 async exclusive<T>(work:()=>Promise<T>):Promise<T>{
  const binding=this.binding();if(!binding||!navigator.locks)throw Error('Manual activity custody unavailable');
  return navigator.locks.request(`callie.manual-activity:${binding.identity}`,{mode:'exclusive'},async()=>{
   if(this.binding()?.identity!==binding.identity)throw Error('Manual activity identity changed');return work();
  });
 }
 async prepare(raw:ManualProspectActivitySaveInput,current:()=>boolean):Promise<ManualActivityPending>{
  const payload=manualProspectActivitySaveInputSchema.parse(raw),binding=this.binding();
  if(!binding||!current()||this.read())throw Error('Reconcile exact pending activity');
  const payloadSHA256=await privateDraftSHA256(privateDraftCanonicalJson(payload));
  if(!current()||this.binding()?.identity!==binding.identity||this.read())throw Error('Manual activity custody changed');
  const held=manualActivityPendingSchema.parse({...binding,commandId:this.uuid(),attemptId:payload.attemptId,candidateId:payload.candidateId,candidateRevision:payload.expectedCandidateRevision,operation:payload.operation,...(payload.operation!=='create'?{expectedActivityRevision:payload.expectedActivityRevision}:{}),payloadSHA256});
  const bytes=JSON.stringify(held);this.storage.setItem(MANUAL_ACTIVITY_PENDING_KEY,bytes);if(this.storage.getItem(MANUAL_ACTIVITY_PENDING_KEY)!==bytes)throw Error('Manual activity custody unavailable');return held;
 }
 assert(held:ManualActivityPending):void{if(JSON.stringify(this.read())!==JSON.stringify(held))throw Error('Manual activity custody changed');}
 complete(held:ManualActivityPending):void{this.assert(held);this.storage.removeItem(MANUAL_ACTIVITY_PENDING_KEY);if(this.storage.getItem(MANUAL_ACTIVITY_PENDING_KEY)!==null)throw Error('Manual activity custody unavailable');}
}

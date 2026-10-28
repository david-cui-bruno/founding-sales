import {z} from 'zod';
import {uuid,callingPreparationInputSchema,callingPreparationAnswerSchema,callingPreparationReceiptSchema,type CallingPreparationInput,type CallingPreparationReceipt} from '@fss/contracts';
import type {BrowserClient} from './BrowserClient.ts';
import {privateDraftCanonicalJson,privateDraftSHA256} from './PrivateDraftCustody.ts';
export const CALLING_PREPARATION_CUSTODY_CHANGED='callie:calling-preparation-custody';
export const CALLING_PREPARATION_PENDING_KEY='callie.browser.calling-preparation.v1';
const record=z.strictObject({identity:z.string().max(1024),commandId:uuid,candidateId:uuid,payloadSHA256:z.string().regex(/^[a-f0-9]{64}$/u)});
const records=z.array(record).max(100).refine(rows=>new Set(rows.map(r=>r.identity)).size===rows.length);
type Pending=z.infer<typeof record>;
type StoragePort=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
/** Only opaque original-command custody persists. A token/session revision change
 * never clears UNKNOWN, and neither lookup nor reload can replay/remint a write.
 */
export class CallingPreparationCustody{
 constructor(private readonly client:BrowserClient,private readonly storage:StoragePort=localStorage){}
 private identity():string|null{const s=this.client.current;return s?.status==='signed_in'&&this.client.isCurrent(this.client.epoch)?JSON.stringify([s.workspaceId,s.userId,s.deviceId]):null;}
 private stored():Pending[]{const bytes=this.storage.getItem(CALLING_PREPARATION_PENDING_KEY);if(bytes===null)return [];if(bytes.length>65536)throw Error('Preparation storage unavailable');return records.parse(JSON.parse(bytes));}
 read():Pending|null{const identity=this.identity();return identity?this.stored().find(r=>r.identity===identity)??null:null;}
 private write(rows:Pending[]):void{const bytes=JSON.stringify(records.parse(rows));this.storage.setItem(CALLING_PREPARATION_PENDING_KEY,bytes);if(this.storage.getItem(CALLING_PREPARATION_PENDING_KEY)!==bytes)throw Error('Preparation storage unavailable');window.dispatchEvent(new Event(CALLING_PREPARATION_CUSTODY_CHANGED));}
 private async exclusive<T>(current:()=>boolean,work:()=>Promise<T>):Promise<T>{
  const identity=this.identity(),epoch=this.client.epoch;
  if(!identity||this.client.current?.status!=='signed_in'||this.client.current.role!=='admin'||!navigator.locks)throw Error('Preparation authority unavailable');
  return navigator.locks.request('callie.calling-preparation',{mode:'exclusive'},async()=>{if(!current()||!this.client.isCurrent(epoch)||this.identity()!==identity)throw Error('Preparation changed');return work();});
 }
 private assert(held:Pending,current:()=>boolean):void{if(!current()||JSON.stringify(this.read())!==JSON.stringify(held))throw Error('Preparation custody changed');}
 private complete(held:Pending,current:()=>boolean):void{this.assert(held,current);this.write(this.stored().filter(row=>row.identity!==held.identity||row.commandId!==held.commandId));}
 async confirm(raw:CallingPreparationInput,current:()=>boolean):Promise<CallingPreparationReceipt>{
  const payload=callingPreparationInputSchema.parse(raw);
  return this.exclusive(current,async()=>{
   if(this.read())return {state:'unknown'};
   const identity=this.identity()!,payloadSHA256=await privateDraftSHA256(privateDraftCanonicalJson(payload));
   if(!current()||identity!==this.identity()||this.read())throw Error('Preparation changed');
   const held=record.parse({identity,payloadSHA256,commandId:crypto.randomUUID(),candidateId:payload.selection.candidateId});
   this.write([...this.stored(),held]);
   try{
    const answer=await this.client.request('/calling/preparation/confirm',callingPreparationAnswerSchema,{...payload,commandId:held.commandId},()=>this.assert(held,current));
    this.assert(held,current);this.complete(held,current);
    return answer.status==='accepted'?{state:'accepted',result:answer.result}:{state:'refused',reason:answer.reason};
   }catch{return {state:'unknown'};}
  });
 }
 async recover(current:()=>boolean):Promise<CallingPreparationReceipt>{
  return this.exclusive(current,async()=>{
   const held=this.read();if(!held)throw Error('No original preparation command');
   const answer=await this.client.request('/calling/preparation/receipt',callingPreparationReceiptSchema,{commandId:held.commandId,payloadSHA256:held.payloadSHA256},()=>this.assert(held,current));
   this.assert(held,current);if(answer.state!=='unknown')this.complete(held,current);return answer;
  });
 }
}

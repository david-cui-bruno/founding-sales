import {z} from 'zod';
import {prospectPrioritySavedSchema,prospectPriorityConsideredSchema,prospectPriorityReceiptSchema} from '@fss/contracts';
import type {BrowserClient} from './BrowserClient.ts';
import type {PriorityPayload,PriorityPending} from './ProspectPriorityCustody.ts';
export const PRIORITY_PREFIX='/sourcing/candidates/prospects/priority';
const accepted=z.strictObject({status:z.literal('accepted'),replayed:z.boolean(),result:z.union([prospectPrioritySavedSchema,prospectPriorityConsideredSchema])});
const response=z.discriminatedUnion('status',[accepted,z.strictObject({status:z.literal('refused'),replayed:z.boolean(),reason:z.string()})]);
function validate(held:PriorityPending,raw:unknown):void{
 const result=held.operation==='save'?prospectPrioritySavedSchema.parse(raw):prospectPriorityConsideredSchema.parse(raw);
 if(result.candidateId!==held.candidateId||result.candidateRevision!==held.candidateRevision||result.assessmentRevision!==held.expectedAssessmentRevision+(held.operation==='save'?1:0))throw Error('Priority receipt mismatch');
}
export async function dispatchPriority(client:BrowserClient,payload:PriorityPayload,current:()=>boolean):Promise<{accepted:boolean;reason?:string}>{
 const held=await client.priority.prepare(payload,current);
 const result=await client.request(`${PRIORITY_PREFIX}/${held.operation}`,response,{...payload.input,commandId:held.commandId},()=>{if(!current())throw Error('Superseded priority command');client.priority.assert(held);});
 if(!current())throw Error('Superseded priority result');
 if(result.status==='accepted')validate(held,result.result);
 client.priority.complete(held);
 return result.status==='accepted'?{accepted:true}:{accepted:false,reason:result.reason};
}
export async function reconcilePriority(client:BrowserClient,held:PriorityPending,current:()=>boolean):Promise<'accepted'|'refused'|'unknown'>{
 const result=await client.request(`${PRIORITY_PREFIX}/receipt`,prospectPriorityReceiptSchema,{commandId:held.commandId,payloadSHA256:held.payloadSHA256,operation:held.operation},()=>{if(!current())throw Error('Superseded priority receipt');client.priority.assert(held);});
 if(!current())throw Error('Superseded priority receipt');
 if(result.state==='accepted')validate(held,result.result);
 if(result.state!=='unknown')client.priority.complete(held);
 return result.state;
}

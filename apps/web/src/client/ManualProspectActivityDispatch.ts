import {z} from 'zod';
import {manualProspectActivitySavedSchema,manualProspectActivityReceiptSchema,manualProspectActivityReadSchema,type ManualProspectActivitySaveInput,type ManualProspectActivityView} from '@fss/contracts';
import type {BrowserClient} from './BrowserClient.ts';
import type {ManualActivityPending} from './ManualProspectActivityCustody.ts';
export const MANUAL_ACTIVITY_PREFIX='/sourcing/candidates/prospects/activity';
const answer=z.discriminatedUnion('status',[
 z.strictObject({status:z.literal('accepted'),replayed:z.boolean(),result:manualProspectActivitySavedSchema}),
 z.strictObject({status:z.literal('refused'),replayed:z.boolean(),reason:z.string()}),
]);
export async function dispatchManualActivity(client:BrowserClient,payload:ManualProspectActivitySaveInput,current:()=>boolean):Promise<{held:ManualActivityPending;accepted:boolean;message:string}>{
 const held=await client.manualActivity.prepare(payload,current);
 const response=await client.request(`${MANUAL_ACTIVITY_PREFIX}/save`,answer,{...payload,commandId:held.commandId},()=>{if(!current())throw Error('Superseded activity save');client.manualActivity.assert(held);});
 if(!current())throw Error('Superseded activity result');
 if(response.status==='accepted')validateManualActivityReceipt(held,response.result);
 client.manualActivity.complete(held);
 return {held,accepted:response.status==='accepted',message:response.status==='accepted'?'Manual report saved. No call, callback task, consent or outreach action was performed.':`Manual report refused: ${response.reason}`};
}
function validateManualActivityReceipt(held:ManualActivityPending,result:z.infer<typeof manualProspectActivitySavedSchema>):void{
 if(result.candidateId!==held.candidateId||result.candidateRevision!==held.candidateRevision||result.attemptId!==held.attemptId||result.activityRevision!==(held.operation==='create'?1:held.expectedActivityRevision!+1))throw Error('Activity receipt mismatch');
}
export async function reconcileManualActivity(client:BrowserClient,held:ManualActivityPending,current:()=>boolean):Promise<'accepted'|'refused'|'unknown'>{
 const response=await client.request(`${MANUAL_ACTIVITY_PREFIX}/receipt`,manualProspectActivityReceiptSchema,{commandId:held.commandId,payloadSHA256:held.payloadSHA256},()=>{if(!current())throw Error('Superseded activity receipt');client.manualActivity.assert(held);});
 if(!current())throw Error('Superseded activity receipt');
 if(response.state==='accepted')validateManualActivityReceipt(held,response.result);
 if(response.state!=='unknown')client.manualActivity.complete(held);
 return response.state;
}
export async function readManualActivity(client:BrowserClient,held:{candidateId:string;candidateRevision:number;attemptId:string},current:()=>boolean):Promise<ManualProspectActivityView>{
 const response=await client.request(`${MANUAL_ACTIVITY_PREFIX}/read`,manualProspectActivityReadSchema,{candidateId:held.candidateId,expectedCandidateRevision:held.candidateRevision,attemptId:held.attemptId},()=>{if(!current())throw Error('Superseded activity read');});
 if(!current()||response.activity.candidateId!==held.candidateId||response.activity.candidateRevision!==held.candidateRevision||response.activity.attemptId!==held.attemptId)throw Error('Activity read mismatch');return response.activity;
}

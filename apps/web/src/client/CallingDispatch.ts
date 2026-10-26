import {z} from 'zod';
import {callingWrapInputSchema,callingWrapResultSchema,callingFollowUpSaveInputSchema,callingFollowUpSavedSchema,callingReceiptSchema,type CallingWrapInput,type CallingWrapResult,type CallingFollowUpSaveInput,type CallingReceipt} from '@fss/contracts';
import {callingTarget,type CallingCustody,type CallingPending} from './CallingPending.ts';
const refusal=z.strictObject({status:z.literal('refused'),replayed:z.boolean(),reason:z.string()});
const unavailable=z.strictObject({error:z.string()});
const wrapAnswer=z.union([z.strictObject({status:z.literal('accepted'),replayed:z.boolean(),result:callingWrapResultSchema}),refusal,unavailable]);
const saveAnswer=z.union([z.strictObject({status:z.literal('accepted'),replayed:z.boolean(),result:callingFollowUpSavedSchema}),refusal,unavailable]);
export type CallingDispatchResult<T>={state:'accepted';result:T}|{state:'refused';reason:string}|{state:'unknown'};
function assertAcceptance(held:CallingPending,receipt:CallingReceipt):void{
 if(receipt.state!=='accepted')return;
 if(receipt.acceptance.operation!==held.operation)throw Error('Calling receipt operation changed');
 if(receipt.acceptance.operation==='wrap'){
  const result=receipt.acceptance.result,subject=held.subject;
  if(!subject||result.kind!==subject.kind)throw Error('Calling receipt subject changed');
  if(result.kind==='candidate'&&(subject.kind!=='candidate'||result.activity.candidateId!==subject.candidateId||result.activity.candidateRevision!==subject.expectedCandidateRevision||result.activity.attemptId!==held.attemptId))throw Error('Calling receipt candidate changed');
  if(result.kind==='firm'&&(subject.kind!=='firm'||result.firmId!==subject.firmId))throw Error('Calling receipt firm changed');
  if(result.followUp.state==='queued_for_review'&&(result.followUp.draftId!==held.draftId||result.followUp.revision!==1))throw Error('Calling receipt draft changed');
 }else if(receipt.acceptance.result.draftId!==held.draftId||receipt.acceptance.result.revision!==held.expectedRevision!+1)throw Error('Calling receipt revision changed');
}
/** Persist once before dispatch. A transport/parse/storage failure is UNKNOWN, never replayed. */
export async function dispatchCallingWrap(custody:CallingCustody,raw:CallingWrapInput,current:()=>boolean):Promise<CallingDispatchResult<CallingWrapResult>>{
 const payload=callingWrapInputSchema.parse(raw),target=callingTarget(payload);
 return custody.exclusive(target,async()=>{
  if(custody.read(target))return {state:'unknown'};
  const held=await custody.prepare('wrap',payload,current);
  try{
   const answer=await custody.client.request('/calling/wrap',wrapAnswer,{...payload,commandId:held.commandId},()=>{if(!current())throw Error('Calling view changed');custody.assert(held);});
   if(!current())return {state:'unknown'};
   if('status' in answer&&answer.status==='accepted'){assertAcceptance(held,{state:'accepted',acceptance:{operation:'wrap',result:answer.result}});custody.complete(held);return {state:'accepted',result:answer.result};}
   // Only a command receipt refusal proves that this UUID cannot have committed.
   if('status' in answer){custody.complete(held);return {state:'refused',reason:answer.reason};}
   return {state:'unknown'};
  }catch{return {state:'unknown'};}
 });
}
export async function dispatchCallingSave(custody:CallingCustody,raw:CallingFollowUpSaveInput,current:()=>boolean):Promise<CallingDispatchResult<{draftId:string;revision:number}>>{
 const payload=callingFollowUpSaveInputSchema.parse(raw),target=`draft:${payload.draftId}`;
 return custody.exclusive(target,async()=>{
  if(custody.read(target))return {state:'unknown'};
  const held=await custody.prepare('save',payload,current);
  try{
   const answer=await custody.client.request('/calling/follow-ups/save',saveAnswer,{...payload,commandId:held.commandId},()=>{if(!current())throw Error('Calling view changed');custody.assert(held);});
   if(!current())return {state:'unknown'};
   if('status' in answer&&answer.status==='accepted'){assertAcceptance(held,{state:'accepted',acceptance:{operation:'save',result:answer.result}});custody.complete(held);return {state:'accepted',result:answer.result};}
   if('status' in answer){custody.complete(held);return {state:'refused',reason:answer.reason};}
   return {state:'unknown'};
  }catch{return {state:'unknown'};}
 });
}
/** Explicit receipt-only recovery. Historical acceptance contains no current prose. */
export async function reconcileCalling(custody:CallingCustody,held:CallingPending,current:()=>boolean):Promise<CallingReceipt>{
 return custody.exclusive(held.target,async()=>{
  custody.assert(held);
  const receipt=await custody.client.request('/calling/follow-ups/receipt',callingReceiptSchema,{operation:held.operation,commandId:held.commandId,payloadSHA256:held.payloadSHA256},()=>{if(!current())throw Error('Calling view changed');custody.assert(held);});
  if(!current())throw Error('Calling view changed');assertAcceptance(held,receipt);
  if(receipt.state!=='unknown')custody.complete(held);
  return receipt;
 });
}

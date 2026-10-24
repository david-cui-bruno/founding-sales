import {z} from 'zod';
import {manualProspectFeedbackSavedSchema} from '@fss/contracts';
import type {BrowserClient} from './BrowserClient.ts';
import type {PendingManualProspect} from './ManualProspectPending.ts';
const answerSchema=z.union([
 z.strictObject({status:z.literal('accepted'),replayed:z.boolean(),result:manualProspectFeedbackSavedSchema}),
 z.strictObject({status:z.literal('refused'),replayed:z.boolean(),reason:z.string()}),
]);
export async function dispatchManualProspect(client:BrowserClient,held:PendingManualProspect,current:()=>boolean):Promise<string>{
 if(held.receipt||!current())throw Error('Manual feedback dispatch unavailable');
 const answer=await client.request('/sourcing/candidates/prospects/feedback',answerSchema,held.payload,()=>{
  const latest=client.manualProspects.read();
  if(!current()||!latest||latest.receipt||JSON.stringify(latest.payload)!==JSON.stringify(held.payload))throw Error('Manual feedback custody changed');
  client.manualProspects.retain(held);
 });
 if(!current())return '';
 if(answer.status==='accepted'&&(answer.result.candidateId!==held.payload.candidateId||answer.result.revision!==held.payload.expectedRevision||answer.result.state!==held.payload.state))throw Error('Manual feedback receipt mismatch');
 client.manualProspects.retain({...held,receipt:answer.status==='accepted'?{status:'accepted',result:answer.result}:{status:'refused'}});
 return answer.status==='accepted'?'Manual feedback saved. Canonical candidate and contact authority unchanged.':`Manual feedback refused: ${answer.reason}`;
}

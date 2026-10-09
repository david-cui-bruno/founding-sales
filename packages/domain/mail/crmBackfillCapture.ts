import {createGmailMailCaptureProvider} from './crmGmailProvider.ts';
import {reserveBackfillRead,observeBackfillRead,type BackfillAllocationVerifier} from './crmBackfillBudget.ts';
import type {HistoricalMailCaptureProvider,MailCaptureProofVerifier} from './crmSources.ts';
/** Explicit historical composition: the native adapter's actual reads, never live fallback. */
export function createHistoricalGmailMailCaptureProvider(deps:Parameters<typeof createGmailMailCaptureProvider>[0]&{proofVerifier:MailCaptureProofVerifier;allocationVerifier:BackfillAllocationVerifier}):HistoricalMailCaptureProvider{
 return {async read(input){
  async function metered<T>(method:'metadata'|'body',read:()=>Promise<T>):Promise<T>{
   if(!await deps.proofVerifier.verify(input.expectedProof))throw new Error('historical_capture_verification_required');
   const reservation=await reserveBackfillRead(input.context,{importId:input.importId,mailboxId:input.mailboxId,ownerUserId:input.expectedProof.ownerUserId,accountBinding:input.expectedProof.accountBinding,generation:input.generation,method,expectedProof:input.expectedProof,expectedCausal:{messageId:input.providerMessageId,conversationId:input.conversationId,decisionRevision:input.decisionRevision},jobId:input.jobId,leaseOwner:input.leaseOwner,fencingToken:input.fencingToken},deps.allocationVerifier);
   if(reservation===null)throw new Error('historical_capture_allocation_unavailable');
   let value:T;
   try{value=await read();}catch{throw new Error('historical_capture_provider_unavailable');}
   await observeBackfillRead(input.context,reservation.reservationId);
   return value;
  }
  const provider=createGmailMailCaptureProvider({...deps,gmail:{...deps.gmail,
   getMetadata:async(access,messageId,headers)=>await metered('metadata',()=>deps.gmail.getMetadata(access,messageId,headers)),
   getBody:async(access,messageId)=>await metered('body',()=>deps.gmail.getBody(access,messageId)),
  }});
  return await provider.read(input);
 }};
}

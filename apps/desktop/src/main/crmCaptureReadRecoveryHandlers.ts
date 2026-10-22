import { crmCaptureReadRecoveryStatusSchema, crmCaptureReadRecoveryAcknowledgmentSchema } from '@fss/contracts';
import type { OperationInput } from '../shared/operations.ts';
import type { AuthedClient } from './authedClient.ts';
/** Fence token renewal, HTTP dispatch and publication against actual session changes. */
export function crmCaptureReadRecoveryHandlers(deps:{api:AuthedClient;generation():number|undefined}){
 function fence(){const generation=deps.generation();if(generation===undefined||!Number.isSafeInteger(generation))throw new Error('identity_changed');return ()=>generation===deps.generation();}
 return {
  'crm.captureReadRecoveryRead':async(input:OperationInput<'crm.captureReadRecoveryRead'>)=>{
   const current=fence();const answer=await deps.api.read('/crm/business/capture-read-recovery/read',value=>crmCaptureReadRecoveryStatusSchema.parse(value),input,{current});
   if(!current())throw new Error('identity_changed');if(!answer.ok)throw new Error(answer.reason);return answer.value;
  },
  'crm.captureReadRecoveryRequest':async(input:OperationInput<'crm.captureReadRecoveryRequest'>)=>{
   const current=fence(),{commandId,...body}=input;
   const answer=await deps.api.command('/crm/business/capture-read-recovery/request',body,value=>crmCaptureReadRecoveryAcknowledgmentSchema.parse(value),{commandId,current});
   if(!current())throw new Error('identity_changed');if(!answer.ok)throw new Error(answer.reason);return answer.value;
  },
 };
}

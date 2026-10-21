import {qualificationViewSchema} from '@fss/contracts';
import type {OperationInput,OperationOutput} from '../shared/operations.ts';
import type {AuthedClient} from './authedClient.ts';
/** Current online Firm evidence only, fenced before token wait, dispatch and result. */
export function sourcingFirmQualificationHandlers(deps:{api:AuthedClient;generation():number|undefined}) {
 return {'sourcing.firmQualification':async(input:OperationInput<'sourcing.firmQualification'>):Promise<OperationOutput<'sourcing.firmQualification'>>=>{
  const generation=deps.generation(),current=()=>generation===deps.generation();
  if(generation===undefined||!Number.isFinite(generation))return {view:null,reason:'session_changed'};
  try{
   const answer=await deps.api.read('/sourcing/qualification/firm',value=>qualificationViewSchema.parse(value),input,{current});
   if(!current())return {view:null,reason:'session_changed'};
   return answer.ok?{view:answer.value,reason:null}:{view:null,reason:answer.reason.slice(0,80)};
  }catch{return {view:null,reason:current()?'unavailable':'session_changed'};}
 }};
}

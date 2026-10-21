import {firmQualificationViewSchema,qualificationViewSchema,qualificationQueuedSchema} from '@fss/contracts';
import type {OperationInput,OperationOutput} from '../shared/operations.ts';
import type {AuthedClient} from './authedClient.ts';
/** Current online qualification flow, fenced before token wait, dispatch and result. */
export function sourcingFirmQualificationHandlers(deps:{api:AuthedClient;generation():number|undefined}) {
 return {'sourcing.firmQualification':async(input:OperationInput<'sourcing.firmQualification'>):Promise<OperationOutput<'sourcing.firmQualification'>>=>{
  const generation=deps.generation(),current=()=>generation===deps.generation();
  if(generation===undefined||!Number.isFinite(generation))return {view:null,reason:'session_changed'};
  try{
   const answer=await deps.api.read('/sourcing/qualification/firm',value=>firmQualificationViewSchema.parse(value),input,{current});
   if(!current())return {view:null,reason:'session_changed'};
   return answer.ok?{view:answer.value,reason:null}:{view:null,reason:answer.reason.slice(0,80)};
  }catch{return {view:null,reason:current()?'unavailable':'session_changed'};}
 },'sourcing.qualification':async(input:OperationInput<'sourcing.qualification'>):Promise<OperationOutput<'sourcing.qualification'>>=>{
  const generation=deps.generation(),current=()=>generation===deps.generation();
  if(generation===undefined||!Number.isFinite(generation))return {view:null,reason:'session_changed'};
  const answer=await deps.api.read('/sourcing/qualification/read',value=>qualificationViewSchema.parse(value),input,{current});
  if(!current())return {view:null,reason:'session_changed'};
  return answer.ok?{view:answer.value,reason:null}:{view:null,reason:answer.reason.slice(0,80)};
 },'sourcing.qualify':async(input:OperationInput<'sourcing.qualify'>):Promise<OperationOutput<'sourcing.qualify'>>=>{
  const generation=deps.generation(),current=()=>generation===deps.generation();
  if(generation===undefined||!Number.isFinite(generation))return {result:null,reason:'session_changed'};
  const {commandId,...body}=input;
  const answer=await deps.api.command('/sourcing/qualification/request',body,value=>qualificationQueuedSchema.parse(value),{commandId,current});
  if(!current())return {result:null,reason:'session_changed'};
  return answer.ok?{result:answer.value,reason:null}:{result:null,reason:answer.reason.slice(0,80)};
 }};
}

import {linkedinPostingPolicyViewSchema,linkedinPostingCandidateBindingSchema} from '@fss/contracts';
import type {OperationInput,OperationOutput} from '../../shared/operations.ts';
import type {AuthedClient} from '../authedClient.ts';
export function linkedinPostingPolicyOperations(deps:{api:AuthedClient;generation():number}){
 const change=async(path:string,input:OperationInput<'social.savePostingPolicy'>|OperationInput<'social.disablePostingPolicy'>):Promise<OperationOutput<'social.postingPolicy'>>=>{
  const g=deps.generation(),{commandId,...payload}=input;
  if(g!==deps.generation())return {view:null,reason:'session_changed'};
  const result=await deps.api.command(path,payload,v=>linkedinPostingPolicyViewSchema.parse(v),{commandId});
  if(g!==deps.generation())return {view:null,reason:'session_changed'};
  return result.ok?{view:result.value,reason:null}:{view:null,reason:result.reason};
 };
 return {
  'social.postingPolicy':async():Promise<OperationOutput<'social.postingPolicy'>>=>{const g=deps.generation();const result=await deps.api.read('/social/linkedin-posting-policy/read',v=>linkedinPostingPolicyViewSchema.parse(v),{});if(g!==deps.generation())return {view:null,reason:'session_changed'};return result.ok?{view:result.value,reason:null}:{view:null,reason:result.reason};},
  'social.savePostingPolicy':(input:OperationInput<'social.savePostingPolicy'>)=>change('/social/linkedin-posting-policy/save',input),
  'social.disablePostingPolicy':(input:OperationInput<'social.disablePostingPolicy'>)=>change('/social/linkedin-posting-policy/disable',input),
  'social.revokePostingPolicy':(input:OperationInput<'social.revokePostingPolicy'>)=>change('/social/linkedin-posting-policy/revoke',input),
  'social.bindPostingCandidate':async(input:OperationInput<'social.bindPostingCandidate'>):Promise<OperationOutput<'social.bindPostingCandidate'>>=>{const g=deps.generation(),{commandId,...payload}=input;if(g!==deps.generation())return {binding:null,reason:'session_changed'};const result=await deps.api.command('/social/linkedin-posting-policy/bind-candidate',payload,v=>linkedinPostingCandidateBindingSchema.parse(v),{commandId});if(g!==deps.generation())return {binding:null,reason:'session_changed'};return result.ok?{binding:result.value,reason:null}:{binding:null,reason:result.reason};},
 };
}

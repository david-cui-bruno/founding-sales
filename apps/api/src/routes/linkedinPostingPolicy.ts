import {z} from 'zod';
import {linkedinPostingPolicySaveCommandSchema,linkedinPostingPolicyStopCommandSchema,linkedinPostingPolicyCheckSchema,linkedinPostingCandidateBindCommandSchema} from '@fss/contracts';
import {readLinkedinPostingPolicy,saveLinkedinPostingPolicy,stopLinkedinPostingPolicy,checkLinkedinPostingPolicyCurrent,bindLinkedinPostingCandidate} from '@fss/domain/social/linkedinPostingPolicy.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {contextForPrincipal,requirePrincipal,runRouteCommand} from './routeSupport.ts';
import type {ApiRequest,RoutingOptions,RouteResult} from './types.ts';
export const LINKEDIN_POSTING_POLICY_PATHS=['/social/linkedin-posting-policy/read','/social/linkedin-posting-policy/save','/social/linkedin-posting-policy/disable','/social/linkedin-posting-policy/revoke','/social/linkedin-posting-policy/check-current','/social/linkedin-posting-policy/bind-candidate'] as const;
export async function routeLinkedinPostingPolicy(request:ApiRequest,options:RoutingOptions):Promise<RouteResult|null>{
 if(!(LINKEDIN_POSTING_POLICY_PATHS as readonly string[]).includes(request.path))return null;
 if(request.method!=='POST')return {status:405,body:{error:'method_not_allowed'}};
 const auth=options.auth;if(!auth)return {status:401,body:{error:'unauthenticated'}};
 const principal=await requirePrincipal(auth,request);if(!principal.ok)return principal.result;
 const scoped=contextForPrincipal(auth,principal.principal);if(!scoped.ok)return scoped.result;
 if(request.path==='/social/linkedin-posting-policy/read'){
  if(!z.strictObject({}).safeParse(request.body).success)return {status:400,body:{error:'invalid_input'}};
  return {status:200,body:await withTransaction(auth.db,()=>readLinkedinPostingPolicy(scoped.context))};
 }
 const deps={auth,request,principal:principal.principal};
 if(request.path.endsWith('/bind-candidate'))return runRouteCommand(deps,linkedinPostingCandidateBindCommandSchema,'linkedin_posting_candidate_bind',(ctx,input)=>bindLinkedinPostingCandidate(ctx,input));
 if(request.path==='/social/linkedin-posting-policy/check-current'){
  const parsed=linkedinPostingPolicyCheckSchema.safeParse(request.body);if(!parsed.success)return {status:400,body:{error:'invalid_input'}};
  return {status:200,body:await withTransaction(auth.db,()=>checkLinkedinPostingPolicyCurrent(scoped.context,parsed.data))};
 }
 if(request.path.endsWith('/disable')||request.path.endsWith('/revoke')){
  const state=request.path.endsWith('/disable')?'disabled':'revoked';
  return runRouteCommand(deps,linkedinPostingPolicyStopCommandSchema,`linkedin_posting_policy_${state}`,(ctx,input)=>stopLinkedinPostingPolicy(ctx,input,state));
 }
 return runRouteCommand(deps,linkedinPostingPolicySaveCommandSchema,'linkedin_posting_policy_save',(ctx,body)=>{const {commandId:_id,clientVersion:_client,...input}=body;return saveLinkedinPostingPolicy(ctx,input);});
}

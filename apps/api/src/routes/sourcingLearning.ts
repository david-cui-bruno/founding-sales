import {learningInputSchema,targetingProposalCommandSchema,targetingApplyCommandSchema} from '@fss/contracts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {readSourcingLearning} from '@fss/domain/sourcing/learningReport.ts';
import {readTargetingView,saveTargetingProposal,applyTargetingProposal} from '@fss/domain/sourcing/targetingProposals.ts';
import {contextForPrincipal,requirePrincipal,runRouteCommand} from './routeSupport.ts';
import type {ApiRequest,RouteResult,RoutingOptions} from './types.ts';
export const SOURCING_LEARNING_PATHS=['/sourcing/learning','/sourcing/targeting','/sourcing/targeting/save','/sourcing/targeting/apply'];
export async function routeSourcingLearning(request:ApiRequest,options:RoutingOptions):Promise<RouteResult|null>{
 if(!SOURCING_LEARNING_PATHS.includes(request.path))return null;
 const auth=options.auth;if(!auth)return {status:404,body:{error:'not_found'}};
 if(request.method!=='POST')return {status:405,body:{error:'method_not_allowed'}};
 const authenticated=await requirePrincipal(auth,request);if(!authenticated.ok)return authenticated.result;
 const scoped=contextForPrincipal(auth,authenticated.principal);if(!scoped.ok)return scoped.result;
 const deps={auth,request,principal:authenticated.principal};
 if(request.path==='/sourcing/learning'){
  const input=learningInputSchema.safeParse(request.body);if(!input.success)return {status:400,body:{error:'invalid_input'}};
  return withTransaction(auth.db,async()=>({status:200,body:await readSourcingLearning(scoped.context,input.data)}));
 }
 if(request.path==='/sourcing/targeting')return {status:200,body:await readTargetingView(scoped.context)};
 if(request.path==='/sourcing/targeting/save')return runRouteCommand(deps,targetingProposalCommandSchema,'sourcing.targeting_save',async(ctx,body)=>{const {commandId:_id,clientVersion:_version,...input}=body;return saveTargetingProposal(ctx,input);});
 return runRouteCommand(deps,targetingApplyCommandSchema,'sourcing.targeting_apply',async(ctx,body)=>{const {commandId:_id,clientVersion:_version,...input}=body;return applyTargetingProposal(ctx,input);});
}

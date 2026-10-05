import {candidateListInputSchema,candidateSaveCommandSchema,candidateReviewCommandSchema,candidateDeleteCommandSchema} from '@fss/contracts';
import {saveCandidate,listCandidates,reviewCandidate,deleteCandidate} from '@fss/domain/sourcing/candidates.ts';
import {contextForPrincipal,requirePrincipal,runRouteCommand} from './routeSupport.ts';
import type {ApiRequest,RouteResult,RoutingOptions} from './types.ts';
export const SOURCING_PATHS=['/sourcing/candidates/list','/sourcing/candidates/save','/sourcing/candidates/review','/sourcing/candidates/delete'] as const;
export async function routeSourcing(request:ApiRequest,options:RoutingOptions):Promise<RouteResult|null> {
  if(!(SOURCING_PATHS as readonly string[]).includes(request.path))return null;
  if(!options.auth)return {status:404,body:{error:'not_found'}};
  if(request.method!=='POST')return {status:405,body:{error:'method_not_allowed'}};
  const auth=options.auth,authenticated=await requirePrincipal(auth,request);
  if(!authenticated.ok)return authenticated.result;
  const deps={auth,request,principal:authenticated.principal};
  if(request.path==='/sourcing/candidates/save')return await runRouteCommand(deps,candidateSaveCommandSchema,'sourcing.save',async(context,body)=>{
    const {commandId:_commandId,clientVersion:_clientVersion,...input}=body;
    return await saveCandidate(context,input);
  });
  if(request.path==='/sourcing/candidates/review')return await runRouteCommand(deps,candidateReviewCommandSchema,'sourcing.review',async(context,body)=>{
    const {commandId:_commandId,clientVersion:_clientVersion,...input}=body;
    return await reviewCandidate(context,input);
  });
  if(request.path==='/sourcing/candidates/delete')return await runRouteCommand(deps,candidateDeleteCommandSchema,'sourcing.delete',async(context,body)=>{
    const {commandId:_commandId,clientVersion:_clientVersion,...input}=body;
    return await deleteCandidate(context,input);
  });
  const parsed=candidateListInputSchema.safeParse(request.body);
  if(!parsed.success)return {status:400,body:{error:'malformed_body'}};
  const scoped=contextForPrincipal(auth,authenticated.principal);
  if(!scoped.ok)return scoped.result;
  const answer=await listCandidates(scoped.context,parsed.data);
  return answer.ok?{status:200,body:answer.value}:{status:answer.reason==='admin_only'?403:400,body:{error:answer.reason}};
}

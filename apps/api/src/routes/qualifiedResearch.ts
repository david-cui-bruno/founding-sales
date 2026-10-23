import {qualifiedResearchCreateCommandSchema,qualifiedResearchListRequestSchema,qualifiedResearchListSchema,qualifiedResearchReadRequestSchema} from '@fss/contracts';
import {createQualifiedResearchFirm,listQualifiedResearchCandidates,readQualifiedResearchFirm} from '@fss/domain/sourcing/qualifiedResearch.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {runCommand} from '../auth/commands.ts';
import {isDeepStrictEqual} from 'node:util';
import {commandReply,contextForPrincipal,requirePrincipal,type RouteDeps} from './routeSupport.ts';
import type {RouteResult} from './types.ts';
export const QUALIFIED_RESEARCH_PATHS=['/sourcing/research-firms/list','/sourcing/research-firms/read','/sourcing/research-firms/create'] as const;
export async function routeQualifiedResearch(deps:RouteDeps):Promise<RouteResult>{
 const {auth,principal,request}=deps,scoped=contextForPrincipal(auth,principal);if(!scoped.ok)return scoped.result;
 const currentAuthority=async()=>{const current=await requirePrincipal(auth,request);return current.ok&&isDeepStrictEqual(current.principal,principal);};
 if(request.path==='/sourcing/research-firms/list'){
  const parsed=qualifiedResearchListRequestSchema.safeParse(request.body);if(!parsed.success)return {status:400,body:{error:'malformed_body'}};
  const view=await withTransaction(auth.db,()=>listQualifiedResearchCandidates(scoped.context,parsed.data));
  if(!await currentAuthority())return {status:401,body:{error:'unauthenticated'}};
  return {status:200,body:qualifiedResearchListSchema.parse(view)};
 }
 if(request.path==='/sourcing/research-firms/read'){
  const parsed=qualifiedResearchReadRequestSchema.safeParse(request.body);if(!parsed.success)return {status:400,body:{error:'malformed_body'}};
  const view=await withTransaction(auth.db,()=>readQualifiedResearchFirm(scoped.context,parsed.data.firmId));
  if(!await currentAuthority())return {status:401,body:{error:'unauthenticated'}};
  return view?{status:200,body:view}:{status:404,body:{error:'research_firm_unavailable'}};
 }
 const parsed=qualifiedResearchCreateCommandSchema.safeParse(request.body);if(!parsed.success)return {status:400,body:{error:'malformed_body'}};
 const {commandId,clientVersion,...payload}=parsed.data;
 const outcome=await runCommand(auth,principal,{commandId,clientVersion,kind:'sourcing.qualified_research_firm',payload},async context=>{
  const answer=await createQualifiedResearchFirm(context,payload,currentAuthority);
  return answer.ok?{status:'accepted',result:answer.value}:{status:'refused',reason:answer.reason};
 });
 if(outcome.status!=='accepted')return commandReply(outcome);
 const view=await withTransaction(auth.db,()=>readQualifiedResearchFirm(scoped.context,outcome.result.firmId));
 if(!await currentAuthority())return {status:401,body:{error:'unauthenticated'}};
 // An accepted receipt remains accepted. Missing current proof is not an auth
 // refusal and must not erase the caller's still-uncertain command identity.
 return view?commandReply({...outcome,result:view}):{status:404,body:{error:'research_firm_unavailable'}};
}

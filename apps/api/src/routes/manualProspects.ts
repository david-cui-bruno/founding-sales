import {isDeepStrictEqual} from 'node:util';
import {manualProspectFeedbackCommandSchema,manualProspectListInputSchema} from '@fss/contracts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {listManualProspects,recordManualProspectFeedback,currentManualPhoneChoiceAuthority,ManualPhoneChoiceChanged} from '@fss/domain/sourcing/manualProspects.ts';
import {contextForPrincipal,runRouteCommand,requirePrincipal,type RouteDeps} from './routeSupport.ts';
import {retainedPrincipalAuthority} from './retainedPrincipalAuthority.ts';
import type {RouteResult} from './types.ts';
export const MANUAL_PROSPECT_PATHS=['/sourcing/candidates/prospects/list','/sourcing/candidates/prospects/feedback'] as const;
export async function routeManualProspects(deps:RouteDeps):Promise<RouteResult>{
 if(deps.principal.role!=='admin')return {status:403,body:{error:'admin_only'}};
 if(deps.request.path===MANUAL_PROSPECT_PATHS[1]){
 try{
 let finish:(()=>Promise<void>)|undefined;
 const answer=await runRouteCommand(deps,manualProspectFeedbackCommandSchema,'sourcing.manual_prospect_feedback',async(ctx,body)=>{
  const {commandId:_id,clientVersion:_version,...input}=body;
  const authority=retainedPrincipalAuthority(deps,ctx),result=await recordManualProspectFeedback(ctx,input,authority);
  if(result.ok&&input.phoneChoice){const phoneChoice=input.phoneChoice;finish=()=>currentManualPhoneChoiceAuthority(ctx,{candidateId:input.candidateId,expectedRevision:input.expectedRevision,phoneChoice},authority);}
  return result;
 },async()=>{await finish?.();});
 const current=await requirePrincipal(deps.auth,deps.request);
 if(!current.ok||!isDeepStrictEqual(current.principal,deps.principal))return {status:401,body:{error:'unauthenticated'}};
 return answer;
 }catch(error){if(error instanceof ManualPhoneChoiceChanged)return {status:error.reason==='authority_changed'?401:409,body:{error:error.reason}};throw error;}
 }
 const parsed=manualProspectListInputSchema.safeParse(deps.request.body);if(!parsed.success)return {status:400,body:{error:'malformed_body'}};
 const scoped=contextForPrincipal(deps.auth,deps.principal);if(!scoped.ok)return scoped.result;
 const answer=await withTransaction(deps.auth.db,()=>listManualProspects(scoped.context,parsed.data,retainedPrincipalAuthority(deps,scoped.context)));
 return answer.ok?{status:200,body:answer.value}:{status:answer.reason==='admin_only'?403:answer.reason==='authority_changed'?409:400,body:{error:answer.reason}};
}

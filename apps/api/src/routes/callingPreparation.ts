import {CALLING_PREPARATION_PATHS,CALLING_PREPARATION_COMMAND_KIND,callingPreparationReadInputSchema,callingPreparationCommandSchema,
 callingPreparationReceiptInputSchema,CALLING_PREPARATION_REFUSALS} from '@fss/contracts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {CallingPreparationChanged,readCallingPreparation,confirmCallingPreparation,readCallingPreparationReceipt,requireCurrentCallingPreparation} from '@fss/domain/calling/preparation.ts';
import {CallingAuthorityChanged,requireCallingAuthority} from '@fss/domain/calling/followUpDraftAccess.ts';
import {policyRouteDeps} from './dialSupport.ts';
import {contextForPrincipal,runRouteCommand} from './routeSupport.ts';
import {retainedPrincipalAuthority,retainedPrincipalPublicationAuthority} from './retainedPrincipalAuthority.ts';
import {privatePrincipalIsCurrent} from './privateReadAuthority.ts';
import type {ApiRequest,RouteResult,RoutingOptions} from './types.ts';
export const CALLING_PREPARATION_ROUTE_PATHS=Object.values(CALLING_PREPARATION_PATHS);

/** Exact source preparation only. No CRM capture, source acquisition or dial grant. */
export async function routeCallingPreparation(request:ApiRequest,options:RoutingOptions):Promise<RouteResult|null>{
 if(!CALLING_PREPARATION_ROUTE_PATHS.includes(request.path as typeof CALLING_PREPARATION_ROUTE_PATHS[number]))return null;
 if(request.method!=='POST')return {status:405,body:{error:'method_not_allowed'}};
 const prepared=await policyRouteDeps(request,options);if(!prepared.ok)return prepared.result;
 const deps=prepared.deps,scoped=contextForPrincipal(deps.auth,deps.principal);if(!scoped.ok)return scoped.result;
 try{
  if(deps.principal.role!=='admin')return {status:403,body:{error:'admin_only'}};
  let answer:RouteResult,sourceDeadline:number|null=null;
  if(request.path===CALLING_PREPARATION_PATHS.confirm){
   let firmId:string|null=null;
   answer=await runRouteCommand(deps,callingPreparationCommandSchema,CALLING_PREPARATION_COMMAND_KIND,async(ctx,input)=>{
    const {commandId:_commandId,clientVersion:_clientVersion,...payload}=input;
    const outcome=await confirmCallingPreparation(ctx,payload,retainedPrincipalAuthority(deps,ctx));
    if(outcome.ok)firmId=outcome.value.firmId;
    return outcome;
   },async ctx=>{
    const publication=retainedPrincipalPublicationAuthority(deps,ctx);
    await requireCallingAuthority(ctx,publication.authority);
    if(firmId)await requireCurrentCallingPreparation(ctx,firmId);
    const clock=(await ctx.db.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0]?.at;
    if(!clock||publication.publicationNow(Math.max(clock.getTime(),Date.now()))===null)throw new CallingAuthorityChanged();
   });
  }else answer=await withTransaction(deps.auth.db,async()=>{
   const ctx=scoped.context,authority=retainedPrincipalAuthority(deps,ctx);
   if(request.path===CALLING_PREPARATION_PATHS.read){
    const input=callingPreparationReadInputSchema.safeParse(request.body);if(!input.success)return {status:400,body:{error:'malformed_body'}};
    const body=await readCallingPreparation(ctx,input.data,authority);
    if(body.state==='available')sourceDeadline=Date.parse(body.phone.expiresAt);
    // Keep source lifecycle custody through the final principal wait. Source or
    // member withdrawal cannot commit between this projection and publication.
    if(!await privatePrincipalIsCurrent(deps))throw new CallingAuthorityChanged();
    if(sourceDeadline!==null&&Math.max(Date.now(),deps.auth.now().getTime())>=sourceDeadline)return {status:409,body:{error:'source_changed'}};
    return {status:200,body};
   }
   const input=callingPreparationReceiptInputSchema.safeParse(request.body);if(!input.success)return {status:400,body:{error:'malformed_body'}};
   return {status:200,body:await readCallingPreparationReceipt(ctx,input.data,deps.principal.deviceId,authority)};
  });
  // Historical command replay skips work/beforeCommit. It still requires the
  // original current principal; its opaque IDs never constitute a current view.
  if(request.path!==CALLING_PREPARATION_PATHS.read&&!await privatePrincipalIsCurrent(deps))throw new CallingAuthorityChanged();
  // No I/O follows this wall-clock fence. A late principal lookup cannot publish
  // a phone/profile whose original source grant expired while that lookup waited.
  if(sourceDeadline!==null&&Math.max(Date.now(),deps.auth.now().getTime())>=sourceDeadline)return {status:409,body:{error:'source_changed'}};
  return answer;
 }catch(error){
  if(error instanceof CallingAuthorityChanged||error instanceof CallingPreparationChanged&&error.reason==='authority_changed')return {status:401,body:{error:'session_changed'}};
  if(error instanceof CallingPreparationChanged){
   const reason=CALLING_PREPARATION_REFUSALS.find(value=>value===error.reason)??'source_withdrawn';
   return request.path===CALLING_PREPARATION_PATHS.confirm?{status:409,body:{status:'refused',replayed:false,reason}}:{status:409,body:{error:'source_changed'}};
  }
  throw error;
 }
}

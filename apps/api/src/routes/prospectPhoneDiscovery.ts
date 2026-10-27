import {
 PROSPECT_PHONE_DISCOVERY_PATHS,prospectPhoneDiscoveryCommandSchema,prospectPhoneDiscoveryInputSchema,
 prospectPhoneDiscoveryQueuedSchema,prospectPhoneDiscoveryReceiptInputSchema,prospectPhoneDiscoveryReceiptSchema,
 prospectPhoneDiscoveryViewSchema,prospectPhoneDiscoveryReasonSchema,
 PROSPECT_PHONE_REFUSAL_ORIGINAL_PATH,prospectPhoneRefusalOriginalInputSchema,prospectPhoneRefusalOriginalSchema,
} from '@fss/contracts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {readProspectPhoneRefusalOriginal} from '@fss/domain/sourcing/prospectPhoneRefusalOriginal.ts';
import {requestProspectPhoneDiscovery,readProspectPhoneDiscovery,currentProspectPhoneDiscoveryAuthority,ProspectPhoneDiscoveryAuthorityChanged,ProspectPhoneDiscoveryUnavailable} from '@fss/domain/sourcing/prospectPhoneDiscovery.ts';
import type {RepositoryContext} from '@fss/domain/db/workspaceScope.ts';
import {contextForPrincipal,runRouteCommand,commandReply,type RouteDeps} from './routeSupport.ts';
import {retainedPrincipalAuthority,retainedPrincipalPublicationAuthority} from './retainedPrincipalAuthority.ts';
import {privatePrincipalIsCurrent,privateAuthorityRefusal} from './privateReadAuthority.ts';
import {policyRouteDeps} from './dialSupport.ts';
import type {ApiRequest,RouteResult,RoutingOptions} from './types.ts';

export const PROSPECT_PHONE_DISCOVERY_COMMAND_KIND='sourcing.phone_discover' as const;
const readPaths=[...PROSPECT_PHONE_DISCOVERY_PATHS,PROSPECT_PHONE_REFUSAL_ORIGINAL_PATH];

/** Public Router contract used directly by moduleOf, with normal authentication. */
export async function routeProspectPhoneDiscovery(request:ApiRequest,options:RoutingOptions):Promise<RouteResult|null> {
 if(!(readPaths as readonly string[]).includes(request.path))return null;
 const prepared=await policyRouteDeps(request,options);if(!prepared.ok)return prepared.result;
 return routeProspectPhoneDiscoveryForPrincipal(prepared.deps);
}

/** Principal-scoped composition seam for controlled adapter tests. */
export async function routeProspectPhoneDiscoveryForPrincipal(deps:RouteDeps):Promise<RouteResult> {
 try{return await routePhoneDiscoveryWithAuthority(deps);}
 catch(error){
  if(error instanceof ProspectPhoneDiscoveryAuthorityChanged)return privateAuthorityRefusal();
  if(error instanceof ProspectPhoneDiscoveryUnavailable){
   const reason=prospectPhoneDiscoveryReasonSchema.safeParse(error.reason);
   if(!reason.success)return {status:409,body:{error:'discovery_unavailable'}};
   return reason.data==='authority_changed'?privateAuthorityRefusal():commandReply({status:'refused',replayed:false,reason:reason.data});
  }
  throw error;
 }
}

/** Closed adapters. Requests commit in the ordinary command transaction;
 * reads and receipt reconciliation cannot request, renew or redispatch capture. */
async function routePhoneDiscoveryWithAuthority(deps:RouteDeps):Promise<RouteResult> {
 const {request,principal}=deps;
 if(!(readPaths as readonly string[]).includes(request.path))return {status:404,body:{error:'not_found'}};
 if(request.method!=='POST')return {status:405,body:{error:'method_not_allowed'}};
 if(principal.role!=='admin')return {status:403,body:{error:'admin_only'}};
 const scoped=contextForPrincipal(deps.auth,principal);if(!scoped.ok)return scoped.result;
 if(request.path===PROSPECT_PHONE_REFUSAL_ORIGINAL_PATH){
  const parsed=prospectPhoneRefusalOriginalInputSchema.safeParse(request.body);if(!parsed.success)return {status:400,body:{error:'malformed_body'}};
  return withTransaction(deps.auth.db,async()=>{
   // Authenticate inside the transaction before the final locked current reads.
   // There is no post-read authentication wait outside the source/run locks.
   if(!await privatePrincipalIsCurrent(deps))return privateAuthorityRefusal();
   const publication=retainedPrincipalPublicationAuthority(deps,scoped.context);
   const result=await readProspectPhoneRefusalOriginal(scoped.context,parsed.data,publication.authority,publication.publicationNow);
   return !result.ok?result.reason==='authority_changed'?privateAuthorityRefusal():{status:409,body:{error:result.reason}}:
    {status:200,body:prospectPhoneRefusalOriginalSchema.parse(result.value)};
  });
 }
 let answer:RouteResult;
 if(request.path===PROSPECT_PHONE_DISCOVERY_PATHS[0]){
  let beforeCommit:((ctx:RepositoryContext)=>Promise<void>)|undefined;
  answer=await runRouteCommand(deps,prospectPhoneDiscoveryCommandSchema,PROSPECT_PHONE_DISCOVERY_COMMAND_KIND,async(ctx,body)=>{
   const {commandId:_id,clientVersion:_version,...input}=body;
   const result=await requestProspectPhoneDiscovery(ctx,input,retainedPrincipalAuthority(deps,ctx));
   if(!result.ok)return result;
   const queued=prospectPhoneDiscoveryQueuedSchema.parse(result.value);
   // The receipt INSERT/audit trigger can wait after the domain request returns.
   // Throwing here rolls run/job/receipt back together, never re-dispatches.
   beforeCommit=current=>currentProspectPhoneDiscoveryAuthority(current,input,queued.runId,retainedPrincipalAuthority(deps,current));
   return {ok:true,value:queued};
  },async ctx=>{await beforeCommit?.(ctx);});
 }else if(request.path===PROSPECT_PHONE_DISCOVERY_PATHS[1]){
  const parsed=prospectPhoneDiscoveryInputSchema.safeParse(request.body);if(!parsed.success)return {status:400,body:{error:'malformed_body'}};
  const result=await withTransaction(deps.auth.db,()=>readProspectPhoneDiscovery(scoped.context,parsed.data,retainedPrincipalAuthority(deps,scoped.context)));
  answer=!result.ok?result.reason==='authority_changed'?privateAuthorityRefusal():{status:409,body:{error:result.reason}}:
   result.value===null?{status:404,body:{error:'not_found'}}:{status:200,body:prospectPhoneDiscoveryViewSchema.parse(result.value)};
 }else{
  const parsed=prospectPhoneDiscoveryReceiptInputSchema.safeParse(request.body);if(!parsed.success)return {status:400,body:{error:'malformed_body'}};
  answer=await withTransaction(deps.auth.db,async()=>{
   const ctx=scoped.context,p=principal,input=parsed.data;
   const receipt=(await ctx.db.query<{result_status:string;result:unknown}>(`SELECT r.result_status,r.result FROM command_receipts r
    JOIN devices d ON d.workspace_id=r.workspace_id AND d.id=r.device_id
    WHERE r.workspace_id=$1 AND r.command_id=$2 AND r.device_id=$3 AND d.user_id=$4 AND r.command_kind=$5 AND r.payload_hash=$6`,
   [p.workspaceId,input.commandId,p.deviceId,p.userId,PROSPECT_PHONE_DISCOVERY_COMMAND_KIND,input.payloadHash])).rows[0];
   // Reauthenticate after the lookup wait, under device/session share locks. A
   // historical receipt is custody only, never current source/content authority.
   if(!await retainedPrincipalAuthority(deps,ctx)())return privateAuthorityRefusal();
   const ids=receipt?.result_status==='accepted'?prospectPhoneDiscoveryQueuedSchema.safeParse(receipt.result):null;
   const body=receipt?.result_status==='refused'?{state:'refused'}:ids?.success?{state:'accepted',result:ids.data}:{state:'unknown'};
   return {status:200,body:prospectPhoneDiscoveryReceiptSchema.parse(body)};
  });
 }
 return await privatePrincipalIsCurrent(deps)?answer:privateAuthorityRefusal();
}

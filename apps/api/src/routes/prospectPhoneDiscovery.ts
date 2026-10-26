import {
 PROSPECT_PHONE_DISCOVERY_PATHS,prospectPhoneDiscoveryCommandSchema,prospectPhoneDiscoveryInputSchema,
 prospectPhoneDiscoveryQueuedSchema,prospectPhoneDiscoveryReceiptInputSchema,prospectPhoneDiscoveryReceiptSchema,
 prospectPhoneDiscoveryViewSchema,
} from '@fss/contracts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {requestProspectPhoneDiscovery,readProspectPhoneDiscovery} from '@fss/domain/sourcing/prospectPhoneDiscovery.ts';
import {contextForPrincipal,runRouteCommand,type RouteDeps} from './routeSupport.ts';
import {retainedPrincipalAuthority} from './retainedPrincipalAuthority.ts';
import {privatePrincipalIsCurrent,privateAuthorityRefusal} from './privateReadAuthority.ts';
import type {RouteResult} from './types.ts';

export const PROSPECT_PHONE_DISCOVERY_COMMAND_KIND='sourcing.phone_discover' as const;

/** Three closed adapters. Requests commit in the ordinary command transaction;
 * reads and receipt reconciliation cannot request, renew or redispatch capture. */
export async function routeProspectPhoneDiscovery(deps:RouteDeps):Promise<RouteResult> {
 const {request,principal}=deps;
 if(!(PROSPECT_PHONE_DISCOVERY_PATHS as readonly string[]).includes(request.path))return {status:404,body:{error:'not_found'}};
 if(request.method!=='POST')return {status:405,body:{error:'method_not_allowed'}};
 if(principal.role!=='admin')return {status:403,body:{error:'admin_only'}};
 const scoped=contextForPrincipal(deps.auth,principal);if(!scoped.ok)return scoped.result;
 let answer:RouteResult;
 if(request.path===PROSPECT_PHONE_DISCOVERY_PATHS[0]){
  answer=await runRouteCommand(deps,prospectPhoneDiscoveryCommandSchema,PROSPECT_PHONE_DISCOVERY_COMMAND_KIND,async(ctx,body)=>{
   const {commandId:_id,clientVersion:_version,...input}=body;
   const result=await requestProspectPhoneDiscovery(ctx,input,retainedPrincipalAuthority(deps,ctx));
   return result.ok?{ok:true,value:prospectPhoneDiscoveryQueuedSchema.parse(result.value)}:result;
  });
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

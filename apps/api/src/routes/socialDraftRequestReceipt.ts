import {socialGuidedRequestReceiptInputSchema,socialGuidedRequestReceiptSchema} from '@fss/contracts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {PrivateDraftAuthorityChanged,requirePrivateDraftAuthority} from '@fss/domain/social/privateDrafts.ts';
import {contextForPrincipal,type RouteDeps} from './routeSupport.ts';
import {privatePrincipalIsCurrent,privateAuthorityRefusal} from './privateReadAuthority.ts';
import {retainedPrincipalAuthority} from './retainedPrincipalAuthority.ts';
import type {RouteResult} from './types.ts';
/** Historical IDs only. Neither missing receipts nor acceptance authorize replay
 * or access to suggestion prose. The original principal is pinned after waits. */
export async function socialDraftRequestReceipt(deps:RouteDeps):Promise<RouteResult>{
 const input=socialGuidedRequestReceiptInputSchema.safeParse(deps.request.body);
 if(!input.success)return {status:400,body:{error:'invalid_input'}};
 const scoped=contextForPrincipal(deps.auth,deps.principal);if(!scoped.ok)return scoped.result;
 try{
  const answer=await withTransaction(deps.auth.db,async()=>{
   const ctx=scoped.context,authority=retainedPrincipalAuthority(deps,ctx),p=deps.principal;
   await requirePrivateDraftAuthority(authority);
   const row=(await ctx.db.query<{result_status:string;result:unknown}>(
    `SELECT r.result_status,r.result FROM command_receipts r JOIN devices d ON d.workspace_id=r.workspace_id AND d.id=r.device_id WHERE r.workspace_id=$1 AND r.command_id=$2 AND r.device_id=$3 AND d.user_id=$4 AND r.command_kind=$5 AND r.payload_hash=$6`,
    [p.workspaceId,input.data.commandId,p.deviceId,p.userId,'social_drafts_request',input.data.payloadSHA256])).rows[0];
   await requirePrivateDraftAuthority(authority);
   const body=socialGuidedRequestReceiptSchema.parse(!row?{state:'unknown'}:row.result_status==='accepted'?{state:'accepted',result:row.result}:{state:'refused',reason:typeof row.result==='string'?row.result:'refused'});
   return {status:200,body};
  });
  if(!await privatePrincipalIsCurrent(deps))return privateAuthorityRefusal();
  return answer;
 }catch(error){if(error instanceof PrivateDraftAuthorityChanged)return privateAuthorityRefusal();throw error;}
}

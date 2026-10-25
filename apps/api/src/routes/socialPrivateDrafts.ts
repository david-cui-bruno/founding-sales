import {socialPrivateDraftSaveCommandSchema,socialPrivateDraftListInputSchema,socialPrivateDraftReadInputSchema,socialPrivateDraftReceiptInputSchema,socialPrivateDraftReceiptSchema} from '@fss/contracts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {saveSocialPrivateDraft,readSocialPrivateDraft,listSocialPrivateDrafts,PrivateDraftAuthorityChanged,requirePrivateDraftAuthority} from '@fss/domain/social/privateDrafts.ts';
import {contextForPrincipal,runRouteCommand,requirePrincipal,type RouteDeps} from './routeSupport.ts';
import {retainedPrincipalAuthority} from './retainedPrincipalAuthority.ts';
import {samePrivatePrincipal} from './privateReadAuthority.ts';
import type {RouteResult} from './types.ts';
export const SOCIAL_PRIVATE_PATHS=['/social/private-drafts/list','/social/private-drafts/read','/social/private-drafts/receipt','/social/private-drafts/save'] as const;
export const SOCIAL_PRIVATE_COMMAND_KIND='social.private_draft_save';
/** No receipt ever stores prose. The ordinary runner alone owns deduplication. */
export async function routeSocialPrivateDrafts(deps:RouteDeps):Promise<RouteResult>{
 const scoped=contextForPrincipal(deps.auth,deps.principal);if(!scoped.ok)return scoped.result;
 const check=async():Promise<void>=>{const fresh=await requirePrincipal(deps.auth,deps.request);if(!fresh.ok||!samePrivatePrincipal(fresh.principal,deps.principal))throw new PrivateDraftAuthorityChanged();};
 try{
  let answer:RouteResult;
  if(deps.request.path===SOCIAL_PRIVATE_PATHS[3]){
   answer=await runRouteCommand(deps,socialPrivateDraftSaveCommandSchema,SOCIAL_PRIVATE_COMMAND_KIND,(ctx,body)=>{
    const {commandId:_id,clientVersion:_version,...input}=body;
    return saveSocialPrivateDraft(ctx,input,retainedPrincipalAuthority(deps,ctx));
   });
  }else{
   const schema=deps.request.path===SOCIAL_PRIVATE_PATHS[0]?socialPrivateDraftListInputSchema:deps.request.path===SOCIAL_PRIVATE_PATHS[1]?socialPrivateDraftReadInputSchema:socialPrivateDraftReceiptInputSchema;
   const parsed=schema.safeParse(deps.request.body);if(!parsed.success)return {status:400,body:{error:'invalid_input'}};
   answer=await withTransaction(deps.auth.db,async()=>{
    const ctx=scoped.context,authority=retainedPrincipalAuthority(deps,ctx);
    await check();
    if('commandId' in parsed.data){
     const p=deps.principal;
     const row=(await ctx.db.query<{result_status:string;result:unknown}>(`SELECT r.result_status,r.result FROM command_receipts r JOIN devices d ON d.workspace_id=r.workspace_id AND d.id=r.device_id WHERE r.workspace_id=$1 AND r.command_id=$2 AND r.device_id=$3 AND d.user_id=$4 AND r.command_kind=$5 AND r.payload_hash=$6`,[p.workspaceId,parsed.data.commandId,p.deviceId,p.userId,SOCIAL_PRIVATE_COMMAND_KIND,parsed.data.payloadSHA256])).rows[0];
     await requirePrivateDraftAuthority(authority);
     const projection=!row?{state:'unknown'}:row.result_status==='accepted'?{state:'accepted',result:row.result}:{state:'refused',reason:typeof row.result==='string'?row.result:'refused'};
     return {status:200,body:socialPrivateDraftReceiptSchema.parse(projection)};
    }
    if('draftId' in parsed.data){const draft=await readSocialPrivateDraft(ctx,parsed.data.draftId,authority);return draft?{status:200,body:{draft}}:{status:404,body:{error:'not_found'}};}
    return {status:200,body:await listSocialPrivateDrafts(ctx,'afterId' in parsed.data?parsed.data.afterId:undefined,authority)};
   });
  }
  await check();
  // Content refusals are ordinary product state, not session invalidation. Keep
  // the ordinary API command contract, project only the exact browser route.
  return answer;
 }catch(error){if(error instanceof PrivateDraftAuthorityChanged)return {status:401,body:{error:'unauthenticated'}};throw error;}
}

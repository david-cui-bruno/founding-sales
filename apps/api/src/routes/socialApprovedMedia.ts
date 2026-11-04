import {socialMediaCompleteCommandSchema,socialMediaApproveCommandSchema,socialMediaWithdrawCommandSchema,socialMediaPreviewInputSchema,socialMediaReceiptInputSchema} from '@fss/contracts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {approveSocialMedia,withdrawSocialMedia,listSocialMedia} from '@fss/domain/social/approvedMedia.ts';
import {socialAssetObject} from '@fss/domain/social/assets.ts';
import {PrivateDraftAuthorityChanged,requirePrivateDraftAuthority} from '@fss/domain/social/privateDrafts.ts';
import {completeSanitizedSocialMedia} from '../social/completeMedia.ts';
import type {SocialMediaStore} from '../social/mediaStore.ts';
import {contextForPrincipal,runRouteCommand,type RouteDeps} from './routeSupport.ts';
import {retainedPrincipalAuthority} from './retainedPrincipalAuthority.ts';
import type {RouteResult} from './types.ts';
export const SOCIAL_APPROVED_MEDIA_PATHS=['/social/media/complete','/social/media/list','/social/media/approve','/social/media/withdraw','/social/media/preview','/social/media/receipt'] as const;
export async function handleSocialApprovedMediaRoute(deps:RouteDeps,store:SocialMediaStore|null):Promise<RouteResult>{
 const scoped=contextForPrincipal(deps.auth,deps.principal);if(!scoped.ok)return scoped.result;
 const ctx=scoped.context,authority=retainedPrincipalAuthority(deps,ctx);
 try{
  let result:RouteResult;
  if(deps.request.path==='/social/media/complete'){
   if(!store)return {status:503,body:{error:'social_media_not_configured'}};
   result=await runRouteCommand(deps,socialMediaCompleteCommandSchema,'social_media_complete',(c,input)=>completeSanitizedSocialMedia(c,input,store,retainedPrincipalAuthority(deps,c)));
  }else if(deps.request.path==='/social/media/approve')result=await runRouteCommand(deps,socialMediaApproveCommandSchema,'social_media_approve',(c,input)=>{const {commandId:_id,clientVersion:_version,...approval}=input;return approveSocialMedia(c,approval,retainedPrincipalAuthority(deps,c));});
  else if(deps.request.path==='/social/media/withdraw')result=await runRouteCommand(deps,socialMediaWithdrawCommandSchema,'social_media_withdraw',(c,input)=>withdrawSocialMedia(c,input,retainedPrincipalAuthority(deps,c)));
  else result=await withTransaction(deps.auth.db,async()=>{
   await requirePrivateDraftAuthority(authority);
   if(deps.request.path==='/social/media/list'){const media=await listSocialMedia(ctx);await requirePrivateDraftAuthority(authority);return {status:200,body:{media}};}
   if(deps.request.path==='/social/media/receipt'){
    const parsed=socialMediaReceiptInputSchema.safeParse(deps.request.body);if(!parsed.success)return {status:400,body:{error:'invalid_input'}};
    const kinds={register:'social_asset_register',complete:'social_media_complete',approve:'social_media_approve',withdraw:'social_media_withdraw',delete:'social_asset_delete'},p=deps.principal;
    const row=(await ctx.db.query<{result_status:string;result:unknown}>(`SELECT r.result_status,r.result FROM command_receipts r JOIN devices d ON d.workspace_id=r.workspace_id AND d.id=r.device_id WHERE r.workspace_id=$1 AND r.command_id=$2 AND r.device_id=$3 AND d.user_id=$4 AND r.command_kind=$5 AND r.payload_hash=$6`,[p.workspaceId,parsed.data.commandId,p.deviceId,p.userId,kinds[parsed.data.kind],parsed.data.payloadSHA256])).rows[0];
    await requirePrivateDraftAuthority(authority);
    return {status:200,body:!row?{state:'unknown'}:row.result_status==='accepted'?{state:'accepted',result:row.result}:{state:'refused',reason:typeof row.result==='string'?row.result:'refused'}};
   }
   const parsed=socialMediaPreviewInputSchema.safeParse(deps.request.body);if(!parsed.success)return {status:400,body:{error:'invalid_input'}};
   const object=await socialAssetObject(ctx,parsed.data,'download');if(!object||object.sha256!==parsed.data.sha256)return {status:404,body:{error:'not_found'}};
   if(!store)return {status:503,body:{error:'social_media_not_configured'}};
   const preview=await store.presignGet(object.object_key);await requirePrivateDraftAuthority(authority);return {status:200,body:preview};
  });
  // A replay is not a principal lease; reauthenticate after receipt/row waits.
  await requirePrivateDraftAuthority(authority);return result;
 }catch(error){if(error instanceof PrivateDraftAuthorityChanged)return {status:401,body:{error:'unauthenticated'}};if(error instanceof Error&&error.message==='media_store_unavailable')return {status:503,body:{error:'storage_unavailable'}};throw error;}
}

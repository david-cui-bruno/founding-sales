import {socialWeeklyCommandSchema} from '@fss/contracts';
import {readSocialWeekly,saveSocialWeekly} from '@fss/domain/social/weekly.ts';
import {readSocialDraftWorkspace,socialDraftView} from '@fss/domain/social/draftWorkspace.ts';
import {socialDraftRequestCommandSchema} from '@fss/contracts';
import {requestSocialDrafts,readSocialDraftRequest} from '@fss/domain/social/drafts.ts';
import {socialConnectionCommandSchema,socialDisconnectCommandSchema} from '@fss/contracts';
import {saveSocialConnection,disconnectSocialAccount} from '@fss/domain/social/accounts.ts';
import {socialPostSaveCommandSchema,socialPostActionCommandSchema,socialBeginCommandSchema,socialObservationCommandSchema} from '@fss/contracts';
import {saveSocialPost,approveSocialPost,requestSocialCancellation,readSocialWorkspace} from '@fss/domain/social/posts.ts';
import {claimSocialDelivery,beginSocialSubmission,recordSocialObservation} from '@fss/domain/social/delivery.ts';
import {z} from 'zod';
import {uuid,socialAssetRegisterCommandSchema,socialAssetCompleteCommandSchema,socialAssetDeleteCommandSchema} from '@fss/contracts';
import {readSocialAsset,registerSocialAsset,completeSocialAsset,deleteSocialAsset,listSocialAssets,socialAssetObject} from '@fss/domain/social/assets.ts';
import {contextForPrincipal,requirePrincipal,runRouteCommand} from './routeSupport.ts';
import type {ApiRequest,RouteResult,RoutingOptions} from './types.ts';
export const SOCIAL_PATHS=['/social/weekly','/social/weekly/save','/social/drafts','/social/drafts/request','/social/drafts/read','/social','/social/accounts/connect','/social/accounts/disconnect','/social/posts/save','/social/posts/approve','/social/posts/cancel','/social/delivery/claim','/social/delivery/begin','/social/delivery/observe','/social/assets','/social/assets/read','/social/assets/register','/social/assets/complete','/social/assets/delete','/social/assets/upload-url','/social/assets/download-url'];
export async function routeSocial(request:ApiRequest,options:RoutingOptions):Promise<RouteResult|null>{
 if(!SOCIAL_PATHS.includes(request.path))return null;if(request.method!=='POST')return {status:405,body:{error:'method_not_allowed'}};
 const auth=options.auth;if(!auth)return {status:404,body:{error:'not_found'}};
 const principal=await requirePrincipal(auth,request);if(!principal.ok)return principal.result;const scoped=contextForPrincipal(auth,principal.principal);if(!scoped.ok)return scoped.result;
 const ctx=scoped.context,deps={auth,request,principal:principal.principal};
 if(request.path==='/social/weekly'){if(!z.strictObject({}).safeParse(request.body).success)return {status:400,body:{error:'invalid_input'}};return {status:200,body:await readSocialWeekly(ctx)};}
 if(request.path==='/social/weekly/save')return runRouteCommand(deps,socialWeeklyCommandSchema,'social_weekly_save',(c,input)=>saveSocialWeekly(c,{enabled:input.enabled,expectedRevision:input.expectedRevision}));
 if(request.path==='/social/drafts'){if(!z.strictObject({}).safeParse(request.body).success)return {status:400,body:{error:'invalid_input'}};return {status:200,body:await readSocialDraftWorkspace(ctx)};}
 if(request.path==='/social/drafts/request')return runRouteCommand(deps,socialDraftRequestCommandSchema,'social_drafts_request',(c,input)=>{const {commandId:_id,clientVersion:_client,...selection}=input;return requestSocialDrafts(c,selection);});
 if(request.path==='/social/drafts/read'){
  const parsed=z.strictObject({requestId:uuid}).safeParse(request.body);if(!parsed.success)return {status:400,body:{error:'invalid_input'}};
  const row=await readSocialDraftRequest(ctx,parsed.data.requestId);if(!row)return {status:404,body:{error:'not_found'}};
  return {status:200,body:{request:socialDraftView(row)}};
 }
 if(request.path==='/social/accounts/connect')return runRouteCommand(deps,socialConnectionCommandSchema,'social_account_connect',(c,input)=>{const {commandId:_id,clientVersion:_client,...connection}=input;return saveSocialConnection(c,connection);});
 if(request.path==='/social/accounts/disconnect')return runRouteCommand(deps,socialDisconnectCommandSchema,'social_account_disconnect',disconnectSocialAccount);
 if(request.path==='/social'){const parsed=z.strictObject({afterId:uuid.optional()}).safeParse(request.body);if(!parsed.success)return {status:400,body:{error:'invalid_input'}};return {status:200,body:await readSocialWorkspace(ctx,parsed.data.afterId)};}
 if(request.path==='/social/posts/save')return runRouteCommand(deps,socialPostSaveCommandSchema,'social_post_save',(c,input)=>{const {commandId:_id,clientVersion:_client,...post}=input;return saveSocialPost(c,post);});
 if(request.path==='/social/posts/approve')return runRouteCommand(deps,socialPostActionCommandSchema,'social_post_approve',approveSocialPost);
 if(request.path==='/social/posts/cancel')return runRouteCommand(deps,socialPostActionCommandSchema,'social_post_cancel',requestSocialCancellation);
 if(request.path==='/social/delivery/claim')return runRouteCommand(deps,socialPostActionCommandSchema,'social_delivery_claim',(c,input)=>claimSocialDelivery(c,{...input,deviceId:principal.principal.deviceId}));
 if(request.path==='/social/delivery/begin'){
  const answer=await runRouteCommand(deps,socialBeginCommandSchema,'social_delivery_begin',(c,input)=>beginSocialSubmission(c,{...input,deviceId:principal.principal.deviceId}));
  // A durable submission marker is not a reusable authorization to click again.
  if(answer.status===200&&(answer.body as {replayed?:boolean}).replayed)return {status:409,body:{error:'inspect_existing_submission'}};
  return answer;
 }
 if(request.path==='/social/delivery/observe')return runRouteCommand(deps,socialObservationCommandSchema,'social_delivery_observe',(c,input)=>recordSocialObservation(c,{...input,deviceId:principal.principal.deviceId}));
 if(request.path==='/social/assets'){const parsed=z.strictObject({afterId:uuid.optional()}).safeParse(request.body);if(!parsed.success)return {status:400,body:{error:'invalid_input'}};return {status:200,body:{assets:await listSocialAssets(ctx,parsed.data.afterId)}};}
 if(request.path==='/social/assets/read'){const parsed=z.strictObject({assetId:uuid}).safeParse(request.body);if(!parsed.success)return {status:400,body:{error:'invalid_input'}};const asset=await readSocialAsset(ctx,parsed.data.assetId);return asset&&asset.state!=='deleted'?{status:200,body:{asset}}:{status:404,body:{error:'not_found'}};}
 if(request.path==='/social/assets/delete')return runRouteCommand(deps,socialAssetDeleteCommandSchema,'social_asset_delete',(c,input)=>deleteSocialAsset(c,input.assetId));
 const store=options.socialMedia;if(!store)return {status:503,body:{error:'social_media_not_configured'}};
 if(request.path==='/social/assets/register')return runRouteCommand(deps,socialAssetRegisterCommandSchema,'social_asset_register',(c,input)=>{const {commandId:_id,clientVersion:_client,...asset}=input;return registerSocialAsset(c,asset);});
 try{
 if(request.path==='/social/assets/complete')return await runRouteCommand(deps,socialAssetCompleteCommandSchema,'social_asset_complete',async(c,input)=>{
  // Completed command retries are served by runRouteCommand; new commands must still name a live object.
  const object=await socialAssetObject(c,input,'upload');if(!object)return {ok:false,reason:'upload_unavailable'};
  const observed=await store.head(object.object_key);if(!observed.found)throw new Error('social_object_missing');
  if(observed.uploadId!==input.uploadId)return {ok:false,reason:'object_mismatch'};
  return completeSocialAsset(c,{assetId:input.assetId,uploadId:input.uploadId,verified:observed});
 });
 const upload=request.path==='/social/assets/upload-url';
 const parsed=(upload?z.strictObject({assetId:uuid,uploadId:uuid}):z.strictObject({assetId:uuid,version:z.number().int().positive()})).safeParse(request.body);
 if(!parsed.success)return {status:400,body:{error:'invalid_input'}};
 const object=await socialAssetObject(ctx,parsed.data,upload?'upload':'download');if(!object)return {status:404,body:{error:'not_found'}};
 return {status:200,body:upload?await store.presignPut({key:object.object_key,sha256:object.sha256,bytes:object.bytes,mime:object.mime,uploadId:object.upload_id,issuedAt:new Date(object.authorized_at).toISOString()}):await store.presignGet(object.object_key)};
 }catch(error){if(error instanceof Error&&error.message==='social_object_missing')return {status:409,body:{error:'object_missing'}};if(error instanceof Error&&error.message==='media_store_unavailable')return {status:503,body:{error:'storage_unavailable'}};throw error;}
}

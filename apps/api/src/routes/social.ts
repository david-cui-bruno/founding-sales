import {z} from 'zod';
import {uuid,socialAssetRegisterCommandSchema,socialAssetCompleteCommandSchema,socialAssetDeleteCommandSchema} from '@fss/contracts';
import {registerSocialAsset,completeSocialAsset,deleteSocialAsset,listSocialAssets,socialAssetObject} from '@fss/domain/social/assets.ts';
import {contextForPrincipal,requirePrincipal,runRouteCommand} from './routeSupport.ts';
import type {ApiRequest,RouteResult,RoutingOptions} from './types.ts';
export const SOCIAL_PATHS=['/social/assets','/social/assets/register','/social/assets/complete','/social/assets/delete','/social/assets/upload-url','/social/assets/download-url'];
export async function routeSocial(request:ApiRequest,options:RoutingOptions):Promise<RouteResult|null>{
 if(!SOCIAL_PATHS.includes(request.path))return null;if(request.method!=='POST')return {status:405,body:{error:'method_not_allowed'}};
 const auth=options.auth;if(!auth)return {status:404,body:{error:'not_found'}};
 const principal=await requirePrincipal(auth,request);if(!principal.ok)return principal.result;const scoped=contextForPrincipal(auth,principal.principal);if(!scoped.ok)return scoped.result;
 const ctx=scoped.context,deps={auth,request,principal:principal.principal};
 if(request.path==='/social/assets'){const parsed=z.strictObject({afterId:uuid.optional()}).safeParse(request.body);if(!parsed.success)return {status:400,body:{error:'invalid_input'}};return {status:200,body:{assets:await listSocialAssets(ctx,parsed.data.afterId)}};}
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
 return {status:200,body:upload?await store.presignPut({key:object.object_key,sha256:object.sha256,bytes:object.bytes,mime:object.mime,uploadId:object.upload_id}):await store.presignGet(object.object_key)};
 }catch(error){if(error instanceof Error&&error.message==='social_object_missing')return {status:409,body:{error:'object_missing'}};if(error instanceof Error&&error.message==='media_store_unavailable')return {status:503,body:{error:'storage_unavailable'}};throw error;}
}

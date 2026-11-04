import {z} from 'zod';
import {uuid} from '@fss/contracts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {socialAssetObject} from '@fss/domain/social/assets.ts';
import {PrivateDraftAuthorityChanged,requirePrivateDraftAuthority} from '@fss/domain/social/privateDrafts.ts';
import type {SocialMediaStore} from '../social/mediaStore.ts';
import {contextForPrincipal,type RouteDeps} from './routeSupport.ts';
import {retainedPrincipalAuthority} from './retainedPrincipalAuthority.ts';
import type {RouteResult} from './types.ts';
/** URL issuance retains the same exact principal through ownership and signer waits. */
export async function routeSocialAssetUrl(deps:RouteDeps,store:SocialMediaStore):Promise<RouteResult>{
 const scoped=contextForPrincipal(deps.auth,deps.principal);if(!scoped.ok)return scoped.result;
 const upload=deps.request.path==='/social/assets/upload-url';
 const parsed=(upload?z.strictObject({assetId:uuid,uploadId:uuid}):z.strictObject({assetId:uuid,version:z.number().int().positive()})).safeParse(deps.request.body);
 if(!parsed.success)return {status:400,body:{error:'invalid_input'}};
 const ctx=scoped.context,authority=retainedPrincipalAuthority(deps,ctx);
 try{
  const result=await withTransaction(deps.auth.db,async():Promise<RouteResult>=>{
   await requirePrivateDraftAuthority(authority);
   const object=await socialAssetObject(ctx,parsed.data,upload?'upload':'download');
   await requirePrivateDraftAuthority(authority);
   if(!object)return {status:404,body:{error:'not_found'}};
   const signed=upload?await store.presignPut({key:object.object_key,sha256:object.sha256,bytes:object.bytes,mime:object.mime,uploadId:object.upload_id,issuedAt:new Date(object.authorized_at).toISOString()}):await store.presignGet(object.object_key);
   await requirePrivateDraftAuthority(authority);
   return {status:200,body:signed};
  });
  await requirePrivateDraftAuthority(authority);
  return result;
 }catch(error){
  if(error instanceof PrivateDraftAuthorityChanged)return {status:401,body:{error:'unauthenticated'}};
  if(error instanceof Error&&error.message==='media_store_unavailable')return {status:503,body:{error:'storage_unavailable'}};
  throw error;
 }
}

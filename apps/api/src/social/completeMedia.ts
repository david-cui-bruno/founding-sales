import type {RepositoryContext} from '@fss/domain/db/workspaceScope.ts';
import {socialAssetObject,queueSocialAssetDeletion} from '@fss/domain/social/assets.ts';
import {requirePrivateDraftAuthority,type PrivateDraftAuthority} from '@fss/domain/social/privateDrafts.ts';
import type {SocialMediaStore} from './mediaStore.ts';
import {sanitizeSocialImage,InvalidSocialImage} from './sanitizeMedia.ts';
export async function completeSanitizedSocialMedia(ctx:RepositoryContext,input:{assetId:string;uploadId:string},store:SocialMediaStore,authority:PrivateDraftAuthority){
 // Global quota lock ordering matches registration, removal and physical deletion.
 await ctx.db.query('SELECT 1 FROM social_library_usage WHERE workspace_id=$1 FOR UPDATE',[ctx.scope.workspaceId]);
 await requirePrivateDraftAuthority(authority);
 const original=await socialAssetObject(ctx,input,'upload');if(!original||original.kind!=='original')return {ok:false as const,reason:'upload_unavailable'};
 let image;
 try{image=await sanitizeSocialImage(await store.read(original.object_key,20*1024*1024),original);}catch(error){
  if(!(error instanceof InvalidSocialImage))throw error;
  await queueSocialAssetDeletion(ctx,input.assetId);
  await ctx.db.query("UPDATE social_assets SET state='deleted',deleted_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2",[ctx.scope.workspaceId,input.assetId]);
  return {ok:false as const,reason:'invalid_image'};
 }
 await requirePrivateDraftAuthority(authority);
 if(!await socialAssetObject(ctx,input,'upload'))return {ok:false as const,reason:'upload_unavailable'};
 const derivative=(await ctx.db.query<{object_key:string;bytes:number}>('SELECT object_key,bytes FROM social_asset_objects WHERE workspace_id=$1 AND asset_id=$2 AND version=2 FOR UPDATE',[ctx.scope.workspaceId,input.assetId])).rows[0];
 if(!derivative)return {ok:false as const,reason:'upload_unavailable'};
 await store.put({key:derivative.object_key,body:image.body,mime:image.mime,sha256:image.sha256});
 await requirePrivateDraftAuthority(authority);
 if(!await socialAssetObject(ctx,input,'upload'))return {ok:false as const,reason:'upload_unavailable'};
 await ctx.db.query("UPDATE social_asset_objects SET state='ready',sanitized=true,sha256=$3,bytes=$4,mime=$5,width=$6,height=$7,completed_at=clock_timestamp() WHERE workspace_id=$1 AND asset_id=$2 AND version=2",[ctx.scope.workspaceId,input.assetId,image.sha256,image.bytes,image.mime,image.width,image.height]);
 await ctx.db.query('UPDATE social_library_usage SET bytes_reserved=bytes_reserved-$2+$3 WHERE workspace_id=$1',[ctx.scope.workspaceId,derivative.bytes,image.bytes]);
 await queueSocialAssetDeletion(ctx,input.assetId,1);
 await ctx.db.query("UPDATE social_assets SET state='ready',current_version=2 WHERE workspace_id=$1 AND id=$2",[ctx.scope.workspaceId,input.assetId]);
 return {ok:true as const,value:{assetId:input.assetId,version:2,sha256:image.sha256}};
}

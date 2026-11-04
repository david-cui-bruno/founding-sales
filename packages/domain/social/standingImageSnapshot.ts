import type {PostRevision} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import type {SocialResult} from './posts.ts';
import {socialAssetObject} from './assets.ts';
import {readApprovedSocialMediaForOwner} from './approvedMedia.ts';
/** Same immutable image snapshot for manual approval and explicit worker delegation. */
export async function socialApprovalImages(ctx:RepositoryContext,post:PostRevision,ownerUserId:string|null):Promise<SocialResult<Record<string,unknown>[]>>{
 const images:Record<string,unknown>[]=[];const seen=new Set<string>();
 for(const image of post.images){
  const key=`${image.assetId}:${image.version}`;if(seen.has(key))return {ok:false,reason:'duplicate_image'};seen.add(key);
  if(ctx.scope.actor.kind==='system'){
   const digest=(await ctx.db.query<{sha256:string}>("SELECT sha256 FROM social_asset_objects WHERE workspace_id=$1 AND asset_id=$2 AND version=$3 AND state='ready' AND kind='derivative'",[ctx.scope.workspaceId,image.assetId,image.version])).rows[0]?.sha256;
   if(!digest||!ownerUserId)return {ok:false,reason:'image_unavailable'};
   const media=await readApprovedSocialMediaForOwner(ctx,ownerUserId,{assetId:image.assetId,version:image.version,sha256:digest});
   if(!media||media.altText!==image.altText)return {ok:false,reason:'image_unavailable'};
   images.push({...image,sha256:media.sha256,mime:media.mime,width:media.width,height:media.height,approvalRevision:media.approvalRevision});
  }else{
   const object=await socialAssetObject(ctx,{assetId:image.assetId,version:image.version},'download');
   if(!object||object.kind!=='derivative')return {ok:false,reason:'image_unavailable'};
   images.push({...image,sha256:object.sha256,mime:object.mime,width:object.width,height:object.height});
  }
 }return {ok:true,value:images};
}

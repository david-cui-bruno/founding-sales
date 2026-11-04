import type {RepositoryContext} from '../../db/workspaceScope.ts';
import {approveSocialMedia} from '../../social/approvedMedia.ts';
/** Domain tests start after the real sanitizer boundary; API tests exercise actual bytes. */
export async function approveSanitizedMediaFixture(ctx:RepositoryContext,assetId:string,sha256:string,altText:string){
 await ctx.db.query("UPDATE social_asset_objects SET state='ready',sanitized=true,sha256=$3,mime='image/png',bytes=100,width=10,height=10 WHERE workspace_id=$1 AND asset_id=$2 AND version=2",[ctx.scope.workspaceId,assetId,sha256]);
 await ctx.db.query('UPDATE social_library_usage SET bytes_reserved=bytes_reserved-5242880+100 WHERE workspace_id=$1',[ctx.scope.workspaceId]);
 await ctx.db.query("UPDATE social_assets SET state='ready',current_version=2 WHERE workspace_id=$1 AND id=$2",[ctx.scope.workspaceId,assetId]);
 const result=await approveSocialMedia(ctx,{assetId,version:2,sha256,expectedApprovalRevision:0,caption:'Synthetic owned screenshot',topic:'engineering',altText,publicUseClearance:true},async()=>true);
 if(!result.ok)throw Error(result.reason);return result.value;
}

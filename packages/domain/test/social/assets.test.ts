import {beforeAll,afterAll,it,expect} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {withTransaction} from '../../db/queryable.ts';
import {registerSocialAsset,deleteSocialAsset,readSocialAsset,expireSocialUploads,socialAssetObject,recordSocialObjectDeletion} from '../../social/assets.ts';
import {approveSocialMedia,withdrawSocialMedia,readApprovedSocialMediaForOwner} from '../../social/approvedMedia.ts';
let db:TestDatabase,seed:TwoWorkspaces;
const ctx=(other=false)=>{const s=other?seed.beta:seed.alpha;return repositoryContext(workspaceScope(s.workspaceId,{kind:'user',userId:s.admin.userId,role:'admin'}),db.session);};
const tx=<T>(f:()=>Promise<T>)=>withTransaction(db.session,f);
const original={sha256:'a'.repeat(64),bytes:100,mime:'image/jpeg' as const,origin:{kind:'upload' as const,sourceUrl:null,usageNote:null}};
beforeAll(async()=>{db=await createTestDatabase();seed=await seedTwoWorkspaces(db.session);});afterAll(async()=>db.drop());
async function registered(){const result=await tx(()=>registerSocialAsset(ctx(),original));if(!result.ok)throw Error(result.reason);return result.value;}
async function sanitized(){const r=await registered();await db.session.query("UPDATE social_asset_objects SET state='ready',sanitized=true,sha256=$3,width=40,height=20 WHERE workspace_id=$1 AND asset_id=$2 AND version=2",[seed.alpha.workspaceId,r.assetId,'b'.repeat(64)]);await db.session.query("UPDATE social_assets SET state='ready',current_version=2 WHERE workspace_id=$1 AND id=$2",[seed.alpha.workspaceId,r.assetId]);return {...r,version:2,sha256:'b'.repeat(64)};}
it('reserves original plus deterministic derivative before processing; original is never downloadable',async()=>{
 const r=await registered();expect(await readSocialAsset(ctx(true),r.assetId)).toBeNull();expect(await socialAssetObject(ctx(),{assetId:r.assetId,version:1},'download')).toBeNull();
 const objects=(await db.session.query<{object_key:string;bytes:number}>('SELECT object_key,bytes FROM social_asset_objects WHERE workspace_id=$1 AND asset_id=$2 ORDER BY version',[seed.alpha.workspaceId,r.assetId])).rows;expect(objects).toHaveLength(2);expect(objects[1]!.object_key).toBe(`${objects[0]!.object_key}/sanitized`);expect(objects[1]!.bytes).toBe(5*1024*1024);
});
it('expires abandoned and crashed uploads with both reserved keys and URL expiry grace',async()=>{
 const r=await registered();await db.session.query("UPDATE social_asset_objects SET expires_at=now()-interval '1 minute' WHERE workspace_id=$1 AND upload_id=$2",[seed.alpha.workspaceId,r.uploadId]);await tx(()=>expireSocialUploads(ctx()));
 expect(await readSocialAsset(ctx(),r.assetId)).toMatchObject({state:'deleted'});
 const rows=(await db.session.query<{waiting:boolean}>('SELECT next_attempt_at>now()+interval \'9 minutes\' AS waiting FROM social_object_deletions WHERE workspace_id=$1 AND asset_id=$2',[seed.alpha.workspaceId,r.assetId])).rows;expect(rows).toHaveLength(2);expect(rows.every(row=>row.waiting)).toBe(true);
});
it('binds approval to exact sanitized version/digest, fences stale edits and physically queues withdrawal',async()=>{
 const r=await sanitized(),input={assetId:r.assetId,version:2,sha256:r.sha256,expectedApprovalRevision:0,caption:'Synthetic release screenshot',topic:'engineering',altText:'A synthetic blue rectangle',publicUseClearance:true as const};
 expect(await tx(()=>approveSocialMedia(ctx(),{...input,sha256:'c'.repeat(64)},async()=>true))).toMatchObject({ok:false,reason:'media_unavailable'});
 expect(await tx(()=>approveSocialMedia(ctx(),input,async()=>true))).toMatchObject({ok:true,value:{approvalRevision:1}});
 expect(await tx(()=>approveSocialMedia(ctx(),input,async()=>true))).toMatchObject({ok:false,reason:'stale_approval'});
 expect(await tx(()=>readApprovedSocialMediaForOwner(ctx(),seed.alpha.admin.userId,{...r,approvalRevision:1}))).toMatchObject({altText:input.altText,approvalRevision:1});
 expect(await tx(()=>withdrawSocialMedia(ctx(),{assetId:r.assetId,expectedApprovalRevision:0},async()=>true))).toMatchObject({ok:false,reason:'stale_approval'});
 expect(await tx(()=>withdrawSocialMedia(ctx(),{assetId:r.assetId,expectedApprovalRevision:1},async()=>true))).toMatchObject({ok:true});
 expect(await tx(()=>readApprovedSocialMediaForOwner(ctx(),seed.alpha.admin.userId,r))).toBeNull();
 const row=(await db.session.query('SELECT approved_caption,approved_alt_text FROM social_assets WHERE workspace_id=$1 AND id=$2',[seed.alpha.workspaceId,r.assetId])).rows[0];expect(row).toEqual({approved_caption:null,approved_alt_text:null});
 expect((await db.session.query('SELECT 1 FROM social_object_deletions WHERE workspace_id=$1 AND asset_id=$2',[seed.alpha.workspaceId,r.assetId])).rows).toHaveLength(2);
});
it('holds quota until physical deletion and releases once per key, not on failed deletion',async()=>{
 const r=await registered();await tx(()=>deleteSocialAsset(ctx(),r.assetId));const amount=async()=>Number((await db.session.query<{n:string}>('SELECT bytes_reserved AS n FROM social_library_usage WHERE workspace_id=$1',[seed.alpha.workspaceId])).rows[0]!.n);const before=await amount();
 await tx(()=>recordSocialObjectDeletion(ctx(),{assetId:r.assetId,version:1,success:false}));expect(await amount()).toBe(before);
 await tx(()=>recordSocialObjectDeletion(ctx(),{assetId:r.assetId,version:1,success:true}));await tx(()=>recordSocialObjectDeletion(ctx(),{assetId:r.assetId,version:1,success:true}));expect(await amount()).toBe(before-100);
 await tx(()=>recordSocialObjectDeletion(ctx(),{assetId:r.assetId,version:2,success:true}));expect(await amount()).toBe(before-100-5*1024*1024);
});
it('owner departure immediately clears metadata and queues originals and derivatives without sweeping another owner',async()=>{
 const r=await sanitized(),other=await registered();
 await db.session.query('UPDATE social_assets SET owner_user_id=$3 WHERE workspace_id=$1 AND id=$2',[seed.alpha.workspaceId,r.assetId,seed.alpha.salesperson.userId]);
 await db.session.query("UPDATE workspace_memberships SET status='inactive',deactivated_at=clock_timestamp() WHERE workspace_id=$1 AND user_id=$2",[seed.alpha.workspaceId,seed.alpha.salesperson.userId]);
 expect(await tx(()=>readApprovedSocialMediaForOwner(ctx(),seed.alpha.salesperson.userId,r))).toBeNull();
 expect((await db.session.query('SELECT 1 FROM social_object_deletions WHERE workspace_id=$1 AND asset_id=$2',[seed.alpha.workspaceId,r.assetId])).rows).toHaveLength(2);
 expect(await readSocialAsset(ctx(),other.assetId)).toMatchObject({state:'uploading'});
});

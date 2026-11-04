import {beforeAll,afterAll,it,expect} from 'vitest';
import sharp from 'sharp';
import {createHash} from 'node:crypto';
import {createTestDatabase,type TestDatabase} from '@fss/domain/db/testing/testDatabase.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '@fss/domain/test/db/support/fixtures.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {registerSocialAsset,socialAssetObject,expireSocialUploads} from '@fss/domain/social/assets.ts';
import {completeSanitizedSocialMedia} from '../src/social/completeMedia.ts';
import type {SocialMediaStore} from '../src/social/mediaStore.ts';
let db:TestDatabase,seed:TwoWorkspaces;
const ctx=()=>repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'user',userId:seed.alpha.admin.userId,role:'admin'}),db.session);
beforeAll(async()=>{db=await createTestDatabase();seed=await seedTwoWorkspaces(db.session);});afterAll(async()=>db.drop());
function store(objects:Map<string,Buffer>):SocialMediaStore{return {
 read:async(key,max)=>{const value=objects.get(key);if(!value||value.length>max)throw Error('media_store_unavailable');return value;},
 put:async input=>{objects.set(input.key,input.body);},delete:async key=>{objects.delete(key);},
 head:async()=>{throw Error('HEAD must not establish sanitized status');},presignPut:async()=>{throw Error('not used');},presignGet:async()=>{throw Error('not used');},
};}
async function upload(body:Buffer){const registered=await withTransaction(db.session,()=>registerSocialAsset(ctx(),{sha256:createHash('sha256').update(body).digest('hex'),bytes:body.length,mime:'image/png',origin:{kind:'upload',sourceUrl:null,usageNote:null}}));if(!registered.ok)throw Error(registered.reason);const object=await socialAssetObject(ctx(),registered.value,'upload');if(!object)throw Error('missing object');return {...registered.value,key:object.object_key};}
it('reads actual bytes, writes a stripped derivative, and queues only the quarantined original after success',async()=>{
 const body=await sharp({create:{width:9,height:5,channels:3,background:'blue'}}).withMetadata().png().toBuffer(),r=await upload(body),objects=new Map([[r.key,body]]);
 const result=await withTransaction(db.session,()=>completeSanitizedSocialMedia(ctx(),r,store(objects),async()=>true));expect(result).toMatchObject({ok:true,value:{version:2}});
 expect(await socialAssetObject(ctx(),{assetId:r.assetId,version:1},'download')).toBeNull();const derivative=await socialAssetObject(ctx(),{assetId:r.assetId,version:2},'download');expect(derivative?.sanitized).toBe(true);
 const final=objects.get(`${r.key}/sanitized`)!;expect((await sharp(final).metadata()).exif).toBeUndefined();expect(derivative?.sha256).toBe(createHash('sha256').update(final).digest('hex'));
 expect((await db.session.query('SELECT version FROM social_object_deletions WHERE workspace_id=$1 AND asset_id=$2',[seed.alpha.workspaceId,r.assetId])).rows).toEqual([{version:1}]);
});
it('actual mismatched object bytes are refused and both keys become durable deletion work',async()=>{
 const body=await sharp({create:{width:2,height:2,channels:3,background:'blue'}}).png().toBuffer(),r=await upload(body),objects=new Map([[r.key,Buffer.from('not an image')]]);
 expect(await withTransaction(db.session,()=>completeSanitizedSocialMedia(ctx(),r,store(objects),async()=>true))).toEqual({ok:false,reason:'invalid_image'});
 expect((await db.session.query('SELECT version FROM social_object_deletions WHERE workspace_id=$1 AND asset_id=$2',[seed.alpha.workspaceId,r.assetId])).rows).toHaveLength(2);
});
it('a crash after derivative object write rolls back DB readiness but durable pre-reserved keys survive for cleanup',async()=>{
 const body=await sharp({create:{width:2,height:2,channels:3,background:'blue'}}).png().toBuffer(),r=await upload(body),objects=new Map<string,Buffer>([[r.key,body]]);const port=store(objects);port.put=async input=>{objects.set(input.key,input.body);throw Error('simulated_process_failure');};
 await expect(withTransaction(db.session,()=>completeSanitizedSocialMedia(ctx(),r,port,async()=>true))).rejects.toThrow('simulated_process_failure');
 expect(objects.has(`${r.key}/sanitized`)).toBe(true);expect(await socialAssetObject(ctx(),{assetId:r.assetId,version:2},'download')).toBeNull();
 await db.session.query("UPDATE social_asset_objects SET expires_at=clock_timestamp()-interval '1 minute' WHERE workspace_id=$1 AND asset_id=$2",[seed.alpha.workspaceId,r.assetId]);await withTransaction(db.session,()=>expireSocialUploads(ctx()));
 const queued=(await db.session.query<{object_key:string}>('SELECT object_key FROM social_object_deletions WHERE workspace_id=$1 AND asset_id=$2',[seed.alpha.workspaceId,r.assetId])).rows;expect(queued.map(row=>row.object_key).sort()).toEqual([r.key,`${r.key}/sanitized`].sort());
 for(const row of queued)await port.delete(row.object_key);expect(objects.size).toBe(0);
});
it('revoked retained authority after byte decoding prevents derivative storage handoff',async()=>{
 const body=await sharp({create:{width:2,height:2,channels:3,background:'blue'}}).png().toBuffer(),r=await upload(body),objects=new Map([[r.key,body]]);let reads=0;
 await expect(withTransaction(db.session,()=>completeSanitizedSocialMedia(ctx(),r,store(objects),async()=>++reads===1))).rejects.toThrow();
 expect(objects.has(`${r.key}/sanitized`)).toBe(false);
 expect(await socialAssetObject(ctx(),{assetId:r.assetId,version:2},'download')).toBeNull();
});

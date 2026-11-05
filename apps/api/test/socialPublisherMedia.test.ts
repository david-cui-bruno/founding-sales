import {createHash,randomBytes} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import pg from 'pg';
import sharp from 'sharp';
import {it,expect} from 'vitest';
import {createTestDatabase,CLUSTER_URL_ENVIRONMENT_VARIABLE} from '@fss/domain/db/testing/testDatabase.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {standingFixture,readyStandingFixture} from '@fss/domain/test/social/standingFixture.ts';
import {registerSocialAsset,socialAssetObject} from '@fss/domain/social/assets.ts';
import {approveSocialMedia,withdrawSocialMedia} from '@fss/domain/social/approvedMedia.ts';
import {adoptStandingPost,markStandingSubmission,readStandingSlot} from '@fss/domain/social/standingPublication.ts';
import {SocialBufferPublisher,postgresPublisherCredentials} from '@fss/social-publisher';
import {createApiServer} from '../src/server.ts';
import {poolConnections} from '../src/bootstrap/connections.ts';
import {completeSanitizedSocialMedia} from '../src/social/completeMedia.ts';
import type {SocialMediaStore} from '../src/social/mediaStore.ts';

it('serves exact admitted image bytes anonymously, never private originals, unmarked attempts, corrupt objects or withdrawn media',async()=>{
 const db=await createTestDatabase(),url=new URL(process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE]!);url.pathname=`/${db.name}`;
 const pool=new pg.Pool({connectionString:url.toString(),options:'-c role=app_runtime',max:4});
 const objects=new Map<string,Buffer>();let reads=0;
 const store:SocialMediaStore={
  read:async(key,max)=>{reads++;const body=objects.get(key);if(!body||body.length>max)throw Error('object_unavailable');return body;},
  put:async input=>{objects.set(input.key,input.body);},delete:async key=>{objects.delete(key);},
  head:async()=>{throw Error('not used');},presignGet:async()=>{throw Error('not used');},presignPut:async()=>{throw Error('not used');},
 };
 const publisher=new SocialBufferPublisher({credentials:postgresPublisherCredentials(db.session,randomBytes(32)),executionSide:'api',mediaOrigin:'https://founder.example'});
 const server=createApiServer({connections:poolConnections(pool),supportedClientVersions:{minimum:'1.2.0',ceiling:'1.4.x',incompatible:[]},sendingEnabled:false,production:false,socialMedia:store,socialPublisher:publisher});
 try{
  expect((await pool.query<{current_user:string}>('SELECT current_user')).rows[0]?.current_user).toBe('app_runtime');
  const f=await standingFixture(db.session,true,'approved_pool'),slot=await readyStandingFixture(db.session,f);
  const original=await sharp({create:{width:9,height:5,channels:3,background:'blue'}}).withMetadata().png().toBuffer();
  const registered=await withTransaction(db.session,()=>registerSocialAsset(f.owner,{sha256:createHash('sha256').update(original).digest('hex'),bytes:original.length,mime:'image/png',origin:{kind:'upload',sourceUrl:null,usageNote:null}}));
  if(!registered.ok)throw Error(registered.reason);
  const upload=await socialAssetObject(f.owner,registered.value,'upload');if(!upload)throw Error('missing upload');objects.set(upload.object_key,original);
  const complete=await withTransaction(db.session,()=>completeSanitizedSocialMedia(f.owner,registered.value,store,async()=>true));if(!complete.ok)throw Error(complete.reason);
  const derivative=await socialAssetObject(f.owner,{assetId:registered.value.assetId,version:2},'download');if(!derivative)throw Error('missing derivative');
  const body=objects.get(derivative.object_key)!;
  const approved=await withTransaction(db.session,()=>approveSocialMedia(f.owner,{assetId:registered.value.assetId,version:2,sha256:derivative.sha256,expectedApprovalRevision:0,caption:'Owned image',topic:'engineering',altText:'Blue rectangle',publicUseClearance:true},async()=>true));if(!approved.ok)throw Error(approved.reason);
  const image={...approved.value,altText:'Blue rectangle',mime:derivative.mime,byteLength:body.length};
  await db.session.query('UPDATE social_standing_slots SET image=$3::jsonb WHERE workspace_id=$1 AND id=$2',[f.w,slot.id,JSON.stringify(image)]);
  const admitted=await withTransaction(db.session,async()=>adoptStandingPost(f.worker,(await readStandingSlot(f.worker,slot.id))!));
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`,path=`/social/publisher/media/${f.w}/${admitted.attempt_id}/${derivative.sha256}`;
  expect((await fetch(origin+path)).status).toBe(404);
  await withTransaction(db.session,()=>markStandingSubmission(f.worker,admitted));
  const response=await fetch(origin+path);
  expect(response.status).toBe(200);expect(response.headers.get('content-type')).toBe(derivative.mime);expect(response.headers.get('cache-control')).toContain('no-store');
  expect(Buffer.from(await response.arrayBuffer())).toEqual(body);expect(body.equals(original)).toBe(false);
  const beforeHead=reads,head=await fetch(origin+path,{method:'HEAD'});
  expect(head.status).toBe(200);expect(head.headers.get('content-length')).toBe(String(body.length));expect(await head.text()).toBe('');expect(reads).toBe(beforeHead);
  expect((await fetch(origin+path.replace(f.w,f.seed.beta.workspaceId))).status).toBe(404);
  expect((await fetch(origin+path.replace(derivative.sha256,createHash('sha256').update(original).digest('hex')))).status).toBe(404);
  expect((await fetch(origin+path+'?objectKey='+encodeURIComponent(upload.object_key))).status).toBe(404);
  objects.set(derivative.object_key,Buffer.alloc(body.length,0));
  const corrupt=await fetch(origin+path);expect(corrupt.status).toBe(500);expect(await corrupt.json()).toMatchObject({error:'internal_error'});
  objects.set(derivative.object_key,body);
  await withTransaction(db.session,()=>withdrawSocialMedia(f.owner,{assetId:image.assetId,expectedApprovalRevision:image.approvalRevision},async()=>true));
  expect((await fetch(origin+path)).status).toBe(404);
 }finally{
  await publisher.close();server.closeAllConnections();if(server.listening)await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  await pool.end();await db.drop();
 }
});

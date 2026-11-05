import {randomUUID} from 'node:crypto';
import {it,expect} from 'vitest';
import type {SocialPublisherAttempt,SocialPublisherObservation} from '@fss/contracts';
import {createTestDatabase} from '../../db/testing/testDatabase.ts';
import {withTransaction} from '../../db/queryable.ts';
import {standingFixture,readyStandingFixture} from './standingFixture.ts';
import {adoptStandingPost,markStandingSubmission,readStandingSlot,recordStandingObservation,readStandingPublicationMedia} from '../../social/standingPublication.ts';
import {admitSocialStandingSlots} from '../../social/standingSlots.ts';
import {registerSocialAsset} from '../../social/assets.ts';
import {approveSanitizedMediaFixture} from './mediaFixture.ts';
import {withdrawSocialMedia} from '../../social/approvedMedia.ts';

it('binds first receipt immutably, ignores stale/conflicting observations and only presents observed LinkedIn permalinks',async()=>{
 const db=await createTestDatabase();try{
  const f=await standingFixture(db.session),slot=await readyStandingFixture(db.session,f),s=await withTransaction(db.session,()=>adoptStandingPost(f.worker,slot));
  await withTransaction(db.session,()=>markStandingSubmission(f.worker,s));
  const a:SocialPublisherAttempt={binding:f.configuration.binding,attemptId:s.attempt_id,fingerprint:s.fingerprint!,text:s.text,textSHA256:s.snapshot!.textSHA256,publishAt:s.publish_at.toISOString(),submittedAt:new Date().toISOString(),mediaReceiptId:null,image:null};
  const o:SocialPublisherObservation={state:'scheduled',receiptId:'333333333333333333333333',mediaReceiptId:null,permalink:null,observedAt:new Date().toISOString(),accountExternalId:a.binding.externalId,fingerprint:a.fingerprint,imageCount:0,mediaMatched:true,reason:'matched'};
  const record=(change:Partial<SocialPublisherObservation>)=>withTransaction(db.session,()=>recordStandingObservation(f.worker,s,a,{...o,...change}));
  await record({});expect(await readStandingSlot(f.worker,s.id)).toMatchObject({state:'scheduled',receipt_id:o.receiptId});
  await record({receiptId:'555555555555555555555555',state:'published'});
  expect(await readStandingSlot(f.worker,s.id)).toMatchObject({state:'scheduled',receipt_id:o.receiptId});
  await record({observedAt:new Date(Date.parse(o.observedAt)-1000).toISOString(),state:'published'});
  expect(await readStandingSlot(f.worker,s.id)).toMatchObject({state:'scheduled'});
  await record({state:'published',permalink:'https://www.linkedin.com.attacker.test/post'});
  expect(await readStandingSlot(f.worker,s.id)).toMatchObject({state:'published',receipt_id:o.receiptId,permalink:null});
  await expect(db.session.query('UPDATE social_standing_slots SET receipt_id=$3 WHERE workspace_id=$1 AND id=$2',[f.w,s.id,'foreign'])).rejects.toThrow('social_standing_identity_immutable');
 }finally{await db.drop();}
});
it('known no-create rejection consumes its marked slot and lineage permanently, without a replacement create',async()=>{
 const db=await createTestDatabase();try{
  const f=await standingFixture(db.session),slot=await readyStandingFixture(db.session,f),s=await withTransaction(db.session,()=>adoptStandingPost(f.worker,slot));
  await withTransaction(db.session,()=>markStandingSubmission(f.worker,s));
  const a:SocialPublisherAttempt={binding:f.configuration.binding,attemptId:s.attempt_id,fingerprint:s.fingerprint!,text:s.text,publishAt:s.publish_at.toISOString(),submittedAt:new Date().toISOString(),mediaReceiptId:null,image:null};
  await withTransaction(db.session,()=>recordStandingObservation(f.worker,s,a,{state:'rejected',receiptId:null,mediaReceiptId:null,permalink:null,observedAt:new Date().toISOString(),accountExternalId:a.binding.externalId,fingerprint:a.fingerprint,imageCount:0,mediaMatched:false,reason:'provider_rejected'}));
  expect(await readStandingSlot(f.worker,s.id)).toMatchObject({state:'failed_known_not_submitted',attempt_id:s.attempt_id,submission_marked_at:expect.any(Date),receipt_id:null});
  await withTransaction(db.session,()=>admitSocialStandingSlots(f.worker,f.u,f.plan.planId,1,f.at));
  expect((await db.session.query('SELECT id FROM social_standing_slots WHERE workspace_id=$1',[f.w])).rows).toHaveLength(3);
  await expect(db.session.query("UPDATE social_standing_slots SET state='queued',submission_marked_at=NULL WHERE workspace_id=$1 AND id=$2",[f.w,s.id])).rejects.toThrow('social_standing_submission_immutable');
 }finally{await db.drop();}
});
it('serves only marked, exact, currently approved derivatives; erasure cannot fall back to retained immutable image identity',async()=>{
 const db=await createTestDatabase();try{
  const f=await standingFixture(db.session,true,'approved_pool'),slot=await readyStandingFixture(db.session,f),sha256='b'.repeat(64);
  const asset=await withTransaction(db.session,()=>registerSocialAsset(f.owner,{sha256,bytes:100,mime:'image/png',origin:{kind:'screenshot',sourceUrl:null,usageNote:null}}));if(!asset.ok)throw Error(asset.reason);
  const approved=await withTransaction(db.session,()=>approveSanitizedMediaFixture(f.owner,asset.value.assetId,sha256,'Owned fixture'));
  const image={assetId:asset.value.assetId,version:2,sha256,approvalRevision:approved.approvalRevision,altText:'Owned fixture',mime:'image/png',byteLength:100};
  await db.session.query('UPDATE social_standing_slots SET image=$3::jsonb WHERE workspace_id=$1 AND id=$2',[f.w,slot.id,JSON.stringify(image)]);
  const s=await withTransaction(db.session,async()=>adoptStandingPost(f.worker,(await readStandingSlot(f.worker,slot.id))!));
  const media=(workspace=f.w,attempt=s.attempt_id,sha=sha256,now=new Date())=>withTransaction(db.session,()=>readStandingPublicationMedia(db.session,workspace,attempt,sha,now));
  expect(await media()).toBeNull();await withTransaction(db.session,()=>markStandingSubmission(f.worker,s));
  expect(await media()).toEqual({ownerUserId:f.u,objectKey:expect.any(String),mimeType:'image/png',sha256,byteLength:100});
  expect(await media(f.seed.beta.workspaceId)).toBeNull();expect(await media(f.w,randomUUID())).toBeNull();expect(await media(f.w,s.attempt_id,'c'.repeat(64))).toBeNull();
  expect(await media(f.w,s.attempt_id,sha256,new Date(s.publish_at.getTime()+86400001))).toBeNull();
  const a:SocialPublisherAttempt={binding:f.configuration.binding,attemptId:s.attempt_id,fingerprint:s.fingerprint!,text:null,publishAt:s.publish_at.toISOString(),submittedAt:new Date().toISOString(),mediaReceiptId:null,image:{mime:'image/png',sha256,altText:'',byteLength:100}};
  const o:SocialPublisherObservation={state:'scheduled',receiptId:'333333333333333333333333',mediaReceiptId:'444444444444444444444444',permalink:null,observedAt:new Date().toISOString(),accountExternalId:a.binding.externalId,fingerprint:a.fingerprint,imageCount:1,mediaMatched:true,reason:'matched'};
  await withTransaction(db.session,()=>recordStandingObservation(f.worker,s,a,{...o,mediaReceiptId:null}));
  expect(await readStandingSlot(f.worker,s.id)).toMatchObject({state:'unknown',receipt_id:null,media_receipt_id:null});
  await withTransaction(db.session,()=>recordStandingObservation(f.worker,s,a,o));
  expect(await readStandingSlot(f.worker,s.id)).toMatchObject({state:'scheduled',receipt_id:o.receiptId,media_receipt_id:o.mediaReceiptId});
  await withTransaction(db.session,()=>recordStandingObservation(f.worker,s,a,{...o,state:'published',mediaReceiptId:'555555555555555555555555'}));
  expect(await readStandingSlot(f.worker,s.id)).toMatchObject({state:'scheduled',media_receipt_id:o.mediaReceiptId});
  await expect(db.session.query('UPDATE social_standing_slots SET media_receipt_id=$3 WHERE workspace_id=$1 AND id=$2',[f.w,s.id,'foreign'])).rejects.toThrow('social_standing_identity_immutable');
  await withTransaction(db.session,()=>withdrawSocialMedia(f.owner,{assetId:image.assetId,expectedApprovalRevision:image.approvalRevision},async()=>true));
  expect(await readStandingSlot(f.worker,s.id)).toMatchObject({image:null,snapshot:{image:{assetId:image.assetId,sha256,altText:''}}});
  expect(await media()).toBeNull();
 }finally{await db.drop();}
});

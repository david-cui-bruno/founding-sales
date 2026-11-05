import {randomUUID} from 'node:crypto';
import {it,expect} from 'vitest';
import type {SocialPublisherPort,SocialPublisherAttempt,SocialPublisherObservation} from '@fss/contracts';
import {createTestDatabase} from '@fss/domain/db/testing/testDatabase.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import type {SessionQueryable,QueryResultRowLike} from '@fss/domain/db/queryable.ts';
import {standingFixture,readyStandingFixture} from '@fss/domain/test/social/standingFixture.ts';
import {pauseSocialStandingPlan} from '@fss/domain/social/standingPlan.ts';
import {readStandingSlot,readStandingPublicationMedia} from '@fss/domain/social/standingPublication.ts';
import {registerSocialAsset} from '@fss/domain/social/assets.ts';
import {approveSanitizedMediaFixture} from '@fss/domain/test/social/mediaFixture.ts';
import {socialStandingHandler} from '../src/social/standingJobs.ts';
const observation=(a:SocialPublisherAttempt,state:SocialPublisherObservation['state']):SocialPublisherObservation=>({state,receiptId:'333333333333333333333333',mediaReceiptId:a.image?'444444444444444444444444':null,permalink:state==='published'?'https://www.linkedin.com/feed/update/urn:li:activity:123456/':null,observedAt:new Date().toISOString(),accountExternalId:a.binding.externalId,fingerprint:a.fingerprint,imageCount:a.image?1:0,mediaMatched:true,reason:'matched'});
it('crash after committed marker is inspect-only on restart and never recreates missing receipts',async()=>{
 const db=await createTestDatabase();try{
  const f=await standingFixture(db.session),s=await readyStandingFixture(db.session,f),observer=await db.appRuntimeSession();let submits=0,inspects=0;
  const port:SocialPublisherPort={verify:async b=>({usable:true,externalId:b.externalId,adapter:'buffer-linkedin-v1',reason:null}),prepare:async(a,authority)=>{await authority();return {attemptId:a.attemptId,fingerprint:a.fingerprint,expiresAt:new Date(Date.now()+60000).toISOString()};},submit:async(_a,authority,marker)=>{await authority();expect(await marker()).toBe(true);submits++;const durable=(await observer.query('SELECT submission_marked_at FROM social_standing_slots WHERE workspace_id=$1 AND id=$2',[f.w,s.id])).rows[0];expect(durable?.['submission_marked_at']).not.toBeNull();throw new Error('controlled lost response');},inspect:async(a,receipt,authority)=>{await authority();inspects++;expect(receipt).toBeNull();return {...observation(a,'unknown'),receiptId:null,mediaMatched:false};},cancel:async()=>{throw new Error('unexpected cancel');}};
  const handler=socialStandingHandler({publisher:port,admitGeneration:async()=>{throw new Error('unexpected model request');}}),job={id:randomUUID(),workspaceId:f.w,kind:'social.standing',idempotencyKey:'controlled',payload:{slotId:s.id},attempt:1,maxAttempts:1,fencingToken:'1',leaseOwner:'fixture',leaseExpiresAt:new Date(Date.now()+300000).toISOString()};
  await handler.handle({session:db.session,scope:f.worker.scope,job});expect(await readStandingSlot(f.worker,s.id)).toMatchObject({state:'unknown',attempt_id:s.attempt_id});
  await handler.handle({session:db.session,scope:f.worker.scope,job:{...job,attempt:2}});expect(submits).toBe(1);expect(inspects).toBe(1);
 }finally{await db.drop();}
});
it('orders pause behind in-flight egress, then tracks cancellation losing to actual publication',async()=>{
 const db=await createTestDatabase();try{
  const f=await standingFixture(db.session),s=await readyStandingFixture(db.session,f),stopSession=await db.appRuntimeSession();
  const {promise:held,resolve:release}=Promise.withResolvers<void>(),{promise:started,resolve:entered}=Promise.withResolvers<void>(),{promise:stopReached,resolve:signalStop}=Promise.withResolvers<void>();let submits=0,cancels=0;
  const port:SocialPublisherPort={verify:async b=>({usable:true,externalId:b.externalId,adapter:'buffer-linkedin-v1',reason:null}),prepare:async(a,authority)=>{await authority();return {attemptId:a.attemptId,fingerprint:a.fingerprint,expiresAt:new Date(Date.now()+60000).toISOString()};},submit:async(a,authority,marker)=>{await authority();expect(await marker()).toBe(true);submits++;await authority();entered();await held;return observation(a,'scheduled');},inspect:async(a,_r,authority)=>{await authority();return observation(a,'scheduled');},cancel:async(a,_r,authority)=>{await authority();cancels++;return observation(a,'published');}};
  const handler=socialStandingHandler({publisher:port,admitGeneration:async()=>{throw new Error('unexpected model request');}}),job={id:randomUUID(),workspaceId:f.w,kind:'social.standing',idempotencyKey:'pause-race',payload:{slotId:s.id},attempt:1,maxAttempts:1,fencingToken:'1',leaseOwner:'fixture',leaseExpiresAt:new Date(Date.now()+300000).toISOString()};
  const running=handler.handle({session:db.session,scope:f.worker.scope,job});await started;
  const stopDb:SessionQueryable={query<Row extends QueryResultRowLike>(text:string,values?:readonly unknown[]){const pending=stopSession.query<Row>(text,values);if(text.includes('workspace_memberships')&&text.includes('FOR UPDATE'))signalStop();return pending;}};
  const stopOwner=repositoryContext(workspaceScope(f.w,{kind:'user',userId:f.u,role:'admin'}),stopDb);let stopped=false;
  const pause=withTransaction(stopDb,()=>pauseSocialStandingPlan(stopOwner,{planId:f.plan.planId,expectedRevision:1})).then(result=>{stopped=true;return result;});
  await stopReached;expect(stopped).toBe(false);release();await running;expect(await pause).toEqual({ok:true,value:null});
  expect(await readStandingSlot(f.worker,s.id)).toMatchObject({state:'cancellation_pending'});
  await handler.handle({session:db.session,scope:f.worker.scope,job:{...job,attempt:2}});expect(submits).toBe(1);expect(cancels).toBe(1);expect(await readStandingSlot(f.worker,s.id)).toMatchObject({state:'published',permalink:expect.stringContaining('linkedin.com')});
 }finally{await db.drop();}
});
it('retains cancellation intent through receipt recovery and transient cancel failures, retrying promptly without another create',async()=>{
 const db=await createTestDatabase();try{
  const f=await standingFixture(db.session),s=await readyStandingFixture(db.session,f);let submits=0,inspects=0,cancels=0;
  const port:SocialPublisherPort={
   verify:async b=>({usable:true,externalId:b.externalId,adapter:'buffer-linkedin-v1',reason:null}),
   prepare:async(a,authority)=>{await authority();return {attemptId:a.attemptId,fingerprint:a.fingerprint,expiresAt:new Date(Date.now()+60000).toISOString()};},
   submit:async(a,authority,marker)=>{await authority();expect(await marker()).toBe(true);submits++;return {...observation(a,'unknown'),receiptId:null,mediaMatched:false,reason:'readback_incomplete'};},
   inspect:async(a,receipt,authority)=>{await authority();expect(receipt).toBeNull();inspects++;return observation(a,'scheduled');},
   cancel:async(a,receipt,authority)=>{await authority();expect(receipt).toBe('333333333333333333333333');cancels++;return cancels===1?{...observation(a,'unknown'),mediaMatched:false,reason:'credential_unavailable'}:observation(a,'cancelled');},
  };
  const handler=socialStandingHandler({publisher:port,admitGeneration:async()=>{throw new Error('unexpected model request');}}),job={id:randomUUID(),workspaceId:f.w,kind:'social.standing',idempotencyKey:'cancellation-recovery',payload:{slotId:s.id},attempt:1,maxAttempts:1,fencingToken:'1',leaseOwner:'fixture',leaseExpiresAt:new Date(Date.now()+300000).toISOString()};
  const run=()=>handler.handle({session:db.session,scope:f.worker.scope,job});
  await run();expect(await readStandingSlot(f.worker,s.id)).toMatchObject({state:'unknown',receipt_id:null});
  await withTransaction(db.session,()=>pauseSocialStandingPlan(f.owner,{planId:f.plan.planId,expectedRevision:1}));
  await run();
  expect(await readStandingSlot(f.worker,s.id)).toMatchObject({state:'cancellation_pending',receipt_id:'333333333333333333333333'});
  const prompt=(await db.session.query<{prompt:boolean}>("SELECT next_inspection_at<clock_timestamp()+interval '6 minutes' AND next_inspection_at<publish_at AS prompt FROM social_standing_slots WHERE workspace_id=$1 AND id=$2",[f.w,s.id])).rows[0];expect(prompt?.prompt).toBe(true);
  await run();expect(await readStandingSlot(f.worker,s.id)).toMatchObject({state:'cancellation_pending',reason:'credential_unavailable'});
  expect((await db.session.query('SELECT state FROM social_post_revisions WHERE workspace_id=$1 AND post_id=(SELECT post_id FROM social_standing_slots WHERE workspace_id=$1 AND id=$2)',[f.w,s.id])).rows).toEqual([{state:'cancellation_pending'}]);
  await run();expect(await readStandingSlot(f.worker,s.id)).toMatchObject({state:'cancelled',attempt_id:s.attempt_id});expect({submits,inspects,cancels}).toEqual({submits:1,inspects:1,cancels:2});
 }finally{await db.drop();}
});
it('allows a separate Buffer media fetch during create while pause waits for egress and then revokes public media',async()=>{
 const db=await createTestDatabase();try{
  const f=await standingFixture(db.session,true,'approved_pool'),s=await readyStandingFixture(db.session,f),mediaSession=await db.appRuntimeSession(),stopSession=await db.appRuntimeSession(),sha256='b'.repeat(64);
  const asset=await withTransaction(db.session,()=>registerSocialAsset(f.owner,{sha256,bytes:100,mime:'image/png',origin:{kind:'screenshot',sourceUrl:null,usageNote:null}}));if(!asset.ok)throw Error(asset.reason);
  const approved=await withTransaction(db.session,()=>approveSanitizedMediaFixture(f.owner,asset.value.assetId,sha256,'Owned screenshot'));
  const image={assetId:asset.value.assetId,version:2,sha256,approvalRevision:approved.approvalRevision,altText:'Owned screenshot',mime:'image/png',byteLength:100};
  await db.session.query('UPDATE social_standing_slots SET image=$3::jsonb WHERE workspace_id=$1 AND id=$2',[f.w,s.id,JSON.stringify(image)]);
  const fetched=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),stopReached=Promise.withResolvers<void>();let creates=0,stopped=false;
  const port:SocialPublisherPort={
   verify:async b=>({usable:true,externalId:b.externalId,adapter:'buffer-linkedin-v1',reason:null}),
   prepare:async(a,authority)=>{await authority();return {attemptId:a.attemptId,fingerprint:a.fingerprint,expiresAt:new Date(Date.now()+60000).toISOString()};},
   submit:async(a,authority,marker)=>{
    await authority();expect(await marker()).toBe(true);await authority();creates++;
    const descriptor=await withTransaction(mediaSession,()=>readStandingPublicationMedia(mediaSession,f.w,a.attemptId,sha256));
    expect(descriptor).toMatchObject({ownerUserId:f.u,mimeType:'image/png',sha256,byteLength:100});
    fetched.resolve();await release.promise;return observation(a,'scheduled');
   },
   inspect:async(a,_r,authority)=>{await authority();return observation(a,'scheduled');},
   cancel:async(a,_r,authority)=>{await authority();return observation(a,'cancelled');},
  };
  const handler=socialStandingHandler({publisher:port,admitGeneration:async()=>{throw Error('unexpected generation');}});
  const job={id:randomUUID(),workspaceId:f.w,kind:'social.standing',idempotencyKey:'media-egress',payload:{slotId:s.id},attempt:1,maxAttempts:1,fencingToken:'1',leaseOwner:'fixture',leaseExpiresAt:new Date(Date.now()+300000).toISOString()};
  const running=handler.handle({session:db.session,scope:f.worker.scope,job});await fetched.promise;
  const stopDb:SessionQueryable={query<Row extends QueryResultRowLike>(text:string,values?:readonly unknown[]){const pending=stopSession.query<Row>(text,values);if(text.includes('workspace_memberships')&&text.includes('FOR UPDATE'))stopReached.resolve();return pending;}};
  const stopOwner=repositoryContext(workspaceScope(f.w,{kind:'user',userId:f.u,role:'admin'}),stopDb);
  const pause=withTransaction(stopDb,()=>pauseSocialStandingPlan(stopOwner,{planId:f.plan.planId,expectedRevision:1})).then(result=>{stopped=true;return result;});
  await stopReached.promise;expect(stopped).toBe(false);release.resolve();await running;expect(await pause).toEqual({ok:true,value:null});
  expect(await withTransaction(mediaSession,()=>readStandingPublicationMedia(mediaSession,f.w,s.attempt_id,sha256))).toBeNull();
  await handler.handle({session:db.session,scope:f.worker.scope,job:{...job,attempt:2}});
  expect(creates).toBe(1);expect(await readStandingSlot(f.worker,s.id)).toMatchObject({state:'cancelled'});
 }finally{await db.drop();}
});

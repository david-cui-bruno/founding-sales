import {randomUUID} from 'node:crypto';
import {it,expect} from 'vitest';
import {SocialBufferPublisher,postgresPublisherCredentials,sealPublisherCredential} from '@fss/social-publisher';
import {createTestDatabase} from '@fss/domain/db/testing/testDatabase.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {standingFixture,readyStandingFixture} from '@fss/domain/test/social/standingFixture.ts';
import {readStandingSlot} from '@fss/domain/social/standingPublication.ts';
import {pauseSocialStandingPlan} from '@fss/domain/social/standingPlan.ts';
import {registerSocialAsset} from '@fss/domain/social/assets.ts';
import {approveSanitizedMediaFixture} from '@fss/domain/test/social/mediaFixture.ts';
import {socialStandingHandler} from '../src/social/standingJobs.ts';

it.each(['sending','error'])('concrete Buffer %s retains exact receipt/media UNKNOWN custody, then sent cancellation-race truth becomes published without another create',async initial=>{
 const db=await createTestDatabase();try{
  const f=await standingFixture(db.session,true,'approved_pool'),s=await readyStandingFixture(db.session,f),providerDb=await db.appRuntimeSession(),key=Buffer.alloc(32,17),binding=f.configuration.binding,sha256='b'.repeat(64);
  await db.session.query('UPDATE social_publisher_credentials SET encrypted_state=$3 WHERE workspace_id=$1 AND id=$2',[f.w,binding.credentialId,sealPublisherCredential(key,binding,'fixture-key')]);
  const asset=await withTransaction(db.session,()=>registerSocialAsset(f.owner,{sha256,bytes:100,mime:'image/png',origin:{kind:'screenshot',sourceUrl:null,usageNote:null}}));if(!asset.ok)throw Error(asset.reason);
  const approved=await withTransaction(db.session,()=>approveSanitizedMediaFixture(f.owner,asset.value.assetId,sha256,'Owned fixture'));
  await db.session.query('UPDATE social_standing_slots SET image=$3::jsonb WHERE workspace_id=$1 AND id=$2',[f.w,s.id,JSON.stringify({assetId:asset.value.assetId,version:2,sha256,approvalRevision:approved.approvalRevision,altText:'Owned fixture',mime:'image/png',byteLength:100})]);
  let status=initial,creates=0,inspects=0;
  const post=()=>({id:'333333333333333333333333',channelId:binding.channelId,channel:{organizationId:binding.organizationId,serviceId:binding.externalId,service:'linkedin',type:'profile'},text:s.text,dueAt:s.publish_at.toISOString(),createdAt:new Date().toISOString(),status,schedulingType:'automatic',isCustomScheduled:true,externalLink:status==='sent'?'https://www.linkedin.com/feed/update/urn:li:activity:123456/':null,allowedActions:[],assets:[{__typename:'ImageAsset',id:'444444444444444444444444',source:'https://provider.example.test/accepted-image',mimeType:'image/png',image:{altText:'Owned fixture'}}]});
  const publisher=new SocialBufferPublisher({credentials:postgresPublisherCredentials(providerDb,key),executionSide:'worker',mediaOrigin:'https://app.example.test'},{transport:async(_url,init)=>{
   const body:unknown=JSON.parse(String(init.body));if(!body||typeof body!=='object'||!('query' in body)||typeof body.query!=='string')throw Error('invalid fixture request');
   if(body.query.includes('PublisherOrganizations'))return Response.json({data:{account:{organizations:[{id:binding.organizationId}]}}});
   if(body.query.includes('PublisherChannels'))return Response.json({data:{channels:[{id:binding.channelId,organizationId:binding.organizationId,service:'linkedin',type:'profile',serviceId:binding.externalId,externalLink:null,name:'Fixture',displayName:'Fixture',isDisconnected:false,isLocked:false,isQueuePaused:false,allowedActions:['readUpdates','scheduleUpdates','manageUpdates']}]}});
   if(body.query.includes('PublisherCreate')){creates++;return Response.json({data:{createPost:{__typename:'PostActionSuccess',post:post()}}});}
   if(body.query.includes('PublisherPost')){inspects++;return Response.json({data:{post:post()}});}
   throw Error('unexpected provider write');
  }});
  const handler=socialStandingHandler({publisher,admitGeneration:async()=>{throw Error('unexpected generation');}}),job={id:randomUUID(),workspaceId:f.w,kind:'social.standing',idempotencyKey:'concrete-observation',payload:{slotId:s.id},attempt:1,maxAttempts:1,fencingToken:'1',leaseOwner:'fixture',leaseExpiresAt:new Date(Date.now()+300000).toISOString()};
  await handler.handle({session:db.session,scope:f.worker.scope,job});
  expect(await readStandingSlot(f.worker,s.id)).toMatchObject({state:'unknown',reason:'readback_incomplete',receipt_id:'333333333333333333333333',media_receipt_id:'444444444444444444444444'});
  await withTransaction(db.session,()=>pauseSocialStandingPlan(f.owner,{planId:f.plan.planId,expectedRevision:1}));status='sent';
  await handler.handle({session:db.session,scope:f.worker.scope,job:{...job,attempt:2}});
  expect(await readStandingSlot(f.worker,s.id)).toMatchObject({state:'published',reason:'cancel_race',receipt_id:'333333333333333333333333',media_receipt_id:'444444444444444444444444',permalink:'https://www.linkedin.com/feed/update/urn:li:activity:123456/'});
  expect({creates,inspects}).toEqual({creates:1,inspects:1});
  expect((await db.session.query('SELECT state,reason FROM social_post_revisions WHERE workspace_id=$1 AND post_id=(SELECT post_id FROM social_standing_slots WHERE workspace_id=$1 AND id=$2)',[f.w,s.id])).rows).toEqual([{state:'published',reason:'cancel_race'}]);
 }finally{await db.drop();}
});

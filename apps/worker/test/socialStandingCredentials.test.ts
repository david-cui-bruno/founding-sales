import {randomUUID} from 'node:crypto';
import {it,expect} from 'vitest';
import {SocialBufferPublisher,postgresPublisherCredentials,sealPublisherCredential} from '@fss/social-publisher';
import {createTestDatabase} from '@fss/domain/db/testing/testDatabase.ts';
import {withTransaction,type SessionQueryable,type QueryResultRowLike} from '@fss/domain/db/queryable.ts';
import type {SocialPublisherBinding} from '@fss/contracts';
import {standingFixture,readyStandingFixture} from '@fss/domain/test/social/standingFixture.ts';
import {adoptStandingPost,markStandingSubmission,readStandingSlot} from '@fss/domain/social/standingPublication.ts';
import {invalidateSocialPublisherCredential} from '@fss/domain/social/standingAuthority.ts';
import {socialStandingHandler} from '../src/social/standingJobs.ts';

it.each([{phase:'prepare',reconnect:false},{phase:'create',reconnect:false},{phase:'inspect',reconnect:false},{phase:'create',reconnect:true}] as const)('persists $phase 401 after authority release and conserves reconnect=$reconnect on separate real DB sessions',async({phase,reconnect})=>{
 const db=await createTestDatabase();try{
  const f=await standingFixture(db.session),s=await readyStandingFixture(db.session,f),providerDb=await db.appRuntimeSession(),key=Buffer.alloc(32,17),binding=f.configuration.binding;
  await providerDb.query("SET statement_timeout='2s'");
  await db.session.query('UPDATE social_publisher_credentials SET encrypted_state=$3 WHERE workspace_id=$1 AND id=$2',[f.w,binding.credentialId,sealPublisherCredential(key,binding,'fixture-api-key')]);
  if(phase==='inspect'){
   const adopted=await withTransaction(db.session,()=>adoptStandingPost(f.worker,s));await withTransaction(db.session,()=>markStandingSubmission(f.worker,adopted));
   await db.session.query("UPDATE social_standing_slots SET state='scheduled',receipt_id='333333333333333333333333' WHERE workspace_id=$1 AND id=$2",[f.w,s.id]);
  }
  const credentials=postgresPublisherCredentials(providerDb,key);let creates=0,rejectionReturned=false,replacement:SocialPublisherBinding|null=null;
  const publisher=new SocialBufferPublisher({credentials,executionSide:'worker',mediaOrigin:'https://app.example.test'},{transport:async(_url,init)=>{
   const body:unknown=JSON.parse(String(init.body));if(!body||typeof body!=='object'||!('query' in body)||typeof body.query!=='string')throw Error('invalid fixture request');
   if(body.query.includes('PublisherOrganizations'))return phase==='prepare'?new Response(null,{status:401}):Response.json({data:{account:{organizations:[{id:binding.organizationId}]}}});
   if(body.query.includes('PublisherChannels'))return Response.json({data:{channels:[{id:binding.channelId,organizationId:binding.organizationId,service:'linkedin',type:'profile',serviceId:binding.externalId,externalLink:null,name:'Fixture',displayName:'Fixture',isDisconnected:false,isLocked:false,isQueuePaused:false,allowedActions:['readUpdates','scheduleUpdates','manageUpdates']}]}});
   if(body.query.includes('PublisherCreate')){creates++;rejectionReturned=true;expect(phase).toBe('create');return new Response(null,{status:401});}
   if(body.query.includes('PublisherPost')){expect(phase).toBe('inspect');return new Response(null,{status:401});}
   throw Error('unexpected provider operation');
  }});
  const handler=socialStandingHandler({publisher,admitGeneration:async()=>{throw Error('unexpected generation');}}),job={id:randomUUID(),workspaceId:f.w,kind:'social.standing',idempotencyKey:`credential-${phase}`,payload:{slotId:s.id},attempt:1,maxAttempts:1,fencingToken:'1',leaseOwner:'fixture',leaseExpiresAt:new Date(Date.now()+300000).toISOString()};
  const workerDb:SessionQueryable={async query<Row extends QueryResultRowLike>(text:string,values?:readonly unknown[]){
   const outcome=await db.session.query<Row>(text,values);
   if(reconnect&&rejectionReturned&&text==='COMMIT'&&!replacement)replacement=await credentials.save({workspaceId:f.w,ownerUserId:f.u},binding.accountId,{organizationId:binding.organizationId,channelId:binding.channelId,externalId:binding.externalId,displayName:'Fixture'},'replacement-fixture-key',async()=>{});
   return outcome;
  }};
  await handler.handle({session:workerDb,scope:f.worker.scope,job});
  if(reconnect){
   if(!replacement)throw Error('replacement was not installed after outcome commit');
   expect(await credentials.read(replacement)).toBe('replacement-fixture-key');
   expect((await providerDb.query('SELECT state,revision,adapter_version FROM social_accounts WHERE workspace_id=$1 AND id=$2',[f.w,binding.accountId])).rows).toEqual([{state:'connected',revision:2,adapter_version:'buffer-linkedin-v1'}]);
  }else{
   expect((await providerDb.query('SELECT encrypted_state,state,revision FROM social_publisher_credentials WHERE workspace_id=$1 AND id=$2',[f.w,binding.credentialId])).rows).toEqual([{encrypted_state:null,state:'disconnected',revision:2}]);
   expect((await providerDb.query('SELECT state,revision,adapter_version FROM social_accounts WHERE workspace_id=$1 AND id=$2',[f.w,binding.accountId])).rows).toEqual([{state:'disconnected',revision:2,adapter_version:null}]);
  }
  const retained=await readStandingSlot(f.worker,s.id);
  expect(retained).toMatchObject({state:phase==='inspect'?'unknown':'failed_known_not_submitted',attempt_id:s.attempt_id,receipt_id:phase==='inspect'?'333333333333333333333333':null});
  expect(retained?.submission_marked_at===null).toBe(phase==='prepare');expect(creates).toBe(phase==='create'?1:0);
 }finally{await db.drop();}
});
it('a delayed invalid-key observation cannot erase a replacement key or disconnect its newer account revision',async()=>{
 const db=await createTestDatabase();try{
  const f=await standingFixture(db.session),providerDb=await db.appRuntimeSession(),key=Buffer.alloc(32,17),old=f.configuration.binding,credentials=postgresPublisherCredentials(providerDb,key);
  const replacement=await credentials.save({workspaceId:f.w,ownerUserId:f.u},old.accountId,{organizationId:old.organizationId,channelId:old.channelId,externalId:old.externalId,displayName:'Fixture'},'replacement-fixture-key',async()=>{});
  expect(await invalidateSocialPublisherCredential(f.worker,old)).toBe(false);
  expect(await credentials.read(replacement)).toBe('replacement-fixture-key');
  expect((await db.session.query('SELECT state,revision FROM social_accounts WHERE workspace_id=$1 AND id=$2',[f.w,old.accountId])).rows).toEqual([{state:'connected',revision:replacement.accountRevision}]);
  expect(await invalidateSocialPublisherCredential(f.worker,replacement)).toBe(true);
  expect(await credentials.read(replacement)).toBeNull();
 }finally{await db.drop();}
});

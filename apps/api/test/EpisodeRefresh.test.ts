import {expect,it} from 'vitest';
import {bookingStopsFixture} from './support/bookingStopsFixture.ts';
import {captureAt} from './support/bookingConversationFixture.ts';
import {METADATA_REVIEW_DISCLOSURE} from '@fss/domain/business/acquisition.ts';
import {recordedGmailClient} from '@fss/domain/mail/gmailClientFake.ts';
import {createApprovedBusinessMailObserver} from '@fss/domain/mail/crmSources.ts';
import {claimJobs} from '@fss/domain/jobs/jobStore.ts';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {registerHandlers} from '../../worker/src/bootstrap/main.ts';
import {createBookingInterpretationModel} from '../../worker/src/providers/bookingInterpretationModel.ts';
import {runOnce} from '../../worker/src/runner/jobRunner.ts';

it.each(['two_manual','manual_auto','refusal','opt_out'] as const)('EpisodeRefresh preserves the original bounded aggregate after registered retained-original metadata refresh: %s',async mode=>{
 const f=await bookingStopsFixture();try{
  const event=async(value:string)=>expect((await f.request('POST','/meetings/booking-conversation/event',f.command({conversationId:f.conversationId,expectedPolicyRevision:1,event:value}))).status).toBe(200);
  if(mode==='two_manual'){await event('manual_nudge');await event('manual_nudge');}
  else if(mode==='manual_auto'){
   await event('manual_nudge');f.setClock('2026-10-20T17:00:00Z');
   expect((await f.request('POST','/meetings/booking-messages',f.command({conversationId:f.conversationId,kind:'nudge_7'}))).status).toBe(200);
   await f.run();expect(f.gmail.sends).toHaveLength(1);
  }else await event(mode);
  const initial=(await f.request('GET',`/meetings/booking-conversation?conversationId=${f.conversationId}`)).body as {nudgeCount:number;nudgesStoppedAt:string|null};
  const workspaceId=f.fixture.alpha.workspaceId;
  // Existing controlled acquisition infrastructure only. Refresh itself is an
  // authenticated import followed by the ordinary registered backfill handler.
  await f.fixture.db.query('UPDATE crm_business_policies SET enabled=true,disclosure_version=$3,disclosure_sha256=$4 WHERE workspace_id=$1 AND mailbox_id=$2',[workspaceId,f.mailbox.id,METADATA_REVIEW_DISCLOSURE.version,METADATA_REVIEW_DISCLOSURE.sha256]);
  await f.fixture.db.query("INSERT INTO crm_mail_import_allocations(workspace_id,mailbox_id,revision,owner_user_id,account_binding,generation,project_hash,user_hash,user_limit_units,project_limit_units,user_headroom_units,project_headroom_units,profile_units,list_units,history_units,metadata_units,body_units,verification_sha256,verified_until) VALUES($1,$2,1,$3,$4,1,repeat('c',64),repeat('d',64),1000,1000,100,100,1,1,1,1,1,repeat('e',64),clock_timestamp()+interval '1 hour')",[workspaceId,f.mailbox.id,f.fixture.alpha.admin.userId,f.binding]);
  expect((await f.request('POST','/crm/business/mail/import/request',f.command({mailboxId:f.mailbox.id}))).status).toBe(200);
  const gmail=recordedGmailClient({emailAddress:'owner@booking.example',historyId:'1000',messages:[{id:'booking-source-1',threadId:'booking-thread',historyId:'999',internalDateEpochMilliseconds:Date.parse('2026-10-13T16:00:00Z'),headers:{From:'prospect@booking.example',To:'owner@booking.example',Subject:'Agreed call'},body:'Yes, let us arrange our call.'}]});
  const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmMailBackfill:{gmail:{...gmail,listMessageIds:async()=>({ok:true,messageIds:['booking-source-1'],nextPageToken:null})},resolveAccess:async()=>({mailboxId:f.mailbox.id,providerAccountId:'controlled-google',generation:1,access:{accessToken:'controlled-refresh-only',expiresAtEpochSeconds:Date.now()/1000+3600}}),proofVerifier:{verify:async()=>true},allocationVerifier:{verify:async()=>true},observer:createApprovedBusinessMailObserver({categorizeMetadata:()=>({category:'business',reason:'business_metadata',classifierVersion:'controlled-metadata'})})}});
  const job=(await claimJobs(f.fixture.db,{owner:'episode-refresh-worker',kinds:['crm.mail_backfill'],limit:1,leaseSeconds:120}))[0]!;
  await registry.get('crm.mail_backfill')!.handle({session:f.fixture.db,scope:workspaceScope(workspaceId,{kind:'system',component:'worker'}),job});
  expect(gmail.metadataReads).toEqual(['booking-source-1']);expect(gmail.bodyReads).toEqual([]);expect(gmail.sends).toEqual([]);
  expect((await f.request('POST','/crm/business/mail/read/v2',f.source)).body).toMatchObject({state:'available',source:{sourceRevision:1,passage:'Yes, let us arrange our call.',originalObservation:{state:'available',revision:'1'}}});
  const redacted=(await f.fixture.db.query('SELECT source_refs,source_fingerprint,nudge_count,nudges_stopped_at FROM booking_conversations WHERE workspace_id=$1 AND id=$2',[workspaceId,f.conversationId])).rows[0]!;
  expect(redacted).toMatchObject({source_refs:[],source_fingerprint:'0'.repeat(64),nudge_count:initial.nudgeCount});expect(redacted['nudges_stopped_at']).not.toBeNull();
  const interpretation=await f.interpret();expect(interpretation).not.toBe(f.firstInterpretation);
  const replayed=await f.admit(interpretation);expect(replayed).toBe(f.conversationId);
  expect((await f.request('GET',`/meetings/booking-conversation?conversationId=${replayed}`)).body).toMatchObject({state:'stale',nudgeCount:initial.nudgeCount,nudgesStoppedAt:initial.nudgesStoppedAt,outcome:null});
  f.setClock('2026-10-20T17:00:00Z');
  expect((await f.request('POST','/meetings/booking-messages',f.command({conversationId:replayed,kind:'nudge_3'}))).status).toBe(409);
  await f.run();expect(f.gmail.sends).toHaveLength(mode==='manual_auto'?1:0);
  expect((await f.fixture.db.query('SELECT id FROM booking_conversations WHERE workspace_id=$1',[workspaceId])).rows).toHaveLength(1);
 }finally{await f.stop();}
});

it('EpisodeRefresh distinguishes a fresh canonical message from a stopped original episode',async()=>{
 const f=await bookingStopsFixture();try{
  expect((await f.request('POST','/meetings/booking-conversation/event',f.command({conversationId:f.conversationId,expectedPolicyRevision:1,event:'refusal'}))).status).toBe(200);
  const text='Yes, let us arrange our call.',{source}=await captureAt(f,text,'2026-10-14T16:00:00Z');
  expect(source.sourceId).not.toBe(f.source.sourceId);
  const requested=await f.request('POST','/crm/booking/interpretation/request',f.command({source,priorSources:[]}));expect(requested.status).toBe(200);
  const model=createBookingInterpretationModel({accountBinding:'controlled-bedrock',fundingVerifiedUntil:'2099-01-01T00:00:00Z',surface:{endpointId:'bedrock-runtime.us-east-1.amazonaws.com',converse:async()=>({stopReason:'end_turn',usage:{inputTokens:40,outputTokens:20},output:{message:{role:'assistant',content:[{text:JSON.stringify({intent:'interest',agreement:{sourceId:source.sourceId,start:0,end:text.length,quote:text},slot:null,substantive:null})}]}}})}});
  const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,bookingInterpretation:{authority:f.conversation.interpretationAuthority,model},bookingConversation:f.conversation});
  expect((await runOnce(f.fixture.db,{registry,owner:'fresh-episode-interpreter',limit:30})).failed).toBe(0);
  const fresh=await f.admit((requested.body as {result:{requestId:string}}).result.requestId);expect(fresh).not.toBe(f.conversationId);
  expect((await f.request('GET',`/meetings/booking-conversation?conversationId=${fresh}`)).body).toMatchObject({state:'awaiting_time',nudgeCount:0,nudgesStoppedAt:null});
  expect((await f.request('GET',`/meetings/booking-conversation?conversationId=${f.conversationId}`)).body).toMatchObject({state:'stopped',nudgeCount:0,nudgesStoppedAt:expect.any(String)});
  expect(f.gmail.sends).toHaveLength(0);
 }finally{await f.stop();}
});

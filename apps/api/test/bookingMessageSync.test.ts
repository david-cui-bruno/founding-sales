import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {bookingStopsFixture} from './support/bookingStopsFixture.ts';
import {recordedGmailClient} from '@fss/domain/mail/gmailClientFake.ts';
import {enqueueJob} from '@fss/domain/jobs/jobStore.ts';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {registerHandlers} from '../../worker/src/bootstrap/main.ts';
import {runOnce} from '../../worker/src/runner/jobRunner.ts';
import {todayReplyPromoter} from '../../worker/src/handlers/mail.ts';
import {prepareHumanReplyFence,prepareStandingBookingFence,readFence} from '@fss/domain/outbound/fence.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';

it.each(['provider_identity','rfc_identity','nudge_identity','manual_outgoing','manual_fence','incoming','unrelated_fence','wrong_rfc','queued_incoming','queued_manual','queued_own'] as const)('normal sync interrupts only messages other than this episode own fenced automation: %s',async mode=>{
 const f=await bookingStopsFixture();try{
  const link=await f.request('POST','/meetings/booking-messages',f.command({conversationId:f.conversationId,kind:'approved_link'}));expect(link.status,JSON.stringify(link.body)).toBe(200);await f.run();expect(f.gmail.sends).toHaveLength(1);
  let origin=link;
  if(mode==='nudge_identity'){
   f.setClock('2026-10-16T17:00:00Z');origin=await f.request('POST','/meetings/booking-messages',f.command({conversationId:f.conversationId,kind:'nudge_3'}));expect(origin.status).toBe(200);await f.run();expect(f.gmail.sends).toHaveLength(2);
  }
  const initialSends=f.gmail.sends.length;
  let queued:Awaited<ReturnType<typeof f.request>>|undefined;
  if(mode.startsWith('queued_')){f.setClock('2026-10-16T17:00:00Z');queued=await f.request('POST','/meetings/booking-messages',f.command({conversationId:f.conversationId,kind:'nudge_3'}));expect(queued.status).toBe(200);}
  const fence=(await f.fixture.db.query<{provider_message_id:string;provider_message_id_header:string}>('SELECT provider_message_id,provider_message_id_header FROM outbound_messages WHERE workspace_id=$1 AND id=$2',[f.fixture.alpha.workspaceId,(origin.body as {result:{outboundMessageId:string}}).result.outboundMessageId])).rows[0]!;
  const positive=['provider_identity','rfc_identity','nudge_identity','queued_own'].includes(mode);
  let header=fence.provider_message_id_header,providerId=fence.provider_message_id;
  if(mode==='unrelated_fence'||mode==='manual_fence'){
   // Existing sender infrastructure supplies a genuine, unrelated or human-origin
   // fence. A fence identity alone must not exempt its synchronized outgoing mail.
   const prepare=mode==='manual_fence'?prepareHumanReplyFence:prepareStandingBookingFence;
   const prepared=await withTransaction(f.fixture.db,()=>prepare(f.ctx,{draftId:randomUUID(),mailboxId:f.mailbox.id,firmId:f.firmId,contactId:f.contactId,opportunityId:null,address:'prospect@booking.example',routeId:f.attendeeRouteId,routeVersion:1,subject:'Re: Agreed call',body:f.gmail.sends[0]!.body,sourceZone:'America/New_York'}));
   expect(prepared.ok).toBe(true);if(!prepared.ok)throw new Error(prepared.reason);
   header=(await readFence(f.ctx,prepared.value.outboundMessageId))!.providerMessageIdHeader;providerId='unrelated-provider';
  }
  if(mode==='rfc_identity')providerId='different-provider-copy';
  if(mode==='provider_identity')header='<different-provider-header@booking.example>';
  if(['manual_outgoing','incoming','wrong_rfc','queued_incoming','queued_manual'].includes(mode)){providerId=randomUUID();header=mode==='wrong_rfc'?fence.provider_message_id_header.replace('fss.','not-fss.'):'<manual@booking.example>';}
  const outgoing=mode!=='incoming'&&mode!=='queued_incoming',gmail=recordedGmailClient({...f.gmailFixture,historyId:'1001',messages:[{id:providerId,threadId:'booking-thread',internalDateEpochMilliseconds:Date.now()-60_000,historyId:'1001',labelIds:outgoing?['SENT']:['INBOX'],headers:{From:outgoing?'owner@booking.example':'prospect@booking.example',To:outgoing?'prospect@booking.example':'owner@booking.example',Subject:'Re: Agreed call','Message-ID':header,Date:'Wed, 14 Oct 2026 17:00:00 +0000'},body:'Scheduling update.'}]});
  const registered=registerHandlers(new HandlerRegistry(),{classifier:undefined,send:undefined,research:undefined,mail:{gmail,cipher:f.runtime.send.cipher,oauth:f.runtime.send.oauth,journal:{append:async()=>{}},replyPromoter:todayReplyPromoter(),pushTopicName:'projects/controlled/topics/mail'}});
  // This controlled worker drains only the normally registered sync handler.
  // Unconfigured booking handlers must not claim the queued terminal-send proof.
  const registry=new HandlerRegistry();registry.register(registered.get('mail.sync')!);
  await enqueueJob(f.fixture.db,{workspaceId:f.fixture.alpha.workspaceId,kind:'mail.sync',idempotencyKey:randomUUID(),payload:{mailboxId:f.mailbox.id,generation:1}});
  const synced=await runOnce(f.fixture.db,{registry,owner:'booking-message-sync',limit:30});expect(synced.failed).toBe(0);
  expect((await f.fixture.db.query('SELECT id FROM mail_messages WHERE workspace_id=$1 AND provider_message_id=$2',[f.fixture.alpha.workspaceId,providerId])).rows).toHaveLength(1);
  f.setClock(mode==='nudge_identity'?'2026-10-20T17:00:00Z':'2026-10-16T17:00:00Z');
  const nudge=queued??await f.request('POST','/meetings/booking-messages',f.command({conversationId:f.conversationId,kind:mode==='nudge_identity'?'nudge_7':'nudge_3'}));
  if(positive){
   expect(nudge.status,JSON.stringify(nudge.body)).toBe(200);await f.run();expect(f.gmail.sends).toHaveLength(initialSends+1);
   expect(f.gmail.sends[initialSends]).toMatchObject({threadId:'booking-thread',to:'prospect@booking.example',inReplyTo:'<controlled-interest@booking.example>',references:['<controlled-interest@booking.example>']});
  }else{
   if(queued){await f.run();expect((await f.request('GET',`/meetings/booking-messages?messageId=${(queued.body as {result:{messageId:string}}).result.messageId}`)).body).toMatchObject({state:'held'});}
   else expect(nudge.status,JSON.stringify(nudge.body)).toBe(409);
   expect(f.gmail.sends).toHaveLength(initialSends);
  }
 }finally{await f.stop();}
});

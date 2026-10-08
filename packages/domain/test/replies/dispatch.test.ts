import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {createOutboundWorld,type OutboundWorld} from '../outbound/support/outboundWorld.ts';
import {seedFirm,openExtraSession,pausingAtTokenRefresh} from '../outbound/support/dispatchFixtures.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {withTransaction} from '../../db/queryable.ts';
import {recordMessage,storeMessageBody} from '../../mail/messages.ts';
import {recordMatches} from '../../mail/matching.ts';
import {setProspectingAuthorization} from '../../outreach/authorization.ts';
import {previewHumanReply,requestHumanReplySend,readHumanReplySend} from '../../replies/dispatch.ts';
import {dispatchOutboundMessage} from '../../outbound/send.ts';
import {readReplyDraftContext} from '../../replies/composer.ts';
import {recordSuppression} from '../../suppression/events.ts';
import {recordingSuppressionJournal} from '../../suppression/journal.ts';
import {receiveCalcomEvent} from '../../meetings/calcom.ts';
import {applyDirectSendEffects} from '../../mail/effects.ts';
import {reassignFirm} from '../../crm/firms.ts';
import {saveAnswerBlock,approveAnswerBlock,retireAnswerBlock} from '../../outreach/facts.ts';
import {reconcileOutboundMessage} from '../../outbound/reconcile.ts';
import type {HumanReplySendInput} from '../../../contracts/src/replyComposer.ts';
import {setAdminCap} from '../../outbound/ramp.ts';

let world:OutboundWorld;
beforeAll(async()=>{world=await createOutboundWorld();});
afterAll(async()=>world.stop());
async function fixture(withCc=false){
 const member=world.alpha.workspace.salesperson;
 const ctx=repositoryContext(workspaceScope(world.alpha.workspace.workspaceId,{kind:'user',userId:member.userId,role:'salesperson'}),world.database.session);
 const admin=repositoryContext(workspaceScope(ctx.scope.workspaceId,{kind:'user',userId:world.alpha.workspace.admin.userId,role:'admin'}),ctx.db);
 const tx=<T>(work:()=>Promise<T>)=>withTransaction(world.database.session,work);
 const firm=await seedFirm(world,world.alpha,'human-send');
 await ctx.db.query("UPDATE firms SET time_zone='Etc/UTC',time_zone_confidence='high',time_zone_source='recorded',time_zone_rule_version='fixture' WHERE workspace_id=$1 AND id=$2",[ctx.scope.workspaceId,firm.firmId]);
 const cc=withCc?[`colleague-${randomUUID()}@prospect.example.test`]:[];
 if(withCc){
  const contact=(await ctx.db.query<{id:string}>('INSERT INTO contacts(workspace_id,firm_id,full_name) VALUES($1,$2,$3) RETURNING id',[ctx.scope.workspaceId,firm.firmId,'Colleague Fixture'])).rows[0]!;
  await ctx.db.query("INSERT INTO email_addresses(workspace_id,firm_id,contact_id,address,source,retrieved_at,association_confidence,technical_validation,eligibility,eligibility_policy_version) VALUES($1,$2,$3,$4,'reply',now(),0.9,'passed','usable','fixture')",[ctx.scope.workspaceId,firm.firmId,contact.id,cc[0]]);
 }
 const auth=(await ctx.db.query<{revision:number}>('SELECT revision FROM gmail_prospecting_authorizations WHERE workspace_id=$1 AND mailbox_id=$2',[ctx.scope.workspaceId,world.alpha.mailboxId])).rows[0];
 await tx(()=>setProspectingAuthorization(admin,{mailboxId:world.alpha.mailboxId,expectedRevision:auth?.revision??0,enabled:true,basis:'owner_reported_google_permission'}));
 const sessionId=randomUUID();
 await ctx.db.query("INSERT INTO sessions(workspace_id,id,user_id,device_id,access_token_hash,expires_at,reauthenticate_after) VALUES($1,$2,$3,$4,$5,now()+interval '1 hour',now()+interval '30 days')",[ctx.scope.workspaceId,sessionId,member.userId,member.deviceId,randomUUID().replaceAll('-','')+'a'.repeat(32)]);
 const threadId=randomUUID();
 const incoming=await tx(()=>recordMessage(ctx,{mailboxId:world.alpha.mailboxId,metadata:{providerMessageId:randomUUID(),providerThreadId:threadId,rfcMessageId:`${threadId}@example.test`,direction:'incoming',internalDate:new Date(Date.now()-1000).toISOString(),headerFrom:firm.address,headerTo:[world.alpha.address],headerCc:cc,subject:'Can you help?',referenceMessageIds:[],inReplyTo:null,autoSubmitted:null,listId:null,labelIds:[],attachments:[]}}));
 await tx(()=>recordMatches(ctx,{messageId:incoming.message.id,candidates:[{firmId:firm.firmId,contactId:firm.contactId,opportunityId:firm.opportunityId,rule:'participant',viaClosedOpportunity:false}]}));
 await tx(()=>storeMessageBody(ctx,{messageId:incoming.message.id,text:'Could you explain Callie?',truncated:false}));
 const input={messageId:incoming.message.id,text:'Callie helps coordinate maintenance requests.\n\nDavid',factRefs:[],envelope:{to:[firm.address],cc}};
 const preview=await previewHumanReply(ctx,input);if(!preview.ok)throw new Error(preview.reason);
 const send:HumanReplySendInput={...input,commandId:randomUUID(),clientVersion:'1.0.0',sourceRevision:preview.value.sourceRevision,draftRevision:preview.value.draftRevision};
 return {ctx,admin,tx,firm,threadId,input,cc,preview:preview.value,send,identity:{sessionId,deviceId:member.deviceId}};
}

for(const change of ['stop','booking','new question','manual Gmail answer','reassignment','retired fact','ended session'] as const)it(`a ${change} committed during token refresh refuses the exact human reply with zero submissions`,async()=>{
 const f=await fixture(),second=await openExtraSession(world),human=repositoryContext(f.ctx.scope,second.session),admin=repositoryContext(f.admin.scope,second.session);
 try{
  let fact:{id:string;version:number}|null=null;
  if(change==='retired fact'){
   const block=await f.tx(()=>saveAnswerBlock(f.admin,{kind:'product',text:'A current approved fact.'}));if(!block.ok)throw new Error(block.reason);
   await f.tx(()=>approveAnswerBlock(f.admin,{id:block.value.id,version:1}));fact={id:block.value.id,version:1};
   f.send.factRefs=[fact];const p=await previewHumanReply(f.ctx,{...f.input,factRefs:[fact]});if(!p.ok)throw new Error(p.reason);f.send.sourceRevision=p.value.sourceRevision;f.send.draftRevision=p.value.draftRevision;
  }
  const queued=await f.tx(()=>requestHumanReplySend(f.ctx,f.send,f.identity));if(!queued.ok)throw new Error(queued.reason);
  const before=world.alpha.gmail.sends.length;
  const paused=pausingAtTokenRefresh(world.alpha.gmail,()=>withTransaction(second.session,async()=>{
   if(change==='stop')await recordSuppression(admin,{scope:'firm',firmId:f.firm.firmId,source:'prospect_opt_out',channel:'email',commandId:randomUUID(),journal:recordingSuppressionJournal()});
   if(change==='reassignment')await reassignFirm(admin,{firmId:f.firm.firmId,toUserId:world.alpha.workspace.admin.userId,reason:'Controlled race'});
   if(change==='retired fact')await retireAnswerBlock(admin,fact!);
   if(change==='ended session')await second.session.query("UPDATE sessions SET status='ended',ended_at=now(),end_reason='signed_out' WHERE workspace_id=$1 AND id=$2",[f.ctx.scope.workspaceId,f.identity.sessionId]);
   if(change==='booking'){
    const body={triggerEvent:'BOOKING_CREATED',createdAt:'2026-10-08T14:00:00.000Z',payload:{uid:randomUUID(),startTime:'2026-10-12T15:00:00.000Z',endTime:'2026-10-12T15:30:00.000Z',attendees:[{email:f.firm.address,name:'Robin'}],organizer:{email:world.alpha.address},title:'A call'}};
    const booked=await receiveCalcomEvent(second.session,{workspaceId:f.ctx.scope.workspaceId,rawBody:Buffer.from(JSON.stringify(body)),body});if(booked.outcome!=='applied')throw new Error('Booking fixture was not applied');
   }
   if(change==='new question'||change==='manual Gmail answer'){
    const message=await recordMessage(human,{mailboxId:world.alpha.mailboxId,metadata:{providerMessageId:randomUUID(),providerThreadId:f.threadId,rfcMessageId:`${randomUUID()}@example.test`,direction:change==='new question'?'incoming':'outgoing',internalDate:new Date().toISOString(),headerFrom:change==='new question'?f.firm.address:world.alpha.address,headerTo:change==='new question'?[world.alpha.address]:[f.firm.address],headerCc:[],subject:'Can you help?',referenceMessageIds:[],inReplyTo:null,autoSubmitted:null,listId:null,labelIds:[],attachments:[]}});
    const candidate={firmId:f.firm.firmId,contactId:f.firm.contactId,opportunityId:f.firm.opportunityId,rule:'participant' as const,viaClosedOpportunity:false};
    await recordMatches(human,{messageId:message.message.id,candidates:[candidate]});await storeMessageBody(human,{messageId:message.message.id,text:'A changed conversation.',truncated:false});
    if(change==='manual Gmail answer')await applyDirectSendEffects(human,{message:message.message,candidate});
   }
  }));
  const report=await dispatchOutboundMessage(f.ctx,world.sendDeps(world.alpha,{gmail:paused.client}),{outboundMessageId:queued.value.outboundMessageId});
  expect(paused.refreshes()).toBe(1);expect(report.outcome).toBe('held');expect(world.alpha.gmail.sends).toHaveLength(before);
  expect(report.refusal).toMatch(/firm_suppressed|step_ineligible/u);
 }finally{await second.close();}
});

it('an exact explicit approval queues one original attempt and readback survives another command without sending',async()=>{
 const f=await fixture();
 const first=await f.tx(()=>requestHumanReplySend(f.ctx,f.send,f.identity));
 expect(first).toMatchObject({ok:true,value:{state:'queued',messageId:f.input.messageId,providerMessageId:null}});
 expect(await f.tx(()=>requestHumanReplySend(f.ctx,{...f.send,commandId:randomUUID()},f.identity))).toEqual(first);
 expect(await readHumanReplySend(f.ctx,{messageId:f.input.messageId})).toEqual(first);
 expect(world.alpha.gmail.sends).toHaveLength(0);
 expect(JSON.stringify(first)).not.toContain(f.input.text);
});

it('a definitely unsent refusal requires a new explicit approval of the same original fence',async()=>{
 const f=await fixture(),queued=await f.tx(()=>requestHumanReplySend(f.ctx,f.send,f.identity));if(!queued.ok)throw new Error(queued.reason);
 const before=world.alpha.gmail.sends.length,id=queued.value.outboundMessageId;
 expect(await dispatchOutboundMessage(f.ctx,world.sendDeps(world.alpha,{deploymentSendingEnabled:false}),{outboundMessageId:id})).toMatchObject({outcome:'held',refusal:'workspace_sending_not_attested'});
 await dispatchOutboundMessage(f.ctx,world.sendDeps(world.alpha),{outboundMessageId:id});
 expect(world.alpha.gmail.sends).toHaveLength(before);
 expect(await f.tx(()=>requestHumanReplySend(f.ctx,f.send,f.identity))).toMatchObject({ok:true,value:{state:'held'}});
 const fresh=await f.tx(()=>requestHumanReplySend(f.ctx,{...f.send,commandId:randomUUID()},f.identity));
 expect(fresh).toMatchObject({ok:true,value:{state:'queued',outboundMessageId:id}});
 expect(await dispatchOutboundMessage(f.ctx,world.sendDeps(world.alpha),{outboundMessageId:id})).toMatchObject({outcome:'sent'});
 expect(world.alpha.gmail.sends).toHaveLength(before+1);
});

it('dispatches reviewed bytes once in the original thread and reports confirmed delivery as an answered conversation',async()=>{
 const f=await fixture(),queued=await f.tx(()=>requestHumanReplySend(f.ctx,f.send,f.identity));if(!queued.ok)throw new Error(queued.reason);
 const before=world.alpha.gmail.sends.length;
 const report=await dispatchOutboundMessage(f.ctx,world.sendDeps(world.alpha),{outboundMessageId:queued.value.outboundMessageId});
 if(report.outcome!=='sent')throw new Error(JSON.stringify(report));
 expect(report).toMatchObject({outcome:'sent'});
 expect(world.alpha.gmail.sends.slice(before)).toMatchObject([{to:f.firm.address,subject:'Can you help?',body:'Callie helps coordinate maintenance requests.\n\nDavid\n\n',threadId:f.threadId,inReplyTo:`<${f.threadId}@example.test>`,references:[`<${f.threadId}@example.test>`]}]);
 expect(await readHumanReplySend(f.ctx,f.input)).toMatchObject({ok:true,value:{state:'sent',providerMessageId:expect.any(String),sentAt:expect.any(String)}});
 expect(await dispatchOutboundMessage(f.ctx,world.sendDeps(world.alpha),{outboundMessageId:queued.value.outboundMessageId})).toMatchObject({outcome:'already_terminal'});
 expect(world.alpha.gmail.sends).toHaveLength(before+1);
 expect(await readReplyDraftContext(f.ctx,{messageId:f.input.messageId,factRefs:[]})).toEqual({ok:false,reason:'answered_manually'});
});

it('uncertain acceptance survives another connection and command, then reconciles the original message without resubmission',async()=>{
 const f=await fixture(),queued=await f.tx(()=>requestHumanReplySend(f.ctx,f.send,f.identity));if(!queued.ok)throw new Error(queued.reason);
 const gmail=world.clientWith(world.alpha,{sendBehaviour:'indeterminate_but_delivered'}),id=queued.value.outboundMessageId;
 expect(await dispatchOutboundMessage(f.ctx,world.sendDeps(world.alpha,{gmail}),{outboundMessageId:id})).toMatchObject({outcome:'reconciling'});
 const other=await openExtraSession(world),restarted=repositoryContext(f.ctx.scope,other.session);
 try{
  expect(await readHumanReplySend(restarted,f.input)).toMatchObject({ok:true,value:{state:'reconciling',outboundMessageId:id,providerMessageId:null}});
  expect(await withTransaction(other.session,()=>requestHumanReplySend(restarted,{...f.send,commandId:randomUUID(),text:'A replacement must never go.'},f.identity))).toMatchObject({ok:true,value:{state:'reconciling',outboundMessageId:id}});
  await dispatchOutboundMessage(restarted,world.sendDeps(world.alpha,{gmail}),{outboundMessageId:id});
  expect(gmail.sends).toHaveLength(1);
  expect(await reconcileOutboundMessage(restarted,world.reconcileDeps(world.alpha,{gmail}),{outboundMessageId:id})).toMatchObject({outcome:'sent'});
  expect(await readHumanReplySend(restarted,f.input)).toMatchObject({ok:true,value:{state:'sent',outboundMessageId:id,providerMessageId:expect.any(String)}});
  expect(await readReplyDraftContext(restarted,{messageId:f.input.messageId,factRefs:[]})).toEqual({ok:false,reason:'answered_manually'});
  expect(gmail.sends).toHaveLength(1);
 }finally{await other.close();}
});

it('an explicit human approval cannot override a lower mailbox cap',async()=>{
 const f=await fixture(),queued=await f.tx(()=>requestHumanReplySend(f.ctx,f.send,f.identity));if(!queued.ok)throw new Error(queued.reason);
 const before=world.alpha.gmail.sends.length;
 await f.tx(()=>setAdminCap(f.admin,{mailboxId:world.alpha.mailboxId,adminUserId:world.alpha.workspace.admin.userId,lowerTo:0}));
 try{
  expect(await dispatchOutboundMessage(f.ctx,world.sendDeps(world.alpha),{outboundMessageId:queued.value.outboundMessageId})).toMatchObject({outcome:'held',refusal:'daily_cap'});
  expect(await readHumanReplySend(f.ctx,f.input)).toMatchObject({ok:true,value:{state:'held',reason:'daily_cap'}});
  expect(world.alpha.gmail.sends).toHaveLength(before);
 }finally{await f.tx(()=>setAdminCap(f.admin,{mailboxId:world.alpha.mailboxId,adminUserId:world.alpha.workspace.admin.userId,lowerTo:null}));}
});

it('dispatches only the exact verified CC choice and a CC stop during refresh prevents submission',async()=>{
 const first=await fixture(true),queued=await first.tx(()=>requestHumanReplySend(first.ctx,first.send,first.identity));if(!queued.ok)throw new Error(queued.reason);
 const before=world.alpha.gmail.sends.length;
 expect(await dispatchOutboundMessage(first.ctx,world.sendDeps(world.alpha),{outboundMessageId:queued.value.outboundMessageId})).toMatchObject({outcome:'sent'});
 expect(world.alpha.gmail.sends.slice(before)).toMatchObject([{to:first.firm.address,cc:first.cc,threadId:first.threadId}]);
 const stopped=await fixture(true),second=await openExtraSession(world),admin=repositoryContext(stopped.admin.scope,second.session);
 try{
  const q=await stopped.tx(()=>requestHumanReplySend(stopped.ctx,stopped.send,stopped.identity));if(!q.ok)throw new Error(q.reason);
  const paused=pausingAtTokenRefresh(world.alpha.gmail,()=>withTransaction(second.session,()=>recordSuppression(admin,{scope:'handle',value:stopped.cc[0]!,firmId:stopped.firm.firmId,source:'prospect_opt_out',channel:'email',commandId:randomUUID(),journal:recordingSuppressionJournal()})).then(()=>undefined));
  expect(await dispatchOutboundMessage(stopped.ctx,world.sendDeps(world.alpha,{gmail:paused.client}),{outboundMessageId:q.value.outboundMessageId})).toMatchObject({outcome:'held',detail:'human_reply:conversation_stopped'});
  expect(paused.refreshes()).toBe(1);expect(world.alpha.gmail.sends).toHaveLength(before+1);
 }finally{await second.close();}
});

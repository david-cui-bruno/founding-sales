import {routineReplyFixture} from './routineFixture.ts';
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,it,expect} from 'vitest';
import {createOutboundWorld,type OutboundWorld} from '../outbound/support/outboundWorld.ts';
import {pausingAtTokenRefresh} from '../outbound/support/dispatchFixtures.ts';
import {withTransaction} from '../../db/queryable.ts';
import {repositoryContext} from '../../db/workspaceScope.ts';
import {setProspectingAuthorization} from '../../outreach/authorization.ts';
import {recordMessage,storeMessageBody} from '../../mail/messages.ts';
import {readRoutineSource} from '../../outreach/replyRequests.ts';
import {readFence} from '../../outbound/fence.ts';
import {dispatchOutboundMessage} from '../../outbound/send.ts';
import {decideSend} from '../../outbound/gate.ts';
let world:OutboundWorld;
beforeAll(async()=>{world=await createOutboundWorld();});
afterAll(async()=>world.stop());
const fixture=(beforePrepare?:Parameters<typeof routineReplyFixture>[1])=>routineReplyFixture(world,beforePrepare);
it('dispatches a routine reply once with frozen threading, and replay cannot send twice',async()=>{
 const f=await fixture(),gmail=world.clientWith(world.alpha,{}),deps=world.sendDeps(world.alpha,{gmail});
 const verdict=await decideSend(f.ctx,(await readFence(f.ctx,f.fenceId))!,deps);expect(verdict.ok,JSON.stringify(verdict)).toBe(true);
 const sent=await dispatchOutboundMessage(f.ctx,deps,{outboundMessageId:f.fenceId});expect(sent.outcome,JSON.stringify(sent)).toBe('sent');
 await dispatchOutboundMessage(f.ctx,deps,{outboundMessageId:f.fenceId});
 expect(gmail.sends).toHaveLength(1);expect(gmail.sends[0]).toMatchObject({threadId:f.plan,inReplyTo:`${f.plan}@example.test`,to:f.firm.address});
 expect((await f.ctx.db.query('SELECT state FROM outreach_reply_requests WHERE id=$1',[f.requestId])).rows[0]).toEqual({state:'delivered'});
});
it('a changed source during token refresh blocks the final claim',async()=>{
 const f=await fixture(),gmail=world.clientWith(world.alpha,{});
 const paused=pausingAtTokenRefresh(gmail,async()=>{await f.tx(()=>storeMessageBody(f.ctx,{messageId:f.messageId,text:'Please do not contact me again.',truncated:false}));});
 const report=await dispatchOutboundMessage(f.ctx,world.sendDeps(world.alpha,{gmail:paused.client}),{outboundMessageId:f.fenceId});
 expect(paused.refreshes()).toBe(1);expect(report.outcome).toBe('held');expect(gmail.sends).toHaveLength(0);
});
for(const change of ['authorization','owner','fact','rematch','automatic','takeover','policy','pause'] as const)it(`${change} committed during refresh prevents an outdated reply`,async()=>{
 const f=await fixture(),gmail=world.clientWith(world.alpha,{});
 const paused=pausingAtTokenRefresh(gmail,async()=>f.tx(async()=>{
  if(change==='authorization'){
   const row=(await f.ctx.db.query<{revision:number}>('SELECT revision FROM gmail_prospecting_authorizations WHERE workspace_id=$1 AND mailbox_id=$2',[f.ctx.scope.workspaceId,world.alpha.mailboxId])).rows[0]!;
   await setProspectingAuthorization(f.ctx,{mailboxId:world.alpha.mailboxId,expectedRevision:row.revision,enabled:false,basis:'owner_reported_google_permission'});
  }else if(change==='owner')await f.ctx.db.query('UPDATE firms SET assigned_user_id=$2 WHERE id=$1',[f.firm.firmId,world.alpha.workspace.admin.userId]);
  else if(change==='fact'){const {retireAnswerBlock}=await import('../../outreach/facts.ts');await retireAnswerBlock(f.ctx,{id:f.block.id,version:1});}
  else if(change==='rematch')await f.ctx.db.query('DELETE FROM mail_message_matches WHERE mail_message_id=$1',[f.messageId]);
  else if(change==='automatic')await f.ctx.db.query("UPDATE mail_messages SET auto_submitted='auto-replied' WHERE id=$1",[f.messageId]);
  else if(change==='policy')await f.ctx.db.query('UPDATE outreach_settings SET reply_sequence_version_id=NULL WHERE workspace_id=$1',[f.ctx.scope.workspaceId]);
  else if(change==='takeover')await f.ctx.db.query("UPDATE outreach_plans SET state='manual',revision=revision+1 WHERE id=$1",[f.plan]);
  else await f.ctx.db.query('UPDATE outreach_settings SET routine_replies_enabled=false WHERE workspace_id=$1',[f.ctx.scope.workspaceId]);
 }));
 const report=await dispatchOutboundMessage(f.ctx,world.sendDeps(world.alpha,{gmail:paused.client}),{outboundMessageId:f.fenceId});
 expect(paused.refreshes()).toBe(1);expect(report.outcome).toBe('held');expect(gmail.sends).toHaveLength(0);
});
it('keeps uncertain provider acceptance fenced rather than sending another answer',async()=>{
 const f=await fixture(),gmail=world.clientWith(world.alpha,{sendBehaviour:'indeterminate'}),deps=world.sendDeps(world.alpha,{gmail});
 await dispatchOutboundMessage(f.ctx,deps,{outboundMessageId:f.fenceId});
 await dispatchOutboundMessage(f.ctx,deps,{outboundMessageId:f.fenceId});
 expect(gmail.sends).toHaveLength(1);expect((await readFence(f.ctx,f.fenceId))?.state).toBe('reconciling');
});
it('expires a stranded paid claim independently of the failed worker and settles it once',async()=>{
 const f=await fixture();
 const {reserveAttempt,markCalling}=await import('../../research/reservations.ts');
 const {expireRoutineReplies}=await import('../../outreach/replyRun.ts');
 const reservation=await f.tx(async()=>{
  const r=await reserveAttempt(f.ctx,{subjectKind:'outreach_reply',subjectId:f.requestId,attempt:1,providerKey:'aws_bedrock.outreach_reply',at:new Date().toISOString(),businessTimeZone:'America/New_York',cents:2,modelName:'claude-haiku-4-5',maxInputTokens:100,maxOutputTokens:1024});
  await markCalling(f.ctx,r.id);
  await f.ctx.db.query("UPDATE outreach_reply_requests SET state='calling',paid_attempts=1,created_at=now()-interval '31 minutes',deadline_at=now()-interval '1 minute' WHERE id=$1",[f.requestId]);
  return r;
 });
 await f.tx(()=>expireRoutineReplies(f.ctx,new Date().toISOString()));
 await f.tx(()=>expireRoutineReplies(f.ctx,new Date().toISOString()));
 expect((await f.ctx.db.query('SELECT state FROM outreach_reply_requests WHERE id=$1',[f.requestId])).rows[0]).toEqual({state:'expired'});
 expect((await f.ctx.db.query('SELECT state,settled_cents FROM provider_reservations WHERE id=$1',[reservation.id])).rows[0]).toEqual({state:'estimated',settled_cents:2});
});
it('scheduler maintenance skips a busy research budget without waiting for its owner',async()=>{
 const f=await fixture(),session=await world.database.appRuntimeSession();
 const {lockResearchBudget}=await import('../../research/ceilings.ts');
 const {tryLockRoutineWorkspace}=await import('../../outreach/replyRun.ts');
 await session.query('BEGIN');
 try{
  const other=repositoryContext(f.ctx.scope,session);await lockResearchBudget(other);
  expect(await f.tx(()=>tryLockRoutineWorkspace(f.ctx))).toBe(false);
 }finally{await session.query('ROLLBACK');}
 expect(await f.tx(()=>tryLockRoutineWorkspace(f.ctx))).toBe(true);
});
it('attributes only accepted sends and confirmed human replies, replayed once',async()=>{
 const f=await fixture();
 const {attributeFirmInteraction,reconcileEmailAttribution}=await import('../../sourcing/attribution.ts');
 const attribute=(id:string)=>f.tx(()=>attributeFirmInteraction(f.ctx,{firmId:f.firm.firmId,kind:'email',subjectId:id}));
 const rows=()=>f.ctx.db.query('SELECT subject_id,outbound FROM sourcing_interactions WHERE workspace_id=$1 AND kind=$2 AND subject_id=ANY($3::uuid[]) ORDER BY outbound DESC',[f.ctx.scope.workspaceId,'email',[f.fenceId,f.messageId]]);
 await attribute(f.fenceId);await attribute(f.messageId);expect((await rows()).rows).toHaveLength(0);
 await dispatchOutboundMessage(f.ctx,world.sendDeps(world.alpha),{outboundMessageId:f.fenceId});
 await f.tx(()=>reconcileEmailAttribution(f.ctx));await f.tx(()=>reconcileEmailAttribution(f.ctx));await attribute(f.fenceId);
 expect((await rows()).rows).toEqual([{subject_id:f.fenceId,outbound:true}]);
 await f.ctx.db.query("INSERT INTO mail_message_classifications(workspace_id,mail_message_id,layer,class,requires_confirmation,rules_version) VALUES($1,$2,'deterministic','human',false,'fixture')",[f.ctx.scope.workspaceId,f.messageId]);
 await attribute(f.messageId);await attribute(f.messageId);
 expect((await rows()).rows).toEqual([{subject_id:f.fenceId,outbound:true},{subject_id:f.messageId,outbound:false}]);
});

for(const targetKind of ['firm','contact'] as const)for(const sent of [false,true])it(`deletes ${targetKind} with a ${sent?'sent':'prepared'} routine delivery`,async()=>{
 const f=await fixture();
 if(sent)await dispatchOutboundMessage(f.ctx,world.sendDeps(world.alpha),{outboundMessageId:f.fenceId});
 const {previewDeletion,commitDeletion}=await import('../../retention/deletion.ts');
 const {recordingSuppressionJournal}=await import('../../suppression/journal.ts');
 const preview=await previewDeletion(f.ctx,{targetKind,firmId:f.firm.firmId,...(targetKind==='contact'?{contactId:f.firm.contactId}:{})});
 expect(preview.ok).toBe(true);
 const result=await commitDeletion(f.ctx,{requestId:preview.value!.requestId,previewHash:preview.value!.previewHash,commandId:randomUUID(),journal:recordingSuppressionJournal()});
 expect(result.ok,JSON.stringify(result)).toBe(true);
 expect((await f.ctx.db.query('SELECT * FROM outreach_reply_deliveries WHERE request_id=$1',[f.requestId])).rows).toHaveLength(0);
});
it('a confirmed reply cannot undo explicit conversation takeover',async()=>{
 const f=await fixture();
 const {handleRoutineManually}=await import('../../outreach/settings.ts');
 const {confirmReplyDisposition}=await import('../../classification/confirmations.ts');
 const {recordingSuppressionJournal}=await import('../../suppression/journal.ts');
 await f.ctx.db.query("INSERT INTO mail_message_classifications(workspace_id,mail_message_id,layer,class,requires_confirmation,rules_version) VALUES($1,$2,'deterministic','human',true,'fixture')",[f.ctx.scope.workspaceId,f.messageId]);
 const handled=await f.tx(()=>handleRoutineManually(f.ctx,{id:f.requestId,expectedRevision:1}));expect(handled.ok).toBe(true);
 const result=await f.tx(()=>confirmReplyDisposition(f.ctx,{messageId:f.messageId,disposition:'interested',grantFollowUp:false,journal:recordingSuppressionJournal()}));
 expect(result.ok,JSON.stringify(result)).toBe(true);
 expect((await f.ctx.db.query('SELECT state FROM outreach_plans WHERE id=$1',[f.plan])).rows[0]).toEqual({state:'manual'});
 expect((await readRoutineSource(f.ctx,{planId:f.plan,messageId:f.messageId})).ok).toBe(false);
});

it('a direct human answer on another thread invalidates the pending answer before permission exists',async()=>{
 await expect(fixture(async({ctx,firm,plan,messageId})=>{
  const {applyDirectSendEffects}=await import('../../mail/effects.ts');
  const incoming=(await ctx.db.query<{internal_date:Date}>('SELECT internal_date FROM mail_messages WHERE id=$1',[messageId])).rows[0]!;
  const outgoing=await withTransaction(ctx.db,()=>recordMessage(ctx,{mailboxId:world.alpha.mailboxId,metadata:{providerMessageId:randomUUID(),providerThreadId:randomUUID(),rfcMessageId:`${randomUUID()}@example.test`,direction:'outgoing',internalDate:new Date(incoming.internal_date.getTime()+1000).toISOString(),headerFrom:world.alpha.address,headerTo:[firm.address],headerCc:[],subject:'Here is the answer',referenceMessageIds:[],inReplyTo:null,autoSubmitted:null,listId:null,labelIds:[],attachments:[]}}));
  await withTransaction(ctx.db,()=>applyDirectSendEffects(ctx,{message:outgoing.message,candidate:{firmId:firm.firmId,contactId:firm.contactId,opportunityId:null,outreachPlanId:plan,rule:'participant',viaClosedOpportunity:false}}));
 })).rejects.toThrow('answered_manually');
});
it('reassigns an unclaimed prepared email after midnight but retains an uncertain dispatch',async()=>{
 const f=await fixture();const {buildOutreachCadence}=await import('../../outreach/cadence.ts');const {claimProspectingTouch}=await import('../../outreach/touchReservations.ts');
 const start='2026-10-05T14:00:00.000Z',cadence=buildOutreachCadence({lane:'email_first',startsAt:start,timeZone:'America/New_York'});
 await f.ctx.db.query("UPDATE outreach_plans SET state='active',cadence=$2::jsonb,expires_at=$3 WHERE id=$1",[f.plan,JSON.stringify(cadence),cadence.expiresAt]);
 const actionId=(await f.ctx.db.query<{step_execution_id:string}>('SELECT step_execution_id FROM outbound_messages WHERE id=$1',[f.fenceId])).rows[0]!.step_execution_id;
 const input={planId:f.plan,expectedRevision:1,actionId,channel:'email' as const,expectedOrdinal:1,at:start};
 const first=await f.tx(()=>claimProspectingTouch(f.ctx,input));expect(first.ok).toBe(true);
 const next=await f.tx(()=>claimProspectingTouch(f.ctx,{...input,at:'2026-10-06T14:00:00.000Z'}));expect(next.ok,JSON.stringify(next)).toBe(true);
 expect((await f.ctx.db.query('SELECT local_date::text FROM outreach_touch_reservations WHERE plan_id=$1',[f.plan])).rows).toEqual([{local_date:'2026-10-06'}]);
 await f.ctx.db.query("UPDATE outbound_messages SET state='dispatching',attempt_token=$2,dispatch_started_at=$3 WHERE id=$1",[f.fenceId,randomUUID(),'2026-10-06T14:00:00.000Z']);
 const unknown=await f.tx(()=>claimProspectingTouch(f.ctx,{...input,at:'2026-10-07T14:00:00.000Z'}));expect(unknown.ok).toBe(false);
 expect((await f.ctx.db.query('SELECT state,local_date::text FROM outreach_touch_reservations WHERE plan_id=$1',[f.plan])).rows).toEqual([{state:'reserved',local_date:'2026-10-06'}]);
});

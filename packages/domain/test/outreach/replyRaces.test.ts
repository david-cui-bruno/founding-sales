import {routineReplyFixture} from './routineFixture.ts';
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,it,expect} from 'vitest';
import {createOutboundWorld,type OutboundWorld} from '../outbound/support/outboundWorld.ts';
import {repositoryContext} from '../../db/workspaceScope.ts';
import {readFence,claimForDispatch,beginReconciling,recordSent} from '../../outbound/fence.ts';
import {dispatchOutboundMessage} from '../../outbound/send.ts';
import {reconcileOutboundMessage} from '../../outbound/reconcile.ts';
import {recordRoutineDelivery,routineReplyThreading} from '../../outreach/replyDelivery.ts';
let world:OutboundWorld;
beforeAll(async()=>{world=await createOutboundWorld();});
afterAll(async()=>world.stop());
const fixture=()=>routineReplyFixture(world);
/** Reconstruct an already attempted historical effect, never dispatch through current policy. */
async function historicalAttempt(f:Awaited<ReturnType<typeof fixture>>,sent=false){
 const claim=await f.tx(()=>claimForDispatch(f.ctx,{outboundMessageId:f.fenceId}));if(!claim.ok)throw Error(claim.reason);
 if(sent){
  await f.tx(()=>recordSent(f.ctx,{outboundMessageId:f.fenceId,attemptToken:claim.value.attemptToken,providerMessageId:'historical-provider-id',providerThreadId:f.plan}));
  await f.tx(()=>recordRoutineDelivery(f.ctx,f.fenceId));
 }else await f.tx(()=>beginReconciling(f.ctx,{outboundMessageId:f.fenceId,detail:'retained historical uncertain attempt',windowHours:24}));
}
it('never dispatches an unattempted historical routine reply despite stored enabled settings',async()=>{
 const f=await fixture(),gmail=world.clientWith(world.alpha,{});
 const report=await dispatchOutboundMessage(f.ctx,world.sendDeps(world.alpha,{gmail}),{outboundMessageId:f.fenceId});
 expect(report.outcome).toBe('held');expect(gmail.sends).toHaveLength(0);
 expect((await readFence(f.ctx,f.fenceId))?.attemptToken).toBeNull();
 expect((await f.ctx.db.query('SELECT state FROM outreach_reply_requests WHERE id=$1',[f.requestId])).rows[0]).toEqual({state:'ready'});
});
it.each([false,true])('retains historical UNKNOWN reconciliation without resend, Sent hit=%s',async(found)=>{
 const f=await fixture();await historicalAttempt(f);
 const before=await readFence(f.ctx,f.fenceId),gmail=world.clientWith(world.alpha,{});
 // Source/settings loss cannot erase the identity of an attempted send.
 await f.ctx.db.query('UPDATE outreach_settings SET routine_replies_enabled=false,reply_sequence_version_id=NULL WHERE workspace_id=$1',[f.ctx.scope.workspaceId]);
 await f.ctx.db.query('DELETE FROM mail_message_bodies WHERE mail_message_id=$1',[f.messageId]);
 const threading=await routineReplyThreading(f.ctx,f.fenceId);
 expect(threading).toEqual({threadId:f.plan,inReplyTo:`${f.plan}@example.test`,references:[`${f.plan}@example.test`]});
 const search={...gmail,searchSentByMessageId:async(_access:unknown,messageId:string)=>{
  expect(messageId).toBe(before?.providerMessageIdHeader);
  return {ok:true as const,found:found?{messageId:'retained-provider-id',threadId:f.plan}:null};
 }};
 const report=await reconcileOutboundMessage(f.ctx,world.reconcileDeps(world.alpha,{gmail:search}),{outboundMessageId:f.fenceId});
 expect(report.outcome).toBe(found?'sent':'still_unknown');
 await dispatchOutboundMessage(f.ctx,world.sendDeps(world.alpha,{gmail}),{outboundMessageId:f.fenceId});
 expect(gmail.sends).toHaveLength(0);
 const after=await readFence(f.ctx,f.fenceId);
 expect(after).toMatchObject({state:found?'sent':'reconciling',subject:before!.subject,body:before!.body,renderedHash:before!.renderedHash,providerMessageIdHeader:before!.providerMessageIdHeader,attemptToken:before!.attemptToken});
 expect((await f.ctx.db.query('SELECT state FROM outreach_reply_requests WHERE id=$1',[f.requestId])).rows[0]).toEqual({state:found?'delivered':'ready'});
});
it('expires a stranded paid claim independently of the retired runner and settles it once',async()=>{
 const f=await fixture();
 const {reserveAttempt,markCalling}=await import('../../research/reservations.ts');
 const {expireRoutineReplies}=await import('../../outreach/replyRun.ts');
 const reservation=await f.tx(async()=>{
  const r=await reserveAttempt(f.ctx,{subjectKind:'outreach_reply',subjectId:f.requestId,attempt:1,providerKey:'aws_bedrock.outreach_reply',at:new Date().toISOString(),businessTimeZone:'America/New_York',cents:2,modelName:'claude-haiku-4-5',maxInputTokens:100,maxOutputTokens:1024});
  await markCalling(f.ctx,r.id);
  await f.ctx.db.query("UPDATE outreach_reply_requests SET state='calling',paid_attempts=1,created_at=now()-interval '31 minutes',deadline_at=now()-interval '1 minute' WHERE id=$1",[f.requestId]);
  return r;
 });
 await f.tx(()=>expireRoutineReplies(f.ctx,new Date().toISOString()));await f.tx(()=>expireRoutineReplies(f.ctx,new Date().toISOString()));
 expect((await f.ctx.db.query('SELECT state FROM outreach_reply_requests WHERE id=$1',[f.requestId])).rows[0]).toEqual({state:'expired'});
 expect((await f.ctx.db.query('SELECT state,settled_cents FROM provider_reservations WHERE id=$1',[reservation.id])).rows[0]).toEqual({state:'estimated',settled_cents:2});
});
it('scheduler maintenance skips a busy research budget without waiting for its owner',async()=>{
 const f=await fixture(),session=await world.database.appRuntimeSession();
 const {lockResearchBudget}=await import('../../research/ceilings.ts');const {tryLockRoutineWorkspace}=await import('../../outreach/replyRun.ts');
 await session.query('BEGIN');
 try{await lockResearchBudget(repositoryContext(f.ctx.scope,session));expect(await f.tx(()=>tryLockRoutineWorkspace(f.ctx))).toBe(false);}finally{await session.query('ROLLBACK');}
 expect(await f.tx(()=>tryLockRoutineWorkspace(f.ctx))).toBe(true);
});
it('attributes retained accepted sends and confirmed human replies exactly once',async()=>{
 const f=await fixture();const {attributeFirmInteraction,reconcileEmailAttribution}=await import('../../sourcing/attribution.ts');
 const attribute=(id:string)=>f.tx(()=>attributeFirmInteraction(f.ctx,{firmId:f.firm.firmId,kind:'email',subjectId:id}));
 const rows=()=>f.ctx.db.query('SELECT subject_id,outbound FROM sourcing_interactions WHERE workspace_id=$1 AND kind=$2 AND subject_id=ANY($3::uuid[]) ORDER BY outbound DESC',[f.ctx.scope.workspaceId,'email',[f.fenceId,f.messageId]]);
 await attribute(f.fenceId);await attribute(f.messageId);expect((await rows()).rows).toHaveLength(0);
 await historicalAttempt(f,true);await f.tx(()=>reconcileEmailAttribution(f.ctx));await f.tx(()=>reconcileEmailAttribution(f.ctx));await attribute(f.fenceId);
 expect((await rows()).rows).toEqual([{subject_id:f.fenceId,outbound:true}]);
 await f.ctx.db.query("INSERT INTO mail_message_classifications(workspace_id,mail_message_id,layer,class,requires_confirmation,rules_version) VALUES($1,$2,'deterministic','human',false,'fixture')",[f.ctx.scope.workspaceId,f.messageId]);
 await attribute(f.messageId);await attribute(f.messageId);
 expect((await rows()).rows).toEqual([{subject_id:f.fenceId,outbound:true},{subject_id:f.messageId,outbound:false}]);
});
for(const targetKind of ['firm','contact'] as const)for(const sent of [false,true])it(`deletes ${targetKind} with a retained ${sent?'sent':'prepared'} routine delivery`,async()=>{
 const f=await fixture();if(sent)await historicalAttempt(f,true);
 const {previewDeletion,commitDeletion}=await import('../../retention/deletion.ts');const {recordingSuppressionJournal}=await import('../../suppression/journal.ts');
 const preview=await previewDeletion(f.ctx,{targetKind,firmId:f.firm.firmId,...(targetKind==='contact'?{contactId:f.firm.contactId}:{})});expect(preview.ok).toBe(true);
 const result=await commitDeletion(f.ctx,{requestId:preview.value!.requestId,previewHash:preview.value!.previewHash,commandId:randomUUID(),journal:recordingSuppressionJournal()});expect(result.ok,JSON.stringify(result)).toBe(true);
 expect((await f.ctx.db.query('SELECT * FROM outreach_reply_deliveries WHERE request_id=$1',[f.requestId])).rows).toHaveLength(0);
});
it('keeps explicit manual handling and prevents a confirmed reply from undoing takeover',async()=>{
 const f=await fixture();const {handleRoutineManually}=await import('../../outreach/settings.ts');const {confirmReplyDisposition}=await import('../../classification/confirmations.ts');const {recordingSuppressionJournal}=await import('../../suppression/journal.ts');
 await f.ctx.db.query("INSERT INTO mail_message_classifications(workspace_id,mail_message_id,layer,class,requires_confirmation,rules_version) VALUES($1,$2,'deterministic','human',true,'fixture')",[f.ctx.scope.workspaceId,f.messageId]);
 expect((await f.tx(()=>handleRoutineManually(f.ctx,{id:f.requestId,expectedRevision:1}))).ok).toBe(true);
 const result=await f.tx(()=>confirmReplyDisposition(f.ctx,{messageId:f.messageId,disposition:'interested',grantFollowUp:false,journal:recordingSuppressionJournal()}));expect(result.ok,JSON.stringify(result)).toBe(true);
 expect((await f.ctx.db.query('SELECT state FROM outreach_plans WHERE id=$1',[f.plan])).rows[0]).toEqual({state:'manual'});
});
it('reassigns an unclaimed prepared email after midnight but retains an uncertain dispatch',async()=>{
 const f=await fixture();const {buildOutreachCadence}=await import('../../outreach/cadence.ts');const {claimProspectingTouch}=await import('../../outreach/touchReservations.ts');
 const start='2026-10-05T14:00:00.000Z',cadence=buildOutreachCadence({lane:'email_first',startsAt:start,timeZone:'America/New_York'});
 await f.ctx.db.query("UPDATE outreach_plans SET state='active',cadence=$2::jsonb,expires_at=$3 WHERE id=$1",[f.plan,JSON.stringify(cadence),cadence.expiresAt]);
 const actionId=(await f.ctx.db.query<{step_execution_id:string}>('SELECT step_execution_id FROM outbound_messages WHERE id=$1',[f.fenceId])).rows[0]!.step_execution_id;
 const input={planId:f.plan,expectedRevision:1,actionId,channel:'email' as const,expectedOrdinal:1,at:start};
 expect((await f.tx(()=>claimProspectingTouch(f.ctx,input))).ok).toBe(true);
 expect((await f.tx(()=>claimProspectingTouch(f.ctx,{...input,at:'2026-10-06T14:00:00.000Z'}))).ok).toBe(true);
 expect((await f.ctx.db.query('SELECT local_date::text FROM outreach_touch_reservations WHERE plan_id=$1',[f.plan])).rows).toEqual([{local_date:'2026-10-06'}]);
 await f.ctx.db.query("UPDATE outbound_messages SET state='dispatching',attempt_token=$2,dispatch_started_at=$3 WHERE id=$1",[f.fenceId,randomUUID(),'2026-10-06T14:00:00.000Z']);
 expect((await f.tx(()=>claimProspectingTouch(f.ctx,{...input,at:'2026-10-07T14:00:00.000Z'}))).ok).toBe(false);
 expect((await f.ctx.db.query('SELECT state,local_date::text FROM outreach_touch_reservations WHERE plan_id=$1',[f.plan])).rows).toEqual([{state:'reserved',local_date:'2026-10-06'}]);
});

import {resolveZoneForFirm} from '../../crm/firms.ts';
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,it,expect} from 'vitest';
import {createOutboundWorld,OPEN_INSTANT,type OutboundWorld} from '../outbound/support/outboundWorld.ts';
import {seedFirm,pausingAtTokenRefresh} from '../outbound/support/dispatchFixtures.ts';
import {withTransaction} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {setProspectingAuthorization} from '../../outreach/authorization.ts';
import {saveAnswerBlock,approveAnswerBlock} from '../../outreach/facts.ts';
import {recordMessage,storeMessageBody} from '../../mail/messages.ts';
import {recordMatches} from '../../mail/matching.ts';
import {readRoutineSource,requestRoutineReply} from '../../outreach/replyRequests.ts';
import {prepareRoutineReply,routineDraftForExecution,attachRoutineFence} from '../../outreach/replyDelivery.ts';
import {prepareOutboundMessage,readFence} from '../../outbound/fence.ts';
import {dispatchOutboundMessage} from '../../outbound/send.ts';
import {decideSend} from '../../outbound/gate.ts';
let world:OutboundWorld;
beforeAll(async()=>{world=await createOutboundWorld();});
afterAll(async()=>world.stop());
async function fixture(){
 const db=world.database.session,w=world.alpha.workspace.workspaceId;
 const ctx=repositoryContext(workspaceScope(w,{kind:'user',userId:world.alpha.workspace.admin.userId,role:'admin'}),db);
 const tx=<T>(fn:()=>Promise<T>)=>withTransaction(db,fn);
 const firm=await seedFirm(world,world.alpha,'routine-reply');
 await db.query('DELETE FROM opportunities WHERE id=$1',[firm.opportunityId]);
 await tx(()=>resolveZoneForFirm(ctx,{firmId:firm.firmId,recordedZone:'Etc/UTC'}));
 const current=(await db.query<{revision:number}>('SELECT revision FROM gmail_prospecting_authorizations WHERE workspace_id=$1 AND mailbox_id=$2',[w,world.alpha.mailboxId])).rows[0];
 await tx(()=>setProspectingAuthorization(ctx,{mailboxId:world.alpha.mailboxId,expectedRevision:current?.revision??0,enabled:true,basis:'owner_reported_google_permission'}));
 const candidate=randomUUID(),run=randomUUID(),plan=randomUUID();
 await db.query("INSERT INTO sourcing_candidates(workspace_id,id,identity_key,payload,status,revision) VALUES($1,$2,$3,'{}','needs_review',1)",[w,candidate,randomUUID().replaceAll('-','').repeat(2)]);
 await db.query("INSERT INTO sourcing_qualification_runs(workspace_id,id,candidate_id,candidate_revision,fingerprint,prompt_version,policy_version,model_name) VALUES($1,$2,$3,1,$4,'fixture','fixture','fixture')",[w,run,candidate,'e'.repeat(64)]);
 await db.query("INSERT INTO outreach_email_sources(workspace_id,candidate_id,run_id,firm_id,contact_id,route_id,observation_id,block_id,identity_kind,reviewed) VALUES($1,$2,$3,$4,$5,$6,$7,'contact','named',true)",[w,candidate,run,firm.firmId,firm.contactId,firm.routeId,randomUUID()]);
 await db.query("INSERT INTO outreach_plans(workspace_id,id,firm_id,contact_id,owner_user_id,mailbox_id,candidate_id,qualification_run_id,lane,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'email_first','reply_pending')",[w,plan,firm.firmId,firm.contactId,world.alpha.workspace.salesperson.userId,world.alpha.mailboxId,candidate,run]);
 const message=await tx(()=>recordMessage(ctx,{mailboxId:world.alpha.mailboxId,metadata:{providerMessageId:randomUUID(),providerThreadId:plan,rfcMessageId:`${plan}@example.test`,direction:'incoming',internalDate:new Date().toISOString(),headerFrom:firm.address,headerTo:[world.alpha.address],headerCc:[],subject:'Product question',referenceMessageIds:[],inReplyTo:null,autoSubmitted:null,listId:null,labelIds:[],attachments:[]}}));
 await tx(()=>recordMatches(ctx,{messageId:message.message.id,candidates:[{firmId:firm.firmId,contactId:firm.contactId,opportunityId:null,outreachPlanId:plan,rule:'participant',viaClosedOpportunity:false}]}));
 await tx(()=>storeMessageBody(ctx,{messageId:message.message.id,text:'Does it work with AppFolio?',truncated:false}));
 const block=await tx(()=>saveAnswerBlock(ctx,{kind:'product',text:'Callie integrates with AppFolio.'}));if(!block.ok)throw new Error(block.reason);
 await tx(()=>approveAnswerBlock(ctx,{id:block.value.id,version:1}));
 const sequence=(await db.query<{id:string}>('INSERT INTO sequences(workspace_id,name,created_by_user_id) VALUES($1,$2,$3) RETURNING id',[w,plan,world.alpha.workspace.admin.userId])).rows[0]!.id;
 const version=(await db.query<{id:string}>('INSERT INTO sequence_versions(workspace_id,sequence_id,version) VALUES($1,$2,1) RETURNING id',[w,sequence])).rows[0]!.id;
 await db.query("INSERT INTO sequence_steps(workspace_id,sequence_version_id,ordinal,channel,delay_unit,delay_amount,template_version_id) VALUES($1,$2,1,'email','elapsed',0,$3)",[w,version,world.alpha.templateVersionId]);
 await db.query("UPDATE sequence_versions SET state='published',published_at=now(),published_by_user_id=$2 WHERE id=$1",[version,world.alpha.workspace.admin.userId]);
 await db.query('INSERT INTO outreach_settings(workspace_id,routine_replies_enabled,reply_sequence_version_id) VALUES($1,true,$2) ON CONFLICT(workspace_id) DO UPDATE SET routine_replies_enabled=true,reply_sequence_version_id=EXCLUDED.reply_sequence_version_id',[w,version]);
 const source=await readRoutineSource(ctx,{planId:plan,messageId:message.message.id});if(!source.ok)throw new Error(source.reason);
 const request=await tx(()=>requestRoutineReply(ctx,{planId:plan,messageId:message.message.id,threadRevision:source.value.hash}));if(!request.ok)throw new Error(request.reason);
 await db.query("UPDATE outreach_reply_requests SET state='ready',decision=$2::jsonb WHERE id=$1",[request.value.requestId,JSON.stringify({kind:'answer',blockRefs:[{id:block.value.id,version:1}],allQuestionsSupported:true,confidence:'high'})]);
 const delivery=await tx(()=>prepareRoutineReply(ctx,{requestId:request.value.requestId,expectedRevision:1}));if(!delivery.ok)throw new Error(delivery.reason);
 const draft=await routineDraftForExecution(ctx,delivery.value.executionId);if(!draft?.ok)throw new Error('draft missing');
 const e=(await db.query<{enrollment_id:string}>('SELECT enrollment_id FROM step_executions WHERE id=$1',[delivery.value.executionId])).rows[0]!.enrollment_id;
 await db.query('UPDATE step_executions SET not_before=$2 WHERE id=$1',[delivery.value.executionId,OPEN_INSTANT]);
 const prepared=await tx(()=>prepareOutboundMessage(ctx,{enrollmentId:e,stepExecutionId:delivery.value.executionId,firmId:firm.firmId,contactId:firm.contactId,ownerUserId:world.alpha.workspace.salesperson.userId,templateVersionId:world.alpha.templateVersionId,templateContentHash:world.alpha.templateContentHash,emailAddressId:firm.routeId,toAddress:firm.address,subject:draft.value.subject,body:draft.value.body,sendAt:OPEN_INSTANT,sourceZone:'UTC',businessDate:'2026-09-23'}));if(!prepared.ok)throw new Error(prepared.reason);
 await tx(()=>attachRoutineFence(ctx,{executionId:delivery.value.executionId,fenceId:prepared.value.outboundMessageId}));
 return {ctx,tx,firm,plan,block: block.value,requestId:request.value.requestId,messageId:message.message.id,fenceId:prepared.value.outboundMessageId};
}
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

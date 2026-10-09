import {saveAnswerBlock,approveAnswerBlock,retireAnswerBlock} from '../../outreach/facts.ts';
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { withTransaction } from '../../db/queryable.ts';
import { preparedMeetingFixture, meetingDispatchFixture } from './support/meetingDispatchFixture.ts';
import { dispatchOutboundMessage } from '../../outbound/send.ts';
import { reconcileOutboundMessage } from '../../outbound/reconcile.ts';
import { readFence, readFenceByStepExecution, prepareOutboundMessage, readOutboundOutcome } from '../../outbound/fence.ts';
import { completeStepExecution, runDueStepExecution } from '../../sequences/executions.ts';
import { composeEligibility } from '../../sequences/eligibility.ts';
import { recordHolidayCalendar } from '../../sequences/calendars.ts';
import { verifyMeetingFence } from '../../meetings/followThroughDelivery.ts';
import { readMeetingFollowThrough, readMeetingPlan, editMeetingRecap } from '../../meetings/followThrough.ts';
import { runMeetingFollowThrough, meetingDeliveryHistory, scheduleMeetingFollowThrough } from '../../meetings/followThroughJobs.ts';
import { nextMeetingFollowThroughAction } from '../../meetings/followThroughSchedule.ts';
import { invalidateMeetingFollowThrough } from '../../meetings/followThroughLifecycle.ts';
import { applyDirectSendEffects } from '../../mail/effects.ts';
import { readMessage } from '../../mail/messages.ts';

describe('meeting follow-through review regressions', () => {
  let stop: (() => Promise<void>) | undefined;
  afterEach(async () => { await stop?.(); });
  async function enrolled() { const f = await meetingDispatchFixture({ steps: 3 }); stop = () => f.world.stop(); return f; }
  async function deliver(f: Awaited<ReturnType<typeof enrolled>>) {
    const fence = await f.prepare(), gmail = f.world.clientWith(f.world.alpha, {});
    expect(await dispatchOutboundMessage(f.context, f.world.sendDeps(f.world.alpha, { gmail, now: () => new Date(f.at) }), { outboundMessageId: fence.id })).toMatchObject({ outcome: 'sent' });
    const sent = await meetingDeliveryHistory(f.context, f.planId);
    await withTransaction(f.db, () => completeStepExecution(f.context, { stepExecutionId: f.executionId, completionSource: 'send', result: 'sent', completedAt: sent[0]!.sentAt }));
    return { fence, gmail, sent };
  }
  async function cancel(f: Awaited<ReturnType<typeof enrolled>>) {
    const v = (await readMeetingFollowThrough(f.admin, { meetingId: f.meetingId }))!;
    return await withTransaction(f.db, () => editMeetingRecap(f.admin, { planId: f.planId, expectedPlanVersion: v.version, expectedDraftVersion: v.currentDraft!.version, action: 'cancel' }, f.at));
  }
  it.each(['downtime', 'calendar'])('rechecks a prepared nudge after %s before any provider call', async kind => {
    const f = await enrolled(), { sent, gmail } = await deliver(f);
    const plan = (await readMeetingPlan(f.context, f.planId))!;
    const next = nextMeetingFollowThroughAction({ plan: { scope: plan.scope, maxMessages: 3 }, deliveryHistory: sent, at: sent[0]!.sentAt, zone: 'Etc/UTC', calendar: { version: 'none', dates: [] } });
    if (next.kind !== 'nudge') throw new Error('expected nudge');
    await withTransaction(f.db, () => runMeetingFollowThrough(f.context, { meetingId: f.meetingId, at: next.dueAt }));
    const execution = (await f.db.query<{id:string}>('SELECT id FROM step_executions WHERE enrollment_id=$1 AND ordinal=2',[plan.enrollment_id])).rows[0]!;
    const ready = new Date(Date.parse(next.dueAt) + 31 * 60_000).toISOString();
    const handoff = { prepare: async (c: typeof f.context, request: Parameters<typeof prepareOutboundMessage>[1]) => { const p = await prepareOutboundMessage(c,request); if (!p.ok) throw new Error(p.reason); return {ok:true as const,...p.value}; }, dispatch: async()=>({ok:true as const}), readOutcome:readOutboundOutcome };
    expect(await withTransaction(f.db,()=>runDueStepExecution(f.context,{stepExecutionId:execution.id,now:ready,eligibility:composeEligibility(),sendHandoff:handoff}))).toMatchObject({kind:'handed_to_send'});
    const fence = (await readFenceByStepExecution(f.context, execution.id))!;
    expect(await verifyMeetingFence(f.context,{fenceId:fence.id,at:ready})).toMatchObject({ok:true});
    const at = kind === 'downtime' ? new Date(Date.parse(ready) + 7 * 86_400_000).toISOString() : ready;
    if (kind === 'calendar') expect(await withTransaction(f.db,()=>recordHolidayCalendar(f.admin,{version:'review-holiday',dates:[ready.slice(0,10)]}))).toMatchObject({ok:true});
    // No meeting-preparation job ran after the clock/calendar changed.
    expect(await verifyMeetingFence(f.context,{fenceId:fence.id,at})).toMatchObject({ok:false,reason:kind==='downtime'?'nudge_obsolete':'nudge_not_due'});
    const result=await dispatchOutboundMessage(f.context,f.world.sendDeps(f.world.alpha,{gmail,now:()=>new Date(at)}),{outboundMessageId:fence.id});
    expect(result.outcome).not.toBe('sent');
    if(kind==='downtime') expect(result).toMatchObject({outcome:'held',detail:'follow_up_not_permitted:nudge_obsolete'});
    expect(gmail.sends).toHaveLength(1);
  });
  it('wakes and revalidates a corrected missing opportunity, preserving the edit window',async()=>{
    const f=await enrolled(); await f.db.query('UPDATE meetings SET opportunity_id=NULL WHERE id=$1',[f.meetingId]);
    await withTransaction(f.db,()=>runMeetingFollowThrough(f.context,{meetingId:f.meetingId,at:f.at}));
    await f.db.query('UPDATE meetings SET opportunity_id=$2 WHERE id=$1',[f.meetingId,f.opportunityId]);
    let v=(await readMeetingFollowThrough(f.admin,{meetingId:f.meetingId}))!;
    const b=await withTransaction(f.db,()=>editMeetingRecap(f.admin,{planId:f.planId,expectedPlanVersion:v.version,expectedDraftVersion:v.currentDraft!.version,action:'begin_edit'},f.at)); if(!b.ok)throw new Error(b.reason);v=b.value;
    expect(await withTransaction(f.db,()=>editMeetingRecap(f.admin,{planId:f.planId,expectedPlanVersion:v.version,expectedDraftVersion:v.currentDraft!.version,action:'save',subject:v.currentDraft!.subject,body:v.currentDraft!.body},f.at))).toMatchObject({ok:true});
    expect(await scheduleMeetingFollowThrough(f.db,new Date(Date.parse(f.at)+60*60_000).toISOString())).toEqual(expect.arrayContaining([expect.objectContaining({payload:{meetingId:f.meetingId}})]));
    await withTransaction(f.db,()=>runMeetingFollowThrough(f.context,{meetingId:f.meetingId,at:f.at}));
    expect(await readMeetingFollowThrough(f.admin,{meetingId:f.meetingId})).toMatchObject({blockers:[],currentDraft:{notBefore:new Date(Date.parse(f.at)+30*60_000).toISOString()}});
  });
  it.each(['reply_received','manual_email_review','suppressed'])('never clears an intentional %s hold when saved or retried',async reason=>{
    const f=await enrolled();await withTransaction(f.db,()=>invalidateMeetingFollowThrough(f.context,{meetingId:f.meetingId,reason,eventId:randomUUID()}));
    const v=(await readMeetingFollowThrough(f.admin,{meetingId:f.meetingId}))!;
    const b=await withTransaction(f.db,()=>editMeetingRecap(f.admin,{planId:f.planId,expectedPlanVersion:v.version,expectedDraftVersion:v.currentDraft!.version,action:'begin_edit'},f.at));if(!b.ok)throw new Error(b.reason);
    expect(await withTransaction(f.db,()=>editMeetingRecap(f.admin,{planId:f.planId,expectedPlanVersion:b.value.version,expectedDraftVersion:b.value.currentDraft!.version,action:'save',subject:b.value.currentDraft!.subject,body:b.value.currentDraft!.body},f.at))).toMatchObject({ok:true});
    await withTransaction(f.db,()=>runMeetingFollowThrough(f.context,{meetingId:f.meetingId,at:f.at}));
    expect(await readMeetingFollowThrough(f.admin,{meetingId:f.meetingId})).toMatchObject({status:'needs_review',blockers:expect.arrayContaining([reason])});
  });
  it('binds authority after an exact unenrolled manual recap without recreating the recap send',async()=>{
    const f=await preparedMeetingFixture({steps:3,paused:true});stop=()=>f.world.stop();
    const id=(await f.db.query<{id:string}>(`INSERT INTO mail_messages(workspace_id,mailbox_id,provider_message_id,provider_thread_id,direction,internal_date,header_from,header_to,header_cc,subject,matched) VALUES($1,$2,'manual-paused','manual-paused','outgoing',$3,$4,$5::text[],'{}',$6,true) RETURNING id`,[f.workspace,f.world.alpha.mailboxId,f.at,f.world.alpha.address,[f.address],f.draft.subject])).rows[0]!.id;
    await f.db.query('INSERT INTO mail_message_bodies(workspace_id,mail_message_id,body_text,truncated) VALUES($1,$2,$3,false)',[f.workspace,id,f.draft.body]);
    const message=(await readMessage(f.context,id))!;
    await withTransaction(f.db,()=>applyDirectSendEffects(f.context,{message,candidate:{firmId:f.firmId,contactId:f.contactId,opportunityId:f.opportunityId,rule:'thread',viaClosedOpportunity:false}}));
    expect(await readMeetingFollowThrough(f.admin,{meetingId:f.meetingId})).toMatchObject({status:'awaiting_reply',currentDraft:{state:'sent'}});
    expect((await readMeetingPlan(f.context,f.planId))!.enrollment_id).toBeNull();
    await f.db.query('UPDATE sending_domains SET automated_sending_enabled=true,automated_sending_enabled_at=now() WHERE workspace_id=$1',[f.workspace]);
    for(let i=0;i<2;i++)await withTransaction(f.db,()=>runMeetingFollowThrough(f.context,{meetingId:f.meetingId,at:f.at}));
    const p=(await readMeetingPlan(f.context,f.planId))!;expect(p.blockers).toEqual([]);expect(p.scope).not.toBeNull();expect(p.enrollment_id).not.toBeNull();
    expect((await f.db.query('SELECT ordinal,state FROM step_executions WHERE enrollment_id=$1 ORDER BY ordinal',[p.enrollment_id])).rows).toEqual([{ordinal:1,state:'completed'},{ordinal:2,state:'pending'}]);
    expect((await f.db.query('SELECT id FROM outbound_messages WHERE enrollment_id=$1',[p.enrollment_id])).rows).toEqual([]);
    expect(await meetingDeliveryHistory(f.context,f.planId)).toEqual([{ordinal:1,messageId:id,sentAt:f.at}]);
  });
  it('approves remaining nudges after an exact manual recap without resubmitting ordinal one',async()=>{
    const f=await preparedMeetingFixture({steps:3,paused:true,approve:false});stop=()=>f.world.stop();
    const id=(await f.db.query<{id:string}>(`INSERT INTO mail_messages(workspace_id,mailbox_id,provider_message_id,provider_thread_id,direction,internal_date,header_from,header_to,header_cc,subject,matched) VALUES($1,$2,'manual-before-approval','manual-before-approval','outgoing',$3,$4,$5::text[],'{}',$6,true) RETURNING id`,[f.workspace,f.world.alpha.mailboxId,f.at,f.world.alpha.address,[f.address],f.draft.subject])).rows[0]!.id;
    await f.db.query('INSERT INTO mail_message_bodies(workspace_id,mail_message_id,body_text,truncated) VALUES($1,$2,$3,false)',[f.workspace,id,f.draft.body]);
    const message=(await readMessage(f.context,id))!;
    await withTransaction(f.db,()=>applyDirectSendEffects(f.context,{message,candidate:{firmId:f.firmId,contactId:f.contactId,opportunityId:f.opportunityId,rule:'thread',viaClosedOpportunity:false}}));
    const v=(await readMeetingFollowThrough(f.admin,{meetingId:f.meetingId}))!;
    expect(v).toMatchObject({approvalRequired:true,currentDraft:{state:'sent'}});
    expect(await withTransaction(f.db,()=>editMeetingRecap(f.admin,{planId:f.planId,expectedPlanVersion:v.version,expectedDraftVersion:v.currentDraft!.version,expectedApprovalHash:v.approvalHash!,action:'approve'},f.at))).toMatchObject({ok:true,value:{approvalRequired:false,currentDraft:{state:'sent'}}});
    await f.db.query('UPDATE sending_domains SET automated_sending_enabled=true,automated_sending_enabled_at=now() WHERE workspace_id=$1',[f.workspace]);
    for(let i=0;i<2;i++)await withTransaction(f.db,()=>runMeetingFollowThrough(f.context,{meetingId:f.meetingId,at:f.at}));
    expect(await readMeetingFollowThrough(f.admin,{meetingId:f.meetingId})).toMatchObject({sentMessages:[{ordinal:1,messageId:id}],plannedSteps:[{ordinal:1,state:'completed'},{ordinal:2,state:'pending'}]});
    const plan=(await readMeetingPlan(f.context,f.planId))!;
    const ordinalOne=(await f.db.query<{id:string}>('SELECT id FROM step_executions WHERE enrollment_id=$1 AND ordinal=1',[plan.enrollment_id])).rows[0]!;
    const gmail=f.world.clientWith(f.world.alpha,{});
    const handoff={prepare:async(c:typeof f.context,request:Parameters<typeof prepareOutboundMessage>[1])=>{const p=await prepareOutboundMessage(c,request);if(!p.ok)throw new Error(p.reason);return {ok:true as const,...p.value};},dispatch:async()=>({ok:true as const}),readOutcome:readOutboundOutcome};
    await withTransaction(f.db,()=>runDueStepExecution(f.context,{stepExecutionId:ordinalOne.id,now:f.at,eligibility:composeEligibility(),sendHandoff:handoff}));
    const duplicate=await readFenceByStepExecution(f.context,ordinalOne.id);
    if(duplicate!==null)await dispatchOutboundMessage(f.context,f.world.sendDeps(f.world.alpha,{gmail,now:()=>new Date(f.at)}),{outboundMessageId:duplicate.id});
    expect(duplicate).toBeNull();expect(gmail.sends).toHaveLength(0);
  });
  it('reviews changed future fact bindings after provider delivery and sends only the remaining nudge',async()=>{
    const f=await enrolled(),{fence,gmail,sent}=await deliver(f);
    const receipt=(await readFence(f.context,fence.id))!;
    const fact=await withTransaction(f.db,()=>saveAnswerBlock(f.admin,{kind:'product',text:'Following up on our conversation. Is there a useful next step?'}));if(!fact.ok)throw new Error(fact.reason);await withTransaction(f.db,()=>approveAnswerBlock(f.admin,fact.value));
    let v=(await readMeetingFollowThrough(f.admin,{meetingId:f.meetingId}))!;expect(v).toMatchObject({approvalRequired:true,blockers:expect.arrayContaining(['facts_changed']),currentDraft:{state:'sent'}});
    expect(await withTransaction(f.db,()=>editMeetingRecap(f.admin,{planId:f.planId,expectedPlanVersion:v.version,expectedDraftVersion:v.currentDraft!.version,expectedApprovalHash:v.approvalHash!,action:'approve'},f.at))).toMatchObject({ok:true,value:{approvalRequired:false}});
    const plan=(await readMeetingPlan(f.context,f.planId))!;
    const next=nextMeetingFollowThroughAction({plan:{scope:plan.scope,maxMessages:3},deliveryHistory:sent,at:sent[0]!.sentAt,zone:'Etc/UTC',calendar:{version:'none',dates:[]}});if(next.kind!=='nudge')throw new Error('nudge missing');
    await withTransaction(f.db,()=>runMeetingFollowThrough(f.context,{meetingId:f.meetingId,at:next.dueAt}));
    v=(await readMeetingFollowThrough(f.admin,{meetingId:f.meetingId}))!;expect(v).toMatchObject({approvalRequired:false,currentDraft:{ordinal:2}});
    const execution=(await f.db.query<{id:string}>('SELECT id FROM step_executions WHERE enrollment_id=$1 AND ordinal=2',[plan.enrollment_id])).rows[0]!;
    const at=new Date(Date.parse(next.dueAt)+31*60_000).toISOString();
    const handoff={prepare:async(c:typeof f.context,request:Parameters<typeof prepareOutboundMessage>[1])=>{const p=await prepareOutboundMessage(c,request);if(!p.ok)throw new Error(p.reason);return {ok:true as const,...p.value};},dispatch:async()=>({ok:true as const}),readOutcome:readOutboundOutcome};
    expect(await withTransaction(f.db,()=>runDueStepExecution(f.context,{stepExecutionId:execution.id,now:at,eligibility:composeEligibility(),sendHandoff:handoff}))).toMatchObject({kind:'handed_to_send'});
    const nudge=(await readFenceByStepExecution(f.context,execution.id))!;
    expect(await dispatchOutboundMessage(f.context,f.world.sendDeps(f.world.alpha,{gmail,now:()=>new Date(at)}),{outboundMessageId:nudge.id})).toMatchObject({outcome:'sent'});
    expect(gmail.sends).toHaveLength(2);expect(await readFence(f.context,fence.id)).toMatchObject({state:'sent',providerMessageId:receipt.providerMessageId,renderedHash:receipt.renderedHash,body:receipt.body});
    await withTransaction(f.db,()=>retireAnswerBlock(f.admin,fact.value));v=(await readMeetingFollowThrough(f.admin,{meetingId:f.meetingId}))!;
    expect(v.blockers).toContain('facts_block_retired');
    expect(await withTransaction(f.db,()=>editMeetingRecap(f.admin,{planId:f.planId,expectedPlanVersion:v.version,expectedDraftVersion:v.currentDraft!.version,expectedApprovalHash:v.approvalHash??'a'.repeat(64),action:'approve'},at))).toMatchObject({ok:false,reason:'facts_block_retired'});
    await withTransaction(f.db,()=>runMeetingFollowThrough(f.context,{meetingId:f.meetingId,at}));expect(gmail.sends).toHaveLength(2);
  });
  it.each(['sent','ambiguous'])('cancels future work while preserving the %s delivery and reconciliation',async kind=>{
    const f=await enrolled(), fence=await f.prepare(), gmail=f.world.clientWith(f.world.alpha,kind==='ambiguous'?{sendBehaviour:'indeterminate_but_delivered'}:{});
    expect(await dispatchOutboundMessage(f.context,f.world.sendDeps(f.world.alpha,{gmail,now:()=>new Date(f.at)}),{outboundMessageId:fence.id})).toMatchObject({outcome:kind==='sent'?'sent':'reconciling'});
    if(kind==='sent'){const sent=await meetingDeliveryHistory(f.context,f.planId);await withTransaction(f.db,()=>completeStepExecution(f.context,{stepExecutionId:f.executionId,completionSource:'send',result:'sent',completedAt:sent[0]!.sentAt}));}
    expect(await cancel(f)).toMatchObject({ok:true,value:{status:'cancelled',currentDraft:{state:kind==='sent'?'sent':'submitted'}}});
    if(kind==='ambiguous')expect(await reconcileOutboundMessage(f.context,f.world.reconcileDeps(f.world.alpha,{gmail}),{outboundMessageId:fence.id})).toMatchObject({outcome:'sent'});
    expect((await readFence(f.context,fence.id))!.state).toBe('sent'); expect(gmail.sends).toHaveLength(1);
    expect((await f.db.query("SELECT id FROM step_executions WHERE enrollment_id=(SELECT enrollment_id FROM meeting_follow_through WHERE id=$1) AND state IN ('pending','held')",[f.planId])).rows).toEqual([]);
    expect(await readMeetingFollowThrough(f.admin,{meetingId:f.meetingId})).toMatchObject({status:'cancelled',currentDraft:{state:'sent'}});
  });
});

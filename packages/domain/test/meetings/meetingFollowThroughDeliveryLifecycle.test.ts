import { recordSuppression } from '../../suppression/events.ts';
import { afterEach, describe, expect, it } from 'vitest';
import { withTransaction } from '../../db/queryable.ts';
import { meetingDispatchFixture } from './support/meetingDispatchFixture.ts';
import { dispatchOutboundMessage } from '../../outbound/send.ts';
import { completeStepExecution, runDueStepExecution } from '../../sequences/executions.ts';
import { composeEligibility } from '../../sequences/eligibility.ts';
import { markPreDispatchFenceSent, readOutboundOutcome, prepareOutboundMessage } from '../../outbound/fence.ts';
import { readMeetingFollowThrough, readMeetingPlan, appendMeetingDraft } from '../../meetings/followThrough.ts';
import { meetingDeliveryHistory, runMeetingFollowThrough, finalizeMeetingFollowThrough } from '../../meetings/followThroughJobs.ts';
import { nextMeetingFollowThroughAction } from '../../meetings/followThroughSchedule.ts';
import { localDate, addCalendarDays, localInstant } from '../../src/rules/localClock.ts';

describe('delivery drives meeting follow-through work', () => {
  let f: Awaited<ReturnType<typeof meetingDispatchFixture>> | undefined;
  afterEach(async () => { await f?.world.stop(); });
  it('uses actual delivery for the next execution, prepares an approved nudge and honors the edit window', async () => {
    f = await meetingDispatchFixture({ steps: 3 }); const x = f;
    const fence = await x.prepare(), gmail = x.world.clientWith(x.world.alpha, {});
    expect(await dispatchOutboundMessage(x.context, x.world.sendDeps(x.world.alpha, { gmail, now: () => new Date(x.at) }), { outboundMessageId: fence.id })).toMatchObject({ outcome: 'sent' });
    await x.db.query("UPDATE meeting_follow_through_drafts SET state='ready' WHERE outbound_message_id=$1", [fence.id]);
    await withTransaction(x.db, () => runMeetingFollowThrough(x.context, { meetingId: x.meetingId, at: x.at }));
    expect((await readMeetingFollowThrough(x.admin, { meetingId: x.meetingId }))!.currentDraft!.state).toBe('sent');
    const sent = await meetingDeliveryHistory(x.context, x.planId), plan = (await readMeetingPlan(x.context, x.planId))!;
    const action = nextMeetingFollowThroughAction({ plan: { scope: plan.scope, maxMessages: 3 }, deliveryHistory: sent, at: sent[0]!.sentAt, zone: 'Etc/UTC', calendar: { version: 'none', dates: [] } });
    if (action.kind !== 'nudge') throw new Error('no nudge');
    const done = await withTransaction(x.db, () => completeStepExecution(x.context, { stepExecutionId: x.executionId, completionSource: 'send', result: 'sent', completedAt: sent[0]!.sentAt }));
    expect(done).toMatchObject({ ok: true, value: { enrollmentCompleted: false } });
    const next = (await x.db.query<{ id: string; due_at: Date }>('SELECT id,due_at FROM step_executions WHERE enrollment_id=$1 AND ordinal=2', [plan.enrollment_id])).rows[0]!;
    expect(next.due_at.toISOString()).toBe(action.dueAt);
    await withTransaction(x.db, () => runMeetingFollowThrough(x.context, { meetingId: x.meetingId, at: action.dueAt }));
    expect(await readMeetingFollowThrough(x.admin, { meetingId: x.meetingId })).toMatchObject({ currentDraft: { ordinal: 2, subject: 'Following up', notBefore: new Date(Date.parse(action.dueAt) + 30 * 60_000).toISOString() } });
    const handoff = { prepare: async (c: typeof x.context, request: Parameters<typeof prepareOutboundMessage>[1]) => { const p = await prepareOutboundMessage(c, request); if (!p.ok) throw new Error(p.reason); return { ok: true as const, ...p.value }; }, readOutcome: readOutboundOutcome, dispatch: async () => ({ ok: true as const }) };
    expect(await withTransaction(x.db, () => runDueStepExecution(x.context, { stepExecutionId: next.id, now: action.dueAt, eligibility: composeEligibility(), sendHandoff: handoff }))).not.toMatchObject({ kind: 'handed_to_send' });
    await x.db.query('UPDATE sending_domains SET automated_sending_enabled=false,automated_sending_enabled_at=NULL WHERE workspace_id=$1', [x.workspace]);
    await x.db.query('UPDATE sending_domains SET automated_sending_enabled=true,automated_sending_enabled_at=now() WHERE workspace_id=$1', [x.workspace]);
    const resumed = new Date(Date.parse(action.dueAt) + 60 * 60_000).toISOString();
    await withTransaction(x.db, () => runMeetingFollowThrough(x.context, { meetingId: x.meetingId, at: resumed }));
    expect(await readMeetingFollowThrough(x.admin, { meetingId: x.meetingId })).toMatchObject({ status: 'scheduled', currentDraft: { ordinal: 2, notBefore: new Date(Date.parse(resumed) + 30 * 60_000).toISOString() } });
    const later = new Date(Date.parse(resumed) + 31 * 60_000).toISOString();
    expect(await withTransaction(x.db, () => runDueStepExecution(x.context, { stepExecutionId: next.id, now: later, eligibility: composeEligibility(), sendHandoff: handoff }))).toMatchObject({ kind: 'handed_to_send' });
    expect(gmail.sends).toHaveLength(1);
  });
  it('holds restored sent mail whose actual bytes were not verified', async () => {
    f = await meetingDispatchFixture(); const x = f, fence = await x.prepare();
    expect(await withTransaction(x.db, () => markPreDispatchFenceSent(x.context, { outboundMessageId: fence.id, sentAt: x.at, providerMessageId: 'restored-message', providerThreadId: 'restored-thread' }))).toMatchObject({ ok: true });
    await withTransaction(x.db, () => runMeetingFollowThrough(x.context, { meetingId: x.meetingId, at: x.at }));
    expect(await readMeetingFollowThrough(x.admin, { meetingId: x.meetingId })).toMatchObject({ status: 'needs_review', blockers: expect.arrayContaining(['delivery_bytes_unverified']) });
    expect(await meetingDeliveryHistory(x.context, x.planId)).toEqual([]);
  });
  it.each(['none','stop','source','reassigned'])('rechecks %s before fulfilling an exact linked material task', async change => {
    const url = 'https://example.test/approved-guide'; f = await meetingDispatchFixture({ material: url }); const x = f;
    const plan = (await readMeetingPlan(x.context, x.planId))!;
    const deadline = { precision: 'date', localDate: addCalendarDays(localDate(x.at, 'Etc/UTC'), 1), zone: 'Etc/UTC' };
    const task = (await x.db.query<{ id: string }>(`INSERT INTO meeting_tasks(workspace_id,meeting_id,firm_id,commitment_id,label,owner_user_id,deadline,due_at,evidence)
      VALUES($1,$2,$3,'guide',$4,$5,$6::jsonb,$7,$8::jsonb) RETURNING id`, [x.workspace,x.meetingId,x.firmId,`Send ${url}`,x.world.alpha.workspace.salesperson.userId,JSON.stringify(deadline),localInstant(deadline.localDate,{hour:8,minute:0},'Etc/UTC'),JSON.stringify([{kind:'debrief',revision:1,quote:`Send ${url}`,startOffset:0,endOffset:5+url.length}])])).rows[0]!;
    expect(await withTransaction(x.db, () => appendMeetingDraft(x.context, plan, { subject: x.draft.subject, body: x.draft.body, templateVersionId: x.templateVersionId, sourceHash: x.draft.sourceHash, materialReferences: [url], at: new Date(Date.parse(x.at)-40*60_000).toISOString() }))).toMatchObject({ok:true});
    const fence = await x.prepare();
    await withTransaction(x.db, () => finalizeMeetingFollowThrough(x.context, { meetingId: x.meetingId, at: x.at }));
    expect((await x.db.query('SELECT status FROM meeting_tasks WHERE id=$1',[task.id])).rows).toEqual([{status:'open'}]);
    const gmail = x.world.clientWith(x.world.alpha, {});
    expect(await dispatchOutboundMessage(x.context,x.world.sendDeps(x.world.alpha,{gmail,now:()=>new Date(x.at)}),{outboundMessageId:fence.id})).toMatchObject({outcome:'sent'});
    if (change === 'stop') expect(await withTransaction(x.db, () => recordSuppression(x.admin, { scope: 'firm', firmId: x.firmId, source: 'prospect_opt_out', channel: 'all', journal: x.world.journal }))).toMatchObject({ ok: true });
    if (change === 'source') await x.db.query('UPDATE meeting_follow_through SET source_hash=$2 WHERE id=$1', [x.planId, 'f'.repeat(64)]);
    if (change === 'reassigned') await x.db.query('UPDATE firms SET assigned_user_id=NULL WHERE id=$1', [x.firmId]);
    for(let n=0;n<2;n++) await withTransaction(x.db,()=>finalizeMeetingFollowThrough(x.context,{meetingId:x.meetingId,at:x.at}));
    expect((await x.db.query('SELECT status,version FROM meeting_tasks WHERE id=$1',[task.id])).rows).toEqual([{status:change === 'none' ? 'done' : 'open',version:change === 'none' ? 2 : 1}]);
  });
});

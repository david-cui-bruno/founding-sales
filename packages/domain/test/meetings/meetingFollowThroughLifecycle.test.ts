import { randomUUID } from 'node:crypto';
import { applyBooked } from '../../meetings/calcom.ts';
import { foldMeetingOutcomes, deleteMeetingOutcomeContent } from '../../meetings/outcomeCorrections.ts';
import { dispatchOutboundMessage } from '../../outbound/send.ts';
import { editMeetingRecap } from '../../meetings/followThrough.ts';
import { verifyMeetingFence } from '../../meetings/followThroughDelivery.ts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withTransaction } from '../../db/queryable.ts';
import { meetingDispatchFixture } from './support/meetingDispatchFixture.ts';
import { runMeetingFollowThrough, finalizeMeetingFollowThrough } from '../../meetings/followThroughJobs.ts';
import { readMeetingFollowThrough } from '../../meetings/followThrough.ts';
import { ensureUnresolvedMeetingTask } from '../../meetings/followThroughTasks.ts';
import { changeMeetingTask } from '../../meetings/tasks.ts';
import { readMeetingTask } from '../../meetings/outcomes.ts';

describe('meeting follow-through recovery and task identity', () => {
  let f: Awaited<ReturnType<typeof meetingDispatchFixture>>;
  beforeEach(async () => { f = await meetingDispatchFixture(); });
  afterEach(async () => { await f?.world.stop(); });
  it('records a short domain pause even when no scheduler pass runs during it', async () => {
    await f.db.query('UPDATE sending_domains SET automated_sending_enabled=false,automated_sending_enabled_at=NULL WHERE workspace_id=$1', [f.workspace]);
    expect((await f.db.query('SELECT pause_observed_at FROM meeting_follow_through WHERE id=$1', [f.planId])).rows[0]!['pause_observed_at']).not.toBeNull();
    await f.db.query('UPDATE sending_domains SET automated_sending_enabled=true,automated_sending_enabled_at=now() WHERE workspace_id=$1', [f.workspace]);
    expect((await f.db.query('SELECT pause_observed_at FROM meeting_follow_through WHERE id=$1', [f.planId])).rows[0]!['pause_observed_at']).not.toBeNull();
  });
  it('resumes a never-submitted paused draft with a fresh thirty minute window', async () => {
    await f.db.query('UPDATE meeting_follow_through SET pause_observed_at=$2 WHERE id=$1', [f.planId, f.before]);
    await withTransaction(f.db, () => runMeetingFollowThrough(f.context, { meetingId: f.meetingId, at: f.at }));
    const view = await readMeetingFollowThrough(f.admin, { meetingId: f.meetingId });
    expect(view!.currentDraft).toMatchObject({ version: 2, notBefore: new Date(Date.parse(f.at) + 30 * 60_000).toISOString() });
  });
  it('requires review for a recap more than two business days old', async () => {
    await withTransaction(f.db, () => runMeetingFollowThrough(f.context, { meetingId: f.meetingId, at: new Date(Date.parse(f.at) + 7 * 86_400_000).toISOString() }));
    expect(await readMeetingFollowThrough(f.admin, { meetingId: f.meetingId })).toMatchObject({ status: 'needs_review', blockers: expect.arrayContaining(['recap_stale']) });
  });
  it('permits explicit review of a stale recap only after a fresh window', async () => {
    const at = new Date(Date.parse(f.at) + 7 * 86_400_000).toISOString();
    await withTransaction(f.db, () => runMeetingFollowThrough(f.context, { meetingId: f.meetingId, at }));
    let view = (await readMeetingFollowThrough(f.admin, { meetingId: f.meetingId }))!;
    const begun = await withTransaction(f.db, () => editMeetingRecap(f.admin, { planId: f.planId, expectedPlanVersion: view.version, expectedDraftVersion: view.currentDraft!.version, action: 'begin_edit' }, at));
    if (!begun.ok) throw new Error(begun.reason); view = begun.value;
    expect(await withTransaction(f.db, () => editMeetingRecap(f.admin, { planId: f.planId, expectedPlanVersion: view.version, expectedDraftVersion: view.currentDraft!.version, action: 'save', subject: 'Following up on our meeting', body: 'Here are the details we discussed.\n\nSigned off' }, at))).toMatchObject({ ok: true });
    await withTransaction(f.db, () => runMeetingFollowThrough(f.context, { meetingId: f.meetingId, at }));
    expect(await readMeetingFollowThrough(f.admin, { meetingId: f.meetingId })).toMatchObject({ blockers: [], currentDraft: { version: 2, subject: 'Following up on our meeting', notBefore: new Date(Date.parse(at) + 30 * 60_000).toISOString() } });
  });
  it('cancels obsolete pending follow-ups on a newer booking', async () => {
    const fence = await f.prepare(), id = randomUUID(), uid = randomUUID().replaceAll('-','');
    await f.db.query(`INSERT INTO meetings(workspace_id,id,booking_uid,current_booking_uid,firm_id,contact_id,state,starts_at,ends_at,last_event_at)
      VALUES($1,$2,$3,$3,$4,$5,'booked',$6::timestamptz+interval '1 day',$6::timestamptz+interval '2 days',$6)`, [f.workspace,id,uid,f.firmId,f.contactId,f.at]);
    expect(await verifyMeetingFence(f.context, { fenceId: fence.id, at: f.at })).toMatchObject({ ok: false });
    await withTransaction(f.db, () => applyBooked(f.context, { id, booking_uid: uid, firm_id: f.firmId }));
    expect(await readMeetingFollowThrough(f.admin, { meetingId: f.meetingId })).toMatchObject({ status: 'cancelled' });
    expect((await f.db.query('SELECT ended_at FROM sequence_enrollments WHERE id=(SELECT enrollment_id FROM meeting_follow_through WHERE id=$1)', [f.planId])).rows[0]!['ended_at']).not.toBeNull();
  });
  it('preserves identities while folding the source meeting and holds historical plans', async () => {
    const id = randomUUID(), uid = randomUUID().replaceAll('-','');
    await f.db.query(`INSERT INTO meetings(workspace_id,id,booking_uid,current_booking_uid,firm_id,contact_id,state,starts_at,ends_at,last_event_at)
      VALUES($1,$2,$3,$3,$4,$5,'ended',$6::timestamptz-interval '1 hour',$6,$6)`, [f.workspace,id,uid,f.firmId,f.contactId,f.before]);
    await withTransaction(f.db, () => foldMeetingOutcomes(f.context, { sourceMeetingId: f.meetingId, targetMeetingId: id }));
    expect((await f.db.query('SELECT id,meeting_id,status FROM meeting_follow_through WHERE id=$1', [f.planId])).rows).toEqual([{ id: f.planId, meeting_id: id, status: 'cancelled' }]);
    expect((await f.db.query('SELECT id FROM meeting_follow_through_drafts WHERE plan_id=$1', [f.planId])).rows).toEqual([{ id: f.draft.id }]);
  });
  it('deletes recap content with its source and cannot dispatch the orphaned fence', async () => {
    const fence = await f.prepare();
    await withTransaction(f.db, () => deleteMeetingOutcomeContent(f.context, { meetingIds: [f.meetingId] }));
    expect((await f.db.query('SELECT id FROM meeting_follow_through WHERE id=$1', [f.planId])).rows).toHaveLength(0);
    const gmail = f.world.clientWith(f.world.alpha, {});
    await dispatchOutboundMessage(f.context, f.world.sendDeps(f.world.alpha, { gmail, now: () => new Date(f.at) }), { outboundMessageId: fence.id });
    expect(gmail.sends).toHaveLength(0);
  });
  it('deduplicates the unresolved task and preserves a user-completed task', async () => {
    const input = { meetingId: f.meetingId, planId: f.planId, ownerUserId: f.world.alpha.workspace.salesperson.userId, dueAt: f.at, deadline: { precision: 'date' as const, localDate: f.at.slice(0,10), zone: 'Etc/UTC' } };
    const first = await withTransaction(f.db, () => ensureUnresolvedMeetingTask(f.context, input));
    expect(first.created).toBe(true);
    const task = await readMeetingTask(f.admin, first.taskId); expect(task!.source).toEqual({ kind: 'follow_through', planId: f.planId });
    expect(await withTransaction(f.db, () => changeMeetingTask(f.admin, { taskId: first.taskId, expectedVersion: task!.version, action: 'complete' }))).toMatchObject({ ok: true });
    expect(await withTransaction(f.db, () => ensureUnresolvedMeetingTask(f.context, input))).toEqual({ taskId: first.taskId, created: false });
    expect(await readMeetingTask(f.admin, first.taskId)).toMatchObject({ status: 'done' });
    await withTransaction(f.db, () => finalizeMeetingFollowThrough(f.context, { meetingId: f.meetingId, at: f.at }));
    expect((await f.db.query('SELECT id FROM meeting_tasks WHERE follow_through_plan_id=$1', [f.planId])).rows).toHaveLength(1);
  });
});

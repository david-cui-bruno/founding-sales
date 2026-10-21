import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { meetingUnpublishedPlanSchema, type SaveMeetingUnpublishedPlan } from '@fss/contracts';
import { workspaceScope } from '../../db/workspaceScope.ts';
import { withTransaction } from '../../db/queryable.ts';
import { meetingFollowThroughFixture, RECAP_AT } from './support/meetingFollowThroughFixture.ts';
import { readMeetingOutcomes } from '../../meetings/outcomes.ts';
import { readMeetingFollowThrough, prepareMeetingRecap } from '../../meetings/followThrough.ts';
import { saveMeetingUnpublishedPlan } from '../../meetings/unpublishedPlan.ts';

// All notes and people below are controlled fixtures, not live demo records.
describe('migration125 unpublished meeting drafts', () => {
  let f: Awaited<ReturnType<typeof meetingFollowThroughFixture>>;
  beforeEach(async () => { f = await meetingFollowThroughFixture(); });
  afterEach(async () => { await f.db.drop(); });
  async function inputFor(meetingId: string): Promise<SaveMeetingUnpublishedPlan> {
    const notes = (await readMeetingOutcomes(f.context, {meetingId}))!;
    return {meetingId,expectedSourceHash:notes.sourceHash,expectedNotesRevision:notes.notes.revision,expectedPlanVersion:0,expectedUnpublishedRevision:0,
      messages:[{subject:'Fixture recap',body:'Actual fixture note. Setup date: {day}.'},{subject:'',body:''},{subject:'Follow-up',body:'{their question}'},{subject:'Final draft',body:'Known fixture text.'}]};
  }
  const save = (input: SaveMeetingUnpublishedPlan) => withTransaction(f.db.session, () => saveMeetingUnpublishedPlan(f.context,input,RECAP_AT));
  async function counts() {
    return (await f.db.session.query(`SELECT (SELECT count(*) FROM sequence_enrollments) AS enrollments,(SELECT count(*) FROM outbound_messages) AS outbound,(SELECT count(*) FROM follow_up_permissions) AS permissions,(SELECT count(*) FROM step_executions) AS executions`)).rows[0];
  }
  it('persists four held drafts with empty/partial/unknown notes, without send writes or scheduling', async () => {
    const meetingId=await f.meeting(), input=await inputFor(meetingId), before=await counts();
    const result=await save(input);expect(result.ok).toBe(true);
    const view=(await readMeetingFollowThrough(f.context,{meetingId}))!;
    expect(view.unpublishedPlan).toMatchObject({state:'unpublished',sourceHash:input.expectedSourceHash,notesRevision:0,revision:1});
    expect(view.unpublishedPlan!.messages.map(m=>m.elapsedDays)).toEqual([0,3,7,14]);
    expect(view.unpublishedPlan!.messages.every(m=>m.held)).toBe(true);
    expect(view.unpublishedPlan!.messages[0].body).toBe(input.messages[0].body);
    expect(view.unpublishedPlan!.messages[1].unknownFields).toEqual(['Subject needs human entry','Message needs human entry']);
    expect(view.unpublishedPlan!.messages[2].unknownFields).toContain('{their question}');
    expect(view).toMatchObject({currentDraft:null,sequenceVersionId:null,status:'needs_review'});
    expect(await counts()).toEqual(before);
    const row=(await f.db.session.query<{next_wake_at:Date;permission_id:string|null;enrollment_id:string|null}>('SELECT next_wake_at,permission_id,enrollment_id FROM meeting_follow_through WHERE meeting_id=$1',[meetingId])).rows[0]!;
    expect(row.next_wake_at.toISOString()).toBe('9999-01-01T00:00:00.000Z');expect(row.permission_id).toBeNull();expect(row.enrollment_id).toBeNull();
  });
  it('preserves legacy draft, stops, permission, enrollment, approval and wake time on save',async()=>{
    const source=await f.ready();
    const prepared=await withTransaction(f.db.session,()=>prepareMeetingRecap(f.context,{...source,at:RECAP_AT}));if(!prepared.ok)throw new Error(prepared.reason);
    await f.db.session.query("UPDATE meeting_follow_through SET blockers='[\"reply_received\",\"suppressed\"]' WHERE id=$1",[prepared.value.planId]);
    const before=(await f.db.session.query<{version:number;unpublished_plan:unknown;updated_at:Date}>('SELECT * FROM meeting_follow_through WHERE id=$1',[prepared.value.planId])).rows[0]!;
    const input={...await inputFor(source.meetingId),expectedPlanVersion:before.version};
    expect((await save(input)).ok).toBe(true);
    const after=(await f.db.session.query<{version:number;unpublished_plan:unknown;updated_at:Date}>('SELECT * FROM meeting_follow_through WHERE id=$1',[prepared.value.planId])).rows[0]!;
    const {unpublished_plan:_old,version:_v,updated_at:_at,...legacyBefore}=before;
    const {unpublished_plan:_new,version:_nv,updated_at:_nat,...legacyAfter}=after;
    expect(legacyAfter).toEqual(legacyBefore);
    expect((await readMeetingFollowThrough(f.context,source))!.currentDraft).toEqual(prepared.value.currentDraft);
  });
  it('refuses stale source/revisions and terminal plans without losing saved text',async()=>{
    const meetingId=await f.meeting(), input=await inputFor(meetingId);
    const first=await save(input);if(!first.ok)throw new Error(first.reason);
    expect(await save(input)).toEqual({ok:false,reason:'draft_changed'});
    await f.save(meetingId,'New actual fixture notes.');
    expect(await save({...input,expectedPlanVersion:first.value.version,expectedUnpublishedRevision:1})).toEqual({ok:false,reason:'source_changed'});
    const refreshed=(await readMeetingFollowThrough(f.context,{meetingId}))!;
    expect(refreshed.sourceHash).toBe(input.expectedSourceHash);
    expect(refreshed.draftSource).toMatchObject({notesRevision:1});
    const rebased={...input,expectedSourceHash:refreshed.draftSource!.sourceHash,expectedNotesRevision:refreshed.draftSource!.notesRevision,expectedPlanVersion:first.value.version,expectedUnpublishedRevision:1};
    const second=await save(rebased);if(!second.ok)throw new Error(second.reason);
    expect((await readMeetingFollowThrough(f.context,{meetingId}))!.unpublishedPlan).toMatchObject({revision:2,sourceHash:rebased.expectedSourceHash,messages:input.messages});
    await f.db.session.query("UPDATE meeting_follow_through SET status='cancelled' WHERE id=$1",[first.value.planId]);
    const current=await inputFor(meetingId);
    expect(await save({...current,expectedPlanVersion:second.value.version,expectedUnpublishedRevision:2})).toEqual({ok:false,reason:'follow_up_stopped'});
    expect((await readMeetingFollowThrough(f.context,{meetingId}))!.unpublishedPlan!.revision).toBe(2);
  });
  it('migration constraint refuses active state, changed offsets/count, missing fields and invalid stored JSON',async()=>{
    const meetingId=await f.meeting();await save(await inputFor(meetingId));
    const view=(await readMeetingFollowThrough(f.context,{meetingId}))!, plan=view.unpublishedPlan!;
    for(const invalid of [{...plan,state:'published'},{...plan,messages:plan.messages.slice(0,3)},{...plan,messages:plan.messages.map((m,i)=>i===1?{...m,elapsedDays:4}:m)},{...plan,sourceHash:null}]){
      await expect(f.db.session.query('UPDATE meeting_follow_through SET unpublished_plan=$2::jsonb WHERE meeting_id=$1',[meetingId,JSON.stringify(invalid)])).rejects.toMatchObject({code:'23514'});
    }
    // Database envelope guard plus strict parser: malformed nested text never becomes a view.
    const malformed={...plan,messages:plan.messages.map((m,i)=>i===0?{...m,subject:42}:m)};
    expect(meetingUnpublishedPlanSchema.safeParse(malformed).success).toBe(false);
    await f.db.session.query('UPDATE meeting_follow_through SET unpublished_plan=$2::jsonb WHERE meeting_id=$1',[meetingId,JSON.stringify(malformed)]);
    await expect(readMeetingFollowThrough(f.context,{meetingId})).rejects.toThrow();
  });
  it('deleting a meeting cascades copied draft text and another workspace cannot read it',async()=>{
    const meetingId=await f.meeting();await save(await inputFor(meetingId));
    const other={...f.context,scope:workspaceScope(f.seeded.beta.workspaceId,f.context.scope.actor)};
    expect(await readMeetingFollowThrough(other,{meetingId})).toBeNull();
    const input=await inputFor(meetingId);
    expect(await withTransaction(f.db.session,()=>saveMeetingUnpublishedPlan(other,input))).toEqual({ok:false,reason:'meeting_unknown'});
    const system={...f.context,scope:workspaceScope(f.workspace,{kind:'system',component:'worker'})};
    expect(await saveMeetingUnpublishedPlan(system,input)).toEqual({ok:false,reason:'invalid_input'});
    await f.db.session.query('DELETE FROM meetings WHERE workspace_id=$1 AND id=$2',[f.workspace,meetingId]);
    expect((await f.db.session.query('SELECT unpublished_plan FROM meeting_follow_through WHERE meeting_id=$1',[meetingId])).rows).toHaveLength(0);
  });
});

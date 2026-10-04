import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { meetingAutoRecordingFixture } from './support/meetingAutoRecordingFixture.ts';
import { runMeetingRecordingSetup } from '../../meetings/autoRecording.ts';
import { completeJob, type ClaimedJob } from '../../jobs/jobStore.ts';
describe('recording setup execution',()=>{
  let f:Awaited<ReturnType<typeof meetingAutoRecordingFixture>>;
  beforeEach(async()=>{f=await meetingAutoRecordingFixture();});afterEach(async()=>{await f.db.drop();});
  const run=async(job:ClaimedJob,operationId=f.operation.operationId)=>await runMeetingRecordingSetup(f.db.session,{workspaceId:f.workspace,operationId,jobId:job.id,fencingToken:job.fencingToken,calcom:f.calcom,zoom:f.zoom,now:()=>new Date().toISOString()});
  it('writes once and requires readback',async()=>{
    const job=await f.claim();await run(job);expect(f.patches()).toBe(1);expect(await f.read()).toMatchObject({state:'ready',applied_by_us:true,attempts:1});await run(job);expect(f.patches()).toBe(1);
  });
  it('reconciles_a_crash_after_patch',async()=>{
    const job=await f.claim(),original=f.db.session.query.bind(f.db.session);let crash=true;
    f.db.session.query=async(sql,values)=>{if(crash&&sql.includes('SET write_certainty=')){crash=false;throw new Error('simulated_database_disconnect');}return await original(sql,values);};
    await expect(run(job)).rejects.toThrow('simulated_database_disconnect');expect(f.patches()).toBe(1);expect(await f.read()).toMatchObject({write_certainty:'intent'});
    const next=await f.reclaim(job.id);await run(next);expect(f.patches()).toBe(1);expect(await f.read()).toMatchObject({state:'ready',attempts:2});
  });
  it.each(['cancel','disable'])('cancel_or_disable_before_boundary_prevents_patch: %s',async(action)=>{
    const job=await f.claim(),original=f.calcom.readBooking;
    f.calcom.readBooking=async(uid,signal)=>{if(action==='disable')await f.set(false);else await f.db.session.query("UPDATE meetings SET state='cancelled' WHERE id=$1",[f.meetingId]);return await original(uid,signal);};
    await run(job);expect(f.patches()).toBe(0);expect((await f.read())?.['state']).not.toBe('ready');
  });
  it('old_lease_cannot_dispatch',async()=>{
    const job=await f.claim();await f.reclaim(job.id);await run(job);expect(f.patches()).toBe(0);
  });
  it('manual_disable_survives_reschedule',async()=>{
    const job=await f.claim();await run(job);f.mode('none');
    await completeJob(f.db.session,job);
    await f.db.session.query('UPDATE meetings SET current_booking_uid=$2 WHERE id=$1',[f.meetingId,'new-booking']);
    const next=await f.create();await run(await f.claim(),next.operationId);expect(f.patches()).toBe(1);expect(await f.read(next.operationId)).toMatchObject({state:'manual',reason:'manual_override'});
  });
  it('deletion_during_readback_does_not_resurrect_data',async()=>{
    const job=await f.claim(),read=f.zoom.readMeeting;let n=0;
    f.zoom.readMeeting=async(id,signal)=>{n++;if(n===2)await f.db.session.query('DELETE FROM meetings WHERE id=$1',[f.meetingId]);return await read(id,signal);};
    await run(job);expect(await f.read()).toBeUndefined();expect(f.patches()).toBe(1);
  });
  it('uncertain nonlocal readback requires manual action',async()=>{
    f.zoom.setLocalAutoRecording=async()=>({kind:'unknown',code:'ambiguous_write',retryAfterMs:null});
    await run(await f.claim());expect(await f.read()).toMatchObject({state:'manual',reason:'ambiguous_write'});
  });
  it('respects a manual disable after observing an already-local meeting',async()=>{
    f.mode('local');const first=await f.claim();await run(first);await completeJob(f.db.session,first);expect(f.patches()).toBe(0);
    f.mode('none');await f.db.session.query('UPDATE meetings SET current_booking_uid=$2 WHERE id=$1',[f.meetingId,'observed-reschedule']);
    const next=await f.create();await run(await f.claim(),next.operationId);expect(f.patches()).toBe(0);expect(await f.read(next.operationId)).toMatchObject({state:'manual',reason:'manual_override'});
  });
  it('a reconciled old uncertainty does not block a later explicit retry',async()=>{
    const old=await f.claim();await f.db.session.query(`UPDATE meeting_recording_setup SET state='manual',write_certainty='unknown',write_intent_at=now(),write_owner_token=$2,write_job_id=$3 WHERE id=$1`,[f.operation.operationId,old.fencingToken,old.id]);await completeJob(f.db.session,old);
    f.mode('local');const one=await f.create(f.meetingId,1),oneJob=await f.claim();await run(oneJob,one.operationId);await completeJob(f.db.session,oneJob);expect(await f.read(one.operationId)).toMatchObject({state:'ready'});
    f.mode('none');const two=await f.create(f.meetingId,2);await run(await f.claim(),two.operationId);expect(f.patches()).toBe(1);expect(await f.read(two.operationId)).toMatchObject({state:'ready'});
  });

});

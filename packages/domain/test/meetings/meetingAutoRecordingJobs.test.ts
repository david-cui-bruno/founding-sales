import {foldMeetingRecordingSetup} from '../../meetings/autoRecordingLifecycle.ts';
import {runMeetingRecordingSetup} from '../../meetings/autoRecording.ts';
import {enqueueJob,completeJob} from '../../jobs/jobStore.ts';
import { afterEach,beforeEach,describe,expect,it } from 'vitest';
import { withTransaction } from '../../db/queryable.ts';
import { scheduleMeetingRecordingSetup } from '../../meetings/autoRecordingJobs.ts';
import { readMeetingAutoRecordingConfiguration } from '../../meetings/autoRecordingSettings.ts';
import { meetingAutoRecordingFixture } from './support/meetingAutoRecordingFixture.ts';
import { recordHeartbeat } from '../../jobs/heartbeats.ts';
describe('bounded recording setup scheduler',()=>{
  let f:Awaited<ReturnType<typeof meetingAutoRecordingFixture>>;
  beforeEach(async()=>{f=await meetingAutoRecordingFixture();});afterEach(async()=>{await f.db.drop();});
  const schedule=async(at=new Date().toISOString(),configured=true)=>await withTransaction(f.db.session,()=>scheduleMeetingRecordingSetup(f.db.session,at,{providerConfigured:configured}));
  it('twenty_terminal_rows_do_not_starve_new_work',async()=>{
    for(let n=0;n<21;n++){const id=await f.meeting(String(12345679000+n));const op=await f.create(id);await f.db.session.query("UPDATE meeting_recording_setup SET state='ready',verified_at=now() WHERE id=$1",[op.operationId]);}
    const next=await f.meeting('12345679999');const jobs=await schedule();expect(jobs.length).toBeLessThanOrEqual(20);
    const ids=jobs.map(j=>j.payload['operationId']);
    expect((await f.db.session.query<{meeting_id:string}>('SELECT meeting_id FROM meeting_recording_setup WHERE id=ANY($1::uuid[])',[ids])).rows.map(r=>r.meeting_id)).toContain(next);
    expect(await schedule()).toEqual([]);
  });
  it('expired_jobs_cannot_restart_their_deadline',async()=>{
    await f.claim();await f.db.session.query("UPDATE jobs SET first_claimed_at=now()-interval '3 hours',lease_expires_at=now()-interval '1 second'");
    expect(await schedule()).toEqual([]);expect(await f.read()).toMatchObject({state:'manual',reason:'expired'});expect(await schedule()).toEqual([]);
  });
  it('a_crash_before_handler_reservation_is_bounded',async()=>{
    await f.claim();await f.db.session.query("UPDATE jobs SET attempt_count=4,lease_expires_at=now()-interval '1 second'");
    expect(await schedule()).toEqual([]);expect(await f.read()).toMatchObject({state:'manual',reason:'attempt_limit'});
  });
  it('stale_worker_cannot_appear_configured and cannot enable',async()=>{
    await recordHeartbeat(f.db.session,{component:'worker',instanceKey:'test-ready',detail:{meeting_recording_setup:true}});
    expect((await readMeetingAutoRecordingConfiguration(f.context)).configured.ready).toBe(true);
    await f.db.session.query("UPDATE heartbeats SET observed_at=now()-interval '1 hour' WHERE component='worker'");
    expect((await readMeetingAutoRecordingConfiguration(f.context)).configured.workerFresh).toBe(false);
    expect(await f.set(true)).toMatchObject({ok:false});expect(await f.set(false)).toMatchObject({ok:true});
  });
  it('disabled or unconfigured integration schedules nothing',async()=>{
    const id=await f.meeting('12345679999');expect(id).toBeTruthy();expect(await schedule(undefined,false)).toEqual([]);await f.set(false);expect(await schedule()).toEqual([]);
  });
  it('fold schedules one fresh survivor generation without overriding manual recording changes',async()=>{
    const job=await f.claim();await runMeetingRecordingSetup(f.db.session,{workspaceId:f.workspace,operationId:f.operation.operationId,jobId:job.id,fencingToken:job.fencingToken,calcom:f.calcom,zoom:f.zoom,now:()=>new Date().toISOString()});await completeJob(f.db.session,job);f.mode('none');
    const source=await f.meeting('99999999999');await withTransaction(f.db.session,()=>foldMeetingRecordingSetup(f.context,{sourceMeetingId:source,targetMeetingId:f.meetingId,at:new Date().toISOString()}));await f.db.session.query('DELETE FROM meetings WHERE id=$1',[source]);
    const jobs=await schedule();expect(jobs).toHaveLength(1);expect(await schedule()).toEqual([]);
    await enqueueJob(f.db.session,jobs[0]!);const next=await f.claim();await runMeetingRecordingSetup(f.db.session,{workspaceId:f.workspace,operationId:String(next.payload['operationId']),jobId:next.id,fencingToken:next.fencingToken,calcom:f.calcom,zoom:f.zoom,now:()=>new Date().toISOString()});
    expect(f.patches()).toBe(1);expect(await f.read(String(next.payload['operationId']))).toMatchObject({state:'manual',reason:'manual_override'});
  });

});

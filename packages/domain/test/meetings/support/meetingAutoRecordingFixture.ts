import { recordHeartbeat } from '../../../jobs/heartbeats.ts';
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '../../../db/testing/testDatabase.ts';
import { repositoryContext, workspaceScope } from '../../../db/workspaceScope.ts';
import { withTransaction } from '../../../db/queryable.ts';
import { seedTwoWorkspaces } from '../../db/support/fixtures.ts';
import { updateSetting } from '../../../settings/store.ts';
import { claimJobs, enqueueJob, reclaimExpiredLeases } from '../../../jobs/jobStore.ts';
import { recordingSetupTargetHash } from '../../../meetings/autoRecordingEligibility.ts';
import type { CalcomDemoClient, RecordingSetupTarget, ZoomMeetingsClient } from '../../../meetings/autoRecordingTypes.ts';
export async function meetingAutoRecordingFixture() {
  const db=await createTestDatabase(),seeded=await seedTwoWorkspaces(db.session),workspace=seeded.alpha.workspaceId;
  const context=repositoryContext(workspaceScope(workspace,{kind:'user',userId:seeded.alpha.admin.userId,role:'admin'}),db.session);
  const at=new Date().toISOString(),startsAt=new Date(Date.now()+86400000).toISOString(),endsAt=new Date(Date.parse(startsAt)+1800000).toISOString();
  await recordHeartbeat(db.session,{component:'worker',instanceKey:'fixture-ready',detail:{meeting_recording_setup:true}});
  const set=async(enabled:boolean)=>await withTransaction(db.session,()=>updateSetting(context,{settingKey:'meeting_auto_recording',value:{enabled,hostEmail:'host@example.com',calcomEventTypeId:42}}));
  await withTransaction(db.session,()=>updateSetting(context,{settingKey:'calendar_integration',value:{integration:'calcom'}}));await set(true);
  const firm=(await db.session.query<{id:string}>("INSERT INTO firms(workspace_id,name,assigned_user_id) VALUES($1,'Demo firm',$2) RETURNING id",[workspace,seeded.alpha.admin.userId])).rows[0]!.id;
  const meeting=async(zoomId='12345678901')=>{
    const uid=randomUUID();return (await db.session.query<{id:string}>(`INSERT INTO meetings(workspace_id,firm_id,booking_uid,current_booking_uid,state,starts_at,ends_at,organizer_email,attendee_email,last_event_at,details_observed_at,zoom_meeting_id) VALUES($1,$2,$3,$3,'booked',$4,$5,'host@example.com','pm@example.com',$6,$6,$7) RETURNING id`,[workspace,firm,uid,startsAt,endsAt,at,zoomId])).rows[0]!.id;
  };
  const meetingId=await meeting();
  const create=async(id=meetingId,generation=0)=>{
    const row=(await db.session.query<{current_booking_uid:string;zoom_meeting_id:string;starts_at:Date;ends_at:Date}>('SELECT * FROM meetings WHERE workspace_id=$1 AND id=$2',[workspace,id])).rows[0]!;
    const target:RecordingSetupTarget={workspaceId:workspace,meetingId:id,firmId:firm,contactId:null,bookingUid:row.current_booking_uid,zoomMeetingId:row.zoom_meeting_id,attendeeEmail:'pm@example.com',organizerEmail:'host@example.com',startsAt:row.starts_at.toISOString(),endsAt:row.ends_at.toISOString(),settingsVersion:1};
    const operationId=(await db.session.query<{id:string}>(`INSERT INTO meeting_recording_setup(workspace_id,meeting_id,target,target_hash,retry_generation) VALUES($1,$2,$3::jsonb,$4,$5) RETURNING id`,[workspace,id,JSON.stringify(target),recordingSetupTargetHash(target),generation])).rows[0]!.id;
    await enqueueJob(db.session,{workspaceId:workspace,kind:'meeting.recording_setup',idempotencyKey:operationId,payload:{operationId},maxAttempts:4});
    return {operationId,target};
  };
  const claim=async()=> (await claimJobs(db.session,{owner:'demo-test',kinds:['meeting.recording_setup'],limit:1,leaseSeconds:90}))[0]!;
  const reclaim=async(jobId:string)=>{await db.session.query("UPDATE jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[jobId]);await reclaimExpiredLeases(db.session,{limit:10});return await claim();};
  const operation=await create();let mode='none';let patches=0;
  const calcom:CalcomDemoClient={async readBooking(uid){return {kind:'ok',value:{uid,status:'accepted',eventTypeId:42,hostEmail:'host@example.com',attendeeEmail:'pm@example.com',startsAt,endsAt,zoomMeetingId:'12345678901',successorUid:null,recurring:false,seated:false}};}};
  const zoom:ZoomMeetingsClient={async readMeeting(id){return {kind:'ok',value:{id,hostEmail:'host@example.com',type:2,usePmi:false,startsAt,durationMinutes:30,autoRecording:mode}};},async setLocalAutoRecording(){patches++;mode='local';return {kind:'acknowledged',code:null,retryAfterMs:null};}};
  const read=async(id=operation.operationId)=>(await db.session.query('SELECT * FROM meeting_recording_setup WHERE id=$1',[id])).rows[0];
  return {db,seeded,context,workspace,firm,at,startsAt,endsAt,meetingId,meeting,create,claim,reclaim,operation,set,calcom,zoom,read,patches:()=>patches,mode:(value:string)=>{mode=value;}};
}

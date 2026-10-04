import {claimJobs} from '@fss/domain/jobs/jobStore.ts';
import {runMeetingRecordingSetup} from '@fss/domain/meetings/autoRecording.ts';
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {dispatch} from '../src/server.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION,type AuthFixture} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {seedFirm} from './support/crmSeed.ts';
import {recordHeartbeat} from '@fss/domain/jobs/heartbeats.ts';
import {recordingSetupTargetHash} from '@fss/domain/meetings/autoRecordingEligibility.ts';
import type {RecordingSetupTarget} from '@fss/domain/meetings/autoRecordingTypes.ts';
describe('recording setup API',()=>{
  let f:AuthFixture,token:string,firmId:string,meetingId:string,op:string;
  const call=(path:string,body?:unknown,query=new URLSearchParams({meetingId}))=>dispatch({method:body===undefined?'GET':'POST',path,query,headers:{authorization:`Bearer ${token}`},body},{session:f.db,auth:f.deps,supportedClientVersions:f.deps.config.supportedClientVersions,sendingEnabled:false,upgradeUrl:'https://example.test/update'});
  beforeAll(async()=>{
    f=await createAuthFixture();token=(await issueSessionFor(f,f.alpha,f.alpha.salesperson)).accessToken;
    firmId=await seedFirm(f,{name:'Recording setup API',regionCode:'TX',assignedUserId:f.alpha.salesperson.userId});meetingId=randomUUID();op=randomUUID();
    const startsAt=new Date(Date.now()+86400000).toISOString(),endsAt=new Date(Date.parse(startsAt)+1800000).toISOString();
    await f.db.query(`INSERT INTO meetings(workspace_id,id,firm_id,booking_uid,current_booking_uid,state,starts_at,ends_at,last_event_at,details_observed_at,zoom_meeting_id,organizer_email,attendee_email) VALUES($1,$2,$3,'setup-api','setup-api','booked',$4,$5,now(),now(),'12345678901','host@example.com','pm@example.com')`,[f.alpha.workspaceId,meetingId,firmId,startsAt,endsAt]);
    for(const [key,value] of [['calendar_integration',{integration:'calcom'}],['meeting_auto_recording',{enabled:true,hostEmail:'host@example.com',calcomEventTypeId:42}]] as const)await f.db.query('INSERT INTO workspace_settings(workspace_id,setting_key,version,value) VALUES($1,$2,1,$3::jsonb)',[f.alpha.workspaceId,key,JSON.stringify(value)]);
    await recordHeartbeat(f.db,{component:'worker',instanceKey:'test',detail:{meeting_recording_setup:true}});
    const target:RecordingSetupTarget={workspaceId:f.alpha.workspaceId,meetingId,firmId,contactId:null,bookingUid:'setup-api',zoomMeetingId:'12345678901',attendeeEmail:'pm@example.com',organizerEmail:'host@example.com',startsAt,endsAt,settingsVersion:1};
    await f.db.query(`INSERT INTO meeting_recording_setup(workspace_id,id,meeting_id,target,target_hash,state,reason) VALUES($1,$2,$3,$4::jsonb,$5,'manual','provider_unreachable')`,[f.alpha.workspaceId,op,meetingId,JSON.stringify(target),recordingSetupTargetHash(target)]);
  });afterAll(async()=>{await f.stop();});
  it('old_client_integrations_shape_is_unchanged',async()=>{
    expect((await call('/settings/integrations')).body).not.toHaveProperty('meetingAutoRecording');
    expect((await call('/settings/integrations',undefined,new URLSearchParams({include:'meeting_auto_recording'}))).body).toMatchObject({meetingAutoRecording:{configured:{ready:true}}});
  });
  it('retry_is_idempotent_and_versioned',async()=>{
    expect((await call('/meetings/recording-setup')).body).toMatchObject({state:'manual',canRetry:true});
    const command={meetingId,expectedVersion:1,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION};
    const first=await call('/meetings/recording-setup/retry',command);expect(first.status).toBe(200);expect(first.body).toMatchObject({result:{state:'pending'}});
    expect((first.body as {result:{version:number}}).result.version).toBeGreaterThan(command.expectedVersion);
    expect((await call('/meetings/recording-setup/retry',command)).body).toMatchObject({replayed:true});
    expect((await f.db.query('SELECT id FROM meeting_recording_setup WHERE meeting_id=$1',[meetingId])).rows).toHaveLength(2);
    expect((await call('/meetings/recording-setup/retry',{...command,commandId:randomUUID()})).status).toBe(409);
  });
  it('retry_cannot_bypass_unresolved_write',async()=>{
    const oldJob=(await claimJobs(f.db,{owner:'api-test',kinds:['meeting.recording_setup'],limit:1,leaseSeconds:90}))[0]!;
    await f.db.query(`UPDATE meeting_recording_setup SET state='manual',reason='ambiguous_write',write_certainty='unknown',write_intent_at=now(),write_owner_token=$2,write_job_id=$3 WHERE id=$1`,[oldJob.payload['operationId'],oldJob.fencingToken,oldJob.id]);
    const view=(await call('/meetings/recording-setup')).body as {version:number};
    const answer=await call('/meetings/recording-setup/retry',{meetingId,expectedVersion:view.version,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION});
    expect(answer.status).toBe(200);
    const job=(await claimJobs(f.db,{owner:'api-test',kinds:['meeting.recording_setup'],limit:1,leaseSeconds:90}))[0]!;
    const target=(await f.db.query<{target:RecordingSetupTarget}>('SELECT target FROM meeting_recording_setup WHERE id=$1',[job.payload['operationId']])).rows[0]!.target;
    let patches=0;
    await runMeetingRecordingSetup(f.db,{workspaceId:f.alpha.workspaceId,operationId:String(job.payload['operationId']),jobId:job.id,fencingToken:job.fencingToken,now:()=>new Date().toISOString(),
      calcom:{async readBooking(uid){return {kind:'ok',value:{uid,status:'accepted',eventTypeId:42,hostEmail:target.organizerEmail,attendeeEmail:target.attendeeEmail,startsAt:target.startsAt,endsAt:target.endsAt,zoomMeetingId:target.zoomMeetingId,successorUid:null,recurring:false,seated:false}};}},
      zoom:{async readMeeting(id){return {kind:'ok',value:{id,hostEmail:target.organizerEmail,type:2,usePmi:false,startsAt:target.startsAt,durationMinutes:30,autoRecording:'none'}};},async setLocalAutoRecording(){patches++;return {kind:'acknowledged',code:null,retryAfterMs:null};}},
    });
    expect(patches).toBe(0);expect((await call('/meetings/recording-setup')).body).toMatchObject({state:'manual',reason:'ambiguous_write'});
  });
  it('other_firm_and_other_workspace_return_not_found',async()=>{
    expect((await call('/meetings/recording-setup',undefined,new URLSearchParams({meetingId:randomUUID()}))).status).toBe(404);
    const old=token;token=(await issueSessionFor(f,f.beta,f.beta.admin)).accessToken;expect((await call('/meetings/recording-setup')).status).toBe(404);token=old;
    await f.db.query('UPDATE firms SET assigned_user_id=$2 WHERE id=$1',[firmId,f.alpha.admin.userId]);expect((await call('/meetings/recording-setup')).status).toBe(404);
  });
});

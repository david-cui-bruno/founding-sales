import type { RecordingSetupReason } from '@fss/contracts';
import { withTransaction, type SessionQueryable } from '../db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../db/workspaceScope.ts';
import { lockCalendarRoutingForRead } from '../policy/calendarRouting.ts';
import { lockSendGateForDispatch } from '../policy/sendGate.ts';
import { lockSettingForRead } from '../settings/store.ts';
import { workspacesWithIntegration } from '../settings/integrations.ts';
import { lockAnalysisMeeting } from './analysisRequests.ts';
import { readMeetingAutoRecordingSetting } from './autoRecordingSettings.ts';
import { recordingSetupEligibility, recordingSetupTargetHash } from './autoRecordingEligibility.ts';
import { currentRecordingTarget, readRecordingOperation, recordingHistory, reusedRecordingZoomId, setRecordingState, type RecordingSetupRow } from './autoRecordingState.ts';
import type { CalcomDemoClient, ZoomMeetingsClient, ZoomWriteResult } from './autoRecordingTypes.ts';
export interface RecordingSetupRun {
  workspaceId:string;operationId:string;jobId:string;fencingToken:string;calcom:CalcomDemoClient;zoom:ZoomMeetingsClient;now:()=>string;
}
/** Final boundaries all use the same lock order; the job row is always last. */
async function currentBoundary<T>(session:SessionQueryable,input:RecordingSetupRun,work:(c:RepositoryContext,row:RecordingSetupRow,at:string)=>Promise<T>):Promise<T|null> {
  return await withTransaction(session,async()=>{
    const c=repositoryContext(workspaceScope(input.workspaceId,{kind:'system',component:'worker'}),session);
    await lockCalendarRoutingForRead(session);await lockSendGateForDispatch(c);await lockSettingForRead(c,'meeting_auto_recording');
    const located=await readRecordingOperation(c,input.operationId);if(!located)return null;
    const firm=await lockAnalysisMeeting(c,located.meeting_id);
    const row=await readRecordingOperation(c,input.operationId,true);if(!row||['ready','manual','obsolete'].includes(row.state))return null;
    const job=(await session.query<{first_claimed_at:Date|null;attempt_count:number}>(`SELECT first_claimed_at,attempt_count FROM jobs WHERE workspace_id=$1 AND id=$2 AND fencing_token=$3::bigint AND state='running' AND lease_expires_at>clock_timestamp() AND kind='meeting.recording_setup' AND payload->>'operationId'=$4 FOR UPDATE`,[input.workspaceId,input.jobId,input.fencingToken,input.operationId])).rows[0];
    if(!job||!job.first_claimed_at)return null;
    const config=await readMeetingAutoRecordingSetting(c),target=await currentRecordingTarget(c,row.meeting_id,config.version);
    if(!firm||!target||recordingSetupTargetHash(target)!==row.target_hash){await setRecordingState(c,row.id,'obsolete','target_changed');return null;}
    const routing=await workspacesWithIntegration(session,{key:'calendar_integration',value:'calcom'});
    if(!config.setting.enabled||routing.length!==1||routing[0]!==input.workspaceId){await setRecordingState(c,row.id,'manual',config.setting.enabled?'routing_ambiguous':'disabled');return null;}
    const at=(await session.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0]!.at;
    const effectiveAt=new Date(Math.max(at.getTime(),Date.parse(input.now())));
    const deadline=row.deadline_at??new Date(Math.min(job.first_claimed_at.getTime()+7200000,Date.parse(target.startsAt)));
    const attempts=Math.max(row.attempts,job.attempt_count);
    if(!Number.isFinite(effectiveAt.getTime())||effectiveAt>=deadline||attempts>4){await setRecordingState(c,row.id,'manual',attempts>4?'attempt_limit':'expired');return null;}
    await session.query(`UPDATE meeting_recording_setup SET first_attempt_at=COALESCE(first_attempt_at,$3),deadline_at=COALESCE(deadline_at,$4),attempts=$5,state='verifying',updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,[input.workspaceId,row.id,job.first_claimed_at,deadline,attempts]);
    return await work(c,{...row,attempts,deadline_at:deadline,first_attempt_at:row.first_attempt_at??job.first_claimed_at},effectiveAt.toISOString());
  });
}
function reasonOf(code:string):RecordingSetupReason {
  return ['auth_failed','rate_limited','booking_mismatch','zoom_mismatch'].includes(code)?code as RecordingSetupReason:'provider_unreachable';
}
async function failure(session:SessionQueryable,input:RecordingSetupRun,kind:'retry'|'refused',code:string,retryAfterMs:number|null):Promise<void> {
  const retry=await currentBoundary(session,input,async(c,row,at)=>{
    const next=new Date(Math.min(Date.parse(at)+Math.max(30000*2**(row.attempts-1),retryAfterMs??0),row.deadline_at!.getTime()));
    if(kind==='refused'||row.attempts>=4||next>=row.deadline_at!){await setRecordingState(c,row.id,'manual',kind==='refused'?reasonOf(code):row.attempts>=4?'attempt_limit':'expired');return false;}
    await c.db.query(`UPDATE meeting_recording_setup SET state='pending',reason=$3,next_attempt_at=$4,version=version+1 WHERE workspace_id=$1 AND id=$2`,[input.workspaceId,row.id,reasonOf(code),next]);
    // failJob changes run_at, not not_before, so Retry-After survives the runner's backoff.
    await c.db.query('UPDATE jobs SET not_before=$3 WHERE workspace_id=$1 AND id=$2',[input.workspaceId,input.jobId,next]);return true;
  });
  if(retry)throw new Error('meeting_recording_retry');
}
export async function runMeetingRecordingSetup(session:SessionQueryable,input:RecordingSetupRun):Promise<void> {
  const reserved=await currentBoundary(session,input,async(c,row,at)=>({row,at,setting:(await readMeetingAutoRecordingSetting(c)).setting,history:await recordingHistory(c,row),reused:await reusedRecordingZoomId(c,row.target)}));
  if(!reserved)return;
  const {row,setting}=reserved,signal=new AbortController().signal;
  const booking=await input.calcom.readBooking(row.target.bookingUid,signal);
  if(booking.kind!=='ok'){await failure(session,input,booking.kind,booking.code,booking.retryAfterMs);return;}
  const validationStartedAt=new Date().toISOString();
  const zoom=await input.zoom.readMeeting(row.target.zoomMeetingId,signal);
  if(zoom.kind!=='ok'){await failure(session,input,zoom.kind,zoom.code,zoom.retryAfterMs);return;}
  const eligible=recordingSetupEligibility({target:row.target,setting,booking:booking.value,zoom:zoom.value,at:input.now(),reusedZoomId:reserved.reused});
  if(!eligible.ok){await currentBoundary(session,input,async(c,r)=>await setRecordingState(c,r.id,'manual',eligible.reason));return;}
  const ready=async(readStartedAt:string)=>await currentBoundary(session,input,async(c,r,at)=>{
    // This readback settles only intents that existed before its provider read began.
    await c.db.query(`UPDATE meeting_recording_setup SET reconciled_at=$3 WHERE workspace_id=$1 AND meeting_id=$2 AND target->>'zoomMeetingId'=$4 AND write_intent_at<=$5 AND reconciled_at IS NULL AND write_certainty IN ('intent','unknown','acknowledged')`,[input.workspaceId,r.meeting_id,at,r.target.zoomMeetingId,readStartedAt]);
    await c.db.query(`UPDATE meeting_recording_setup SET state='ready',reason=NULL,verified_at=$3,version=version+1,write_certainty=CASE WHEN write_intent_at IS NOT NULL THEN 'acknowledged' ELSE write_certainty END,applied_by_us=applied_by_us OR write_intent_at IS NOT NULL WHERE workspace_id=$1 AND id=$2`,[input.workspaceId,r.id,at]);
  });
  if(eligible.action==='observe'){await ready(validationStartedAt);return;}
  if(reserved.history.uncertain||reserved.history.changed&&!row.explicit_retry){await currentBoundary(session,input,async(c,r)=>await setRecordingState(c,r.id,'manual',reserved.history.uncertain?'ambiguous_write':'manual_override'));return;}
  const intent=await currentBoundary(session,input,async(c,r,at)=>{
    if((await recordingHistory(c,r)).uncertain||await reusedRecordingZoomId(c,r.target))return false;
    await c.db.query(`UPDATE meeting_recording_setup SET write_intent_at=$3,write_owner_token=$4::bigint,write_job_id=$5,write_certainty='intent',previous_mode='none',version=version+1 WHERE workspace_id=$1 AND id=$2`,[input.workspaceId,r.id,at,input.fencingToken,input.jobId]);return true;
  });
  if(!intent)return;
  const write=await currentBoundary(session,input,async(c,r):Promise<ZoomWriteResult|null>=>{
    if(r.write_owner_token!==input.fencingToken||r.write_job_id!==input.jobId||r.write_certainty!=='intent'||await reusedRecordingZoomId(c,r.target))return null;
    const result=await input.zoom.setLocalAutoRecording(r.target.zoomMeetingId,signal);
    await c.db.query('UPDATE meeting_recording_setup SET write_certainty=$3,applied_by_us=applied_by_us OR $4,version=version+1 WHERE workspace_id=$1 AND id=$2',[input.workspaceId,r.id,result.kind,result.kind==='acknowledged']);
    return result;
  });
  if(!write)return;
  if(write.kind==='refused'){
    await failure(session,input,['auth_failed','provider_refused','zoom_mismatch'].includes(write.code??'')?'refused':'retry',write.code??'provider_refused',write.retryAfterMs);return;
  }
  const readbackStartedAt=new Date().toISOString();
  const observed=await input.zoom.readMeeting(row.target.zoomMeetingId,signal);
  if(observed.kind!=='ok'){await failure(session,input,observed.kind,observed.code,observed.retryAfterMs);return;}
  const checked=recordingSetupEligibility({target:row.target,setting,booking:booking.value,zoom:observed.value,at:input.now(),reusedZoomId:reserved.reused});
  if(checked.ok&&checked.action==='observe')await ready(readbackStartedAt);
  else await currentBoundary(session,input,async(c,r)=>await setRecordingState(c,r.id,'manual','ambiguous_write'));
}
export { readMeetingRecordingSetup,retryMeetingRecordingSetup } from './autoRecordingView.ts';

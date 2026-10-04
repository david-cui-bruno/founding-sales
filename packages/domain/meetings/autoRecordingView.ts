import type { MeetingRecordingSetupView } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { lockAnalysisMeeting } from './analysisRequests.ts';
import { readMeetingAutoRecordingConfiguration } from './autoRecordingSettings.ts';
import { currentRecordingTarget, type RecordingSetupRow } from './autoRecordingState.ts';
import { lockCalendarRoutingForRead } from '../policy/calendarRouting.ts';
import { lockSendGateForDispatch } from '../policy/sendGate.ts';
import { lockSettingForRead } from '../settings/store.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import { recordingSetupTargetHash } from './autoRecordingEligibility.ts';
import { enqueueJob } from '../jobs/jobStore.ts';
import type { MeetingResult } from './outcomeTypes.ts';
export async function readMeetingRecordingSetup(context:RepositoryContext,input:{meetingId:string}):Promise<MeetingRecordingSetupView|null> {
  if(await lockAnalysisMeeting(context,input.meetingId)===null)return null;
  const config=await readMeetingAutoRecordingConfiguration(context),target=await currentRecordingTarget(context,input.meetingId,config.version);
  const row=(await context.db.query<RecordingSetupRow>('SELECT * FROM meeting_recording_setup WHERE workspace_id=$1 AND meeting_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',[context.scope.workspaceId,input.meetingId])).rows[0];
  const previouslyEnabled=(await context.db.query('SELECT 1 FROM meeting_recording_setup WHERE workspace_id=$1 AND meeting_id=$2 AND (applied_by_us OR verified_at IS NOT NULL) LIMIT 1',[context.scope.workspaceId,input.meetingId])).rows.length>0;
  if(context.scope.actor.kind==='user'&&context.scope.actor.role==='admin')await recordCrmAuditEvent(context,{action:'meeting.recording_setup_read',subjectKind:'meeting',subjectId:input.meetingId});
  const current=target!==null&&row?.target_hash===recordingSetupTargetHash(target);
  return {meetingId:input.meetingId,operationId:row?.id??null,version:row?.version??0,state:!config.setting.enabled?'disabled':target===null?'not_applicable':row===undefined?'pending':current?row.state:'obsolete',reason:!config.setting.enabled?'disabled':row?.reason??null,checkedAt:row?.verified_at?.toISOString()??null,previouslyEnabled,
    canRetry:config.setting.enabled&&config.configured.ready&&target!==null&&Date.parse(target.startsAt)>Date.now()&&row!==undefined&&['manual','obsolete'].includes(row.state)};
}
export async function retryMeetingRecordingSetup(context:RepositoryContext,input:{meetingId:string;expectedVersion:number;at:string}):Promise<MeetingResult<MeetingRecordingSetupView>> {
  await lockCalendarRoutingForRead(context.db);await lockSendGateForDispatch(context);await lockSettingForRead(context,'meeting_auto_recording');
  const view=await readMeetingRecordingSetup(context,input);if(view===null)return {ok:false,reason:'meeting_unknown'};
  if(view.version!==input.expectedVersion||!view.canRetry)return {ok:false,reason:'recording_setup_changed'};
  const config=await readMeetingAutoRecordingConfiguration(context),target=await currentRecordingTarget(context,input.meetingId,config.version);if(!target||Date.parse(target.startsAt)<=Date.parse(input.at))return {ok:false,reason:'recording_setup_changed'};
  const hash=recordingSetupTargetHash(target);
  const next=(await context.db.query<{generation:number}>('SELECT COALESCE(MAX(retry_generation),0)+1 AS generation FROM meeting_recording_setup WHERE workspace_id=$1 AND meeting_id=$2 AND target_hash=$3',[context.scope.workspaceId,input.meetingId,hash])).rows[0]!.generation;
  const created=(await context.db.query<{id:string}>(`INSERT INTO meeting_recording_setup(workspace_id,meeting_id,target,target_hash,retry_generation,next_attempt_at,explicit_retry,version) VALUES($1,$2,$3::jsonb,$4,$5,$6,true,(SELECT COALESCE(MAX(version),0)+1 FROM meeting_recording_setup WHERE workspace_id=$1 AND meeting_id=$2)) RETURNING id`,[context.scope.workspaceId,input.meetingId,JSON.stringify(target),hash,next,input.at])).rows[0]!.id;
  await enqueueJob(context.db,{workspaceId:context.scope.workspaceId,kind:'meeting.recording_setup',idempotencyKey:`meeting-recording:${created}`,payload:{operationId:created},maxAttempts:4});
  await recordCrmAuditEvent(context,{action:'meeting.recording_setup_retry',subjectKind:'meeting',subjectId:input.meetingId,detail:{operationId:created,generation:next}});
  return {ok:true,value:(await readMeetingRecordingSetup(context,input))!};
}

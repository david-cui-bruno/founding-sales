import type { RecordingSetupReason, RecordingSetupState } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { attendeeAddressOf } from './attendee.ts';
import type { RecordingSetupTarget } from './autoRecordingTypes.ts';
export interface RecordingSetupRow {
  [key:string]:unknown;
  id:string;meeting_id:string;target:RecordingSetupTarget;target_hash:string;version:number;retry_generation:number;explicit_retry:boolean;
  state:RecordingSetupState;reason:RecordingSetupReason|null;attempts:number;first_attempt_at:Date|null;deadline_at:Date|null;next_attempt_at:Date;
  write_intent_at:Date|null;write_owner_token:string|null;write_job_id:string|null;write_certainty:'none'|'intent'|'acknowledged'|'refused'|'unknown';
  previous_mode:string|null;verified_at:Date|null;reconciled_at:Date|null;applied_by_us:boolean;
}
export async function readRecordingOperation(context:RepositoryContext,id:string,lock=false):Promise<RecordingSetupRow|null> {
  return (await context.db.query<RecordingSetupRow>(`SELECT * FROM meeting_recording_setup WHERE workspace_id=$1 AND id=$2${lock?' FOR UPDATE':''}`,[context.scope.workspaceId,id])).rows[0]??null;
}
export async function currentRecordingTarget(context:RepositoryContext,meetingId:string,settingsVersion:number):Promise<RecordingSetupTarget|null> {
  const r=(await context.db.query<{firm_id:string|null;contact_id:string|null;current_booking_uid:string;zoom_meeting_id:string|null;attendee_email:string|null;organizer_email:string|null;starts_at:Date;ends_at:Date;state:string}>(`SELECT m.* FROM meetings m JOIN firms f ON f.workspace_id=m.workspace_id AND f.id=m.firm_id AND f.status='active' WHERE m.workspace_id=$1 AND m.id=$2`,[context.scope.workspaceId,meetingId])).rows[0];
  if(!r||!r.firm_id||!r.zoom_meeting_id||!['booked','rescheduled'].includes(r.state))return null;
  const attendeeEmail=attendeeAddressOf(r.attendee_email),organizerEmail=attendeeAddressOf(r.organizer_email);if(!attendeeEmail||!organizerEmail)return null;
  return {workspaceId:context.scope.workspaceId,meetingId,firmId:r.firm_id,contactId:r.contact_id,bookingUid:r.current_booking_uid,zoomMeetingId:r.zoom_meeting_id,attendeeEmail,organizerEmail,startsAt:r.starts_at.toISOString(),endsAt:r.ends_at.toISOString(),settingsVersion};
}
export async function recordingHistory(context:RepositoryContext,row:RecordingSetupRow):Promise<{uncertain:boolean;changed:boolean}> {
  const rows=(await context.db.query<{write_certainty:string;applied_by_us:boolean;verified_at:Date|null;reconciled_at:Date|null}>(`SELECT write_certainty,applied_by_us,verified_at,reconciled_at FROM meeting_recording_setup WHERE workspace_id=$1 AND meeting_id=$2 AND target->>'zoomMeetingId'=$3`,[context.scope.workspaceId,row.meeting_id,row.target.zoomMeetingId])).rows;
  return {uncertain:rows.some(r=>r.verified_at===null&&r.reconciled_at===null&&['intent','unknown','acknowledged'].includes(r.write_certainty)),changed:rows.some(r=>r.applied_by_us||r.verified_at!==null)};
}
export async function reusedRecordingZoomId(context:RepositoryContext,target:RecordingSetupTarget):Promise<boolean> {
  return (await context.db.query('SELECT 1 FROM meetings WHERE workspace_id=$1 AND id<>$2 AND zoom_meeting_id=$3 LIMIT 1',[context.scope.workspaceId,target.meetingId,target.zoomMeetingId])).rows.length>0;
}
export async function setRecordingState(context:RepositoryContext,id:string,state:RecordingSetupState,reason:RecordingSetupReason|null):Promise<void> {
  await context.db.query('UPDATE meeting_recording_setup SET state=$3,reason=$4,version=version+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2',[context.scope.workspaceId,id,state,reason]);
}

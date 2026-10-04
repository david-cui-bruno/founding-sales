import type { RecordingSetupReason } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
export async function invalidateMeetingRecordingSetup(context:RepositoryContext,input:{meetingId:string;reason:RecordingSetupReason;at:string}):Promise<void> {
  await context.db.query(`UPDATE meeting_recording_setup SET state='obsolete',reason=$3,version=version+1,updated_at=$4 WHERE workspace_id=$1 AND meeting_id=$2 AND state<>'obsolete'`,[context.scope.workspaceId,input.meetingId,input.reason,input.at]);
}
export async function foldMeetingRecordingSetup(context:RepositoryContext,input:{sourceMeetingId:string;targetMeetingId:string;at:string}):Promise<void> {
  // Target hashes include the original meeting ID; preserving it avoids collisions and retains uncertain effects.
  await invalidateMeetingRecordingSetup(context,{meetingId:input.sourceMeetingId,reason:'target_changed',at:input.at});
  await invalidateMeetingRecordingSetup(context,{meetingId:input.targetMeetingId,reason:'target_changed',at:input.at});
  await context.db.query('UPDATE meeting_recording_setup SET meeting_id=$3 WHERE workspace_id=$1 AND meeting_id=$2',[context.scope.workspaceId,input.sourceMeetingId,input.targetMeetingId]);
}

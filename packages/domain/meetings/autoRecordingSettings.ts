import { HEARTBEAT_GRACE_SECONDS } from '../jobs/heartbeats.ts';
import { workspacesWithIntegration } from '../settings/integrations.ts';
import { DEFAULT_MEETING_AUTO_RECORDING, meetingAutoRecordingSettingSchema, type MeetingAutoRecordingSetting } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { readSetting } from '../settings/store.ts';
export async function readMeetingAutoRecordingSetting(context:RepositoryContext):Promise<{setting:MeetingAutoRecordingSetting;version:number}> {
  const row=await readSetting(context,'meeting_auto_recording'); const parsed=meetingAutoRecordingSettingSchema.safeParse(row.value);
  return {setting:parsed.success?parsed.data:{...DEFAULT_MEETING_AUTO_RECORDING},version:row.version};
}

/** Read worker capabilities without exposing worker-only credentials. */
export async function readMeetingAutoRecordingConfiguration(context:RepositoryContext) {
  const config=await readMeetingAutoRecordingSetting(context);
  const workerFresh=(await context.db.query<{ready:boolean}>(`SELECT EXISTS(SELECT 1 FROM heartbeats WHERE component='worker' AND detail->>'meeting_recording_setup'='true' AND observed_at+make_interval(secs=>expected_interval_seconds+$1)>=now()) AS ready`,[HEARTBEAT_GRACE_SECONDS.worker])).rows[0]?.ready===true;
  const routing=await workspacesWithIntegration(context.db,{key:'calendar_integration',value:'calcom'});
  const restoring=(await context.db.query("SELECT 1 FROM active_holds WHERE workspace_id=$1 AND reason_code='restore_in_progress' AND released_at IS NULL LIMIT 1",[context.scope.workspaceId])).rows.length>0;
  return {...config,configured:{ready:workerFresh&&!restoring&&routing.length===1&&routing[0]===context.scope.workspaceId,workerFresh}};
}

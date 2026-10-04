import type { SessionQueryable } from '../db/queryable.ts';
import { repositoryContext,workspaceScope } from '../db/workspaceScope.ts';
import { lockCalendarRoutingForRead } from '../policy/calendarRouting.ts';
import { lockSendGateForStopFact } from '../policy/sendGate.ts';
import { lockSettingForRead } from '../settings/store.ts';
import { workspacesWithIntegration } from '../settings/integrations.ts';
import type { JobSpecification } from '../jobs/jobStore.ts';
import { currentRecordingTarget } from './autoRecordingState.ts';
import { recordingSetupTargetHash } from './autoRecordingEligibility.ts';
import { readMeetingAutoRecordingSetting } from './autoRecordingSettings.ts';
/** Called in the existing scheduler transaction. No provider calls; at most 20 new targets. */
export async function scheduleMeetingRecordingSetup(session:SessionQueryable,at:string,options:{providerConfigured:boolean}):Promise<readonly JobSpecification[]> {
  await lockCalendarRoutingForRead(session);
  const workspaces=(await session.query<{id:string}>(`SELECT DISTINCT workspace_id AS id FROM meeting_recording_setup WHERE state IN ('pending','verifying') UNION SELECT workspace_id AS id FROM workspace_settings WHERE setting_key='meeting_auto_recording' AND superseded_at IS NULL ORDER BY id`)).rows;
  const routing=await workspacesWithIntegration(session,{key:'calendar_integration',value:'calcom'}),jobs:JobSpecification[]=[];
  for(const workspace of workspaces){
    const c=repositoryContext(workspaceScope(workspace.id,{kind:'system',component:'scheduler'}),session);
    // Exclusive gate keeps expiry sweeps and materialization from crossing a worker boundary.
    await lockSendGateForStopFact(c);await lockSettingForRead(c,'meeting_auto_recording');
    await session.query(`UPDATE meeting_recording_setup o SET state='manual',reason=CASE WHEN COALESCE(o.deadline_at,j.first_claimed_at+interval '2 hours',(o.target->>'startsAt')::timestamptz)<=$2 OR (o.target->>'startsAt')::timestamptz<=$2 THEN 'expired' ELSE 'attempt_limit' END,version=o.version+1,updated_at=$2
      FROM jobs j WHERE o.workspace_id=$1 AND o.state IN ('pending','verifying') AND j.workspace_id=o.workspace_id AND j.kind='meeting.recording_setup' AND j.payload->>'operationId'=o.id::text
      AND (COALESCE(o.deadline_at,j.first_claimed_at+interval '2 hours',(o.target->>'startsAt')::timestamptz)<=$2 OR (o.target->>'startsAt')::timestamptz<=$2 OR (j.attempt_count>=4 AND (j.state<>'running' OR j.lease_expires_at<=$2)))`,[workspace.id,at]);
    const config=await readMeetingAutoRecordingSetting(c);
    if(!options.providerConfigured||!config.setting.enabled||routing.length!==1||routing[0]!==workspace.id||jobs.length>=20)continue;
    const candidates=(await session.query<{id:string}>(`SELECT m.id FROM meetings m JOIN firms f ON f.workspace_id=m.workspace_id AND f.id=m.firm_id
      WHERE m.workspace_id=$1 AND f.status='active' AND m.state IN ('booked','rescheduled') AND m.starts_at>$2 AND m.starts_at<=$2::timestamptz+interval '60 days'
      AND m.zoom_meeting_id IS NOT NULL AND m.attendee_email IS NOT NULL AND m.organizer_email IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM meeting_recording_setup o WHERE o.workspace_id=m.workspace_id AND o.meeting_id=m.id AND o.state<>'obsolete' AND o.target->>'meetingId'=m.id::text
        AND o.target->>'firmId'=m.firm_id::text AND (o.target->>'contactId') IS NOT DISTINCT FROM m.contact_id::text
        AND o.target->>'bookingUid'=m.current_booking_uid AND o.target->>'zoomMeetingId'=m.zoom_meeting_id
        AND o.target->>'attendeeEmail'=m.attendee_email AND o.target->>'organizerEmail'=m.organizer_email
        AND (o.target->>'startsAt')::timestamptz=m.starts_at AND (o.target->>'endsAt')::timestamptz=m.ends_at AND o.target->>'settingsVersion'=$3)
      ORDER BY m.starts_at,m.id LIMIT $4`,[workspace.id,at,String(config.version),20-jobs.length])).rows;
    for(const candidate of candidates){
      const target=await currentRecordingTarget(c,candidate.id,config.version);if(!target)continue;
      const inserted=(await session.query<{id:string}>(`INSERT INTO meeting_recording_setup(workspace_id,meeting_id,target,target_hash,next_attempt_at,retry_generation,version) VALUES($1,$2,$3::jsonb,$4,$5,(SELECT COALESCE(MAX(retry_generation),-1)+1 FROM meeting_recording_setup WHERE workspace_id=$1 AND meeting_id=$2 AND target_hash=$4),(SELECT COALESCE(MAX(version),0)+1 FROM meeting_recording_setup WHERE workspace_id=$1 AND meeting_id=$2)) ON CONFLICT(workspace_id,meeting_id,target_hash,retry_generation) DO NOTHING RETURNING id`,[workspace.id,candidate.id,JSON.stringify(target),recordingSetupTargetHash(target),at])).rows[0];
      if(inserted)jobs.push({workspaceId:workspace.id,kind:'meeting.recording_setup',idempotencyKey:`meeting-recording:${inserted.id}`,payload:{operationId:inserted.id},maxAttempts:4});
    }
  }
  return jobs;
}

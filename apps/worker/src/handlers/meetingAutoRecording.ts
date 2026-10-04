import { scheduleMeetingRecordingSetup } from '@fss/domain/meetings/autoRecordingJobs.ts';
import type { DueWorkSource } from '../scheduler/schedulerPass.ts';
import type { JobHandler } from '@fss/domain/jobs/handlerRegistry.ts';
import { runMeetingRecordingSetup } from '@fss/domain/meetings/autoRecording.ts';
import type { CalcomDemoClient, ZoomMeetingsClient } from '@fss/domain/meetings/autoRecordingTypes.ts';
export function meetingAutoRecordingJobHandler(options:{calcom:CalcomDemoClient;zoom:ZoomMeetingsClient;now?:()=>string}):JobHandler {
  return {kind:'meeting.recording_setup',protection:'outbound_fence',maxAttempts:4,leaseSeconds:90,async handle(input){
    const operationId=input.job.payload['operationId'];if(typeof operationId!=='string'||!/^[a-f0-9-]{36}$/u.test(operationId))return;
    await runMeetingRecordingSetup(input.session,{workspaceId:input.scope.workspaceId,operationId,jobId:input.job.id,fencingToken:input.job.fencingToken,...options,now:options.now??(()=>new Date().toISOString())});
  }};
}

export function meetingAutoRecordingSource(enabled:boolean):DueWorkSource {return {name:'meeting-recording-setup',find:async(session,at)=>await scheduleMeetingRecordingSetup(session,at,{providerConfigured:enabled})};}

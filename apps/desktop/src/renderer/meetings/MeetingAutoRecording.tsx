import {useEffect,useRef,type JSX} from 'react';
import type {MeetingRecordingSetupView} from '@fss/contracts';
import {Button} from '../ui/button.tsx';
import {noDefiniteAnswer} from '../today/afterCallModel.ts';
import {useRecordingSetupMemory} from './autoRecordingMemory.ts';
export interface RecordingSetupPorts {
  read(id:string):Promise<{view:MeetingRecordingSetupView|null;reason:string|null}>;
  retry(input:{meetingId:string;expectedVersion:number;commandId:string}):Promise<{view:MeetingRecordingSetupView|null;reason:string|null}>;
}
const defaults:RecordingSetupPorts={
  read:async meetingId=>await globalThis.callieApi?.read('meetings.recordingSetup',{meetingId})??{view:null,reason:'unavailable'},
  retry:async input=>await globalThis.callieApi?.command('meetings.retryRecordingSetup',input)??{view:null,reason:'offline'},
};
const reasons:Record<string,string>={
  disabled:'Automatic demo recording is off in Settings.',unconfigured:'Connect the meeting services in Settings.',routing_ambiguous:'The booking calendar needs to be matched to this workspace.',
  booking_mismatch:'The booking does not match the configured Callie demo.',zoom_mismatch:'Zoom’s meeting details do not match the booking.',unsupported_meeting:'This meeting cannot be configured automatically.',
  unsupported_recording_mode:'Zoom has a different recording setting. Check it in Zoom.',provider_refused:'The meeting service did not allow this change.',provider_unreachable:'The meeting service could not be reached.',
  auth_failed:'Reconnect the meeting service in Settings.',rate_limited:'The meeting service asked Callie to wait.',ambiguous_write:'The result of an earlier change is uncertain. Retry checks Zoom before doing anything else.',
  manual_override:'The recording setting changed after setup. Retry may enable it again.',target_changed:'The booking changed. Check the current meeting before retrying.',expired:'Automatic setup ran out of time.',attempt_limit:'Automatic setup could not finish after four attempts.',not_future:'The meeting has already started.',
};
export function MeetingAutoRecording({meetingId,ports=defaults,actionsEnabled=true}:{meetingId:string;ports?:RecordingSetupPorts;actionsEnabled?:boolean}):JSX.Element|null {
  const {entry,touch}=useRecordingSetupMemory(meetingId),port=useRef(ports);port.current=ports;
  useEffect(()=>{const generation=++entry.generation;void port.current.read(meetingId).then(answer=>{if(generation!==entry.generation)return;if(answer.view?.meetingId===meetingId)entry.view=answer.view;else if(answer.reason==='not_found')entry.view=null;touch();}).catch(()=>{});},[entry,meetingId,touch]);
  const view=entry.view;if(!view||view.meetingId!==meetingId)return null;
  const label=view.state==='ready'?'Auto-recording set':['pending','verifying'].includes(view.state)?'Setting up auto-recording':'Start recording manually';
  const retry=async()=>{
    if(entry.busy||!actionsEnabled||!view.canRetry&&entry.pending===null)return;
    entry.pending??={meetingId,expectedVersion:view.version,commandId:crypto.randomUUID()};const command=entry.pending;
    entry.busy=true;entry.message=null;++entry.generation;touch();
    try{
      const answer=await port.current.retry(command);
      if(answer.view?.meetingId===meetingId){entry.view=answer.view;entry.pending=null;}
      else if(noDefiniteAnswer(answer.reason))entry.message='The answer was lost. Retry uses the same request.';
      else{entry.pending=null;entry.message='The meeting changed. Refresh its details before trying again.';}
    }catch{entry.message='The answer was lost. Retry uses the same request.';}
    finally{entry.busy=false;touch();}
  };
  return <div className="min-w-0 text-xs text-muted-foreground" data-testid="meeting-auto-recording">
    <Button size="sm" variant="quiet" aria-expanded={entry.open} onClick={()=>{entry.open=!entry.open;touch();}}>{label}</Button>
    {entry.open?<div className="space-y-2 px-3 pb-3">
      <p>{view.state==='ready'?'Zoom is set to record locally when you host from its desktop app.':reasons[view.reason??'']??'Press Record in Zoom if automatic setup is unavailable.'}</p>
      {view.checkedAt?<p>Checked {new Date(view.checkedAt).toLocaleString()}</p>:null}
      {view.previouslyEnabled&&view.state!=='ready'?<p>Recording was previously enabled. Check the old meeting’s setting if you reuse its link.</p>:null}
      {view.canRetry||entry.pending!==null?<Button size="sm" variant="outline" disabled={entry.busy||!actionsEnabled} onClick={()=>{void retry();}}>Retry recording setup</Button>:null}
      {entry.message?<p role="status">{entry.message}</p>:null}
    </div>:null}
  </div>;
}

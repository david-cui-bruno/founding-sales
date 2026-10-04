// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import type {MeetingRecordingSetupView} from '@fss/contracts';
import {MeetingAutoRecording,type RecordingSetupPorts} from '../src/renderer/meetings/MeetingAutoRecording.tsx';
import {DraftsProvider} from '../src/renderer/app/drafts.tsx';
const id='00000000-0000-4000-8000-000000000001';
const view=(state:MeetingRecordingSetupView['state']='ready'):MeetingRecordingSetupView=>({meetingId:id,operationId:id,version:1,state,reason:state==='manual'?'provider_unreachable':null,checkedAt:null,canRetry:state==='manual',previouslyEnabled:false});
afterEach(cleanup);
it('reports a setting, never claims a completed recording',async()=>{
  render(<DraftsProvider><MeetingAutoRecording meetingId={id} ports={{read:async()=>({view:view(),reason:null}),retry:async()=>({view:null,reason:'offline'})}}/></DraftsProvider>);
  expect(await screen.findByText('Auto-recording set')).toBeTruthy();expect(screen.queryByText('Recording complete')).toBeNull();
});
it('late_response_cannot_change_another_meeting',async()=>{
  let finish!:(v:Awaited<ReturnType<RecordingSetupPorts['read']>>)=>void;
  const ports:RecordingSetupPorts={read:()=>new Promise(r=>{finish=r;}),retry:async()=>({view:null,reason:'offline'})};
  const {rerender}=render(<DraftsProvider><MeetingAutoRecording meetingId={id} ports={ports}/></DraftsProvider>);const old=finish;
  rerender(<DraftsProvider><MeetingAutoRecording meetingId="00000000-0000-4000-8000-000000000002" ports={ports}/></DraftsProvider>);
  await act(async()=>{old({view:view(),reason:null});});expect(screen.queryByText('Auto-recording set')).toBeNull();
});
it('retains the command identity across an unanswered retry and navigation',async()=>{
  const attempts:string[]=[];const ports:RecordingSetupPorts={read:async()=>({view:view('manual'),reason:null}),retry:vi.fn(async input=>{attempts.push(input.commandId);return {view:null,reason:'offline'};})};
  const {rerender}=render(<DraftsProvider><MeetingAutoRecording meetingId={id} ports={ports}/></DraftsProvider>);
  fireEvent.click(await screen.findByRole('button',{name:'Start recording manually'}));fireEvent.click(screen.getByRole('button',{name:'Retry recording setup'}));await waitFor(()=>expect(attempts).toHaveLength(1));
  rerender(<DraftsProvider><span>Other page</span></DraftsProvider>);rerender(<DraftsProvider><MeetingAutoRecording meetingId={id} ports={ports}/></DraftsProvider>);
  fireEvent.click(await screen.findByRole('button',{name:'Retry recording setup'}));await waitFor(()=>expect(attempts).toHaveLength(2));expect(attempts[1]).toBe(attempts[0]);
});

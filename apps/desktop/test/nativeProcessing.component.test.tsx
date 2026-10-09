// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {MeetingTranscript} from '../src/renderer/meetings/MeetingTranscript.tsx';
import {TranscriptDisclosure} from '../src/renderer/calling/CallHistory.tsx';
import {transcriptPage,MID} from './support/meetingTranscriptFixture.ts';
import type {CanonicalSourceReference} from '@fss/contracts';
const source:CanonicalSourceReference={workspaceId:'11111111-1111-4111-8111-111111111111',sourceId:'22222222-2222-4222-8222-222222222222',kind:'meeting_transcript',revision:1,contentHash:'a'.repeat(64),locator:null,speaker:null,occurredAt:null,observedAt:'2026-10-01T14:00:00Z',completeness:'partial',availability:'available'};
const health=vi.fn(async(input:{sourceId:string})=>({sourceId:input.sourceId,sourceRevision:1,availability:'available' as const,generations:[],truncated:false,unknownAcceptance:true}));
const processing={health,request:async()=>{throw new Error('Unknown provider acceptance forbids retry');}};
afterEach(()=>{cleanup();health.mockClear();});
it('shows persistent evidence processing on the existing meeting transcript',async()=>{
 const page={...transcriptPage(),processingSources:[source],processingSourcesTruncated:false};
 render(<MeetingTranscript meetingId={MID} processing={processing} ports={{read:async()=>({page,reason:null}),reupload:async()=>({status:'resumed'}),chooseFile:async()=>({status:'cancelled'})}}/>);
 fireEvent.click(screen.getByRole('button',{name:'Transcript'}));
 expect(await screen.findByText('Provider acceptance is unknown. Another attempt is blocked.')).toBeTruthy();
 expect(health).toHaveBeenCalledWith({sourceId:source.sourceId,kind:'meeting_transcript'});
});
it('shows persistent evidence processing on the existing call transcript',async()=>{
 const callSource={...source,kind:'call_transcript' as const};
 const view=render(<TranscriptDisclosure callSessionId={source.sourceId} processing={processing} read={async()=>({transcript:{callSessionId:source.sourceId,provider:'deepgram',model:'fixture',language:'en',durationSeconds:1,createdAt:source.observedAt,utterances:[{speaker:0,start:0,end:1,text:'Exact speech.'}],processingSource:callSource},reason:null})}/>);
 const details=view.container.querySelector('details')!;details.open=true;fireEvent(details,new Event('toggle'));
 expect(await screen.findByText('Provider acceptance is unknown. Another attempt is blocked.')).toBeTruthy();
 expect(health).toHaveBeenCalledWith({sourceId:source.sourceId,kind:'call_transcript'});
});

// @vitest-environment jsdom
import {cleanup,render,screen} from '@testing-library/react';
import {afterEach,expect,it} from 'vitest';
import {MeetingTranscript} from '../src/renderer/meetings/MeetingTranscript.tsx';
import {transcriptPage,MID} from './support/meetingTranscriptFixture.ts';
const sourceId='22222222-2222-4222-8222-222222222222';
afterEach(cleanup);
it('keeps a deleted native transcript payment blocker on its existing record without loading deleted text',async()=>{
 render(<MeetingTranscript meetingId={MID} recordHealth={{read:async()=>({sources:[{sourceId,sourceRevision:1,availability:'deleted',generations:[],truncated:false,unknownAcceptance:true}],truncated:false})}} ports={{read:async()=>({page:transcriptPage(),reason:null}),reupload:async()=>({status:'resumed'}),chooseFile:async()=>({status:'cancelled'})}}/>);
 expect(await screen.findByText('Provider acceptance is unknown. Another attempt is blocked.')).toBeTruthy();
 expect(screen.queryByText('Exact deleted transcript.')).toBeNull();
});

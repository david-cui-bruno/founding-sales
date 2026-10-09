// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {DraftsProvider} from '../src/renderer/app/drafts.tsx';
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
 const view=render(<DraftsProvider><TranscriptDisclosure callSessionId={source.sourceId} processing={processing} read={async()=>({transcript:{callSessionId:source.sourceId,provider:'deepgram',model:'fixture',language:'en',durationSeconds:1,createdAt:source.observedAt,utterances:[{speaker:0,start:0,end:1,text:'Exact speech.'}],processingSource:callSource},reason:null})}/></DraftsProvider>);
 const details=view.container.querySelector('details')!;details.open=true;fireEvent(details,new Event('toggle'));
 expect(await screen.findByText('Provider acceptance is unknown. Another attempt is blocked.')).toBeTruthy();
 expect(health).toHaveBeenCalledWith({sourceId:source.sourceId,kind:'call_transcript'});
});
it('uses actual mounted record task context for evidence support and never infers a task from the call session',async()=>{
 const task={kind:'call_task' as const,id:'33333333-3333-4333-8333-333333333333'};
 const callSource={...source,kind:'call_transcript' as const};
 const claim={claimId:source.sourceId,claimRevision:1 as const,claimHash:'b'.repeat(64),contextHash:'c'.repeat(64),semanticHash:'d'.repeat(64),context:{personId:null,firmIds:[source.workspaceId],relationships:[],review:'current' as const},kind:'need' as const,interpretation:'Needs help',status:'inferred' as const,quote:'Exact speech.',source:callSource,anchorId:null,decisionRevision:0,reviewRequired:false,effectiveState:'unreviewed' as const,decision:null,decisionHistory:[],decisionHistoryTruncated:false};
 const bind=vi.fn(async()=>({dependencyId:source.sourceId,revision:1}));
 const processing={health,request:async()=>{},evidence:{read:async()=>({source:callSource,claims:[claim],reviewedHistory:[],nextAfterClaimId:null,nextAfterReviewedAnchorId:null,projection:{scope:'bounded_source_page' as const,counts:{current:1,reviewedHistory:0,confirmed:0,dismissed:0,corrected:0,unreviewed:1,reviewRequired:0},truncated:false,revisionFingerprint:'e'.repeat(64)}}),workRead:async()=>({work:{...task,version:'2026-10-09T11:00:00Z',status:'open' as const,completedAt:null},dependencies:[],nextAfterDependencyId:null}),workBind:bind}};
 const view=render(<DraftsProvider><TranscriptDisclosure callSessionId={source.sourceId} workContexts={[task]} processing={processing} read={async()=>({transcript:{callSessionId:source.sourceId,provider:'deepgram',model:'fixture',language:'en',durationSeconds:1,createdAt:source.observedAt,utterances:[{speaker:0,start:0,end:1,text:'Exact speech.'}],processingSource:callSource},reason:null})}/></DraftsProvider>);
 const details=view.container.querySelector('details')!;details.open=true;fireEvent(details,new Event('toggle'));
 fireEvent.click(await screen.findByRole('button',{name:'Review evidence 1'}));fireEvent.click(await screen.findByRole('button',{name:'Support existing task 1 with interpretation 1'}));
 await waitFor(()=>expect(bind).toHaveBeenCalledWith(expect.objectContaining({work:{...task,expectedVersion:'2026-10-09T11:00:00Z'}})));
});
it('reads actual meeting outcome task IDs before offering source support and fetches the exact current version at binding',async()=>{
 const taskId='33333333-3333-4333-8333-333333333333';const page={...transcriptPage(),processingSources:[source],processingSourcesTruncated:false};
 const claim={claimId:source.sourceId,claimRevision:1 as const,claimHash:'b'.repeat(64),contextHash:'c'.repeat(64),semanticHash:'d'.repeat(64),context:{personId:null,firmIds:[source.workspaceId],relationships:[],review:'current' as const},kind:'need' as const,interpretation:'Needs help',status:'inferred' as const,quote:'Meeting passage',source,anchorId:null,decisionRevision:0,reviewRequired:false,effectiveState:'unreviewed' as const,decision:null,decisionHistory:[],decisionHistoryTruncated:false};
 const bind=vi.fn(async()=>({dependencyId:source.sourceId,revision:1}));const tasks=vi.fn(async(meetingId:string)=>{expect(meetingId).toBe(MID);return [{id:taskId,meetingId:MID,version:2}];});
 const processing={health,request:async()=>{},evidence:{read:async()=>({source,claims:[claim],reviewedHistory:[],nextAfterClaimId:null,nextAfterReviewedAnchorId:null,projection:{scope:'bounded_source_page' as const,counts:{current:1,reviewedHistory:0,confirmed:0,dismissed:0,corrected:0,unreviewed:1,reviewRequired:0},truncated:false,revisionFingerprint:'e'.repeat(64)}}),workRead:async()=>({work:{kind:'meeting_task' as const,id:taskId,version:'3',status:'open' as const,completedAt:null},dependencies:[],nextAfterDependencyId:null}),workBind:bind}};
 render(<DraftsProvider><MeetingTranscript meetingId={MID} processing={processing} ports={{read:async()=>({page,reason:null}),tasks,reupload:async()=>({status:'resumed'}),chooseFile:async()=>({status:'cancelled'})}}/></DraftsProvider>);
 fireEvent.click(screen.getByRole('button',{name:'Transcript'}));fireEvent.click(await screen.findByRole('button',{name:'Review evidence 1'}));fireEvent.click(await screen.findByRole('button',{name:'Support existing task 1 with interpretation 1'}));
 await waitFor(()=>expect(bind).toHaveBeenCalledWith(expect.objectContaining({work:{kind:'meeting_task',id:taskId,expectedVersion:'3'}})));
});
it('offers the actual meeting record processing-source choices for explicit comparison without inventing source identities',async()=>{
 const second={...source,sourceId:'33333333-3333-4333-8333-333333333333',revision:2,contentHash:'f'.repeat(64)};const page={...transcriptPage(),processingSources:[source,second],processingSourcesTruncated:false};
 const read=vi.fn(async(input:{source:{sourceId:string}})=>({source:input.source.sourceId===source.sourceId?source:second,claims:[],reviewedHistory:[],nextAfterClaimId:null,nextAfterReviewedAnchorId:null,projection:{scope:'bounded_source_page' as const,counts:{current:0,reviewedHistory:0,confirmed:0,dismissed:0,corrected:0,unreviewed:0,reviewRequired:0},truncated:false,revisionFingerprint:'e'.repeat(64)}}));
 render(<DraftsProvider><MeetingTranscript meetingId={MID} processing={{health,request:async()=>{},evidence:{read}}} ports={{read:async()=>({page,reason:null}),reupload:async()=>({status:'resumed'}),chooseFile:async()=>({status:'cancelled'})}}/></DraftsProvider>);fireEvent.click(screen.getByRole('button',{name:'Transcript'}));const panes=await screen.findAllByRole('region',{name:'Evidence review'});fireEvent.click(within(panes[0]!).getByRole('button',{name:'Review evidence 2'}));await waitFor(()=>expect(read).toHaveBeenCalledWith({source:{workspaceId:second.workspaceId,sourceId:second.sourceId,kind:second.kind,revision:2,contentHash:'f'.repeat(64),locator:null},limit:50}));
});

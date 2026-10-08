// @vitest-environment jsdom
import { act,cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react';
import { afterEach,expect,it,vi } from 'vitest';
import { MeetingFollowThrough,type FollowThroughPorts } from '../src/renderer/meetings/MeetingFollowThrough.tsx';
import { DraftsProvider } from '../src/renderer/app/drafts.tsx';
import { followThroughView } from './support/meetingFollowThroughFixture.ts';
import { MID } from './support/meetingTranscriptFixture.ts';
afterEach(cleanup);
const ports=():FollowThroughPorts=>({read:vi.fn(async()=>({view:followThroughView(),reason:null})),edit:vi.fn(async()=>({view:{...followThroughView(),version:2,currentDraft:{...followThroughView().currentDraft!,state:'editing' as const}},reason:null}))});
const open=()=>fireEvent.click(screen.getByRole('button',{name:'Follow-up'}));
it('shows a paused draft without a countdown and collapses on second click',async()=>{
  render(<DraftsProvider><MeetingFollowThrough meetingId={MID} ports={ports()} /></DraftsProvider>);open();
  expect(await screen.findByText('Sending paused')).toBeTruthy();expect(screen.queryByText(/sending in/i)).toBeNull();
  expect(screen.getByText('Our maintenance discussion')).toBeTruthy();open();expect(screen.queryByText('Our maintenance discussion')).toBeNull();
});
it('waits for the durable edit hold, retains the draft across navigation and clears it on a new session',async()=>{
  const p=ports();let finish!:(value:Awaited<ReturnType<FollowThroughPorts['edit']>>)=>void;
  p.edit=vi.fn<FollowThroughPorts['edit']>(()=>new Promise(resolve=>{finish=resolve;}));
  const {rerender}=render(<DraftsProvider key="session"><MeetingFollowThrough meetingId={MID} ports={p}/></DraftsProvider>);open();
  fireEvent.click(await screen.findByRole('button',{name:'Edit recap'}));expect(screen.queryByLabelText('Recap message')).toBeNull();
  await act(async()=>{finish({view:{...followThroughView(),version:2,currentDraft:{...followThroughView().currentDraft!,state:'editing'}},reason:null});});
  fireEvent.change(screen.getByLabelText('Recap message'),{target:{value:'Keep this draft'}});
  rerender(<DraftsProvider key="session"><span>Other page</span></DraftsProvider>);
  rerender(<DraftsProvider key="session"><MeetingFollowThrough meetingId={MID} ports={p}/></DraftsProvider>);
  expect((await screen.findByLabelText('Recap message') as HTMLTextAreaElement).value).toBe('Keep this draft');
  rerender(<DraftsProvider key="new-session"><MeetingFollowThrough meetingId={MID} ports={p}/></DraftsProvider>);expect(screen.queryByDisplayValue('Keep this draft')).toBeNull();
});
it('retries a lost edit command with the same identity and keeps source-conflicting text',async()=>{
  const p=ports();p.edit=vi.fn().mockRejectedValueOnce(new Error('lost')).mockResolvedValueOnce({view:{...followThroughView(),version:2,currentDraft:{...followThroughView().currentDraft!,state:'editing'}},reason:null}).mockResolvedValueOnce({view:null,reason:'source_changed'});
  render(<DraftsProvider><MeetingFollowThrough meetingId={MID} ports={p}/></DraftsProvider>);open();
  fireEvent.click(await screen.findByRole('button',{name:'Edit recap'}));fireEvent.click(await screen.findByRole('button',{name:'Retry action'}));
  const input=await screen.findByLabelText('Recap message');expect(p.edit).toHaveBeenNthCalledWith(2,vi.mocked(p.edit).mock.calls[0]![0]);
  fireEvent.change(input,{target:{value:'My correction'}});fireEvent.click(screen.getByRole('button',{name:'Save recap'}));
  await waitFor(()=>expect(screen.getByText(/changed.*draft is kept/i)).toBeTruthy());expect((screen.getByLabelText('Recap message') as HTMLTextAreaElement).value).toBe('My correction');
});
it.each(['submitted','sent'] as const)('can cancel future work without editing a %s message',async state=>{
  const p=ports();p.read=vi.fn(async()=>({view:{...followThroughView(),sendingPaused:false,blockers:[],currentDraft:{...followThroughView().currentDraft!,state}},reason:null}));
  render(<DraftsProvider><MeetingFollowThrough meetingId={MID} ports={p}/></DraftsProvider>);open();
  await screen.findByText(state==='sent'?'Recap sent':'Delivery in progress');expect(screen.queryByRole('button',{name:'Edit recap'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Cancel future follow-ups'}));
  await waitFor(()=>expect(p.edit).toHaveBeenCalledWith(expect.objectContaining({action:'cancel'})));
});
it('shows shared fact versions and approves the exact displayed plan only on click',async()=>{
 const p=ports();p.read=vi.fn<FollowThroughPorts['read']>(async()=>({view:{...followThroughView(),approvalRequired:true,approvalHash:'a'.repeat(64),approvedAt:null,facts:[{id:MID,version:2,kind:'product',text:'Callie coordinates maintenance.',approvedAt:'2026-10-08T12:00:00Z',retiredAt:null}]},reason:null}));
 p.edit=vi.fn(async()=>({view:{...followThroughView(),version:2,approvalRequired:false,approvedAt:'2026-10-08T12:00:00Z'},reason:null}));
 render(<DraftsProvider><MeetingFollowThrough meetingId={MID} ports={p}/></DraftsProvider>);open();
 expect(await screen.findByText('Callie coordinates maintenance.')).toBeTruthy();expect(p.edit).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'Approve recap and plan'}));
 await waitFor(()=>expect(p.edit).toHaveBeenCalledWith(expect.objectContaining({action:'approve',planId:followThroughView().planId,expectedPlanVersion:1,expectedDraftVersion:1})));
 expect(await screen.findByText('Recap and follow-up plan approved.')).toBeTruthy();
});
it('offers approval of remaining follow-up after a recorded sent recap without offering edits',async()=>{
 const p=ports();const base=followThroughView();
 p.read=vi.fn<FollowThroughPorts['read']>(async()=>({view:{...base,approvalRequired:true,approvalHash:'a'.repeat(64),currentDraft:{...base.currentDraft!,state:'sent'},sentMessages:[{ordinal:1,messageId:MID,sentAt:'2026-10-08T12:00:00Z'}],plannedMessages:[{ordinal:2,subject:'Checking in',body:'Any useful next step?'}]},reason:null}));
 p.edit=vi.fn<FollowThroughPorts['edit']>(async()=>({view:{...base,approvalRequired:false,currentDraft:{...base.currentDraft!,state:'sent'}},reason:null}));
 render(<DraftsProvider><MeetingFollowThrough meetingId={MID} ports={p}/></DraftsProvider>);open();
 const approve=await screen.findByRole('button',{name:'Approve remaining follow-up plan'});expect(screen.queryByRole('button',{name:'Edit recap'})).toBeNull();expect(p.edit).not.toHaveBeenCalled();
 fireEvent.click(approve);await waitFor(()=>expect(p.edit).toHaveBeenCalledWith(expect.objectContaining({action:'approve',expectedApprovalHash:'a'.repeat(64)})));
 expect(await screen.findByText('Remaining follow-up plan approved.')).toBeTruthy();
});

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { meetingUnpublishedPlanSchema, type MeetingFollowThroughViewV2 } from '@fss/contracts';
import { DraftsProvider } from '../src/renderer/app/drafts.tsx';
import { UnpublishedPlan, type UnpublishedSave } from '../src/renderer/meetings/UnpublishedPlan.tsx';
import { followThroughView } from './support/meetingFollowThroughFixture.ts';
afterEach(cleanup);
it('saves human-entered known notes and retains blank/unknown drafts without approval or due dates',async()=>{
  let view:MeetingFollowThroughViewV2=followThroughView();
  const save=vi.fn<UnpublishedSave>(async input=>{
    view={...view,version:view.version+1,unpublishedPlan:meetingUnpublishedPlanSchema.parse({schemaVersion:1,state:'unpublished',cadence:'post_demo_3_7_14',sourceHash:input.expectedSourceHash,notesRevision:input.expectedNotesRevision,revision:1,savedAt:'2026-10-20T23:00:00Z',messages:input.messages.map((m,i)=>({...m,ordinal:i+1,elapsedDays:[0,3,7,14][i],held:true,unknownFields:[]}))})};
    return {view,reason:null};
  });
  const {rerender}=render(<DraftsProvider key="one"><UnpublishedPlan view={view} onSaved={vi.fn()} save={save}/></DraftsProvider>);
  expect((screen.getByLabelText('Draft 1 message') as HTMLTextAreaElement).value).toBe('');
  fireEvent.change(screen.getByLabelText('Draft 1 message'),{target:{value:'Known fixture note. Next date {day}.'}});
  fireEvent.click(screen.getByRole('button',{name:'Save unpublished drafts'}));
  expect(await screen.findByText('Four unpublished drafts saved. All remain held. Nothing was scheduled or sent.')).toBeTruthy();
  expect(save).toHaveBeenCalledWith(expect.objectContaining({messages:[{subject:'',body:'Known fixture note. Next date {day}.'},{subject:'',body:''},{subject:'',body:''},{subject:'',body:''}]}));
  rerender(<DraftsProvider key="new-session"><UnpublishedPlan view={view} onSaved={vi.fn()} save={save}/></DraftsProvider>);
  expect((screen.getByLabelText('Draft 1 message') as HTMLTextAreaElement).value).toBe('Known fixture note. Next date {day}.');
  expect(screen.getByText('Day 3 draft')).toBeTruthy();expect(screen.getByText('Day 7 draft')).toBeTruthy();expect(screen.getByText('Day 14 draft')).toBeTruthy();
  expect(screen.queryByRole('button',{name:/^(approve|enroll|publish|send)\b/i})).toBeNull();
});
it('retains lost request identity and unsaved text across navigation but not a new owner session',async()=>{
  const view=followThroughView(), save=vi.fn<UnpublishedSave>().mockRejectedValueOnce(new Error('lost')).mockResolvedValue({view:null,reason:'source_changed'});
  const {rerender}=render(<DraftsProvider key="one"><UnpublishedPlan view={view} onSaved={vi.fn()} save={save}/></DraftsProvider>);
  fireEvent.change(screen.getByLabelText('Draft 2 message'),{target:{value:'Human fixture text'}});
  fireEvent.click(screen.getByRole('button',{name:'Save unpublished drafts'}));
  await screen.findByRole('button',{name:'Retry draft save'});
  rerender(<DraftsProvider key="one"><span>Other page</span></DraftsProvider>);
  rerender(<DraftsProvider key="one"><UnpublishedPlan view={view} onSaved={vi.fn()} save={save}/></DraftsProvider>);
  expect((screen.getByLabelText('Draft 2 message') as HTMLTextAreaElement).value).toBe('Human fixture text');
  fireEvent.click(screen.getByRole('button',{name:'Retry draft save'}));
  await waitFor(()=>expect(save).toHaveBeenCalledTimes(2));expect(save.mock.calls[1]![0]).toEqual(save.mock.calls[0]![0]);
  expect(await screen.findByText(/Meeting notes changed/)).toBeTruthy();
  expect((screen.getByLabelText('Draft 2 message') as HTMLTextAreaElement).value).toBe('Human fixture text');
  rerender(<DraftsProvider key="two"><UnpublishedPlan view={view} onSaved={vi.fn()} save={save}/></DraftsProvider>);
  expect((screen.getByLabelText('Draft 2 message') as HTMLTextAreaElement).value).toBe('');
});
it.each(['cancelled','completed'] as const)('never reopens a %s plan',status=>{
  const save=vi.fn<UnpublishedSave>();
  render(<DraftsProvider><UnpublishedPlan view={{...followThroughView(),status}} onSaved={vi.fn()} save={save}/></DraftsProvider>);
  expect((screen.getByRole('button',{name:'Save unpublished drafts'}) as HTMLButtonElement).disabled).toBe(true);
  expect(save).not.toHaveBeenCalled();
});
it('refuses stale notes then explicitly rebases preserved typed text to refreshed canonical notes',async()=>{
  const original:MeetingFollowThroughViewV2={...followThroughView(),draftSource:{sourceHash:'a'.repeat(64),notesRevision:1}};
  const save=vi.fn<UnpublishedSave>().mockResolvedValueOnce({view:null,reason:'source_changed'}).mockResolvedValue({view:null,reason:'draft_changed'});
  const onSaved=vi.fn();
  const {rerender}=render(<DraftsProvider><UnpublishedPlan view={original} onSaved={onSaved} save={save}/></DraftsProvider>);
  fireEvent.change(screen.getByLabelText('Draft 1 message'),{target:{value:'Preserved human text {date}'}});
  fireEvent.click(screen.getByRole('button',{name:'Save unpublished drafts'}));
  await screen.findByText(/Meeting notes changed/);
  const refreshed={...original,draftSource:{sourceHash:'b'.repeat(64),notesRevision:2}};
  rerender(<DraftsProvider><UnpublishedPlan view={refreshed} onSaved={onSaved} save={save}/></DraftsProvider>);
  expect((screen.getByRole('button',{name:'Save unpublished drafts'}) as HTMLButtonElement).disabled).toBe(true);
  expect(save).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button',{name:'I reviewed current notes. Keep text and rebase drafts'}));
  expect((screen.getByLabelText('Draft 1 message') as HTMLTextAreaElement).value).toBe('Preserved human text {date}');
  fireEvent.click(screen.getByRole('button',{name:'Save unpublished drafts'}));
  await waitFor(()=>expect(save).toHaveBeenCalledTimes(2));
  expect(save.mock.calls[1]![0]).toMatchObject({expectedSourceHash:'b'.repeat(64),expectedNotesRevision:2,messages:[{subject:'',body:'Preserved human text {date}'},{subject:'',body:''},{subject:'',body:''},{subject:'',body:''}]});
  expect(save.mock.calls[1]![0].commandId).not.toBe(save.mock.calls[0]![0].commandId);
});

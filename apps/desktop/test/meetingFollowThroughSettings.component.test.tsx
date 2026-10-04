// @vitest-environment jsdom
import { cleanup,fireEvent,render,screen } from '@testing-library/react';
import { afterEach,expect,it,vi } from 'vitest';
import { MeetingFollowThroughSection } from '../src/renderer/settings/MeetingFollowThroughSection.tsx';
import { DraftsProvider } from '../src/renderer/app/drafts.tsx';
import { RID } from './support/meetingTranscriptFixture.ts';
afterEach(cleanup);
it('requires an explicit approved sequence choice and saves only its ID',()=>{
  const save=vi.fn();render(<DraftsProvider><MeetingFollowThroughSection configuration={{setting:{sequenceVersionId:null},choices:[{id:RID(1),label:'Demo recap · version 1'}]}} editable busy={false} onSave={save}/></DraftsProvider>);
  expect((screen.getByRole('button',{name:'Save recap sequence'}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Recap sequence'),{target:{value:RID(1)}});fireEvent.click(screen.getByRole('button',{name:'Save recap sequence'}));
  expect(save).toHaveBeenCalledWith({sequenceVersionId:RID(1)});
});
it('explains how to prepare the first template without choosing one automatically',()=>{
  render(<DraftsProvider><MeetingFollowThroughSection configuration={{setting:{sequenceVersionId:null},choices:[]}} editable busy={false} onSave={vi.fn()}/></DraftsProvider>);
  expect(screen.getByText(/Create and publish/)).toBeTruthy();
});

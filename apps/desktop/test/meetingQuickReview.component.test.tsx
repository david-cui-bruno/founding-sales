// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DraftsProvider } from '../src/renderer/app/drafts.tsx';
import { MeetingOutcomes, type OutcomesPorts } from '../src/renderer/meetings/MeetingOutcomes.tsx';
import { outcomesView } from './support/meetingOutcomesFixture.ts';
import { MID } from './support/meetingTranscriptFixture.ts';
afterEach(cleanup);
it('asks only missing supported facts and saves unknowns as partial notes without confirming attendance', async () => {
  const view = outcomesView();
  view.attendance = 'unconfirmed'; view.notes.sufficient = false;
  view.items.push({ ...view.items[0]!, id: 'workflow', kind: 'workflow', text: 'The office logs maintenance requests by phone.' });
  const ports: OutcomesPorts = {
    read: vi.fn(async () => ({ view, reason: null })),
    save: vi.fn(async input => ({ notes: { ...view.notes, ...input, revision: 2 }, reason: null })),
    changeTask: vi.fn(async () => ({ task: null, reason: 'unavailable' })),
  };
  render(<DraftsProvider><MeetingOutcomes meetingId={MID} ports={ports} /></DraftsProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Notes & tasks' }));
  expect(await screen.findByRole('region', { name: 'Quick post-call review' })).toBeTruthy();
  expect(screen.queryByText('What is their current workflow?')).toBeNull();
  expect(screen.queryByText('What did each person commit to?')).toBeNull();
  expect(screen.getByText('What problem matters most to them?')).toBeTruthy();
  expect(screen.getByText(/Attendance is unconfirmed/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Leave next step unknown' }));
  expect((screen.getByLabelText('Your notes') as HTMLTextAreaElement).value).toBe('I will send the setup guide tomorrow.\n\nNext step: unknown.');
  fireEvent.click(screen.getByRole('button', { name: 'Save notes' }));
  await waitFor(() => expect(ports.save).toHaveBeenCalledWith(expect.objectContaining({ meetingId: MID, sufficient: false, itemOverrides: [], debrief: 'I will send the setup guide tomorrow.\n\nNext step: unknown.' })));
  expect(ports.changeTask).not.toHaveBeenCalled();
});

it('keeps supported partial facts distinct from inference and asks again when sources become stale', async () => {
  const view = outcomesView('partial');
  view.items.push({ ...view.items[0]!, id: 'workflow', kind: 'workflow', text: 'A paper maintenance log.' });
  view.items.push({ ...view.items[0]!, id: 'need', kind: 'need', provenance: 'inferred', text: 'Maybe they need faster replies.' });
  const ports: OutcomesPorts = {
    read: vi.fn(async () => ({ view: { ...view }, reason: null })),
    save: vi.fn(async () => ({ notes: null, reason: 'offline' })),
    changeTask: vi.fn(async () => ({ task: null, reason: 'unavailable' })),
  };
  render(<DraftsProvider><MeetingOutcomes meetingId={MID} ports={ports} /></DraftsProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Notes & tasks' }));
  await screen.findByRole('region', { name: 'Quick post-call review' });
  expect(screen.queryByText('What is their current workflow?')).toBeNull();
  expect(screen.getByText('What problem matters most to them?')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Your notes'), { target: { value: 'Still deciding. No promise yet.' } });
  view.state = 'stale'; view.sourceHash = 'b'.repeat(64);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh notes' }));
  expect(await screen.findByText('What is their current workflow?')).toBeTruthy();
  expect(screen.getByText(/Sources changed/)).toBeTruthy();
  expect((screen.getByLabelText('Your notes') as HTMLTextAreaElement).value).toBe('Still deciding. No promise yet.');
  expect(ports.save).not.toHaveBeenCalled();
});

it('leaves unknown answers incomplete and retains them only for this meeting and session on return', async () => {
  const view = outcomesView();
  const ports: OutcomesPorts = {
    read: vi.fn(async meetingId => ({ view: { ...view, meetingId, notes: { ...view.notes, meetingId } }, reason: null })),
    save: vi.fn(async () => ({ notes: null, reason: 'offline' })),
    changeTask: vi.fn(async () => ({ task: null, reason: 'unavailable' })),
  };
  const { rerender } = render(<DraftsProvider key="one"><MeetingOutcomes meetingId={MID} ports={ports} /></DraftsProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Notes & tasks' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Leave next step unknown' }));
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  rerender(<DraftsProvider key="one"><span>Another page</span></DraftsProvider>);
  rerender(<DraftsProvider key="one"><MeetingOutcomes meetingId={MID} ports={ports} /></DraftsProvider>);
  expect(await screen.findByText('Left unknown in your notes')).toBeTruthy();
  expect((screen.getByLabelText('Your notes') as HTMLTextAreaElement).value).toContain('Next step: unknown.');
  rerender(<DraftsProvider key="one"><MeetingOutcomes meetingId="00000000-0000-4000-8000-000000000099" ports={ports} /></DraftsProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Notes & tasks' }));
  await screen.findByRole('button', { name: 'Leave next step unknown' });
  expect((screen.getByLabelText('Your notes') as HTMLTextAreaElement).value).not.toContain('Next step: unknown.');
  rerender(<DraftsProvider key="two"><MeetingOutcomes meetingId={MID} ports={ports} /></DraftsProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Notes & tasks' }));
  await screen.findByRole('button', { name: 'Leave next step unknown' });
  expect((screen.getByLabelText('Your notes') as HTMLTextAreaElement).value).not.toContain('Next step: unknown.');
  expect(ports.save).not.toHaveBeenCalled();
});

it('does not ask for conversation facts after a confirmed no-show', async () => {
  const view = outcomesView(); view.attendance = 'no_show'; view.items = [];
  const ports: OutcomesPorts = {
    read: vi.fn(async () => ({ view, reason: null })),
    save: vi.fn(async () => ({ notes: null, reason: 'offline' })),
    changeTask: vi.fn(async () => ({ task: null, reason: 'unavailable' })),
  };
  render(<DraftsProvider><MeetingOutcomes meetingId={MID} ports={ports} /></DraftsProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Notes & tasks' }));
  await screen.findByRole('region', { name: 'Quick post-call review' });
  expect(screen.queryByText('What is their current workflow?')).toBeNull();
  expect(screen.getByText('No conversation facts are required for a no-show or cancelled meeting. You can still add notes below.')).toBeTruthy();
  expect(screen.getByLabelText('Your notes')).toBeTruthy();
  expect(ports.save).not.toHaveBeenCalled();
});

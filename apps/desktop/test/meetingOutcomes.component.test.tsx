// @vitest-environment jsdom
import { TaskRow } from '../src/renderer/today/TaskRow.tsx';
import type { TodayActions } from '../src/renderer/today/useToday.ts';
import type { TaskView } from '../src/renderer/todayView.ts';
import type { TodayState } from '../src/renderer/todayContract.ts';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MeetingOutcomes, type OutcomesPorts } from '../src/renderer/meetings/MeetingOutcomes.tsx';
import { DraftsProvider } from '../src/renderer/app/drafts.tsx';
import { outcomesView } from './support/meetingOutcomesFixture.ts';
import { MID, RID } from './support/meetingTranscriptFixture.ts';
afterEach(cleanup);
const ports = (): OutcomesPorts => ({ read: vi.fn(async () => ({ view: outcomesView(), reason: null })), save: vi.fn(async input => ({ notes: { ...outcomesView().notes, ...input, revision: input.expectedRevision + 1 }, reason: null })), changeTask: vi.fn(async input => ({ task: { ...outcomesView().tasks[0]!, status: 'done' as const, version: input.expectedVersion + 1 }, reason: null })) });
const open = () => fireEvent.click(screen.getByRole('button', { name: 'Notes & tasks' }));
it('keeps unsaved notes through navigation, collapses on second click, clears on a new session', async () => {
  const p = ports();
  const { rerender } = render(<DraftsProvider key="session"><MeetingOutcomes meetingId={MID} ports={p} /></DraftsProvider>); open();
  const input = await screen.findByLabelText('Your notes'); fireEvent.change(input, { target: { value: 'Unsaved notes' } });
  open(); expect(screen.queryByLabelText('Your notes')).toBeNull(); open(); expect((screen.getByLabelText('Your notes') as HTMLTextAreaElement).value).toBe('Unsaved notes');
  rerender(<DraftsProvider key="session"><span>Other page</span></DraftsProvider>);
  rerender(<DraftsProvider key="session"><MeetingOutcomes meetingId={MID} ports={p} /></DraftsProvider>);
  expect((await screen.findByLabelText('Your notes') as HTMLTextAreaElement).value).toBe('Unsaved notes');
  rerender(<DraftsProvider key="different"><MeetingOutcomes meetingId={MID} ports={p} /></DraftsProvider>);
  expect(screen.queryByLabelText('Your notes')).toBeNull();
});
it('uses the task version, not the call task command, and keeps evidence inert', async () => {
  const p = ports(), view = outcomesView(); view.items[0]!.evidence[0]!.quote = '<script>bad()</script>';
  p.read = vi.fn(async () => ({ view, reason: null }));
  const { container } = render(<DraftsProvider><MeetingOutcomes meetingId={MID} ports={p} /></DraftsProvider>); open();
  fireEvent.click(await screen.findByRole('button', { name: 'Complete Send the setup guide' }));
  await waitFor(() => expect(p.changeTask).toHaveBeenCalledWith(expect.objectContaining({ taskId: RID(10), expectedVersion: 1, action: 'complete' })));
  fireEvent.click(screen.getByRole('button', { name: 'Evidence' }));
  expect(screen.getByText('<script>bad()</script>')).toBeTruthy(); expect(container.querySelector('script')).toBeNull();
});
it('retries a lost save with the same command and retains edits made during that save', async () => {
  const p = ports(); let finish!: (value: Awaited<ReturnType<OutcomesPorts['save']>>) => void;
  p.save = vi.fn().mockRejectedValueOnce(new Error('lost')).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  render(<DraftsProvider><MeetingOutcomes meetingId={MID} ports={p} /></DraftsProvider>); open();
  fireEvent.change(await screen.findByLabelText('Your notes'), { target: { value: 'First edit' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save notes' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Retry save' }));
  fireEvent.change(screen.getByLabelText('Your notes'), { target: { value: 'Newer edit' } });
  await act(async () => { finish({ notes: { ...outcomesView().notes, debrief: 'First edit', revision: 2 }, reason: null }); });
  expect(p.save).toHaveBeenNthCalledWith(2, vi.mocked(p.save).mock.calls[0]![0]);
  expect((screen.getByLabelText('Your notes') as HTMLTextAreaElement).value).toBe('Newer edit');
});
it('retains conflicts and refuses another meeting or revoked read', async () => {
  const p = ports(); p.save = vi.fn(async () => ({ notes: null, reason: 'notes_changed' }));
  const { rerender } = render(<DraftsProvider><MeetingOutcomes meetingId={MID} ports={p} /></DraftsProvider>); open();
  fireEvent.change(await screen.findByLabelText('Your notes'), { target: { value: 'Keep this' } }); fireEvent.click(screen.getByRole('button', { name: 'Save notes' }));
  expect(await screen.findByText(/changed elsewhere/)).toBeTruthy(); expect((screen.getByLabelText('Your notes') as HTMLTextAreaElement).value).toBe('Keep this');
  rerender(<DraftsProvider><MeetingOutcomes meetingId={RID(20)} ports={p} /></DraftsProvider>); open();
  expect(await screen.findByText(/could not load/)).toBeTruthy(); expect(screen.queryByDisplayValue('Keep this')).toBeNull();
});

it('Today routes a meeting promise to its own command, never the call-task endpoint', async () => {
  const task = outcomesView().tasks[0]!;
  const command = vi.fn(async () => ({ task: { ...task, status: 'done' as const, version: 2 }, reason: null }));
  vi.stubGlobal('callieApi', { command });
  const completeTask = vi.fn(), expand = vi.fn();
  const actions = { completeTask, expand } as unknown as TodayActions;
  const entry = { task: { meetingTask: task } } as unknown as TaskView;
  render(<DraftsProvider><TaskRow entry={entry} state={{} as TodayState} actions={actions} actionsEnabled /></DraftsProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Complete Send the setup guide' }));
  await waitFor(() => expect(expand).toHaveBeenCalledWith(task.firmId));
  expect(command).toHaveBeenCalledWith('meetings.changeTask', expect.objectContaining({ taskId: task.id, action: 'complete', expectedVersion: 1 }));
  expect(completeTask).not.toHaveBeenCalled(); vi.unstubAllGlobals();
});

// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { NativeDeskRoute } from './NativeDeskRoute';
import { dailyFixture, nativeDeskFixture } from './nativeDesk.fixture';
import type { LocalWorkspaceSnapshot, LocalCommitmentsSnapshot } from '../../../shared/contracts/localWorkspaceContract';
afterEach(cleanup);
const local: LocalWorkspaceSnapshot = { scope: 'local_database', generatedAt: '2026-09-09T12:00:00.000Z', workflowMode: 'meeting_first', transitionReceipt: null, accounts: { state: 'available', snapshots: dailyFixture().accounts } };
const commitments: LocalCommitmentsSnapshot = { scope: 'local_database', generatedAt: local.generatedAt, revision: 1, reviewErrorCount: 0, items: [{ kind: 'callback', item: { id: 'cycle-retained', salesCycleId: 'cycle-retained', personId: 'person-retained', personName: 'Retained Person', contextLabel: 'Existing relationship', stage: 'interviewed', priorityContext: null, action: { id: 'action-retained', type: 'follow_up', channel: 'email', label: 'Send requested details', dueAt: local.generatedAt }, lane: 'later', reason: 'Recorded callback', activeTriggers: [], verifyFirst: false, pinned: false, consentRequirement: null, cloudScores: null } }] };
function fixture(scoped = false) {
  const f = nativeDeskFixture(scoped ? dailyFixture() : dailyFixture({ workspaceId: null, accounts: [], answers: [], calls: { accountIds: [], workloadConflict: false }, ownerStatus: [], transport: [], meetings: [], campaigns: [], issues: [{ code: 'scope_unknown', count: 1 }] }));
  const api = { ...f.api, localWorkspace: { get: vi.fn(async () => structuredClone(local)), getCommitments: vi.fn(async () => structuredClone(commitments)), transition: vi.fn() } };
  return { ...f, api };
}
it('puts typed retained work first in Calls, preserves non-call/later metadata and navigates only explicitly', async () => {
  const f = fixture(); const open = vi.fn(); render(<NativeDeskRoute api={f.api} onOpenLead={open} legacy={<p>Forbidden legacy</p>} />);
  const row = await screen.findByRole('button', { name: /Retained callback.*Retained Person/ });
  const calls = screen.getByRole('heading', { name: /^Calls/ }).closest('section')!;
  expect(within(calls).getAllByRole('button')[0]).toBe(row);
  fireEvent.click(row);
  expect(open).not.toHaveBeenCalled();
  expect(screen.getByText('Action type: follow_up · Channel: email · Lane: later')).toBeTruthy();
  expect(screen.queryByText('Forbidden legacy')).toBeNull();
  for (const text of [/Account call allocation is unavailable/, /Account approvals are unavailable/, /Account meetings are unavailable/]) expect(screen.getByText(text)).toBeTruthy();
  expect(f.calls.every(c => !/prepare|approve|begin|sync|forbidden/.test(c.method))).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Open contact workspace' }));
  expect(open).toHaveBeenCalledWith('person-retained');
});
it('keeps the local account library read-only and separate from unavailable worker scope', async () => {
  const f = fixture(); render(<NativeDeskRoute api={f.api} surface="accounts" onOpenLead={vi.fn()} />);
  await screen.findByRole('heading', { name: 'Local account library' });
  fireEvent.click(screen.getByRole('button', { name: 'Local account · Account A' }));
  expect(screen.getByRole('heading', { name: 'Account A' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Open contact workspace' })).toBeNull();
  expect((await f.api.daily.get()).accounts).toEqual([]);
  expect(f.calls.every(c => /daily.get|delegation.status/.test(c.method))).toBe(true);
});
it('retains stale commitments after failure, holds navigation and recovers without reselection', async () => {
  const f = fixture(); render(<NativeDeskRoute api={f.api} onOpenLead={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: /Retained callback/ }));
  f.api.localWorkspace.getCommitments.mockRejectedValueOnce(Error('private'));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await screen.findByText(/Retained work is stale/);
  expect((screen.getByRole('button', { name: 'Open contact workspace' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect((screen.getByRole('button', { name: 'Open contact workspace' }) as HTMLButtonElement).disabled).toBe(false));
});
it('preserves selected editor DOM and caret across independent local refresh', async () => {
  const f = fixture(true); render(<NativeDeskRoute api={f.api} onOpenLead={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Email · Account A' }));
  const editor = screen.getByLabelText('Email body') as HTMLTextAreaElement;
  editor.focus(); editor.setSelectionRange(3, 3);
  await act(async () => window.dispatchEvent(new Event('focus')));
  expect(screen.getByLabelText('Email body')).toBe(editor); expect(editor.selectionStart).toBe(3);
});
it('restores scope only after a delayed local mode read agrees, and preserves editor during mismatch', async () => {
  const f = fixture(true); const { captureDailySessionScope } = await import('./dailySessionScope');
  let resolve!: (snapshot: LocalWorkspaceSnapshot) => void;
  f.api.localWorkspace.get.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  render(<NativeDeskRoute api={f.api} onOpenLead={vi.fn()} legacy={<p>Forbidden legacy</p>} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Email · Account A' }));
  const editor = screen.getByLabelText('Email body');
  expect(() => captureDailySessionScope(f.api.delegation, 'ws')).toThrow();
  await act(async () => resolve(local));
  expect(() => captureDailySessionScope(f.api.delegation, 'ws')).not.toThrow();
  f.setSnapshot(dailyFixture({ workflowMode: 'legacy' }));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await screen.findByText(/Local workflow unavailable or inconsistent/);
  expect(screen.getByLabelText('Email body')).toBe(editor);
  expect(screen.queryByText('Forbidden legacy')).toBeNull();
  expect(() => captureDailySessionScope(f.api.delegation, 'ws')).toThrow();
});
it('keeps keyboard ordering aligned with retained-first rows and returns close focus to the exact row', async () => {
  const f = fixture(true); render(<NativeDeskRoute api={f.api} onOpenLead={vi.fn()} />);
  const row = await screen.findByRole('button', { name: /Retained callback/ });
  row.focus(); fireEvent.keyDown(row, { key: 'j' });
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Call · Account A' }));
  fireEvent.keyDown(document.activeElement!, { key: 'k' });
  expect(document.activeElement).toBe(row);
  fireEvent.keyDown(row, { key: 'Enter' });
  const close = screen.getByRole('button', { name: 'Close details' }); close.focus(); fireEvent.click(close);
  expect(document.activeElement).toBe(row);
});
it('distinguishes failed initial reads from successfully empty local work', async () => {
  const f = fixture(); f.api.localWorkspace.getCommitments.mockRejectedValueOnce(Error('private message'));
  render(<NativeDeskRoute api={f.api} onOpenLead={vi.fn()} />);
  await screen.findByText(/Retained work could not be checked/);
  expect(screen.queryByText(/No retained work due/)).toBeNull(); expect(screen.queryByText(/private message/)).toBeNull();
  f.api.localWorkspace.getCommitments.mockResolvedValue({ ...commitments, items: [] });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await screen.findByText('No retained work due in this local snapshot.');
});
it('keeps local retained work usable when daily fails or local overview is unavailable', async () => {
  const f = fixture(); f.api.daily.get = vi.fn(async () => { throw Error('daily unavailable'); });
  f.api.localWorkspace.get.mockRejectedValue(Error('overview unavailable'));
  const open = vi.fn(); render(<NativeDeskRoute api={f.api} onOpenLead={open} />);
  fireEvent.click(await screen.findByRole('button', { name: /Retained callback/ }));
  await screen.findByText(/Daily workspace unavailable/);
  fireEvent.click(screen.getByRole('button', { name: 'Open contact workspace' })); expect(open).toHaveBeenCalledWith('person-retained');
});
it('ignores a late old read after API replacement and never keeps old local evidence', async () => {
  const first = fixture(); const next = fixture();
  let resolve!: (snapshot: LocalCommitmentsSnapshot) => void;
  first.api.localWorkspace.getCommitments.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const view = render(<NativeDeskRoute api={first.api} onOpenLead={vi.fn()} />);
  await screen.findByRole('heading', { name: /^Calls/ });
  next.api.localWorkspace.getCommitments.mockResolvedValue({ ...commitments, items: [] });
  view.rerender(<NativeDeskRoute api={next.api} onOpenLead={vi.fn()} />);
  await screen.findByText('No retained work due in this local snapshot.');
  await act(async () => resolve(commitments));
  expect(screen.queryByRole('button', { name: /Retained callback/ })).toBeNull();
});
it('keeps newest local read when an earlier refresh resolves later and preserves removed selection honestly', async () => {
  const f = fixture(); render(<NativeDeskRoute api={f.api} onOpenLead={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: /Retained callback/ }));
  let resolve!: (snapshot: LocalCommitmentsSnapshot) => void;
  f.api.localWorkspace.getCommitments.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Refresh' })));
  f.api.localWorkspace.getCommitments.mockResolvedValue({ ...commitments, items: [] });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await screen.findByText('This item is no longer in the local queue.');
  await act(async () => resolve(commitments));
  expect(screen.queryByRole('button', { name: /Retained callback/ })).toBeNull();
});
it('shows unavailable accounts separately from a valid recorded transition', async () => {
  const f = fixture();
  f.api.localWorkspace.get.mockResolvedValue({ ...local, accounts: { state: 'unavailable', snapshots: [] }, transitionReceipt: { commandId: 'canonical', manifestId: 'manifest', mode: 'meeting_first', revision: 1, occurredAt: local.generatedAt, cancelledActionIds: [], stoppedEnrollmentIds: [], preservedActionIds: [], parkedPersonIds: [], callbackEvidenceIds: [], unknownDraftIds: [], parkedReviewActions: [], parkedActions: [] } });
  render(<NativeDeskRoute api={f.api} surface="accounts" onOpenLead={vi.fn()} />);
  await screen.findByText(/Local account library is unavailable/);
  expect(screen.queryByText('No local accounts in this snapshot.')).toBeNull();
  expect(screen.queryByText(/Local workflow unavailable or inconsistent/)).toBeNull();
});
it('keeps selected retained work when an initially failed daily read recovers', async () => {
  const f = fixture(); const daily = f.api.daily.get;
  f.api.daily.get = vi.fn().mockRejectedValueOnce(Error('unavailable')).mockImplementation(daily);
  render(<NativeDeskRoute api={f.api} onOpenLead={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: /Retained callback/ }));
  expect(screen.getByRole('region', { name: 'Retained work detail' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(screen.queryByText(/Daily workspace unavailable/)).toBeNull());
  expect(screen.getByRole('region', { name: 'Retained work detail' })).toBeTruthy();
});
it('labels retained personal detail as existing commitments rather than company context', async () => {
  const f = fixture(); render(<NativeDeskRoute api={f.api} onOpenLead={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: /Retained callback/ }));
  const bar = screen.getByRole('button', { name: 'Close details' }).parentElement!;
  expect(within(bar).getByText('Existing commitments and relationships')).toBeTruthy();
  expect(within(bar).queryByText('Company context')).toBeNull();
  const heading = screen.getByRole('heading', { name: /^Calls/ });
  expect(within(heading).getByText('Calls').classList.contains('native-desk__lane-label')).toBe(true);
});

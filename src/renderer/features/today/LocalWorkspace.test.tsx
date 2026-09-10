import { PresentationRoot } from '../../app/PresentationRoot';
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render as testingRender, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { NativeDeskRoute } from './NativeDeskRoute';
import { dailyFixture, nativeDeskFixture } from './nativeDesk.fixture';
import type { LocalWorkspaceSnapshot, LocalCommitmentsSnapshot, LocalCompanyDetail, LocalCompanyResearchStatus, SelectedResearch, LocalWorkspaceApi } from '../../../shared/contracts/localWorkspaceContract';
afterEach(cleanup);
const local: LocalWorkspaceSnapshot = { scope: 'local_database', generatedAt: '2026-09-09T12:00:00.000Z', workflowMode: 'meeting_first', transitionReceipt: null, accounts: { state: 'available', snapshots: dailyFixture().accounts } };
const retainedKinds: Array<[LocalCommitmentsSnapshot['items'][number]['kind'], string]> = [
  ['callback', 'Retained callback'],
  ['post_stage', 'Post-stage follow-through'],
  ['onboarding', 'Onboarding'],
  ['inbound_response', 'Inbound response'],
  ['warm_relationship', 'Existing relationship'],
  ['founder_resurface', 'Founder resurface'],
];
const commitments: LocalCommitmentsSnapshot = { scope: 'local_database', generatedAt: local.generatedAt, revision: 1, reviewErrorCount: 0, items: [{ kind: 'callback', item: { id: 'cycle-retained', salesCycleId: 'cycle-retained', personId: 'person-retained', personName: 'Retained Person', contextLabel: 'Existing relationship', stage: 'interviewed', priorityContext: null, action: { id: 'action-retained', type: 'follow_up', channel: 'email', label: 'Send requested details', dueAt: local.generatedAt }, lane: 'later', reason: 'Recorded callback', activeTriggers: [], verifyFirst: false, pinned: false, consentRequirement: null, cloudScores: null } }] };
const retainedTemplate = commitments.items[0].item;
const retainedChannels = ['email', 'call', 'onboarding', 'text', 'review', 'email'] as const;
const sixKindCommitments: LocalCommitmentsSnapshot = { scope: 'local_database', generatedAt: local.generatedAt, revision: 1, reviewErrorCount: 0, items: retainedKinds.map(([kind], index) => ({ kind, item: { ...retainedTemplate, id: `cycle-retained-${index}`, salesCycleId: `cycle-retained-${index}`, personId: `person-retained-${index}`, personName: `Retained Person ${index + 1}`, contextLabel: `Stored Company ${index + 1}`, reason: `Retained reason ${index + 1}`, action: { ...retainedTemplate.action, id: `action-retained-${index}`, label: `Retained action ${index + 1}`, channel: retainedChannels[index] } } })) };
function fixture(scoped = false) {
  const f = nativeDeskFixture(scoped ? dailyFixture() : dailyFixture({ workspaceId: null, accounts: [], answers: [], calls: { accountIds: [], workloadConflict: false }, ownerStatus: [], transport: [], meetings: [], campaigns: [], issues: [{ code: 'scope_unknown', count: 1 }] }));
  const api = { ...f.api, localWorkspace: { ...f.api.localWorkspace, get: vi.fn(async () => structuredClone(local)), getCommitments: vi.fn(async () => structuredClone(commitments)), transition: vi.fn() } };
  return { ...f, api };
}
it.each(['accounts', 'campaigns'] as const)('keeps the %s route identity and truthful status in settled legacy mode', async surface => {
  const f = fixture();
  f.setSnapshot({ ...await f.api.daily.get(), workflowMode: 'legacy' });
  f.api.localWorkspace.get.mockResolvedValue({ ...local, workflowMode: 'legacy' });
  render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} surface={surface} onOpenLead={vi.fn()} />);
  await screen.findByText(/Legacy workflow is active/);
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(surface === 'accounts' ? 'Accounts' : 'Campaigns');
  expect(screen.queryByText(/Workflow mode unavailable or inconsistent/)).toBeNull();
  expect(f.calls.every(c => /daily.get|delegation.status/.test(c.method))).toBe(true);
});
it.each(['accounts', 'campaigns'] as const)('keeps the %s route identity while unknown mode remains held', async surface => {
  const f = fixture();
  f.setSnapshot({ ...await f.api.daily.get(), workflowMode: 'unknown' });
  f.api.localWorkspace.get.mockResolvedValue({ ...local, workflowMode: 'legacy' });
  render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} surface={surface} onOpenLead={vi.fn()} />);
  await screen.findByText(/Workflow mode unavailable or inconsistent/);
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(surface === 'accounts' ? 'Accounts' : 'Campaigns');
  expect(screen.queryByText(/Legacy workflow is active/)).toBeNull();
  expect(f.calls.every(c => /daily.get|delegation.status/.test(c.method))).toBe(true);
});
it('puts typed retained work in Local commitments before worker Calls, preserving metadata and explicit navigation', async () => {
  const f = fixture(); f.api.localWorkspace.getCommitments.mockResolvedValue(sixKindCommitments); const open = vi.fn(); render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} onOpenLead={open} legacy={<p>Forbidden legacy</p>} />);
  const row = await screen.findByRole('button', { name: /Retained callback.*Retained Person 1/ });
  const localCommitments = screen.getByRole('heading', { name: /^Local commitments/ }).closest('section')!;
  const calls = screen.getByRole('heading', { name: /^Calls/ }).closest('section')!;
  expect(localCommitments.compareDocumentPosition(calls) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  for (const [, label] of retainedKinds) expect(within(localCommitments).getByRole('button', { name: new RegExp(label) })).toBeTruthy();
  expect(within(localCommitments).getByText('6')).toBeTruthy();
  expect(within(calls).queryByRole('button', { name: /Retained/ })).toBeNull();
  fireEvent.click(row);
  expect(open).not.toHaveBeenCalled();
  expect(screen.getByText('Action type: follow_up · Channel: email · Lane: later')).toBeTruthy();
  expect(screen.queryByText('Forbidden legacy')).toBeNull();
  expect(within(calls).getByText('Unavailable')).toBeTruthy();
  expect(screen.getByText('Worker unavailable')).toBeTruthy();
  expect(f.calls.every(c => !/prepare|approve|begin|sync|forbidden/.test(c.method))).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Open contact workspace' }));
  expect(open).toHaveBeenCalledWith('person-retained-0');
});
it('keeps the local account library read-only and separate from unavailable worker scope', async () => {
  const f = fixture(); const detailRead = vi.spyOn(f.api.localWorkspace, 'getCompany'); render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} surface="accounts" onOpenLead={vi.fn()} />);
  await screen.findByRole('heading', { name: 'Local account library' });
  fireEvent.click(screen.getByRole('button', { name: 'Local account · Account A' }));
  expect(screen.getByRole('heading', { name: 'Account A' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Open contact workspace' })).toBeNull();
  expect((await f.api.daily.get()).accounts).toEqual([]);
  await screen.findByText('Company evidence unavailable. Reopen this detail to check again.');
  expect(detailRead.mock.calls).toEqual([[{ accountId: 'a' }]]);
  expect(f.calls.every(c => ['daily.get', 'delegation.status', 'localWorkspace.getCompany'].includes(c.method))).toBe(true);
  expect(f.calls.filter(c => c.method === 'localWorkspace.getCompany')).toHaveLength(1);
});

it('preserves the exact six returned keys, mixed-channel details and cross-lane keyboard order', async () => {
  const f = fixture(true);
  f.api.localWorkspace.getCommitments.mockResolvedValue(sixKindCommitments);
  const open = vi.fn();
  render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} onOpenLead={open} />);
  await screen.findByRole('button', { name: /Retained callback.*Retained Person 1/ });
  const lane = screen.getByRole('heading', { name: /^Local commitments/ }).closest('section')!;
  const rows = within(lane).getAllByRole('button');
  const expectedKeys = sixKindCommitments.items.map(({ item }) => JSON.stringify(['retained', item.salesCycleId, item.action.id]));
  expect(rows.map(row => row.getAttribute('data-row-key'))).toEqual(expectedKeys);
  expect(new Set(expectedKeys).size).toBe(6);
  for (const [index, row] of rows.entries()) {
    const entry = sixKindCommitments.items[index];
    expect(row.querySelector('time')?.dateTime).toBe(entry.item.action.dueAt);
    fireEvent.click(row);
    const detail = screen.getByRole('region', { name: 'Retained work detail' });
    expect(within(detail).getByRole('heading', { name: entry.item.personName })).toBeTruthy();
    expect(within(detail).getByText(retainedKinds[index][1])).toBeTruthy();
    expect(within(detail).getByText(`Stored Company ${index + 1}`)).toBeTruthy();
    expect(within(detail).getByText(entry.item.reason)).toBeTruthy();
    expect(within(detail).getByText(`Action type: follow_up · Channel: ${retainedChannels[index]} · Lane: later`)).toBeTruthy();
    expect(detail.querySelector('time')?.dateTime).toBe(entry.item.action.dueAt);
    expect(open).toHaveBeenCalledTimes(index);
    fireEvent.click(within(detail).getByRole('button', { name: 'Open contact workspace' }));
    expect(open).toHaveBeenLastCalledWith(entry.item.personId);
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
    expect(document.activeElement).toBe(row);
  }
  fireEvent.keyDown(rows[5], { key: 'j' });
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Call · Account A' }));
  fireEvent.keyDown(document.activeElement!, { key: 'k' });
  expect(document.activeElement).toBe(rows[5]);
  expect(f.calls.every(call => /daily.get|delegation.status/.test(call.method))).toBe(true);
});

const countText = (label: string) => screen.getByRole('heading', { name: new RegExp(`^${label}`) }).querySelector('.native-desk__count')?.textContent;

for (const daily of ['ready', 'failed'] as const) for (const size of [0, 1] as const) for (const evidence of ['complete', 'partial', 'stale', 'stale_partial'] as const) {
  it(`keeps ${evidence} local count ${size} qualified during a real deferred refresh with daily ${daily}`, async () => {
    const f = fixture(true);
    if (daily === 'failed') f.api.daily.get = vi.fn(async () => { throw Error('Synthetic daily unavailable'); });
    const partial = evidence === 'partial' || evidence === 'stale_partial';
    const stale = evidence === 'stale' || evidence === 'stale_partial';
    const value: LocalCommitmentsSnapshot = { ...commitments, items: size ? commitments.items : [], reviewErrorCount: partial ? 1 : 0 };
    f.api.localWorkspace.getCommitments.mockResolvedValue(value);
    render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} onOpenLead={vi.fn()} />);
    const settled = partial ? `${size}+ · partial` : String(size);
    await waitFor(() => expect(countText('Local commitments')).toBe(settled));
    if (size) fireEvent.click(screen.getByRole('button', { name: /Retained callback/ }));
    if (stale) {
      f.api.localWorkspace.getCommitments.mockRejectedValueOnce(Error('Synthetic retained read failed'));
      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
      await waitFor(() => expect(countText('Local commitments')).toBe(`${size} · last known`));
    }
    const readsBefore = f.api.localWorkspace.getCommitments.mock.calls.length;
    let resolve!: (result: LocalCommitmentsSnapshot) => void;
    f.api.localWorkspace.getCommitments.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Refresh' })));
    expect(f.api.localWorkspace.getCommitments).toHaveBeenCalledTimes(readsBefore + 1);
    expect(countText('Local commitments')).toBe(stale ? `${size} · last known` : partial ? `${size}+ · partial` : `${size} · checking`);
    expect(screen.queryAllByRole('button', { name: /Retained callback/ })).toHaveLength(size);
    if (size) expect((screen.getByRole('button', { name: 'Open contact workspace' }) as HTMLButtonElement).disabled).toBe(true);
    expect(countText('Calls')).toBe(daily === 'failed' ? 'Unavailable' : '1');
    if (daily === 'failed') for (const label of ['Needs your approval', 'Upcoming meetings']) expect(countText(label)).toBe('Unavailable');
    await act(async () => resolve(value));
    expect(countText('Local commitments')).toBe(settled);
    if (size) expect((screen.getByRole('button', { name: 'Open contact workspace' }) as HTMLButtonElement).disabled).toBe(false);
    expect(f.calls.every(call => /daily.get|delegation.status/.test(call.method))).toBe(true);
  });
}

it.each(['ready', 'failed'] as const)('distinguishes no-value Checking, Unavailable and successful zero with daily %s', async daily => {
  const f = fixture(true);
  if (daily === 'failed') f.api.daily.get = vi.fn(async () => { throw Error('Synthetic daily unavailable'); });
  let reject!: (reason: Error) => void;
  f.api.localWorkspace.getCommitments.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} onOpenLead={vi.fn()} />);
  await waitFor(() => expect(countText('Local commitments')).toBe('Checking'));
  await act(async () => reject(Error('Private source sentinel')));
  expect(countText('Local commitments')).toBe('Unavailable');
  expect(screen.queryByText(/Private source sentinel/)).toBeNull();
  let resolve!: (result: LocalCommitmentsSnapshot) => void;
  f.api.localWorkspace.getCommitments.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Refresh' })));
  expect(countText('Local commitments')).toBe('Checking');
  await act(async () => resolve({ ...commitments, items: [] }));
  expect(countText('Local commitments')).toBe('0');
  expect(countText('Calls')).toBe(daily === 'failed' ? 'Unavailable' : '1');
  expect(f.api.localWorkspace.getCommitments).toHaveBeenCalledTimes(2);
});
it('retains stale commitments after failure, holds navigation and recovers without reselection', async () => {
  const f = fixture(); render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} onOpenLead={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: /Retained callback/ }));
  f.api.localWorkspace.getCommitments.mockRejectedValueOnce(Error('private'));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await screen.findByText(/Retained work is stale/);
  expect((screen.getByRole('button', { name: 'Open contact workspace' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect((screen.getByRole('button', { name: 'Open contact workspace' }) as HTMLButtonElement).disabled).toBe(false));
});
it('preserves selected editor DOM and caret across independent local refresh', async () => {
  const f = fixture(true); render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} onOpenLead={vi.fn()} />);
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
  render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} onOpenLead={vi.fn()} legacy={<p>Forbidden legacy</p>} />);
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
  const f = fixture(true); render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} onOpenLead={vi.fn()} />);
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
  render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} onOpenLead={vi.fn()} />);
  await screen.findByText(/Retained work could not be checked/);
  expect(screen.queryByText(/No retained work due/)).toBeNull(); expect(screen.queryByText(/private message/)).toBeNull();
  f.api.localWorkspace.getCommitments.mockResolvedValue({ ...commitments, items: [] });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(screen.queryByText(/Retained work could not be checked|Checking retained work/)).toBeNull());
  expect(screen.queryByRole('button', { name: /Retained callback/ })).toBeNull();
});
it('keeps local retained work usable when daily fails or local overview is unavailable', async () => {
  const f = fixture(); f.api.daily.get = vi.fn(async () => { throw Error('daily unavailable'); });
  f.api.localWorkspace.get.mockRejectedValue(Error('overview unavailable'));
  const open = vi.fn(); render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} onOpenLead={open} />);
  fireEvent.click(await screen.findByRole('button', { name: /Retained callback/ }));
  await screen.findByText(/Daily workspace unavailable/);
  fireEvent.click(screen.getByRole('button', { name: 'Open contact workspace' })); expect(open).toHaveBeenCalledWith('person-retained');
});
it('ignores a late old read after API replacement and never keeps old local evidence', async () => {
  const first = fixture(); const next = fixture();
  let resolve!: (snapshot: LocalCommitmentsSnapshot) => void;
  first.api.localWorkspace.getCommitments.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const view = render(<NativeDeskRoute firstUse={first.firstUse} api={first.api} onOpenLead={vi.fn()} />);
  await screen.findByRole('heading', { name: /^Calls/ });
  next.api.localWorkspace.getCommitments.mockResolvedValue({ ...commitments, items: [] });
  view.rerender(<NativeDeskRoute firstUse={next.firstUse} api={next.api} onOpenLead={vi.fn()} />);
  await waitFor(() => expect(next.api.localWorkspace.getCommitments).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.queryByText(/Retained work could not be checked|Checking retained work/)).toBeNull());
  expect(screen.queryByRole('button', { name: /Retained callback/ })).toBeNull();
  await act(async () => resolve(commitments));
  expect(screen.queryByRole('button', { name: /Retained callback/ })).toBeNull();
});
it('keeps newest local read when an earlier refresh resolves later and preserves removed selection honestly', async () => {
  const f = fixture(); render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} onOpenLead={vi.fn()} />);
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
  render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} surface="accounts" onOpenLead={vi.fn()} />);
  await screen.findByText(/Local account library is unavailable/);
  expect(screen.queryByText('No local accounts in this snapshot.')).toBeNull();
  expect(screen.queryByText(/Local workflow unavailable or inconsistent/)).toBeNull();
});
it('keeps selected retained work when an initially failed daily read recovers', async () => {
  const f = fixture(); const daily = f.api.daily.get;
  f.api.daily.get = vi.fn().mockRejectedValueOnce(Error('unavailable')).mockImplementation(daily);
  render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} onOpenLead={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: /Retained callback/ }));
  expect(screen.getByRole('region', { name: 'Retained work detail' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(screen.queryByText(/Daily workspace unavailable/)).toBeNull());
  expect(screen.getByRole('region', { name: 'Retained work detail' })).toBeTruthy();
});
it('labels retained personal detail as existing commitments rather than company context', async () => {
  const f = fixture(); render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} onOpenLead={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: /Retained callback/ }));
  const bar = screen.getByRole('button', { name: 'Close details' }).parentElement!;
  expect(within(bar).getByText('Existing commitments and relationships')).toBeTruthy();
  expect(within(bar).queryByText('Company context')).toBeNull();
  const heading = screen.getByRole('heading', { name: /^Calls/ });
  expect(within(heading).getByText('Calls').classList.contains('native-desk__lane-label')).toBe(true);
});
it('keeps the exact local account selected when an initially failed daily read recovers', async () => {
  const f = fixture(); const daily = f.api.daily.get;
  f.api.daily.get = vi.fn().mockRejectedValueOnce(Error('unavailable')).mockImplementation(daily);
  const open = vi.fn();
  render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} surface="accounts" onOpenLead={open} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Local account · Account A' }));
  expect(screen.getByRole('heading', { name: 'Account A' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(screen.queryByText(/Daily workspace unavailable/)).toBeNull());
  expect(screen.getByRole('heading', { name: 'Account A' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Local account · Account A' }).getAttribute('aria-current')).toBe('true');
  expect(open).not.toHaveBeenCalled();
});

const render = (ui: Parameters<typeof testingRender>[0], options?: Parameters<typeof testingRender>[1]) => testingRender(ui, { wrapper: PresentationRoot, ...options });

Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.open = true; } });
Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.open = false; } });


// Task 4 additive composition tests. Original source above remains byte-for-byte intact.
import { LocalCompanyIntakeProvider as FirstUseOwnerProvider } from './LocalCompanyIntakeProvider';
import { useFirstUseContinuation } from './LocalCompanyIntake';

const f4Releases: Array<() => void> = [];
const f4Pending: Promise<unknown>[] = [];
function f4Deferred<T>(fallback: T) { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); f4Releases.push(() => resolve(fallback)); f4Pending.push(promise); return { promise, resolve }; }
afterEach(async () => { try { cleanup(); } finally { try { await act(async () => { for (const release of f4Releases.splice(0)) release(); await Promise.allSettled(f4Pending.splice(0)); }); } finally { vi.restoreAllMocks(); } } });
function f4Company(accountId = 'a'): LocalCompanyDetail {
  const snapshot = structuredClone(dailyFixture().accounts.find(item => item.account.id === accountId)!);
  snapshot.portfolio = []; snapshot.claims = []; snapshot.routes = [];
  return { scope: 'local_database', generatedAt: local.generatedAt, snapshot, sources: [{ id: `f4-${accountId}`, url: `https://${accountId}.example/evidence`, fetchedAt: local.generatedAt, sha256: 'c'.repeat(64), excerpt: `Selected local source ${accountId}`, permitted: true }], links: [] };
}
function f4Status(r: SelectedResearch, state: LocalCompanyResearchStatus['state']): LocalCompanyResearchStatus { return { ...r, state, receipt: state === 'completed' ? { accountId: r.accountId, version: 2, duplicate: false } : null, reason: null }; }
function FirstUseDesk({ api }: { api: ReturnType<typeof fixture>['api'] }) {
  const firstUse = useFirstUseContinuation();
  return <NativeDeskRoute api={api} firstUse={firstUse} surface="accounts" onOpenLead={vi.fn()} />;
}
function f4Tree(api: ReturnType<typeof fixture>['api'], routeKey = 'accounts') { return <FirstUseOwnerProvider api={api.localWorkspace}><FirstUseDesk key={routeKey} api={api} /></FirstUseOwnerProvider>; }
function f4Api() {
  const f = fixture(true);
  f.api.localWorkspace.getCompany = vi.fn<LocalWorkspaceApi['getCompany']>(async ({ accountId }) => f4Company(accountId));
  f.api.localWorkspace.getCompanyResearchStatus = vi.fn<LocalWorkspaceApi['getCompanyResearchStatus']>(async r => f4Status(r, 'not_recorded'));
  f.api.localWorkspace.researchCompany = vi.fn<LocalWorkspaceApi['researchCompany']>(async r => f4Status(r, 'held'));
  return f;
}

it('F4-local-01 fallback selected research survives healthy namespace and fresh keyed route without reselection', async () => {
  const f = f4Api(); const originalDaily = f.api.daily.get;
  f.api.daily.get = vi.fn().mockRejectedValueOnce(Error('daily unavailable')).mockImplementation(originalDaily);
  const r = { accountId: 'a', commandId: '10000000-0000-4000-8000-000000000001' };
  const gate = f4Deferred(f4Status(r, 'completed')); vi.spyOn(crypto, 'randomUUID').mockReturnValue('10000000-0000-4000-8000-000000000001');
  f.api.localWorkspace.researchCompany = vi.fn<LocalWorkspaceApi['researchCompany']>(() => gate.promise);
  const view = render(f4Tree(f.api));
  await screen.findByText(/Daily workspace unavailable/); fireEvent.click(await screen.findByRole('button', { name: 'Local account · Account A' }));
  await screen.findByText('Selected local source a'); fireEvent.click(screen.getByRole('button', { name: /^Research(?: company)?$/i }));
  expect(f.api.localWorkspace.researchCompany).toHaveBeenCalledOnce();
  const original = vi.mocked(f.api.localWorkspace.researchCompany).mock.calls[0][0];
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' })); await screen.findByTestId('native-desk');
  expect(screen.getByRole('button', { name: 'Local account · Account A' }).getAttribute('aria-current')).toBe('true');
  await screen.findByText('Selected local source a');
  view.rerender(f4Tree(f.api, 'accounts-after-import'));
  await screen.findByText('Selected local source a'); expect(screen.getByRole('button', { name: 'Local account · Account A' }).getAttribute('aria-current')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: /^Research(?: company)?$/i })); expect(f.api.localWorkspace.researchCompany).toHaveBeenCalledOnce();
  await act(async () => gate.resolve(f4Status(original, 'completed')));
  expect(await screen.findByText(/^Research known · completed$/)).toBeTruthy(); expect(vi.mocked(f.api.localWorkspace.researchCompany).mock.calls[0][0]).toBe(original);
}, 10_000);

it('F4-local-02 healthy local selection is distinct from the worker account and worker row cannot start local research', async () => {
  const f = f4Api(); render(f4Tree(f.api)); await screen.findByTestId('native-desk');
  const workerHeading = screen.getByRole('heading', { name: /Worker accounts/ });
  const workerLane = workerHeading.closest('section')!; fireEvent.click(within(workerLane).getByRole('button', { name: /Account A/ }));
  expect(f.api.localWorkspace.getCompany).not.toHaveBeenCalled(); expect(screen.queryByRole('button', { name: /^Research(?: company)?$/i })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Local account · Account A' })); await screen.findByText('Selected local source a');
  expect(f.api.localWorkspace.getCompany).toHaveBeenCalledWith({ accountId: 'a' });
  expect(f.api.localWorkspace.researchCompany).not.toHaveBeenCalled();
}, 10_000);

it('F4-local-03 selecting B then Close preserves A unresolved and returning A keeps the retained attempt', async () => {
  const f = f4Api(); const r = { accountId: 'a', commandId: '10000000-0000-4000-8000-000000000001' };
  const gate = f4Deferred(f4Status(r, 'completed')); vi.spyOn(crypto, 'randomUUID').mockReturnValue('10000000-0000-4000-8000-000000000001');
  f.api.localWorkspace.researchCompany = vi.fn<LocalWorkspaceApi['researchCompany']>(() => gate.promise); render(f4Tree(f.api)); await screen.findByTestId('native-desk');
  fireEvent.click(screen.getByRole('button', { name: 'Local account · Account A' })); await screen.findByText('Selected local source a');
  fireEvent.click(screen.getByRole('button', { name: /^Research(?: company)?$/i }));
  fireEvent.click(screen.getByRole('button', { name: 'Local account · Account B' })); await screen.findByText('Selected local source b');
  fireEvent.click(screen.getByRole('button', { name: /^Research(?: company)?$/i })); expect(f.api.localWorkspace.researchCompany).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'Close details' })); expect(screen.queryByText('Selected local source b')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Local account · Account A' })); await screen.findByText('Selected local source a');
  fireEvent.click(screen.getByRole('button', { name: /^Research(?: company)?$/i })); expect(f.api.localWorkspace.researchCompany).toHaveBeenCalledOnce();
  await act(async () => gate.resolve(f4Status(r, 'completed'))); expect(await screen.findByText(/^Research known · completed$/)).toBeTruthy();
}, 10_000);


it('F4-local-04 fresh route with empty null-workspace cache prefers healthy owner selection', async () => {
  const f = f4Api(); const view = render(f4Tree(f.api)); await screen.findByTestId('native-desk');
  // Select only after healthy ws composition: no fallback/null namespace selection has been written.
  fireEvent.click(screen.getByRole('button', { name: 'Local account · Account B' })); await screen.findByText('Selected local source b');
  view.rerender(f4Tree(f.api, 'new-route-key'));
  await screen.findByText('Selected local source b');
  expect(screen.getByRole('button', { name: 'Local account · Account B' }).getAttribute('aria-current')).toBe('true');
  expect(f.api.localWorkspace.researchCompany).not.toHaveBeenCalled();
}, 10_000);

import { answerKey } from './DailyAnswers';
import { partitionFirstUseAnswers } from './firstUseCapabilities';
import { PresentationRoot } from '../../app/PresentationRoot';
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render as testingRender, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { NativeDeskRoute } from './NativeDeskRoute';
import { dailyFixture, nativeDeskFixture, nativeDeskReviewFixture, linkedInFixture, localDraftContinuation } from './nativeDesk.fixture';
import type { LinkCompanyPersonRequest, LocalAccountPreparation, LocalWorkspaceSnapshot, LocalCommitmentsSnapshot, LocalCompanyDetail, LocalCompanyResearchStatus, SelectedResearch, LocalWorkspaceApi } from '../../../shared/contracts/localWorkspaceContract';
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
  const f = nativeDeskFixture(scoped ? dailyFixture() : dailyFixture({ workspaceId: null, accounts: [], answers: [], calls: { accountIds: [], workloadConflict: false }, ownerStatus: [], transport: [], campaigns: [], issues: [{ code: 'scope_unknown', count: 1 }] }));
  const api = { ...f.api, localWorkspace: { ...f.api.localWorkspace, get: vi.fn(async () => structuredClone(local)), getCommitments: vi.fn(async () => structuredClone(commitments)), transition: vi.fn() } };
  return { ...f, api };
}
it.each(['accounts', 'campaigns'] as const)('keeps the %s route identity and truthful status in settled legacy mode', async surface => {
  const f = fixture();
  f.setSnapshot({ ...await f.api.daily.get(), workflowMode: 'legacy' });
  f.api.localWorkspace.get.mockResolvedValue({ ...local, workflowMode: 'legacy' });
  render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} surface={surface} />);
  await screen.findByText(/Legacy workflow is active/);
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(surface === 'accounts' ? 'Accounts' : 'Campaigns');
  expect(screen.queryByText(/Workflow mode unavailable or inconsistent/)).toBeNull();
  expect(f.calls.every(c => /daily.get|delegation.status/.test(c.method))).toBe(true);
});
it.each(['accounts', 'campaigns'] as const)('keeps the %s route identity while unknown mode remains held', async surface => {
  const f = fixture();
  f.setSnapshot({ ...await f.api.daily.get(), workflowMode: 'unknown' });
  f.api.localWorkspace.get.mockResolvedValue({ ...local, workflowMode: 'legacy' });
  render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} surface={surface} />);
  await screen.findByText(/Workflow mode unavailable or inconsistent/);
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(surface === 'accounts' ? 'Accounts' : 'Campaigns');
  expect(screen.queryByText(/Legacy workflow is active/)).toBeNull();
  expect(f.calls.every(c => /daily.get|delegation.status/.test(c.method))).toBe(true);
});
it('puts typed retained work in Local commitments before worker Calls, preserving metadata and explicit navigation', async () => {
  const f = fixture(); f.api.localWorkspace.getCommitments.mockResolvedValue(sixKindCommitments); render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} />);
  const row = await screen.findByRole('button', { name: /Retained callback.*Retained Person 1/ });
  const localCommitments = screen.getByRole('heading', { name: /^Local commitments/ }).closest('section')!;
  const calls = screen.getByRole('heading', { name: /^Calls/ }).closest('section')!;
  expect(localCommitments.compareDocumentPosition(calls) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  for (const [, label] of retainedKinds) expect(within(localCommitments).getByRole('button', { name: new RegExp(label) })).toBeTruthy();
  expect(within(localCommitments).getByText('6')).toBeTruthy();
  expect(within(calls).queryByRole('button', { name: /Retained/ })).toBeNull();
  fireEvent.click(row);
  expect(screen.getByText('Action type: follow_up · Channel: email · Lane: later')).toBeTruthy();
  expect(screen.queryByText('Forbidden legacy')).toBeNull();
  expect(within(calls).getByText('Unavailable')).toBeTruthy();
  expect(screen.getByText('Worker unavailable')).toBeTruthy();
  expect(f.calls.every(c => !/prepare|approve|begin|sync|forbidden/.test(c.method))).toBe(true);
  expect(screen.queryByRole('button', { name: 'Open contact workspace' })).toBeNull();
  expect(screen.getByText('Stored local work. Nothing here calls, sends or books.')).toBeTruthy();
});
it('keeps the local account library read-only and separate from unavailable worker scope', async () => {
  const f = fixture(); const detailRead = vi.spyOn(f.api.localWorkspace, 'getCompany'); render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} surface="accounts" />);
  await screen.findByRole('heading', { name: 'Local account library' });
  fireEvent.click(await screen.findByRole('button', { name: 'Local account · Account A' }));
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
  render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} />);
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
    expect(within(detail).queryByRole('button')).toBeNull();
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
    render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} />);
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
    expect(countText('Calls')).toBe(daily === 'failed' ? 'Unavailable' : '1');
    if (daily === 'failed') for (const label of ['Saved draft continuations']) expect(countText(label)).toBe('Unavailable');
    await act(async () => resolve(value));
    expect(countText('Local commitments')).toBe(settled);
    expect(f.calls.every(call => /daily.get|delegation.status/.test(call.method))).toBe(true);
  });
}

it.each(['ready', 'failed'] as const)('distinguishes no-value Checking, Unavailable and successful zero with daily %s', async daily => {
  const f = fixture(true);
  if (daily === 'failed') f.api.daily.get = vi.fn(async () => { throw Error('Synthetic daily unavailable'); });
  let reject!: (reason: Error) => void;
  f.api.localWorkspace.getCommitments.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} />);
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
  const f = fixture(); render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} />);
  fireEvent.click(await screen.findByRole('button', { name: /Retained callback/ }));
  f.api.localWorkspace.getCommitments.mockRejectedValueOnce(Error('private'));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await screen.findByText(/Retained work is stale/);
  expect(screen.getByRole('region', { name: 'Retained work detail' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Open contact workspace' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(screen.queryByText(/Retained work is stale/)).toBeNull());
  expect(screen.getByRole('region', { name: 'Retained work detail' })).toBeTruthy();
});
it('preserves selected editor DOM and caret across independent local refresh', async () => {
  const f = fixture(true); render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} />);
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
  render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} />);
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
  const f = fixture(true); render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} />);
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
  render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} />);
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
  render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} />);
  fireEvent.click(await screen.findByRole('button', { name: /Retained callback/ }));
  await screen.findByText(/Daily workspace unavailable/);
  expect(screen.getByRole('region', { name: 'Retained work detail' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Open contact workspace' })).toBeNull();
});
it('ignores a late old read after API replacement and never keeps old local evidence', async () => {
  const first = fixture(); const next = fixture();
  let resolve!: (snapshot: LocalCommitmentsSnapshot) => void;
  first.api.localWorkspace.getCommitments.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const view = render(<NativeDeskRoute firstUse={first.firstUse} api={first.api} />);
  await screen.findByRole('heading', { name: /^Calls/ });
  next.api.localWorkspace.getCommitments.mockResolvedValue({ ...commitments, items: [] });
  view.rerender(<NativeDeskRoute firstUse={next.firstUse} api={next.api} />);
  await waitFor(() => expect(next.api.localWorkspace.getCommitments).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.queryByText(/Retained work could not be checked|Checking retained work/)).toBeNull());
  expect(screen.queryByRole('button', { name: /Retained callback/ })).toBeNull();
  await act(async () => resolve(commitments));
  expect(screen.queryByRole('button', { name: /Retained callback/ })).toBeNull();
});
it('keeps newest local read when an earlier refresh resolves later and preserves removed selection honestly', async () => {
  const f = fixture(); render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} />);
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
  render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} surface="accounts" />);
  await screen.findByText(/Local account library is unavailable/);
  expect(screen.queryByText('No local accounts in this snapshot.')).toBeNull();
  expect(screen.queryByText(/Local workflow unavailable or inconsistent/)).toBeNull();
});
it('keeps selected retained work when an initially failed daily read recovers', async () => {
  const f = fixture(); const daily = f.api.daily.get;
  f.api.daily.get = vi.fn().mockRejectedValueOnce(Error('unavailable')).mockImplementation(daily);
  render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} />);
  fireEvent.click(await screen.findByRole('button', { name: /Retained callback/ }));
  expect(screen.getByRole('region', { name: 'Retained work detail' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(screen.queryByText(/Daily workspace unavailable/)).toBeNull());
  expect(screen.getByRole('region', { name: 'Retained work detail' })).toBeTruthy();
});
it('labels retained personal detail as existing commitments rather than company context', async () => {
  const f = fixture(); render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} />);
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
  render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} surface="accounts" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Local account · Account A' }));
  expect(screen.getByRole('heading', { name: 'Account A' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(screen.queryByText(/Daily workspace unavailable/)).toBeNull());
  expect(screen.getByRole('heading', { name: 'Account A' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Local account · Account A' }).getAttribute('aria-current')).toBe('true');
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
  return <NativeDeskRoute api={api} firstUse={firstUse} surface="accounts" />;
}
function f4Tree(api: ReturnType<typeof fixture>['api'], routeKey = 'accounts') { return <FirstUseOwnerProvider api={api.localWorkspace}><FirstUseDesk key={routeKey} api={api} /></FirstUseOwnerProvider>; }
function f4Api() {
  const f = fixture(true);
  // Explicit legacy research: no standalone configuration, paired policy remains authoritative.
  f.api.localWorkspace.getCompanyResearchSettings = vi.fn(async () => ({ revision: 0, configuration: null, profiles: [], blockedReason: 'paired_research_present' as const, reservedOrSpentMicros: 0 }));
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
  await screen.findByText('Selected local source a'); await screen.findByText('Existing paired research remains governed by its policy. Standalone local activation is unavailable.');
  fireEvent.click(screen.getByRole('button', { name: /^Research(?: company)?$/i }));
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
  await screen.findByText('Existing paired research remains governed by its policy. Standalone local activation is unavailable.');
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


// Task 6 actual NativeDesk/ResearchPanel composition with fake API projections.
import type { FirstUseContinuation } from './localCompanyContinuation';
function t6LocalRequest(accountId = 'a'): LinkCompanyPersonRequest {
  return { commandId: '60000000-0000-4000-8000-000000000001', accountId, expectedVersion: 1,
    link: { id: 'link-person-51', kind: 'person_role', personId: 'person-51', role: 'Manager', relationship: 'Manages company', evidenceIds: [`f4-${accountId}`], authority: 'unconfirmed', authorityEvidenceIds: [], validFrom: local.generatedAt, validTo: null },
    sourceQuotes: [{ sourceId: `f4-${accountId}`, quote: `Selected local source ${accountId}` }] };
}
function T6LocalDesk({ api, capture }: { api: ReturnType<typeof fixture>['api']; capture: (c: FirstUseContinuation) => void }) {
  const firstUse = useFirstUseContinuation(); capture(firstUse);
  return <NativeDeskRoute api={api} firstUse={firstUse} surface="accounts" />;
}
function t6LocalTree(api: ReturnType<typeof fixture>['api'], capture: (c: FirstUseContinuation) => void) {
  return <FirstUseOwnerProvider api={api.localWorkspace}><T6LocalDesk api={api} capture={capture} /></FirstUseOwnerProvider>;
}
it('T6-L01 selected exact successful detail exposes contact join without a second independent getCompany read or a person import control', async () => {
  const f = f4Api(); render(t6LocalTree(f.api, () => undefined));
  fireEvent.click(await screen.findByRole('button', { name: 'Local account · Account A' })); await screen.findByText('Selected local source a');
  expect(await screen.findByText('Contact not established')).toBeTruthy(); expect(f.api.localWorkspace.getCompany).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'Find saved person' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Import named person' })).toBeNull();
  expect(screen.queryByRole('dialog', { name: 'Import leads' })).toBeNull(); expect(f.api.localWorkspace.researchCompany).not.toHaveBeenCalled();
}, 10_000);
it('T6-L02 failed selected detail is not empty success and close and return remain usable', async () => {
  const f = f4Api(); f.api.localWorkspace.getCompany = vi.fn<LocalWorkspaceApi['getCompany']>().mockRejectedValueOnce(Error('detail unavailable')).mockResolvedValue(f4Company());
  render(t6LocalTree(f.api, () => undefined)); fireEvent.click(await screen.findByRole('button', { name: 'Local account · Account A' }));
  await waitFor(() => expect(f.api.localWorkspace.getCompany).toHaveBeenCalledOnce()); await screen.findByText(/Company evidence unavailable/i);
  expect(screen.queryByText('Contact not established')).toBeNull(); expect(screen.queryByRole('button', { name: 'Find saved person' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
  fireEvent.click(screen.getByRole('button', { name: 'Local account · Account A' })); await screen.findByText('Selected local source a');
  expect(await screen.findByRole('button', { name: 'Find saved person' })).toBeTruthy(); expect(f.api.localWorkspace.researchCompany).not.toHaveBeenCalled();
}, 10_000);
it('T6-L03 actual ResearchPanel refreshes exactly once on same-account known link, never pending or unknown', async () => {
  const f = f4Api(); let c!: FirstUseContinuation; const view = render(t6LocalTree(f.api, value => { c = value; }));
  fireEvent.click(await screen.findByRole('button', { name: 'Local account · Account A' })); await screen.findByText('Selected local source a');
  expect(await screen.findByText('Contact not established')).toBeTruthy(); expect(f.api.localWorkspace.getCompany).toHaveBeenCalledTimes(1);
  let token!: NonNullable<ReturnType<FirstUseContinuation['beginLink']>>;
  act(() => { const started = c.beginLink(c.captureEpoch(), t6LocalRequest()); expect(started).not.toBeNull(); token = started!; });
  expect(f.api.localWorkspace.getCompany).toHaveBeenCalledTimes(1);
  await act(async () => { c.settleLink(token, { outcome: 'unknown' }); }); expect(f.api.localWorkspace.getCompany).toHaveBeenCalledTimes(1);
  const retained = c.snapshot().link!.request;
  act(() => { const replay = c.beginLink(c.captureEpoch(), retained); expect(replay).not.toBeNull(); token = replay!; });
  const updated = f4Company(); updated.links = [retained.link]; updated.snapshot.account.version = 2;
  vi.mocked(f.api.localWorkspace.getCompany).mockResolvedValue(updated);
  await act(async () => { expect(c.settleLink(token, { outcome: 'known', receipt: { accountId: 'a', version: 2, duplicate: false } })).toBe(true); });
  expect(await screen.findByText('person-51 · Manager · Manages company')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Open saved contact' })).toBeNull();
  expect(vi.mocked(f.api.localWorkspace.getCompany).mock.calls).toEqual([[{ accountId: 'a' }], [{ accountId: 'a' }]]);
  view.rerender(t6LocalTree(f.api, value => { c = value; })); await act(async () => undefined);
  expect(f.api.localWorkspace.getCompany).toHaveBeenCalledTimes(2);
}, 10_000);
it('T6-L04 known A settlement while B selected never refreshes B or replaces B detail', async () => {
  const f = f4Api(); let c!: FirstUseContinuation; render(t6LocalTree(f.api, value => { c = value; }));
  fireEvent.click(await screen.findByRole('button', { name: 'Local account · Account A' })); await screen.findByText('Selected local source a');
  let token!: NonNullable<ReturnType<FirstUseContinuation['beginLink']>>;
  act(() => { const begun = c.beginLink(c.captureEpoch(), t6LocalRequest()); expect(begun).not.toBeNull(); token = begun!; });
  fireEvent.click(screen.getByRole('button', { name: 'Local account · Account B' })); await screen.findByText('Selected local source b');
  expect(f.api.localWorkspace.getCompany).toHaveBeenCalledTimes(2);
  await act(async () => { expect(c.settleLink(token, { outcome: 'known', receipt: { accountId: 'a', version: 2, duplicate: false } })).toBe(true); });
  expect(f.api.localWorkspace.getCompany).toHaveBeenCalledTimes(2); expect(screen.getByText('Selected local source b')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Local account · Account B' }).getAttribute('aria-current')).toBe('true');
}, 10_000);

function savedReply(id: string | null, stale = false): Extract<import('../../../shared/contracts/dailyContract').DailyAnswer, { kind: 'reply' }> {
  return {
    kind: 'reply', accountId: 'a', capability: 'held', reason: 'reply_capability_unverified', stale,
    thread: { thread: { accountId: 'a', provider: 'gmail', mailboxSubject: 'mailbox', providerThreadId: 'thread', messages: [{ id: 'message', threadId: 'thread', rfcMessageId: null, references: [], from: ['person@fixture.invalid'], to: ['founder@fixture.invalid'], cc: [], date: local.generatedAt, subject: 'Details', bodyParts: [{ mimeType: 'text/plain', text: 'Tell me more', truncated: false }] }] }, revision: 1, contextRevision: 'context', signals: [] },
    draft: id ? { id, accountId: 'a', mailboxSubject: 'mailbox', threadId: 'thread', threadRevision: 1, contextRevision: 'context', revision: 1, recipient: 'person@fixture.invalid', sender: 'founder@fixture.invalid', subject: 'Re: details', body: `Exact saved ${id}`, evidenceIds: [], generation: 'edited', updatedAt: local.generatedAt } : null,
  };
}

it('stably partitions every frozen saved object, including stale and draftless replies', () => {
  const email = dailyFixture().answers[0], manual = linkedInFixture();
  const replies = [savedReply('one'), savedReply('two', true), savedReply(null)];
  const input = Object.freeze([replies[0], email, replies[1], manual, replies[2]].map(a => Object.freeze(a)));
  const { continuations, history } = partitionFirstUseAnswers(input);
  expect(continuations).toEqual([email, manual]); expect(history).toEqual(replies);
  [email, manual].forEach((a, i) => expect(continuations[i]).toBe(a));
  replies.forEach((a, i) => expect(history[i]).toBe(a));
  expect(input).toEqual([replies[0], email, replies[1], manual, replies[2]]);
  expect(partitionFirstUseAnswers([])).toEqual({ continuations: [], history: [] });
  expect(partitionFirstUseAnswers(replies)).toEqual({ continuations: [], history: replies });
  expect(partitionFirstUseAnswers([email, manual])).toEqual({ continuations: [email, manual], history: [] });
});

it('partitions interleaved saved history with exact keys, keyboard order and retained selected body', async () => {
  const snapshot = nativeDeskReviewFixture(), original = [...snapshot.answers];
  const replies = [savedReply('one'), savedReply('two', true), savedReply(null)];
  snapshot.answers = [replies[0], original[0], replies[1], original[1], replies[2], original[2]];
  const f = fixture(true); f.setSnapshot(snapshot);
  render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} />);
  const history = await screen.findByRole('region', { name: 'Saved reply history 3' });
  const continuation = screen.getByRole('region', { name: 'Saved draft continuations 3' });
  expect(within(continuation).queryByRole('button', { name: /Reply/ })).toBeNull();
  const replyRows = within(history).getAllByRole('button');
  expect(replyRows.map(row => row.dataset.rowKey)).toEqual(replies.map(answerKey));
  const rows = Array.from(screen.getByRole('navigation', { name: 'Today queue' }).querySelectorAll<HTMLButtonElement>('[data-row-key]'));
  rows[0].focus();
  for (let i = 1; i < rows.length; i++) {
    fireEvent.keyDown(document.activeElement!, { key: i % 2 ? 'j' : 'ArrowDown' });
    expect(document.activeElement).toBe(rows[i]);
  }
  for (let i = rows.length - 2; i >= 0; i--) {
    fireEvent.keyDown(document.activeElement!, { key: i % 2 ? 'k' : 'ArrowUp' });
    expect(document.activeElement).toBe(rows[i]);
  }
  fireEvent.keyDown(replyRows[1], { key: 'Enter' });
  expect(screen.getByText('Exact saved two')).toBeTruthy();
  expect(screen.getByText(/Thread or context changed/)).toBeTruthy();
  expect(screen.getByTestId('native-desk').querySelector('.native-desk__detail-bar')?.textContent).toContain('Saved reply history');
  f.setSnapshot({ ...snapshot, answers: [...snapshot.answers].reverse() });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Refresh' })));
  expect(screen.getByText('Exact saved two')).toBeTruthy();
  expect(document.querySelectorAll('[data-row-key][aria-current="true"]')).toHaveLength(1);
  fireEvent.keyDown(screen.getByRole('button', { name: 'Close details' }), { key: 'Escape' });
  expect((document.activeElement as HTMLElement).dataset.rowKey).toBe(answerKey(replies[1]));
  fireEvent.click(within(screen.getByRole('region', { name: 'Saved reply history 3' })).getAllByRole('button')[0]);
  expect(screen.getByText('No saved reply draft.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /approve|delete/i })).toBeNull();
  expect(f.calls.every(c => /^(daily.get|delegation.status)$/.test(c.method))).toBe(true);
});

it('retains the same requested editor, local text and caret when history arrives and reorders', async () => {
  const f = fixture(true);
  render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Email · Account A' }));
  const editor = screen.getByLabelText('Email body') as HTMLTextAreaElement;
  fireEvent.change(editor, { target: { value: 'Unsubmitted local text' } });
  editor.focus(); editor.setSelectionRange(4, 4);
  const snapshot = dailyFixture();
  f.setSnapshot({ ...snapshot, answers: [savedReply('two'), ...snapshot.answers.slice().reverse(), savedReply('one')] });
  await act(async () => window.dispatchEvent(new Event('focus')));
  await screen.findByRole('region', { name: 'Saved reply history 2' });
  expect(screen.getByLabelText('Email body')).toBe(editor);
  expect(editor.value).toBe('Unsubmitted local text'); expect(editor.selectionStart).toBe(4);
  expect(f.calls.every(c => /^(daily.get|delegation.status)$/.test(c.method))).toBe(true);
});

it.each(['empty', 'requested', 'linkedin', 'history', 'unpaired'] as const)('explains missing continuation prerequisites for %s without inventing actions', async kind => {
  const f = fixture(kind !== 'unpaired');
  if (kind !== 'unpaired') f.setSnapshot(dailyFixture({ answers: kind === 'requested' ? dailyFixture().answers : kind === 'linkedin' ? [linkedInFixture()] : kind === 'history' ? [savedReply('one')] : [] }));
  render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} />);
  const lane = await screen.findByRole('region', { name: /^Saved draft continuations/ });
  fireEvent.click(within(lane).getByText('About saved draft continuations'));
  expect(within(lane).getByText(/cannot prepare first worker drafts/)).toBeTruthy();
  expect(!!within(lane).queryByText(/Requested email requires/)).toBe(kind !== 'requested');
  expect(!!within(lane).queryByText(/LinkedIn requires/)).toBe(kind !== 'linkedin');
  expect(countText('Saved draft continuations')).toBe(kind === 'unpaired' ? 'Unavailable' : kind === 'requested' ? '2' : kind === 'linkedin' ? '1' : '0');
  for (const [label, section] of [['Worker settings', 'worker'], ['Connections settings', 'connections']] as const) {
    const link = within(lane).getByRole('link', { name: label });
    expect(link.getAttribute('href')).toBe('#/settings');
    fireEvent.click(link); expect(window.sessionStorage.getItem('callie.settings.section')).toBe(section);
  }
  expect(screen.queryByRole('button', { name: /prepare|enroll|generate|activate/i })).toBeNull();
});

it('links empty calls to Phone setup without implying permission or placing calls', async () => {
  const f = fixture();
  render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} />);
  const lane = await screen.findByRole('region', { name: /^Calls$/ });
  fireEvent.click(within(lane).getByText('About queued calls'));
  const link = within(lane).getByRole('link', { name: 'Phone settings' });
  expect(link.getAttribute('href')).toBe('#/settings');
  fireEvent.click(link); expect(window.sessionStorage.getItem('callie.settings.section')).toBe('phone');
  expect(within(lane).getByText(/Setup alone does not queue or place a call/)).toBeTruthy();
  expect(f.calls.every(c => /^(daily.get|delegation.status)$/.test(c.method))).toBe(true);
});

it.each([true, false])('explains empty campaign draft prerequisites with known scope %s', async scoped => {
  const f = fixture(scoped);
  render(<NativeDeskRoute surface="campaigns" firstUse={f.firstUse} api={f.api} />);
  await screen.findByText(/Save an unapproved call campaign draft for one worker-owned company/);
  const queue = screen.getByRole('navigation', { name: 'Campaigns queue' });
  expect(within(queue).getByText(scoped ? /No saved campaign drafts. A configured worker and active company ownership/ : /Campaign scope is unavailable/)).toBeTruthy();
  const link = within(queue).getByRole('link', { name: 'Worker settings' });
  expect(link.getAttribute('href')).toBe('#/settings');
  expect(screen.queryByRole('button', { name: /create|approve|enroll|activate/i })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'New call campaign' }));
  expect((screen.getByRole('button', { name: 'Save call campaign draft' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/does not enroll accounts, activate a campaign, or start outreach/)).toBeTruthy();
  expect(f.calls.every(c => /^(daily.get|delegation.status)$/.test(c.method))).toBe(true);
});

// Company draft UI integration only: actual public account panel, in-memory mock API.
// This is not encrypted persistence, provider, installed-app or restart acceptance.
import type { CompanyDraftRead, LocalCompanyDraft } from '../../../shared/contracts/localCompanyDraftContract';
it('company draft public panel explicitly opens an existing company route and retains exact saved text through close and keyed remount (mock API)', async () => {
  const f = f4Api(), detail = f4Company();
  const email = 'info@company-panel.example', quote = `Business email: ${email}`;
  const excerpt = `Fictional company source for the draft panel.\n${quote}`;
  detail.sources[0] = { ...detail.sources[0], excerpt };
  const route: LocalCompanyDetail['snapshot']['routes'][number] = { id: 'company-panel-route', accountId: detail.snapshot.account.id, version: 1, personId: null,
    channel: 'email' as const, value: email, purpose: 'business' as const, verification: 'published' as const, evidenceIds: [detail.sources[0].id] };
  detail.snapshot.routes = [route];
  const originalDetail = structuredClone(detail);
  const initial: LocalCompanyDraft = { kind: 'local_company_email', status: 'unsent', id: 'company-panel-draft', accountId: route.accountId,
    revision: 1, recipientBinding: { routeId: route.id, routeVersion: route.version, email, personId: null },
    accountVersionAtOpen: detail.snapshot.account.version, companyLabel: detail.snapshot.account.name, sourceIds: route.evidenceIds,
    publication: { sourceId: detail.sources[0].id, url: detail.sources[0].url, sha256: detail.sources[0].sha256,
      fetchedAt: detail.sources[0].fetchedAt, quote }, subject: '', body: '', createdAt: local.generatedAt, updatedAt: local.generatedAt };
  let stored: CompanyDraftRead | null = null;
  const trace: string[] = [];
  f.api.localWorkspace.getCompany = vi.fn<LocalWorkspaceApi['getCompany']>(async input => {
    expect(input).toEqual({ accountId: route.accountId }); return structuredClone(detail);
  });
  const getDraft = vi.fn<LocalWorkspaceApi['getCompanyDraft']>(async input => {
    trace.push('get'); expect(input.accountId).toBe(route.accountId);
    if ('routeId' in input) expect(input).toEqual({ accountId: route.accountId, routeId: route.id });
    else expect(input).toEqual({ accountId: route.accountId, draftId: initial.id });
    return structuredClone(stored);
  });
  const openDraft = vi.fn<LocalWorkspaceApi['openCompanyDraft']>(async input => {
    trace.push('open'); expect(input).toEqual({ commandId: expect.any(String), accountId: route.accountId, routeId: route.id,
      expectedRouteVersion: route.version, expectedAccountVersion: detail.snapshot.account.version });
    stored ??= { draft: structuredClone(initial), stale: false, reason: null, editable: true };
    return { receipt: { commandId: input.commandId, accountId: route.accountId, draftId: initial.id, operation: 'open',
      appliedRevision: stored.draft.revision, recipientBinding: initial.recipientBinding, publication: initial.publication }, current: structuredClone(stored) };
  });
  const saveDraft = vi.fn<LocalWorkspaceApi['saveCompanyDraft']>(async input => {
    trace.push('save'); if (!stored) throw new Error('Mock draft must be explicitly opened before save');
    expect(input.accountId).toBe(route.accountId); expect(input.draftId).toBe(initial.id); expect(input.expectedRevision).toBe(stored.draft.revision);
    stored = { ...stored, draft: { ...stored.draft, subject: input.subject, body: input.body, revision: stored.draft.revision + 1 } };
    return { receipt: { commandId: input.commandId, accountId: route.accountId, draftId: initial.id, operation: 'save',
      appliedRevision: stored.draft.revision, recipientBinding: initial.recipientBinding, publication: initial.publication }, current: structuredClone(stored) };
  });
  const forbidden = vi.fn(async (): Promise<never> => { throw new Error('Existing company draft must not create/link a person, admit a new route or research'); });
  f.api.localWorkspace.getCompanyDraft = getDraft; f.api.localWorkspace.openCompanyDraft = openDraft; f.api.localWorkspace.saveCompanyDraft = saveDraft;
  f.api.localWorkspace.admitCompanyDraftEmail = forbidden; f.api.localWorkspace.linkCompanyPerson = forbidden;
  f.api.localWorkspace.researchCompany = forbidden;
  const view = render(f4Tree(f.api));
  fireEvent.click(await screen.findByRole('button', { name: 'Local account · Account A' }));
  await screen.findByText(excerpt, { exact: true, normalizer: text => text });
  expect(f.api.localWorkspace.getCompany).toHaveBeenCalledWith({ accountId: route.accountId });
  expect(screen.getByText('Contact not established')).toBeTruthy();
  expect(openDraft).not.toHaveBeenCalled(); expect(saveDraft).not.toHaveBeenCalled();

  // Intended causal RED: current actual LocalAccountLibrary has no company-draft action/composer.
  fireEvent.click(await screen.findByRole('button', { name: /^(?:Open|Reopen) company draft$/i }));
  const panel = await screen.findByRole('region', { name: 'Company draft' });
  await waitFor(() => expect(openDraft).toHaveBeenCalledTimes(1));
  expect(trace.indexOf('get')).toBeGreaterThanOrEqual(0); expect(trace.indexOf('get')).toBeLessThan(trace.indexOf('open'));
  expect(within(panel).getByText(email, { exact: true })).toBeTruthy();
  expect(within(panel).getByText(/no named person verified/i)).toBeTruthy();
  expect(within(panel).getByText(/^Unsent$/i)).toBeTruthy();
  expect(within(panel).queryByRole('button', { name: /generate|send|approve/i })).toBeNull();
  const subject = 'Manual company draft · café';
  const body = 'Hello company team,\n\nExact <untrusted> text stays here.\nTrailing spaces stay too.  \n';
  fireEvent.change(within(panel).getByRole('textbox', { name: 'Subject' }), { target: { value: subject } });
  fireEvent.change(within(panel).getByRole('textbox', { name: 'Message' }), { target: { value: body } });
  fireEvent.click(within(panel).getByRole('button', { name: /^Save$/ }));
  await waitFor(() => expect(saveDraft).toHaveBeenCalledTimes(1));
  expect(saveDraft.mock.calls[0][0]).toEqual({ commandId: expect.any(String), accountId: route.accountId, draftId: initial.id, expectedRevision: 1, subject, body });
  await waitFor(() => expect(within(panel).getByRole('button', { name: /^Save$/ }).hasAttribute('disabled')).toBe(true));
  fireEvent.click(within(panel).getByRole('button', { name: /^Close(?: draft)?$/ }));
  await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Subject' })).toBeNull());
  view.rerender(f4Tree(f.api, 'company-draft-after-close'));
  await screen.findByText(excerpt, { exact: true, normalizer: text => text });
  expect(openDraft).toHaveBeenCalledTimes(1); expect(saveDraft).toHaveBeenCalledTimes(1);
  fireEvent.click(await screen.findByRole('button', { name: /^(?:Open|Reopen) company draft$/i }));
  const reopened = await screen.findByRole('region', { name: 'Company draft' });
  await waitFor(() => {
    expect(within(reopened).getByRole('textbox', { name: 'Subject' })).toHaveProperty('value', subject);
    expect(within(reopened).getByRole('textbox', { name: 'Message' })).toHaveProperty('value', body);
  });
  expect(within(reopened).getByText(email, { exact: true })).toBeTruthy();
  expect(within(reopened).queryByRole('button', { name: /generate|send|approve/i })).toBeNull();
  expect(saveDraft).toHaveBeenCalledTimes(1); expect(forbidden).not.toHaveBeenCalled();
  expect(detail).toEqual(originalDetail); expect(detail.snapshot.routes[0].personId).toBeNull(); expect(detail.links).toEqual([]);
  expect(f.calls.filter(call => /prepare|approve|send|generate|begin|sync|import|createPerson/i.test(call.method))).toEqual([]);
}, 10_000);

// Lane 8: unsent local drafts in Today, the calm paused path, and step controls that focus the panel they name.
it('lists unsent local drafts under Saved draft continuations in keyboard order and opens the company on Accounts without selecting in Today', async () => {
  const f = fixture(true);
  f.setSnapshot(nativeDeskReviewFixture());
  const drafts = [localDraftContinuation(), localDraftContinuation({ accountId: 'b', draftId: 'draft-b', companyLabel: 'Account B', subject: '', revision: 1 })];
  f.api.localWorkspace.getCommitments.mockResolvedValue({ ...commitments, localDrafts: drafts });
  window.location.hash = '';
  render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} />);
  const rowA = await screen.findByRole('button', { name: 'Account A · Local unsent draft · revision 2' });
  const rowB = screen.getByRole('button', { name: 'Account B · Local unsent draft · revision 1' });
  expect(rowA.textContent).toContain('Maintenance request coordination');
  expect(rowA.textContent).toContain('Saved locally · revision 2');
  for (const row of [rowA, rowB]) expect(row.textContent).not.toMatch(/worker|owner|send|approv/i);
  const lane = screen.getByRole('region', { name: 'Saved draft continuations 3' });
  const group = screen.getByRole('heading', { name: 'Local unsent drafts' }).parentElement!;
  expect(lane.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(within(lane).getAllByRole('button')).toHaveLength(3);
  // Keyboard order continues from the worker continuations into the local drafts.
  const linkedIn = screen.getByRole('button', { name: 'Manual LinkedIn · Account A' });
  linkedIn.focus();
  fireEvent.keyDown(linkedIn, { key: 'j' }); expect(document.activeElement).toBe(rowA);
  fireEvent.keyDown(rowA, { key: 'ArrowDown' }); expect(document.activeElement).toBe(rowB);
  // Enter opens the company on Accounts: continuation selection plus hash navigation. Nothing is selected in Today, nothing is commanded.
  fireEvent.keyDown(rowB, { key: 'Enter' });
  expect(f.firstUse.snapshot().selectedAccountId).toBe('b');
  expect(window.location.hash).toBe('#/accounts');
  expect(document.querySelectorAll('[data-row-key][aria-current="true"]')).toHaveLength(0);
  expect(screen.queryByRole('button', { name: 'Close details' })).toBeNull();
  window.location.hash = '';
  fireEvent.click(rowA);
  expect(f.firstUse.snapshot().selectedAccountId).toBe('a');
  expect(window.location.hash).toBe('#/accounts');
  expect(f.calls.every(c => /^(daily.get|delegation.status)$/.test(c.method))).toBe(true);
  window.location.hash = '';
});

it('lists unsent local drafts inside the local-only Saved draft continuations lane while the daily read is unavailable', async () => {
  const f = fixture(); f.api.daily.get = vi.fn(async () => { throw Error('daily unavailable'); });
  f.api.localWorkspace.getCommitments.mockResolvedValue({ ...commitments, localDrafts: [localDraftContinuation()] });
  window.location.hash = '';
  render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} />);
  await screen.findByText(/Daily workspace unavailable/);
  const lane = screen.getByRole('heading', { name: /^Saved draft continuations/ }).closest('section')!;
  expect(within(lane).getByText('Unavailable')).toBeTruthy();
  const row = within(lane).getByRole('button', { name: 'Account A · Local unsent draft · revision 2' });
  expect(row.textContent).not.toMatch(/worker|owner|send|approv/i);
  fireEvent.click(row);
  expect(f.firstUse.snapshot().selectedAccountId).toBe('a');
  expect(window.location.hash).toBe('#/accounts');
  window.location.hash = '';
});

it.each(['paused', 'policy paused', 'unpaired'] as const)('shows one quiet status line with collapsed connection details when this Mac is %s', async kind => {
  const f = fixture(kind !== 'unpaired');
  const active = await f.api.delegation.status();
  if (kind === 'paused') f.setConfiguration({ ...active, state: 'paused' } as typeof active);
  if (kind === 'policy paused') f.setConfiguration({ ...active, configuration: { ...active.configuration!, configuration: { ...active.configuration!.configuration, state: 'paused' } } } as typeof active);
  // David's Mac: an incomplete daily snapshot for cloud-side reasons only, alongside retained local work.
  const daily = await f.api.daily.get();
  f.setSnapshot({ ...daily, freshness: { ...daily.freshness, kind: 'incomplete' }, issues: [...daily.issues, { code: 'transport_incomplete', count: 1 }, { code: 'call_allocation_unconfigured', count: 1 }] });
  render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} />);
  await screen.findByText('Cloud work is paused on this Mac. Local work continues.');
  await screen.findByRole('button', { name: /Retained callback/ });
  const desk = screen.getByTestId('native-desk');
  const statusLines = Array.from(desk.children).filter(el => el.matches('p[role="status"]')).map(el => el.textContent);
  expect(statusLines).toEqual(['Cloud work is paused on this Mac. Local work continues.']);
  expect(screen.queryByText(/daily snapshot is incomplete/)).toBeNull();
  expect(screen.queryByText('Worker freshness unknown')).toBeNull();
  const details = desk.querySelector<HTMLDetailsElement>('.native-desk__connection')!;
  expect(details.open).toBe(false);
  expect(details.querySelector('summary')?.textContent).toBe(kind === 'unpaired' ? 'Worker unavailable' : 'Worker paused');
  expect(within(details).getByText(/Remote freshness unknown/)).toBeTruthy();
  fireEvent.click(screen.getByText('Queue capacity and operational details'));
  expect(screen.getByText('transport incomplete: 1')).toBeTruthy();
  expect(f.calls.every(c => /^(daily.get|delegation.status)$/.test(c.method))).toBe(true);
});

it.each(['invalid_local_record', 'research_failed'] as const)('keeps the incomplete line for a real %s problem while paused', async code => {
  const f = fixture(true);
  const active = await f.api.delegation.status(); f.setConfiguration({ ...active, state: 'paused' } as typeof active);
  const daily = await f.api.daily.get();
  f.setSnapshot({ ...daily, freshness: { ...daily.freshness, kind: 'incomplete' }, issues: [{ code, count: 2 }] });
  render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} />);
  await screen.findByText('Cloud work is paused on this Mac. Local work continues.');
  const desk = screen.getByTestId('native-desk');
  const statusLines = Array.from(desk.children).filter(el => el.matches('p[role="status"]')).map(el => el.textContent);
  expect(statusLines).toEqual(['Cloud work is paused on this Mac. Local work continues.', 'The daily snapshot is incomplete. Account work may be missing. Existing owner checks still apply.']);
  fireEvent.click(screen.getByText('Queue capacity and operational details'));
  expect(screen.getByText(`${code.replaceAll('_', ' ')}: 2`)).toBeTruthy();
});

const stepPreparation = (step: LocalAccountPreparation['nextStep']): LocalAccountPreparation => step === 'unknown'
  ? { researched: null, unsentDraft: null, businessRoute: null, nextStep: step, reason: 'Local preparation evidence unavailable for this company. Open it to check again.' }
  : { researched: step !== 'research', unsentDraft: step === 'reopen_draft', businessRoute: step === 'reopen_draft' || step === 'draft', nextStep: step, reason: 'Saved local reason.' };
const localAccounts = local.accounts.state === 'available' ? local.accounts.snapshots : [];
const withPreparation = (preparation: LocalAccountPreparation): LocalWorkspaceSnapshot =>
  ({ ...local, accounts: { state: 'available', snapshots: localAccounts.map(s => s.account.id === 'a' ? { ...s, preparation } : s) } });
it.each([
  ['reopen_draft', 'Reopen draft', 'Company draft'],
  ['draft', 'Open draft', 'Company draft'],
  ['add_route', 'Open route review', 'Company draft'],
  ['research', 'Open research', 'Company research'],
  ['unknown', 'Open company', 'Account A'],
] as const)('the %s step control (%s) scrolls the %s panel into view and moves focus into it', async (step, label, target) => {
  const f = f4Api();
  f.api.localWorkspace.get.mockResolvedValue(withPreparation(stepPreparation(step)));
  const scroll = vi.fn(), original = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = scroll;
  try {
    render(f4Tree(f.api));
    fireEvent.click(await screen.findByRole('button', { name: `${label} · Account A` }));
    expect(screen.getByRole('button', { name: 'Local account · Account A' }).getAttribute('aria-current')).toBe('true');
    const panel = target === 'Company draft' ? await screen.findByRole('region', { name: 'Company draft' })
      : target === 'Company research' ? await screen.findByRole('heading', { name: 'Company research' })
      : screen.getByRole('heading', { name: 'Account A' }).closest('section')!;
    await waitFor(() => expect(panel.contains(document.activeElement)).toBe(true));
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll).toHaveBeenCalledWith({ block: 'start' });
    expect(scroll.mock.contexts[0]).toBe(panel);
    expect(f.api.localWorkspace.researchCompany).not.toHaveBeenCalled();
    expect(f.calls.some(c => c.method === 'forbidden')).toBe(false);
  } finally { Element.prototype.scrollIntoView = original; }
}, 10_000);

it('step controls also focus their panel on the local-only Accounts view while the daily read is unavailable', async () => {
  const f = f4Api(); f.api.daily.get = vi.fn(async () => { throw Error('daily unavailable'); });
  f.api.localWorkspace.get.mockResolvedValue(withPreparation(stepPreparation('reopen_draft')));
  const scroll = vi.fn(), original = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = scroll;
  try {
    render(f4Tree(f.api));
    await screen.findByText(/Daily workspace unavailable/);
    fireEvent.click(await screen.findByRole('button', { name: 'Reopen draft · Account A' }));
    const panel = await screen.findByRole('region', { name: 'Company draft' });
    await waitFor(() => expect(panel.contains(document.activeElement)).toBe(true));
    expect(scroll).toHaveBeenCalledWith({ block: 'start' });
    expect(scroll.mock.contexts[0]).toBe(panel);
  } finally { Element.prototype.scrollIntoView = original; }
}, 10_000);

// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalCompanyDetail, LocalCompanyResearchStatus, LocalWorkspaceApi, SelectedResearch } from '../../../shared/contracts/localWorkspaceContract';
import { LocalCompanyResearchPanel } from './LocalCompanyResearchPanel';
import { createLocalCompanyContinuation } from './localCompanyContinuation';

const NOW = '2026-09-10T12:00:00.000Z';
const FIRST = '10000000-0000-4000-8000-000000000001';
const SECOND = '10000000-0000-4000-8000-000000000002';
const request = (accountId = 'a'): Readonly<SelectedResearch> => Object.freeze({ accountId, commandId: FIRST });
function status(r: Readonly<SelectedResearch>, state: LocalCompanyResearchStatus['state']): LocalCompanyResearchStatus {
  return { ...r, state, receipt: state === 'completed' ? { accountId: r.accountId, version: 2, duplicate: false } : null, reason: state === 'held' ? 'capability_unavailable' : null };
}
function detail(accountId = 'a', marker = 'current'): LocalCompanyDetail {
  return { scope: 'local_database', generatedAt: NOW, snapshot: { account: { id: accountId, name: `Company ${accountId}`, domain: `${accountId}.example`, version: 1 },
    claims: [], routes: [], portfolio: [], unknowns: [`Unknown ${marker}`], conflicts: [], fingerprint: 'a'.repeat(64) },
    sources: [{ id: `source-${accountId}`, url: `https://${accountId}.example/about`, fetchedAt: NOW, sha256: 'b'.repeat(64), excerpt: `Evidence ${marker}`, permitted: true }], links: [] };
}
type PanelApi = Pick<LocalWorkspaceApi, 'getCompany' | 'researchCompany' | 'getCompanyResearchStatus'>;
const releases: Array<() => void> = [];
const pending: Promise<unknown>[] = [];
const owners: ReturnType<typeof createLocalCompanyContinuation>[] = [];
function deferred<T>(fallback: T) {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  releases.push(() => resolve(fallback)); pending.push(promise);
  return { promise, resolve, reject };
}
function fixture() {
  const bundle = createLocalCompanyContinuation(); owners.push(bundle); bundle.activate();
  const c = bundle.continuation; c.selectAccount(c.captureEpoch(), 'a');
  const api = { getCompany: vi.fn<PanelApi['getCompany']>(async ({ accountId }) => detail(accountId)),
    researchCompany: vi.fn<PanelApi['researchCompany']>(async r => status(r, 'held')),
    getCompanyResearchStatus: vi.fn<PanelApi['getCompanyResearchStatus']>(async r => status(r, 'not_recorded')) };
  return { bundle, c, api };
}
async function mount(f: ReturnType<typeof fixture>, accountId = 'a') {
  const view = render(<LocalCompanyResearchPanel accountId={accountId} api={f.api} continuation={f.c} />);
  await waitFor(() => expect(f.api.getCompany).toHaveBeenCalledWith({ accountId }));
  await act(async () => { await Promise.resolve(); });
  return view;
}
function seed(f: ReturnType<typeof fixture>, state: LocalCompanyResearchStatus['state'] | 'unknown') {
  const r = request(); const token = f.c.beginResearch(f.c.captureEpoch(), r); expect(token).not.toBeNull();
  f.c.settleResearch(token!, state === 'unknown' ? { outcome: 'unknown' } : { outcome: 'known', status: status(r, state) });
  return r;
}
const researchButton = () => screen.getByRole('button', { name: /^Research(?: company)?$/i });
const resumeButton = () => screen.getByRole('button', { name: /^Resume research$/i });
const checkButton = () => screen.getByRole('button', { name: /^Check status$/i });
function expectResumeHeld() { const button = screen.queryByRole('button', { name: /^Resume research$/i }); if (button) expect((button as HTMLButtonElement).disabled).toBe(true); }
afterEach(async () => {
  try { cleanup(); } finally {
    try { await act(async () => { for (const release of releases.splice(0)) release(); await Promise.allSettled(pending.splice(0)); }); }
    finally { for (const owner of owners.splice(0)) owner.invalidate(); vi.restoreAllMocks(); vi.useRealTimers(); }
  }
});

describe('selected local company research panel', () => {
  it('F4-panel-01 displays complete source metadata and escaped text without launching URLs or mutating on mount', async () => {
    const f = fixture(); const value = detail(); const excerpt = '<img src=x onerror="alert(1)"><script>forbidden()</script>';
    value.sources[0].excerpt = excerpt;
    value.snapshot.claims = [{ kind: 'fact', key: 'technology', value: 'Recorded software', evidenceIds: ['source-a'] }, { kind: 'hypothesis', key: 'pain', value: 'Possible delay', evidenceIds: [] }];
    value.snapshot.conflicts = ['Conflicting company totals'];
    f.api.getCompany.mockResolvedValue(value); const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const uuid = vi.spyOn(crypto, 'randomUUID'); await mount(f);
    const source = await screen.findByText(excerpt); expect(source.closest('pre')).not.toBeNull();
    expect(source.querySelector('img,script')).toBeNull(); expect(screen.getByText(value.sources[0].url)).toBeTruthy();
    expect(screen.getByText(value.sources[0].sha256)).toBeTruthy(); expect(screen.getAllByText(NOW, { exact: false }).length).toBeGreaterThan(0);
    expect(screen.getByText(/Fact.*Recorded software/i)).toBeTruthy(); expect(screen.getByText(/Hypothesis.*Possible delay/i)).toBeTruthy();
    expect(screen.getByText(/Unknown current/i)).toBeTruthy(); expect(screen.getByText(/Conflicting company totals/)).toBeTruthy();
    expect(f.api.researchCompany).not.toHaveBeenCalled(); expect(uuid).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
  }, 10_000);

  it('F4-panel-02 differentiates unavailable detail from a successful empty source set', async () => {
    const f = fixture(); f.api.getCompany.mockRejectedValue(new Error('PRIVATE_PATH /workspace.sqlite'));
    const view = await mount(f); expect(await screen.findByText('Company evidence unavailable. Reopen this detail to check again.')).toBeTruthy();
    expect(screen.queryByText(/no (?:saved |admitted )?sources/i)).toBeNull(); expect(document.body.textContent).not.toContain('PRIVATE_PATH');
    view.unmount(); const empty = detail(); empty.sources = []; f.api.getCompany.mockResolvedValue(empty);
    await mount(f); expect(await screen.findByText(/no (?:saved |admitted )?sources/i)).toBeTruthy(); expect(f.api.researchCompany).not.toHaveBeenCalled();
  }, 10_000);

  it('F4-panel-03 only explicit Research mints one UUID and reserves before transport despite same-turn double click', async () => {
    const f = fixture(); const r = request(); const gate = deferred(status(r, 'completed'));
    const uuid = vi.spyOn(crypto, 'randomUUID').mockReturnValue(FIRST);
    f.api.researchCompany.mockImplementation(input => { expect(f.c.snapshot().research!.outcome).toBe('pending'); expect(f.c.snapshot().research!.request).toBe(input); return gate.promise; });
    await mount(f); expect(uuid).not.toHaveBeenCalled();
    const button = researchButton(); act(() => { fireEvent.click(button); fireEvent.click(button); });
    expect(uuid).toHaveBeenCalledOnce(); expect(f.api.researchCompany).toHaveBeenCalledOnce();
    const frozen = f.api.researchCompany.mock.calls[0][0]; expect(Object.isFrozen(frozen)).toBe(true); expect(frozen).toEqual(r);
    expect(f.c.snapshot().research!.outcome).toBe('pending'); expectResumeHeld();
    await act(async () => gate.resolve(status(r, 'completed'))); expect(f.c.snapshot().research!.status!.state).toBe('completed');
  }, 10_000);

  it('F4-panel-04 rejection and not_recorded retain the original request for explicit double-guarded Resume', async () => {
    const f = fixture(); const uuid = vi.spyOn(crypto, 'randomUUID').mockReturnValue(FIRST);
    f.api.researchCompany.mockRejectedValueOnce(new Error('lost')); await mount(f); fireEvent.click(researchButton());
    await waitFor(() => expect(f.c.snapshot().research!.outcome).toBe('unknown')); const original = f.c.snapshot().research!.request;
    fireEvent.click(checkButton()); await waitFor(() => expect(f.c.snapshot().research!.status!.state).toBe('not_recorded'));
    expect(f.api.researchCompany).toHaveBeenCalledOnce(); expect(f.c.snapshot().research!.request).toBe(original);
    const gate = deferred(status(original, 'completed')); f.api.researchCompany.mockReturnValueOnce(gate.promise);
    expect(screen.getByText('May fetch permitted sources or reconcile this existing attempt.')).toBeTruthy();
    const resume = resumeButton(); act(() => { fireEvent.click(resume); fireEvent.click(resume); });
    expect(f.api.researchCompany).toHaveBeenCalledTimes(2); expect(f.api.researchCompany.mock.calls[1][0]).toBe(original); expect(uuid).toHaveBeenCalledOnce();
    await act(async () => gate.resolve(status(original, 'completed'))); expect(f.c.snapshot().research!.status!.state).toBe('completed');
  }, 10_000);

  it.each(['queued', 'held', 'running'] as const)('F4-panel-05 retained %s plus restored capability never executes until explicit Resume', async state => {
    const f = fixture(); const original = seed(f, state); f.api.getCompanyResearchStatus.mockImplementation(async r => status(r, state));
    const uuid = vi.spyOn(crypto, 'randomUUID'); const view = await mount(f);
    fireEvent.click(checkButton()); await act(async () => { window.dispatchEvent(new Event('focus')); });
    view.unmount(); await mount(f); expect(f.api.researchCompany).not.toHaveBeenCalled(); expect(uuid).not.toHaveBeenCalled();
    f.api.researchCompany.mockImplementation(async r => status(r, 'completed'));
    fireEvent.click(resumeButton()); await waitFor(() => expect(f.c.snapshot().research!.status!.state).toBe('completed'));
    expect(f.api.researchCompany.mock.calls).toEqual([[original]]); expect(uuid).not.toHaveBeenCalled();
  }, 10_000);

  it('F4-panel-06 parked observation followed by rejected execution stays unknown parked with Resume held', async () => {
    const f = fixture(); const r = request(); const gate = deferred(status(r, 'completed'));
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(FIRST); f.api.researchCompany.mockReturnValueOnce(gate.promise);
    f.api.getCompanyResearchStatus.mockImplementation(async input => status(input, 'parked'));
    await mount(f); fireEvent.click(researchButton()); fireEvent.click(checkButton());
    await waitFor(() => expect(f.c.snapshot().research!.status!.state).toBe('parked'));
    expect(f.c.snapshot().research!.outcome).toBe('pending');
    await act(async () => gate.reject(new Error('lost execution response')));
    expect(f.c.snapshot().research!.outcome).toBe('unknown'); expect(f.c.snapshot().research!.status!.state).toBe('parked'); expectResumeHeld();
    expect(f.api.researchCompany).toHaveBeenCalledOnce(); expect(f.c.snapshot().research!.request).toEqual(r);
  }, 10_000);

  it('F4-panel-07 deliberate new Research after known parked uses a new UUID but never resumes parked', async () => {
    const f = fixture(); const original = seed(f, 'parked'); f.api.getCompanyResearchStatus.mockImplementation(async r => status(r, 'parked'));
    const uuid = vi.spyOn(crypto, 'randomUUID').mockReturnValue(SECOND); await mount(f); expectResumeHeld(); expect(f.api.researchCompany).not.toHaveBeenCalled();
    fireEvent.click(researchButton()); await waitFor(() => expect(f.api.researchCompany).toHaveBeenCalledOnce());
    expect(f.api.researchCompany.mock.calls[0][0]).toEqual({ accountId: 'a', commandId: SECOND });
    expect(f.api.researchCompany.mock.calls[0][0]).not.toBe(original); expect(uuid).toHaveBeenCalledOnce();
  }, 10_000);

  it('F4-panel-08 Check not_recorded while pending cannot admit Resume or a replacement Research', async () => {
    const f = fixture(); const r = request(); const gate = deferred(status(r, 'completed'));
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(FIRST); f.api.researchCompany.mockReturnValueOnce(gate.promise);
    await mount(f); fireEvent.click(researchButton()); fireEvent.click(checkButton());
    await waitFor(() => expect(f.c.snapshot().research!.status!.state).toBe('not_recorded'));
    expect(f.c.snapshot().research!.outcome).toBe('pending'); expectResumeHeld();
    fireEvent.click(researchButton()); expect(f.api.researchCompany).toHaveBeenCalledOnce();
    await act(async () => gate.resolve(status(r, 'completed'))); expect(f.c.snapshot().research!.status!.state).toBe('completed');
  }, 10_000);

  it('F4-panel-09 checks before and during Resume cannot overwrite completion across panel remount', async () => {
    const f = fixture(); const r = seed(f, 'unknown'); const view = await mount(f);
    const before = deferred(status(r, 'queued')); const priorChecks = f.api.getCompanyResearchStatus.mock.calls.length;
    f.api.getCompanyResearchStatus.mockReturnValueOnce(before.promise); fireEvent.click(checkButton());
    expect(f.api.getCompanyResearchStatus).toHaveBeenCalledTimes(priorChecks + 1);
    const execution = deferred(status(r, 'completed')); f.api.researchCompany.mockReturnValueOnce(execution.promise); fireEvent.click(resumeButton());
    const during = deferred(status(r, 'running')); view.unmount();
    f.api.getCompanyResearchStatus.mockImplementation(() => during.promise); await mount(f); fireEvent.click(checkButton());
    expect(f.api.getCompanyResearchStatus.mock.calls.length).toBeGreaterThan(priorChecks + 1);
    expect(f.c.snapshot().research!.outcome).toBe('pending'); expect(f.api.researchCompany).toHaveBeenCalledOnce();
    await act(async () => execution.resolve(status(r, 'completed')));
    await act(async () => { before.resolve(status(r, 'queued')); during.resolve(status(r, 'running')); });
    expect(f.c.snapshot().research!.status!.state).toBe('completed'); expect(f.c.snapshot().research!.outcome).toBe('known'); expect(f.c.snapshot().research!.request).toBe(r);
    f.api.getCompanyResearchStatus.mockImplementation(async input => ({ ...status(input, 'completed'), receipt: { accountId: 'a', version: 3, duplicate: true } }));
    fireEvent.click(checkButton()); await waitFor(() => expect(f.c.snapshot().research!.status!.receipt!.version).toBe(3));
    expect(f.api.researchCompany).toHaveBeenCalledOnce();
  }, 10_000);

  it('F4-panel-10 A to B to A ignores first A detail and keeps latest evidence', async () => {
    const f = fixture(); const old = deferred(detail('a', 'obsolete')); f.api.getCompany.mockReturnValueOnce(old.promise);
    const view = await mount(f); act(() => { f.c.selectAccount(f.c.captureEpoch(), 'b'); });
    view.rerender(<LocalCompanyResearchPanel accountId="b" api={f.api} continuation={f.c} />); await screen.findByText('Evidence current');
    act(() => { f.c.selectAccount(f.c.captureEpoch(), 'a'); }); f.api.getCompany.mockResolvedValueOnce(detail('a', 'fresh-return'));
    view.rerender(<LocalCompanyResearchPanel accountId="a" api={f.api} continuation={f.c} />); await screen.findByText('Evidence fresh-return');
    await act(async () => old.resolve(detail('a', 'obsolete'))); expect(screen.queryByText('Evidence obsolete')).toBeNull();
    expect(screen.getByText('Evidence fresh-return')).toBeTruthy(); expect(f.c.snapshot().selectedAccountId).toBe('a'); expect(f.api.researchCompany).not.toHaveBeenCalled();
  }, 10_000);

  it('F4-panel-11 API replacement reusing account ID cannot publish old detail into new view', async () => {
    const f = fixture(); const old = deferred(detail('a', 'old-api')); f.api.getCompany.mockReturnValueOnce(old.promise); const view = await mount(f);
    const next = fixture(); next.api.getCompany.mockResolvedValue(detail('a', 'new-api'));
    view.rerender(<LocalCompanyResearchPanel accountId="a" api={next.api} continuation={next.c} />); await screen.findByText('Evidence new-api');
    await act(async () => old.resolve(detail('a', 'old-api'))); expect(screen.queryByText('Evidence old-api')).toBeNull(); expect(screen.getByText('Evidence new-api')).toBeTruthy();
    expect(next.c.snapshot().research).toBeNull();
  }, 10_000);

  it('F4-panel-12 selecting B and closing its detail never discards unresolved A or selects A on late completion', async () => {
    const f = fixture(); const r = request(); const gate = deferred(status(r, 'completed')); vi.spyOn(crypto, 'randomUUID').mockReturnValue(FIRST);
    f.api.researchCompany.mockReturnValueOnce(gate.promise); const view = await mount(f); fireEvent.click(researchButton());
    act(() => { f.c.selectAccount(f.c.captureEpoch(), 'b'); }); view.rerender(<LocalCompanyResearchPanel accountId="b" api={f.api} continuation={f.c} />);
    await waitFor(() => expect(f.api.getCompany).toHaveBeenCalledWith({ accountId: 'b' })); fireEvent.click(researchButton()); expect(f.api.researchCompany).toHaveBeenCalledOnce();
    act(() => { f.c.selectAccount(f.c.captureEpoch(), null); }); view.unmount(); await act(async () => gate.resolve(status(r, 'completed')));
    expect(f.c.snapshot().selectedAccountId).toBeNull(); expect(f.c.snapshot().research!.status!.state).toBe('completed'); expect(f.c.snapshot().research!.request).toEqual(r);
  }, 10_000);

  it('F4-panel-13 Check failure preserves retained state and hides transport secrets', async () => {
    const f = fixture(); seed(f, 'queued'); f.api.getCompanyResearchStatus.mockImplementation(async r => status(r, 'queued')); await mount(f);
    const previous = f.c.snapshot().research; f.api.getCompanyResearchStatus.mockRejectedValueOnce(new Error('SECRET_DB /private/path'));
    fireEvent.click(checkButton()); expect(await screen.findByText(/unavailable|could not check/i)).toBeTruthy();
    expect(f.c.snapshot().research).toBe(previous); expect(document.body.textContent).not.toContain('SECRET_DB'); expect(f.api.researchCompany).not.toHaveBeenCalled();
  }, 10_000);

  it('F4-panel-14 StrictMode setup permits an actual action without automatic execution', async () => {
    const f = fixture(); const uuid = vi.spyOn(crypto, 'randomUUID').mockReturnValue(FIRST);
    render(<StrictMode><LocalCompanyResearchPanel accountId="a" api={f.api} continuation={f.c} /></StrictMode>);
    await screen.findByText('Evidence current'); expect(f.api.researchCompany).not.toHaveBeenCalled(); expect(uuid).not.toHaveBeenCalled();
    fireEvent.click(researchButton()); await waitFor(() => expect(f.c.snapshot().research!.status!.state).toBe('held'));
    expect(f.api.researchCompany).toHaveBeenCalledOnce(); expect(uuid).toHaveBeenCalledOnce();
  }, 10_000);
});


it('F4-panel-15 elapsed time and detached view do not declare a live research invocation stopped', async () => {
  const f = fixture(); const r = request(); const gate = deferred(status(r, 'completed'));
  vi.spyOn(crypto, 'randomUUID').mockReturnValue(FIRST); f.api.researchCompany.mockReturnValueOnce(gate.promise);
  const view = await mount(f); vi.useFakeTimers(); fireEvent.click(researchButton());
  await act(async () => { vi.advanceTimersByTime(60_000); }); expect(f.c.snapshot().research!.outcome).toBe('pending');
  view.unmount(); await act(async () => { vi.advanceTimersByTime(60_000); });
  expect(f.c.snapshot().research!.outcome).toBe('pending'); expect(f.api.researchCompany).toHaveBeenCalledOnce();
  await act(async () => gate.resolve(status(r, 'completed'))); expect(f.c.snapshot().research!.status!.state).toBe('completed');
  vi.useRealTimers();
}, 10_000);

it('F4-panel-16 mismatched execution response becomes unknown and keeps exact request for explicit recovery', async () => {
  const f = fixture(); vi.spyOn(crypto, 'randomUUID').mockReturnValue(FIRST);
  f.api.researchCompany.mockImplementationOnce(async r => ({ ...status(r, 'completed'), accountId: 'wrong-account' }));
  await mount(f); fireEvent.click(researchButton()); await waitFor(() => expect(f.c.snapshot().research!.outcome).toBe('unknown'));
  const original = f.c.snapshot().research!.request; expect(f.c.snapshot().research!.status).toBeNull();
  f.api.researchCompany.mockImplementationOnce(async r => status(r, 'completed')); fireEvent.click(resumeButton());
  await waitFor(() => expect(f.c.snapshot().research!.status!.state).toBe('completed'));
  expect(f.api.researchCompany.mock.calls[1][0]).toBe(original);
}, 10_000);

it('links to Connections without changing selected company or starting another attempt', async () => {
  const f = fixture(); await mount(f);
  const link = screen.getByRole('link', { name: 'Set up local research' });
  expect(link.getAttribute('href')).toBe('#/settings');
  fireEvent.click(link);
  expect(window.sessionStorage.getItem('callie.settings.section')).toBe('connections');
  expect(f.c.snapshot().selectedAccountId).toBe('a');
  expect(f.api.researchCompany).not.toHaveBeenCalled();
  expect(screen.getByText(/new potentially paid attempt/)).toBeTruthy();
  expect(screen.getAllByRole('button', { name: 'Research' })).toHaveLength(1);
});

function setupFixture(): Awaited<ReturnType<LocalWorkspaceApi['getCompanyResearchSettings']>> {
  return { revision: 1, profiles: [], blockedReason: null, reservedOrSpentMicros: 10000, configuration: { version: 1, mode: 'known_company', state: 'active', profileId: 'reviewed-fixture', maxAccountBudgetMicros: 5000000, permittedSources: ['https://a.example/about'], researchLimits: { maxCompanies: 1, maxPages: 1, maxBytes: 250000, maxCostMicros: 20000, knownCompanyExtraction: { version: 1, model: 'fixture-model', maxCostMicros: 20000, maxInputBytes: 20000, maxOutputTokens: 2048, inputMicrosPerMillionTokens: 400000, outputMicrosPerMillionTokens: 1600000 } } } };
}
it.each(['paused', 'conflict', 'mismatch', 'unavailable'] as const)('holds new attempts when local setup is %s without losing old evidence or recovery controls', async kind => {
  const f = fixture(); seed(f, 'held'); const value = setupFixture();
  if (kind === 'paused') value.configuration!.state = 'paused';
  if (kind === 'conflict') value.blockedReason = 'paired_research_present';
  if (kind === 'mismatch') value.configuration!.permittedSources = ['https://www.a.example/about'];
  const getCompanyResearchSettings = vi.fn(async () => { if (kind === 'unavailable') throw Error('private'); return value; });
  render(<LocalCompanyResearchPanel accountId="a" api={{ ...f.api, getCompanyResearchSettings }} continuation={f.c} />);
  await screen.findByText('Evidence current'); await waitFor(() => expect(getCompanyResearchSettings).toHaveBeenCalledTimes(1));
  expect((researchButton() as HTMLButtonElement).disabled).toBe(true);
  expect(checkButton()).toBeTruthy(); expect(resumeButton()).toBeTruthy();
  fireEvent.click(researchButton()); expect(f.api.researchCompany).not.toHaveBeenCalled();
  expect(f.c.snapshot().selectedAccountId).toBe('a');
});
it('matching active local sources enable only the existing explicit Research action', async () => {
  const f = fixture(); const getCompanyResearchSettings = vi.fn(async () => setupFixture());
  render(<LocalCompanyResearchPanel accountId="a" api={{ ...f.api, getCompanyResearchSettings }} continuation={f.c} />);
  await screen.findByText(/Local known-company setup applies/);
  expect(f.api.researchCompany).not.toHaveBeenCalled(); expect((researchButton() as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(researchButton()); await waitFor(() => expect(f.api.researchCompany).toHaveBeenCalledTimes(1));
});
it('preserves existing paired Research when no standalone record exists', async () => {
  const f = fixture(); const value = setupFixture(); value.configuration = null; value.blockedReason = 'paired_research_present';
  render(<LocalCompanyResearchPanel accountId="a" api={{ ...f.api, getCompanyResearchSettings: async () => value }} continuation={f.c} />);
  await screen.findByText('Evidence current');
  expect((researchButton() as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(researchButton()); await waitFor(() => expect(f.api.researchCompany).toHaveBeenCalledTimes(1));
});

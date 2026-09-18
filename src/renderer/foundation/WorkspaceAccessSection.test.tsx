// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CalliePreloadApi } from '../../shared/preload';
import { WorkspaceAccessSection } from './WorkspaceAccessSection';

type Api = Pick<CalliePreloadApi['delegation'], 'status' | 'configure' | 'sync'>;
type Status = Awaited<ReturnType<Api['status']>>;
type Receipt = Awaited<ReturnType<Api['configure']>>;
const updatedAt = '2026-09-10T23:00:00.000Z';
const limits = { maxCompanies: 2, maxPages: 3, maxBytes: 1234, maxCostMicros: 5678 };
const research: NonNullable<Receipt['configuration']['research']> = {
  workspaceId: 'workspace', budgetId: 'budget', audience: { residential: true, regions: ['East'], terms: ['fixture'] },
  audienceRevision: 2, sourceRevision: 3, budgetRevision: 4, discoveryLimits: limits,
  researchLimits: { ...limits, maxPages: 5 }, capability: { model: 'fixture', webSearch: true, searchCostMicros: 10, modelCostMicros: 20 },
  maxAccountBudgetMicros: 123, permittedSources: ['https://fixture.invalid/source'], preparationCommandId: '11111111-1111-4111-8111-111111111111',
};
const status = (state: 'active' | 'paused' = 'paused', revision: number | null = 7): Status => ({
  state, workspaceId: 'workspace', endpoint: 'https://fixture.invalid',
  configuration: revision === null ? null : { revision, updatedAt, configuration: { version: 1, state, research } },
});
const receipt = (state: 'active' | 'paused' = 'active', revision = 8): Receipt => ({ revision, updatedAt, configuration: { version: 1, state, research } });
function api(initial = status()) {
  return {
    status: vi.fn<Api['status']>(async () => initial),
    configure: vi.fn<Api['configure']>(async input => ({ revision: input.expectedRevision + 1, updatedAt, configuration: input.configuration })),
    sync: vi.fn<Api['sync']>(async () => ({ applied: 2, gaps: 0, cursor: null, ownerFresh: true, failure: null })),
  } satisfies Api;
}
const joins: Array<() => Promise<void>> = [];
function deferred<T>(fallback: T) {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  joins.push(async () => { resolve(fallback); await promise; });
  return { promise, resolve, fallback };
}
async function settle<T>(pending: ReturnType<typeof deferred<T>>) {
  await act(async () => { pending.resolve(pending.fallback); await pending.promise; });
}
afterEach(async () => { cleanup(); for (const join of joins.splice(0)) await join(); vi.restoreAllMocks(); });
const button = (name: string) => screen.getByRole<HTMLButtonElement>('button', { name });
const checkbox = () => screen.getByRole<HTMLInputElement>('checkbox');
const refresh = () => fireEvent.click(button('Refresh setup status'));
const sync = () => fireEvent.click(button('Sync saved cloud work'));
const configure = (state = 'paused') => fireEvent.click(button(state === 'active' ? 'Pause cloud work on this Mac' : 'Enable this Mac for cloud work'));
async function ready(a = api()) {
  const view = render(<WorkspaceAccessSection api={a} />);
  await waitFor(() => expect(button('Refresh setup status').disabled).toBe(false));
  return view;
}

describe('Workspace access explicit setup controls', () => {
  it('reads on mount, holds pending and performs no automatic mutation or sync', async () => {
    const a = api(); const pending = deferred(status()); a.status.mockReturnValueOnce(pending.promise);
    render(<WorkspaceAccessSection api={a} />);
    expect(checkbox().disabled).toBe(true); expect(button('Refresh setup status').disabled).toBe(true);
    sync(); expect(a.sync).not.toHaveBeenCalled(); expect(a.configure).not.toHaveBeenCalled();
    await settle(pending);
    expect(button('Enable this Mac for cloud work').disabled).toBe(true);
    expect(a.status.mock.calls).toEqual([[]]); expect(a.sync).not.toHaveBeenCalled();
    expect(screen.getByText(/Cloud work may continue/)).toBeTruthy();
    expect(screen.getByText(/not read-only/)).toBeTruthy();
    const region = screen.getByRole('region', { name: 'Workspace access' });
    expect(region.classList.contains('workspace-access')).toBe(true);
    expect(region.querySelectorAll('dl > .settings__counter')).toHaveLength(3);
  });

  it.each(['unconfigured', 'locked', 'mismatch', 'missing connection'] as const)('holds %s setup without an enabled configuration action', async mode => {
    const initial = status();
    if (mode === 'unconfigured' || mode === 'locked') initial.state = mode;
    if (mode === 'mismatch') initial.state = 'active';
    if (mode === 'missing connection') initial.endpoint = null;
    const a = api(initial); await ready(a);
    expect(checkbox().disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /Enable this Mac|Pause cloud work/ })).toBeNull();
    if (mode !== 'mismatch') { expect(button('Sync saved cloud work').disabled).toBe(true); expect(screen.getByText(/restart the application/)).toBeTruthy(); }
    expect(a.configure).not.toHaveBeenCalled(); expect(a.sync).not.toHaveBeenCalled();
  });

  it.each(['paused', 'active', 'absent'] as const)('changes %s configuration with acknowledgement, preflight, frozen CAS and preserved policy', async state => {
    const initial = status(state === 'active' ? 'active' : 'paused', state === 'absent' ? null : 7);
    const a = api(initial); await ready(a);
    configure(state); expect(a.configure).not.toHaveBeenCalled();
    fireEvent.click(checkbox());
    const followup = status(state === 'active' ? 'paused' : 'active', state === 'absent' ? 1 : 8);
    a.status.mockResolvedValueOnce(initial).mockResolvedValueOnce(followup);
    configure(state);
    await waitFor(() => expect(a.status).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(button('Refresh setup status').disabled).toBe(false));
    const request = a.configure.mock.calls[0][0];
    expect(request).toEqual({ expectedRevision: state === 'absent' ? 0 : 7, configuration: {
      version: 1, state: state === 'active' ? 'paused' : 'active', research: state === 'absent' ? null : research,
    } });
    expect(Object.isFrozen(request)).toBe(true); expect(Object.isFrozen(request.configuration)).toBe(true);
    if (request.configuration.research) expect(Object.isFrozen(request.configuration.research.audience.regions)).toBe(true);
    expect(checkbox().checked).toBe(false); expect(a.sync).not.toHaveBeenCalled();
    expect(screen.getByText(`Local setup: ${followup.state}`)).toBeTruthy();
  });

  it('holds research policy that schema parsing would normalize rather than rewriting it', async () => {
    const initial = status();
    if (!initial.configuration) throw Error('Fixture requires configuration');
    initial.configuration.configuration.research = { ...research, audience: { ...research.audience, terms: [' fixture '] } };
    const a = api(initial); await ready(a);
    expect(screen.getByText(/Setup status could not be read/)).toBeTruthy();
    expect(checkbox().disabled).toBe(true); expect(a.configure).not.toHaveBeenCalled();
    expect(initial.configuration.configuration.research.audience.terms).toEqual([' fixture ']);
  });

  it('changed preflight publishes current facts and consumes acknowledgement without submitting', async () => {
    const a = api(); await ready(a); fireEvent.click(checkbox());
    a.status.mockResolvedValueOnce(status('active', 9)); configure();
    await screen.findByText(/Setup changed since/);
    expect(a.configure).not.toHaveBeenCalled(); expect(checkbox().checked).toBe(false);
    expect(screen.getByText('active, revision 9')).toBeTruthy();
    expect(button('Pause cloud work on this Mac').disabled).toBe(true);
    fireEvent.click(checkbox()); a.status.mockResolvedValueOnce(status()); refresh();
    await screen.findByText('paused, revision 7'); expect(checkbox().checked).toBe(false);
  });

  it.each(['throw', 'wrong revision', 'wrong policy'] as const)('unknown %s configure receipt holds until explicit refresh and new acknowledgement', async mode => {
    const a = api(); await ready(a);
    if (mode === 'throw') a.configure.mockRejectedValueOnce(Error('private details'));
    if (mode === 'wrong revision') a.configure.mockResolvedValueOnce(receipt('active', 19));
    if (mode === 'wrong policy') a.configure.mockResolvedValueOnce({ ...receipt(), configuration: { version: 1, state: 'active', research: null } });
    fireEvent.click(checkbox()); configure();
    expect((await screen.findByRole('alert')).textContent).toContain('Configuration outcome could not be verified');
    expect(a.status).toHaveBeenCalledTimes(2); expect(a.configure).toHaveBeenCalledTimes(1);
    expect(checkbox().checked).toBe(false); expect(checkbox().disabled).toBe(true);
    expect(document.body.textContent).not.toContain('private details');
    refresh(); await waitFor(() => expect(checkbox().disabled).toBe(false));
    expect(button('Enable this Mac for cloud work').disabled).toBe(true);
    expect(a.configure).toHaveBeenCalledTimes(1);
  });

  it('confirmed receipt with failed readback does not expose stale state or retry', async () => {
    const a = api(); await ready(a);
    a.status.mockResolvedValueOnce(status()).mockRejectedValueOnce(Error('read failed'));
    fireEvent.click(checkbox()); configure(); await screen.findByText(/Setup status could not be read/);
    expect(screen.getByText('Setup status unavailable')).toBeTruthy(); expect(checkbox().disabled).toBe(true);
    expect(a.configure).toHaveBeenCalledTimes(1); expect(a.status).toHaveBeenCalledTimes(3);
  });

  it.each(['current', 'gaps', 'stale', 'invalid'] as const)('sync is explicit and validates %s report without configuring', async mode => {
    const a = api(); await ready(a);
    a.sync.mockResolvedValueOnce({ applied: 2, gaps: mode === 'gaps' ? 1 : 0, cursor: null,
      ownerFresh: mode !== 'stale', failure: mode === 'gaps' ? 'gap' : mode === 'stale' ? 'timeout' : null, ...(mode === 'invalid' ? { extra: true } : {}) });
    expect(a.sync).not.toHaveBeenCalled(); sync();
    const feedback = await screen.findByText(mode === 'invalid' ? /Sync outcome unknown/ : mode === 'current' ? /Last sync report: owner events fresh/ : /sync is incomplete/);
    expect(feedback.getAttribute('role')).toBe(mode === 'current' ? 'status' : 'alert');
    if (mode !== 'invalid') expect(feedback.textContent).toContain('Queued commands may remain unresolved even when owner events are fresh.');
    // A complete run says nothing about a stop; a short run names the reason from the closed set.
    if (mode === 'current') expect(feedback.textContent).not.toContain('Sync stopped');
    if (mode === 'gaps') expect(feedback.textContent).toContain('Sync stopped: found a gap in the event stream at cursor none yet.');
    if (mode === 'stale') expect(feedback.textContent).toContain('Sync stopped: timed out after 120 s at cursor none yet.');
    expect(a.sync.mock.calls).toEqual([[]]); expect(a.configure).not.toHaveBeenCalled(); expect(a.status).toHaveBeenCalledTimes(1);
  });

  it('names a timed-out run and the cursor the next sync resumes from', async () => {
    const a = api(); await ready(a);
    a.sync.mockResolvedValueOnce({ applied: 400, gaps: 0, cursor: `${'a'.repeat(64)}:400`, ownerFresh: false, failure: 'timeout' });
    sync();
    const feedback = await screen.findByRole('alert');
    expect(feedback.textContent).toContain('Applied: 400. Gaps: 0. Owner fresh: no.');
    expect(feedback.textContent).toContain(`Sync stopped: timed out after 120 s at cursor ${'a'.repeat(64)}:400. The next sync resumes from that cursor.`);
  });
});

describe('Workspace access operation lifetimes', () => {
  it('serializes preflight, configure and readback, including same-batch clicks', async () => {
    const a = api(); await ready(a); fireEvent.click(checkbox());
    const preflight = deferred(status()); const saving = deferred(receipt()); const readback = deferred(status('active', 8));
    a.status.mockReturnValueOnce(preflight.promise).mockReturnValueOnce(readback.promise); a.configure.mockReturnValueOnce(saving.promise);
    act(() => { configure(); configure(); sync(); refresh(); });
    expect(a.status).toHaveBeenCalledTimes(2); expect(a.configure).not.toHaveBeenCalled();
    await settle(preflight); expect(a.configure).toHaveBeenCalledTimes(1);
    expect(checkbox().disabled).toBe(true); sync(); refresh(); expect(a.sync).not.toHaveBeenCalled();
    await settle(saving); expect(button('Refresh setup status').disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /Enable this Mac|Pause cloud work/ })).toBeNull();
    await settle(readback); expect(button('Refresh setup status').disabled).toBe(false);
    expect(a.configure).toHaveBeenCalledTimes(1); expect(a.status).toHaveBeenCalledTimes(3);
  });

  it('obsolete preflight cannot configure after API replacement', async () => {
    const a = api(); const b = api(status('active', 20)); const view = await ready(a);
    const old = deferred(status()); a.status.mockReturnValueOnce(old.promise);
    fireEvent.click(checkbox()); configure(); view.rerender(<WorkspaceAccessSection api={b} />);
    await screen.findByText('active, revision 20'); await settle(old);
    expect(a.configure).not.toHaveBeenCalled(); expect(b.configure).not.toHaveBeenCalled();
  });

  it('ABA stale configure receipt/finally cannot unlock current pending sync or start readback', async () => {
    const a = api(); const b = api(); const view = await ready(a);
    const old = deferred(receipt()); a.configure.mockReturnValueOnce(old.promise);
    fireEvent.click(checkbox()); configure(); await waitFor(() => expect(a.configure).toHaveBeenCalledTimes(1));
    view.rerender(<WorkspaceAccessSection api={b} />); await waitFor(() => expect(button('Refresh setup status').disabled).toBe(false));
    view.rerender(<WorkspaceAccessSection api={a} />); await waitFor(() => expect(a.status).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(button('Refresh setup status').disabled).toBe(false));
    const fresh = deferred({ applied: 5, gaps: 0, cursor: null, ownerFresh: true, failure: null }); a.sync.mockReturnValueOnce(fresh.promise); sync();
    await settle(old); expect(button('Refresh setup status').disabled).toBe(true); expect(a.status).toHaveBeenCalledTimes(3);
    expect(screen.queryByText(/Local configuration saved/)).toBeNull();
    await settle(fresh); expect(await screen.findByText(/Applied: 5/)).toBeTruthy();
  });

  it('stale status and sync cannot publish after removal or unmount', async () => {
    const a = api(); const oldRead = deferred(status('active', 19)); a.status.mockReturnValueOnce(oldRead.promise);
    const view = render(<WorkspaceAccessSection api={a} />); view.rerender(<WorkspaceAccessSection />);
    await settle(oldRead); expect(screen.getByText('Setup status unavailable')).toBeTruthy();
    view.rerender(<WorkspaceAccessSection api={a} />); await waitFor(() => expect(button('Refresh setup status').disabled).toBe(false));
    const oldSync = deferred({ applied: 99, gaps: 0, cursor: null, ownerFresh: true, failure: null }); a.sync.mockReturnValueOnce(oldSync.promise); sync();
    view.unmount(); await settle(oldSync); expect(a.status).toHaveBeenCalledTimes(2);
    render(<WorkspaceAccessSection api={a} />); await waitFor(() => expect(button('Refresh setup status').disabled).toBe(false));
    expect(screen.queryByText(/Applied: 99/)).toBeNull(); expect(checkbox().checked).toBe(false);
  });
});


describe('Workspace access presentation callbacks', () => {
  it('notifies only after configure readback and validated sync, using the latest callback without resetting setup', async () => {
    const a = api(); const first = vi.fn(); const latest = vi.fn(async () => { throw Error('presentation failure'); });
    const view = render(<WorkspaceAccessSection api={a} onChanged={first} />);
    await waitFor(() => expect(checkbox().disabled).toBe(false));
    expect(first).not.toHaveBeenCalled();
    fireEvent.click(checkbox());
    const readback = deferred(status('active', 8));
    a.status.mockResolvedValueOnce(status()).mockReturnValueOnce(readback.promise);
    configure(); await waitFor(() => expect(a.status).toHaveBeenCalledTimes(3));
    expect(first).not.toHaveBeenCalled();
    view.rerender(<WorkspaceAccessSection api={a} onChanged={latest} />);
    expect(a.status).toHaveBeenCalledTimes(3);
    await settle(readback); expect(latest).toHaveBeenCalledTimes(1); expect(first).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
    sync(); await waitFor(() => expect(latest).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('alert')).toBeNull(); expect(a.configure).toHaveBeenCalledTimes(1); expect(a.sync).toHaveBeenCalledTimes(1);
    refresh(); await waitFor(() => expect(button('Refresh setup status').disabled).toBe(false));
    expect(latest).toHaveBeenCalledTimes(2);
  });

  it('does not notify for failed readback, invalid sync or obsolete completion', async () => {
    const a = api(); const changed = vi.fn();
    const view = render(<WorkspaceAccessSection api={a} onChanged={changed} />);
    await waitFor(() => expect(checkbox().disabled).toBe(false));
    a.status.mockResolvedValueOnce(status()).mockRejectedValueOnce(Error('readback'));
    fireEvent.click(checkbox()); configure(); await screen.findByRole('alert');
    expect(changed).not.toHaveBeenCalled();
    refresh(); await waitFor(() => expect(checkbox().disabled).toBe(false));
    a.sync.mockRejectedValueOnce(Error('sync')); sync(); await screen.findByRole('alert');
    expect(changed).not.toHaveBeenCalled();
    refresh(); await waitFor(() => expect(checkbox().disabled).toBe(false));
    const pending = deferred({ applied: 0, gaps: 0, cursor: null, ownerFresh: true, failure: null });
    a.sync.mockReturnValueOnce(pending.promise); sync(); view.unmount(); await settle(pending);
    expect(changed).not.toHaveBeenCalled();
  });
});

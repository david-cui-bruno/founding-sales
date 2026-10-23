// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { candidateListInputSchema, candidateListSchema } from '@fss/contracts';
import { BrowserClient, type InvalidationChannel } from '../../src/client/BrowserClient.ts';
import { BrowserCandidateInventory } from '../../src/client/BrowserCandidateInventory.tsx';

const id = '10000000-0000-4000-8000-000000000001';
const other = '10000000-0000-4000-8000-000000000002';
const date = '2026-10-23T12:00:00.000Z';
const candidate = { id, revision: 7, status: 'needs_review', firmName: 'Retained ordinary Firm', locality: 'Dallas', region: 'TX', website: 'https://example.test/', sourceUrl: 'https://example.test/source', observedOn: '2026-10-22', preparedBy: 'Controlled fixture', evidence: '<img src=x onerror=alert(1)> Retained passage', signal: 'fit_only', createdAt: date, nextSourceCheckAt: date,
  sourceCheck: { checkId: id, jobId: other, requestedAt: date, state: 'checked', reason: null, checkedAt: date, lastSuccess: { url: 'https://example.test/retained', contentHash: 'a'.repeat(64), retrievedAt: date, excerpt: 'Retained source excerpt', quoteMatched: true, firstParty: true, truncated: false } } };
const page = { candidates: [candidate], hasMore: true, qualificationWaitReason: 'research_held', discovery: { enabled: false, nextRunAt: date, lastResult: 'held', dailyRemaining: 0, monthlyRemaining: 0, halted: true } };
const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status });
function deferred() {
  let resolve!: (response: Response) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<Response>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup() {
  let session = { status: 'signed_in', workspaceId: id, userId: id, deviceId: id, role: 'admin', revision: 'one', csrfToken: 'c'.repeat(40), expiresAt: new Date(Date.now() + 120_000).toISOString() };
  let answer: unknown = page;
  let status = 200;
  let pending: ReturnType<typeof deferred> | undefined;
  let sessionWait: ReturnType<typeof deferred> | undefined;
  const storage = { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() };
  const listeners = new Set<() => void>();
  const channel: InvalidationChannel = { postMessage: vi.fn(), addEventListener: (_type, listener) => { listeners.add(listener); }, removeEventListener: (_type, listener) => { listeners.delete(listener); }, close: vi.fn() };
  const requests: unknown[] = [];
  const send = vi.fn<typeof fetch>(async (url, init) => {
    if (url === '/browser/session') return sessionWait === undefined ? json(session) : await sessionWait.promise;
    if (url !== '/browser/api/sourcing/candidates/list') throw new Error('Unexpected route');
    expect(init?.method).toBe('POST');
    expect(init?.cache).toBe('no-store');
    requests.push(JSON.parse(String(init?.body)));
    return pending === undefined ? json(answer, status) : await pending.promise;
  });
  const randomUUID = vi.fn(() => id);
  const client = new BrowserClient({ fetch: send, storage, channel, navigate: vi.fn(), randomUUID });
  return { client, send, requests, storage, randomUUID,
    answer: (value: unknown, code = 200) => { answer = value; status = code; pending = undefined; },
    change: (value: Partial<typeof session>) => { session = { ...session, ...value }; },
    crossTab: () => { for (const listener of listeners) listener(); },
    delaySession: () => { sessionWait = deferred(); return { ...sessionWait, session }; },
    delay: () => { pending = deferred(); return pending; } };
}
const load = (): void => { fireEvent.click(screen.getByRole('button', { name: 'Load ordinary inventory' })); };
const choose = (value: string): void => { fireEvent.change(screen.getByRole('combobox', { name: 'Inventory status' }), { target: { value } }); };
async function ready(): Promise<void> { await waitFor(() => { expect(screen.getByRole('button', { name: 'Load ordinary inventory' }).hasAttribute('disabled')).toBe(false); }); }
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('ordinary inventory using actual BrowserClient', () => {
  it('only explicitly loads exact read input, renders bounded dated observations and safe nonfetching references without writes or persistence', async () => {
    const scope = setup(); await scope.client.refresh();
    const view = render(<BrowserCandidateInventory client={scope.client} />);
    expect(scope.requests).toEqual([]);
    expect(screen.getByText(/not the ready-qualified research selection/u)).toBeTruthy();
    expect(screen.getByText(/only identity-review cases/u)).toBeTruthy();
    load(); await screen.findByText(candidate.firmName); await ready();
    expect(scope.requests).toEqual([{ status: 'needs_review', offset: 0 }]);
    for (const text of [candidate.evidence, 'Retained source excerpt']) expect(screen.getByText(text)).toBeTruthy();
    expect(screen.getByText(`Candidate ID ${id} · Revision 7 · Status needs_review`)).toBeTruthy();
    expect(screen.getByText(/Observed on 2026-10-22 · Prepared by Controlled fixture/u)).toBeTruthy();
    expect(screen.getByText(/Qualification wait observation at page read/u)).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Retained source-check observation' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Retained discovery metadata' })).toBeTruthy();
    expect(view.container.querySelector('img')).toBeNull();
    for (const link of screen.getAllByRole('link')) {
      expect(link.getAttribute('href')).toMatch(/^https:\/\/example\.test\//u);
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
      expect(link.getAttribute('referrerpolicy')).toBe('no-referrer');
    }
    expect(scope.storage.setItem).not.toHaveBeenCalled(); expect(scope.randomUUID).not.toHaveBeenCalled();
    expect(scope.send.mock.calls.every(([url]) => ['/browser/session', '/browser/api/sourcing/candidates/list'].includes(String(url)))).toBe(true);
    view.unmount(); render(<BrowserCandidateInventory client={scope.client} />);
    expect(screen.queryByText(candidate.firmName)).toBeNull(); expect(scope.requests).toHaveLength(1);
    await act(async () => { scope.client.dispose(); });
  });
  it('replaces 50-item pages, navigates exact offsets and clears selection with no automatic read', async () => {
    const scope = setup(); await scope.client.refresh();
    scope.answer({ candidates: Array.from({ length: 50 }, (_, index) => ({ ...candidate, id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, firmName: `Page one ${index}` })), hasMore: true });
    render(<BrowserCandidateInventory client={scope.client} />); load(); await screen.findByText('Page one 49'); await ready();
    expect(screen.getAllByRole('article')).toHaveLength(50);
    const delayed = scope.delay(); fireEvent.click(screen.getByRole('button', { name: 'Next inventory page' }));
    expect(screen.queryByText('Page one 49')).toBeNull();
    await waitFor(() => { expect(scope.requests).toHaveLength(2); });
    await act(async () => { delayed.resolve(json({ candidates: [{ ...candidate, firmName: 'Page two' }], hasMore: false })); });
    await screen.findByText('Page two'); await ready();
    expect(screen.getAllByRole('article')).toHaveLength(1);
    scope.answer({ candidates: [], hasMore: false }); fireEvent.click(screen.getByRole('button', { name: 'Previous inventory page' }));
    await screen.findByText(/No observations returned for this status and page/u); await ready();
    expect(scope.requests).toEqual([{ status: 'needs_review', offset: 0 }, { status: 'needs_review', offset: 50 }, { status: 'needs_review', offset: 0 }]);
    for (const status of ['kept', 'dismissed']) {
      choose(status); expect(screen.queryByText(/No observations returned/u)).toBeNull();
      expect(scope.requests).toHaveLength(status === 'kept' ? 3 : 4);
      load(); await screen.findByText(/No observations returned/u); await ready();
      expect(scope.requests.at(-1)).toEqual({ status, offset: 0 });
    }
    expect(candidateListInputSchema.safeParse({ status: 'kept', offset: 1_000_000 }).success).toBe(true);
    expect(candidateListInputSchema.safeParse({ status: 'kept', offset: 1_000_050 }).success).toBe(false);
    await act(async () => { scope.client.dispose(); });
  });
  it.each(['malformed', 'oversized', 'unsafe-url', '500', 'network'] as const)('%s clears prior data and reports generic failure, never empty inventory or retry', async reason => {
    const scope = setup(); await scope.client.refresh(); render(<BrowserCandidateInventory client={scope.client} />);
    load(); await screen.findByText(candidate.firmName); await ready();
    if (reason === 'network') { const pending = scope.delay(); load(); await waitFor(() => { expect(scope.requests).toHaveLength(2); }); await act(async () => { pending.reject(new Error('Private failure detail')); }); }
    else {
      scope.answer(reason === 'malformed' ? { candidates: [] } : reason === 'oversized' ? { candidates: Array.from({ length: 51 }, () => candidate), hasMore: true } : reason === 'unsafe-url' ? { candidates: [{ ...candidate, sourceUrl: 'javascript:alert(1)' }], hasMore: false } : {}, reason === '500' ? 500 : 200);
      load();
    }
    await screen.findByRole('alert'); await ready();
    expect(screen.queryByText(candidate.firmName)).toBeNull(); expect(screen.queryByText(/No observations returned/u)).toBeNull();
    expect(screen.queryByText('Private failure detail')).toBeNull(); expect(scope.requests).toHaveLength(2);
    choose('kept'); expect(screen.queryByRole('alert')).toBeNull();
    await act(async () => { scope.client.dispose(); });
  });
  it.each(['401', '403', '409', 'identity', 'device', 'revision', 'role', 'workspace', 'cross-tab', 'expiry', 'logout'] as const)('%s invalidation clears private page and errors without retry', async reason => {
    const scope = setup(); await scope.client.refresh(); render(<BrowserCandidateInventory client={scope.client} />);
    load(); await screen.findByText(candidate.firmName); await ready();
    if (reason === 'cross-tab') await act(async () => { scope.crossTab(); });
    else if (reason === 'logout') await act(async () => { await scope.client.signOut().catch(() => {}); });
    else if (reason === 'expiry') { vi.useFakeTimers(); scope.change({ expiresAt: new Date(Date.now() + 500).toISOString() }); await act(async () => { await scope.client.refresh(); }); await act(async () => { vi.advanceTimersByTime(1000); }); vi.useRealTimers(); }
    else {
      if (['401', '403', '409'].includes(reason)) scope.answer({}, Number(reason));
      else scope.change(reason === 'identity' ? { userId: other } : reason === 'device' ? { deviceId: other } : reason === 'revision' ? { revision: 'two' } : reason === 'workspace' ? { workspaceId: other } : { role: 'salesperson' });
      load(); await waitFor(() => { expect(scope.client.current).toBeNull(); });
    }
    expect(screen.queryByText(candidate.firmName)).toBeNull(); expect(screen.queryByRole('alert')).toBeNull();
    expect(scope.storage.setItem).not.toHaveBeenCalled();
    await act(async () => { scope.client.dispose(); });
  });
  it.each(['200', '401', 'network'] as const)('superseded late %s cannot publish, fail or unlock a newer busy operation', async reason => {
    const scope = setup(); await scope.client.refresh(); render(<BrowserCandidateInventory client={scope.client} />);
    const old = scope.delay(); load(); await waitFor(() => { expect(scope.requests).toHaveLength(1); });
    choose('kept'); const next = scope.delay(); load(); await waitFor(() => { expect(scope.requests).toHaveLength(2); });
    await act(async () => { if (reason === 'network') old.reject(new Error('late')); else old.resolve(json(page, Number(reason))); });
    expect(screen.queryByText(candidate.firmName)).toBeNull(); expect(screen.queryByRole('alert')).toBeNull();
    // A same-epoch auth refusal intentionally invalidates the session, including the newer read.
    if (reason === '401') expect(scope.client.current).toBeNull();
    else expect(screen.getByRole('button', { name: 'Load ordinary inventory' }).hasAttribute('disabled')).toBe(true);
    await act(async () => { next.resolve(json({ candidates: [{ ...candidate, status: 'kept', firmName: 'New page' }], hasMore: false })); });
    if (reason !== '401') await screen.findByText('New page'); else expect(screen.queryByText('New page')).toBeNull();
    await act(async () => { scope.client.dispose(); });
  });
  it.each(['200', '401', 'network'] as const)('old epoch late %s does not affect new identity or busy owner', async reason => {
    const scope = setup(); await scope.client.refresh(); render(<BrowserCandidateInventory client={scope.client} />);
    const old = scope.delay(); load(); await waitFor(() => { expect(scope.requests).toHaveLength(1); });
    await act(async () => { scope.client.invalidate(false); scope.change({ userId: other, revision: 'new' }); await scope.client.refresh(); });
    const next = scope.delay(); load(); await waitFor(() => { expect(scope.requests).toHaveLength(2); });
    await act(async () => { if (reason === 'network') old.reject(new Error('late')); else old.resolve(json(page, Number(reason))); });
    expect(scope.client.current?.status).toBe('signed_in');
    expect(screen.getByRole('button', { name: 'Load ordinary inventory' }).hasAttribute('disabled')).toBe(true);
    expect(screen.queryByRole('alert')).toBeNull();
    await act(async () => { next.resolve(json({ candidates: [], hasMore: false })); });
    await screen.findByText(/No observations returned/u); await ready();
    await act(async () => { scope.client.dispose(); });
  });
  it('does not read without a signed-in identity and guards repeated clicks while busy', async () => {
    const scope = setup(); render(<BrowserCandidateInventory client={scope.client} />);
    load(); expect(scope.send).not.toHaveBeenCalled();
    await act(async () => { await scope.client.refresh(); });
    const pending = scope.delay(); load(); load();
    await waitFor(() => { expect(scope.requests).toHaveLength(1); });
    await act(async () => { pending.resolve(json({ candidates: [], hasMore: false })); });
    await ready(); expect(scope.requests).toHaveLength(1);
    await act(async () => { scope.client.dispose(); });
  });
  it('superseded filter and unmount while session refresh waits prevent dispatch', async () => {
    const scope = setup(); await scope.client.refresh(); const view = render(<BrowserCandidateInventory client={scope.client} />);
    const pending = scope.delaySession(); load(); choose('kept');
    await act(async () => { pending.resolve(json(pending.session)); });
    expect(scope.requests).toHaveLength(0); expect(screen.queryByRole('alert')).toBeNull();
    const second = scope.delaySession(); load(); view.unmount();
    await act(async () => { second.resolve(json(second.session)); });
    expect(scope.requests).toHaveLength(0);
    await act(async () => { scope.client.dispose(); });
  });
  it('unmount fences pending work and remount has no retained page or automatic read', async () => {
    const scope = setup(); await scope.client.refresh(); const first = render(<BrowserCandidateInventory client={scope.client} />);
    const pending = scope.delay(); load(); await waitFor(() => { expect(scope.requests).toHaveLength(1); }); first.unmount();
    render(<BrowserCandidateInventory client={scope.client} />);
    await act(async () => { pending.resolve(json(page)); });
    expect(screen.queryByText(candidate.firmName)).toBeNull(); expect(scope.requests).toHaveLength(1);
    expect(candidateListSchema.safeParse(page).success).toBe(true);
    await act(async () => { scope.client.dispose(); });
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BrowserClient } from '../../src/client/BrowserClient.ts';
import { BrowserCandidateAuthority } from '../../src/client/BrowserCandidateAuthority.tsx';
import { BrowserCandidateInventory } from '../../src/client/BrowserCandidateInventory.tsx';

const id = '10000000-0000-4000-8000-000000000001';
const other = '10000000-0000-4000-8000-000000000002';
const date = '2026-10-23T12:00:00.000Z';
const observation = { candidateId: id, candidateRevision: 7, checkedAt: date, source: { status: 'matched', kind: 'search_hit', attemptId: other }, owner: 'current_admin', researchEnabled: true, holds: 'clear', authority: 'not_granted' };
const candidate = { id, revision: 7, status: 'needs_review', firmName: 'Fixture Firm', locality: 'Dallas', region: 'TX', website: 'https://example.test', sourceUrl: 'https://example.test/source', observedOn: '2026-10-22', preparedBy: 'Fixture', evidence: 'Retained evidence', signal: 'fit_only', createdAt: date, nextSourceCheckAt: null, sourceCheck: null };
const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status });
function deferred() {
  let resolve!: (value: Response) => void;
  let reject!: (value: Error) => void;
  const promise = new Promise<Response>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup() {
  let session = { status: 'signed_in', workspaceId: id, userId: id, deviceId: id, role: 'admin', revision: 'one', csrfToken: 'c'.repeat(40), expiresAt: new Date(Date.now() + 120_000).toISOString() };
  let answer: unknown = observation;
  let code = 200;
  let pending: ReturnType<typeof deferred> | undefined;
  let sessionWait: ReturnType<typeof deferred> | undefined;
  const requests: unknown[] = [];
  const storage = { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() };
  const send = vi.fn<typeof fetch>(async (url, init) => {
    if (url === '/browser/session') return sessionWait === undefined ? json(session) : await sessionWait.promise;
    if (url === '/browser/api/sourcing/candidates/list') return json({ candidates: [candidate], hasMore: true });
    if (url !== '/browser/api/sourcing/candidates/authority/read') throw new Error('Unexpected route');
    expect(init?.method).toBe('POST'); expect(init?.cache).toBe('no-store');
    requests.push(JSON.parse(String(init?.body)));
    return pending === undefined ? json(answer, code) : await pending.promise;
  });
  const client = new BrowserClient({ fetch: send, storage, navigate: vi.fn(), randomUUID: vi.fn(() => id) });
  return { client, send, storage, requests,
    answer: (value: unknown, status = 200) => { answer = value; code = status; pending = undefined; },
    change: (value: Partial<typeof session>) => { session = { ...session, ...value }; },
    delay: () => { pending = deferred(); return pending; },
    delaySession: () => { sessionWait = deferred(); return { ...sessionWait, session }; } };
}
const read = (): void => { fireEvent.click(screen.getByRole('button', { name: 'Read source authority' })); };
const component = (client: BrowserClient, candidateId = id, expectedRevision = 7) => <BrowserCandidateAuthority client={client} candidateId={candidateId} expectedRevision={expectedRevision} />;
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('candidate source authority with actual BrowserClient', () => {
  it('explicit exact read only, literal evidence and no grant or storage', async () => {
    const scope = setup(); await scope.client.refresh(); render(component(scope.client));
    expect(scope.requests).toEqual([]); read();
    await screen.findByText(`Checked at ${date}`);
    expect(scope.requests).toEqual([{ candidateId: id, expectedRevision: 7 }]);
    for (const text of [`Source matched search_hit · Attempt ID ${other}`, 'Owner current_admin', 'Research enabled true', 'Holds clear']) expect(screen.getByText(text)).toBeTruthy();
    expect(screen.getByText(/Authority not_granted/u)).toBeTruthy();
    scope.answer({ ...observation, source: { status: 'unavailable' }, owner: 'unavailable', researchEnabled: false, holds: 'unknown' }); read();
    await screen.findByText('Source unavailable'); expect(screen.getByText('Owner unavailable')).toBeTruthy(); expect(screen.getByText('Holds unknown')).toBeTruthy();
    scope.answer({ ...observation, holds: 'held' }); read(); await screen.findByText('Holds held');
    expect(scope.storage.setItem).not.toHaveBeenCalled();
    await act(async () => { scope.client.dispose(); });
  });
  it.each(['extra', 'malformed', 'id', 'revision', '500', 'network'] as const)('%s is a failure not absence and clears previous evidence', async reason => {
    const scope = setup(); await scope.client.refresh(); render(component(scope.client)); read(); await screen.findByText(`Checked at ${date}`);
    if (reason === 'network') { const delayed = scope.delay(); read(); await waitFor(() => { expect(scope.requests).toHaveLength(2); }); await act(async () => { delayed.reject(new Error('Private detail')); }); }
    else { scope.answer(reason === 'extra' ? { ...observation, private: 'forbidden' } : reason === 'id' ? { ...observation, candidateId: other } : reason === 'revision' ? { ...observation, candidateRevision: 8 } : {}, reason === '500' ? 500 : 200); read(); }
    await screen.findByRole('alert'); expect(screen.queryByText(`Checked at ${date}`)).toBeNull(); expect(screen.queryByText('Source unavailable')).toBeNull(); expect(screen.queryByText('Private detail')).toBeNull(); expect(scope.requests).toHaveLength(2);
    await act(async () => { scope.client.dispose(); });
  });
  it.each(['candidate', 'revision'] as const)('clears on %s change and fences old response from newer busy read', async change => {
    const scope = setup(); await scope.client.refresh(); const view = render(component(scope.client));
    const old = scope.delay(); read(); await waitFor(() => { expect(scope.requests).toHaveLength(1); });
    view.rerender(component(scope.client, change === 'candidate' ? other : id, change === 'revision' ? 8 : 7));
    const next = scope.delay(); read(); read(); await waitFor(() => { expect(scope.requests).toHaveLength(2); });
    await act(async () => { old.resolve(json(observation)); });
    expect(screen.queryByText(`Checked at ${date}`)).toBeNull(); expect(screen.getByRole('button').hasAttribute('disabled')).toBe(true);
    await act(async () => { next.resolve(json({ ...observation, candidateId: change === 'candidate' ? other : id, candidateRevision: change === 'revision' ? 8 : 7 })); });
    await screen.findByText(`Checked at ${date}`); await act(async () => { scope.client.dispose(); });
  });
  it.each(['200', '401', 'network'] as const)('old epoch late %s cannot publish or unlock replacement read', async reason => {
    const scope = setup(); await scope.client.refresh(); render(component(scope.client)); const old = scope.delay(); read(); await waitFor(() => { expect(scope.requests).toHaveLength(1); });
    await act(async () => { scope.client.invalidate(false); scope.change({ userId: other, revision: 'two' }); await scope.client.refresh(); });
    const next = scope.delay(); read(); await waitFor(() => { expect(scope.requests).toHaveLength(2); });
    await act(async () => { if (reason === 'network') old.reject(new Error('late')); else old.resolve(json(observation, Number(reason))); });
    expect(screen.queryByRole('alert')).toBeNull(); expect(screen.queryByText(`Checked at ${date}`)).toBeNull(); expect(screen.getByRole('button').hasAttribute('disabled')).toBe(true);
    await act(async () => { next.resolve(json(observation)); }); await screen.findByText(`Checked at ${date}`);
    expect(scope.storage.setItem).not.toHaveBeenCalled(); await act(async () => { scope.client.dispose(); });
  });
  it.each(['role', 'revision', 'logout', 'expiry'] as const)('%s invalidation clears displayed evidence', async reason => {
    const scope = setup(); await scope.client.refresh(); render(component(scope.client)); read(); await screen.findByText(`Checked at ${date}`);
    await act(async () => {
      if (reason === 'logout') scope.client.invalidate();
      else if (reason === 'expiry') { vi.useFakeTimers(); scope.change({ expiresAt: new Date(Date.now() + 500).toISOString() }); await scope.client.refresh(); vi.advanceTimersByTime(1000); }
      else { scope.change(reason === 'role' ? { role: 'salesperson' } : { revision: 'two' }); await scope.client.refresh().catch(() => {}); }
    });
    expect(screen.queryByText(`Checked at ${date}`)).toBeNull(); expect(screen.queryByRole('alert')).toBeNull(); vi.useRealTimers(); await act(async () => { scope.client.dispose(); });
  });
  it('preflight fences candidate changes and unmount while refresh waits, and refuses unsigned input', async () => {
    const scope = setup(); const view = render(component(scope.client)); read(); expect(scope.send).not.toHaveBeenCalled();
    await act(async () => { await scope.client.refresh(); });
    const first = scope.delaySession(); read(); view.rerender(component(scope.client, other));
    await act(async () => { first.resolve(json(first.session)); }); expect(scope.requests).toHaveLength(0);
    const second = scope.delaySession(); read(); view.unmount(); await act(async () => { second.resolve(json(second.session)); }); expect(scope.requests).toHaveLength(0);
    render(component(scope.client, 'invalid', 0)); read(); await screen.findByRole('alert'); expect(scope.requests).toHaveLength(0);
    await act(async () => { scope.client.dispose(); });
  });
  it('unmount fences an in-flight response and remount retains nothing', async () => {
    const scope = setup(); await scope.client.refresh(); const view = render(component(scope.client));
    const pending = scope.delay(); read(); await waitFor(() => { expect(scope.requests).toHaveLength(1); });
    view.unmount(); render(component(scope.client));
    await act(async () => { pending.resolve(json(observation)); });
    expect(screen.queryByText(`Checked at ${date}`)).toBeNull(); expect(screen.queryByRole('alert')).toBeNull();
    expect(scope.requests).toHaveLength(1); await act(async () => { scope.client.dispose(); });
  });
  it('accepts the first explicit authority action when an asynchronously loaded row becomes visible', async () => {
    const scope = setup(); await scope.client.refresh(); render(<BrowserCandidateInventory client={scope.client} />);
    let clicked = false;
    const observer = new MutationObserver(() => {
      const button = screen.queryByRole('button', { name: 'Read source authority' });
      if (!clicked && button) { clicked = true; fireEvent.click(button); }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Load ordinary inventory' }));
      await screen.findByText(`Checked at ${date}`);
      expect(clicked).toBe(true); expect(scope.requests).toEqual([{ candidateId: id, expectedRevision: 7 }]);
      expect(scope.storage.setItem).not.toHaveBeenCalled();
    } finally { observer.disconnect(); await act(async () => { scope.client.dispose(); }); }
  });
  it.each(['reload', 'filter', 'page'] as const)('ordinary inventory %s unmounts evidence without automatic authority reads', async change => {
    const scope = setup(); await scope.client.refresh(); render(<BrowserCandidateInventory client={scope.client} />);
    fireEvent.click(screen.getByRole('button', { name: 'Load ordinary inventory' })); await screen.findByText(candidate.firmName);
    expect(scope.requests).toHaveLength(0); read(); await screen.findByText(`Checked at ${date}`);
    if (change === 'filter') fireEvent.change(screen.getByRole('combobox'), { target: { value: 'kept' } });
    else fireEvent.click(screen.getByRole('button', { name: change === 'page' ? 'Next inventory page' : 'Load ordinary inventory' }));
    expect(screen.queryByText(`Checked at ${date}`)).toBeNull();
    await act(async () => { await Promise.resolve(); }); expect(scope.requests).toHaveLength(1);
    await act(async () => { scope.client.dispose(); });
  });
});

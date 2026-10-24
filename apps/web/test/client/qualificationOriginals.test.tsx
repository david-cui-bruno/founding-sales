// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { qualificationViewSchema } from '@fss/contracts';
import { BrowserClient } from '../../src/client/BrowserClient.ts';
import { BrowserQualification } from '../../src/client/BrowserQualification.tsx';

const candidateId = '10000000-0000-4000-8000-000000000001';
const runId = '10000000-0000-4000-8000-000000000002';
const other = '10000000-0000-4000-8000-000000000003';
const second = '10000000-0000-4000-8000-000000000004';
const captured = '2026-10-24T00:10:17.000Z';
const hostile = '<img src="https://never-fetch.example.test/pixel" onerror="alert(1)"><script>alert(2)</script> & captured only';
const view = qualificationViewSchema.parse({ candidateId, runId, candidateRevision: 1, status: 'unavailable', reason: 'invalid_evidence',
  requestedAt: captured, deadlineAt: captured, facts: [], verdict: null, openingQuestion: null, admission: null, history: [],
  observations: [{ id: runId, url: 'https://never-fetch.example.test/', contentHash: 'a'.repeat(64), relevantTextHash: 'b'.repeat(64),
    retrievedAt: captured, publishedAt: null, publishedAtBlockId: null, firstParty: true, truncated: false,
    blocks: [{ id: 'captured-identity', text: 'Original retained label, not a verified business identity.' }, { id: 'hostile-block', text: hostile }] },
  { id: second, url: 'https://never-fetch.example.test/partial', contentHash: 'c'.repeat(64), relevantTextHash: 'd'.repeat(64),
    retrievedAt: captured, publishedAt: null, publishedAtBlockId: null, firstParty: false, truncated: true,
    blocks: [{ id: 'partial-block', text: 'Separate partial captured text' }] }] });
const json = (value: unknown): Response => new Response(JSON.stringify(value));
function setup() {
  let session = { status: 'signed_in', workspaceId: candidateId, userId: candidateId, deviceId: candidateId,
    role: 'admin', revision: 'originals-session', csrfToken: 'c'.repeat(40), expiresAt: new Date(Date.now() + 120_000).toISOString() };
  let answer: unknown = view;
  let resolve: ((value: Response) => void) | undefined;
  let delayed: Promise<Response> | undefined;
  const storage = { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() };
  const reads: string[] = [];
  const send = vi.fn<typeof fetch>(async url => {
    if (url === '/browser/session') return json(session);
    expect(url).toBe('/browser/api/sourcing/qualification/read');
    reads.push(String(url)); return delayed === undefined ? json(answer) : await delayed;
  });
  const client = new BrowserClient({ storage, fetch: send, navigate: vi.fn(), randomUUID: vi.fn(() => crypto.randomUUID()) });
  return { client, storage, reads, send, answer: (value: unknown) => { answer = value; },
    session: (value: Partial<typeof session>) => { session = { ...session, ...value }; },
    delay: () => { delayed = new Promise<Response>(yes => { resolve = yes; }); },
    resolve: (value: unknown) => { resolve?.(json(value)); } };
}
const panel = (client: BrowserClient, id = candidateId, revision = 1) => <BrowserQualification client={client} candidateId={id} expectedRevision={revision} />;
const show = (id = runId) => screen.getByRole('button', { name: `Show captured original blocks for observation ${id}` });
const originals = (id = runId) => screen.getByRole('region', { name: `Captured original blocks for observation ${id}` });
async function read() { fireEvent.click(screen.getByRole('button', { name: 'Read qualification' })); await screen.findByText(/Latest run/u); }
async function idle() { await waitFor(() => { expect(screen.getByRole('button', { name: 'Read qualification' }).hasAttribute('disabled')).toBe(false); }); }
afterEach(cleanup);

it('discloses only explicitly selected retained originals with empty facts, exact IDs and capture metadata, without extra requests/storage', async () => {
  const s = setup(); await s.client.refresh(); render(panel(s.client)); expect(s.reads).toHaveLength(0);
  await read(); await idle(); expect(screen.getByText('No current verdict.')).toBeTruthy();
  expect(screen.queryByText(hostile)).toBeNull(); expect(screen.queryByRole('button', { name: 'Admit reviewed qualification' })).toBeNull();
  const count = s.send.mock.calls.length;
  fireEvent.click(show());
  const region = originals();
  expect(within(region).getByText('Block captured-identity')).toBeTruthy();
  expect(within(region).getByText(hostile)).toBeTruthy();
  expect(within(region).getByText(/Retrieved 2026-10-24T00:10:17.000Z · Published unknown · First party true · Truncated false/u)).toBeTruthy();
  expect(within(region).getByText(/not accepted facts or verified identity/u)).toBeTruthy();
  expect(screen.queryByText('Separate partial captured text')).toBeNull();
  expect(region.querySelector('img,script,iframe')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: `Hide captured original blocks for observation ${runId}` }));
  expect(screen.queryByText(hostile)).toBeNull(); fireEvent.click(show(second));
  expect(within(originals(second)).getByText(/First party false · Truncated true/u)).toBeTruthy();
  expect(s.send).toHaveBeenCalledTimes(count); expect(s.storage.setItem).not.toHaveBeenCalled();
  expect(s.reads).toHaveLength(1); s.client.dispose();
});

it('clears expanded originals before refresh waits and keeps the replacement run collapsed even with reused observation IDs', async () => {
  const s = setup(); await s.client.refresh(); render(panel(s.client)); await read(); await idle(); fireEvent.click(show());
  s.delay(); fireEvent.click(screen.getByRole('button', { name: 'Read qualification' }));
  expect(screen.queryByText(hostile)).toBeNull(); expect(screen.queryByRole('region', { name: /Captured original blocks/u })).toBeNull();
  await waitFor(() => { expect(s.reads).toHaveLength(2); });
  await act(async () => { s.resolve({ ...view, runId: other }); }); await idle();
  expect(show().getAttribute('aria-expanded')).toBe('false'); expect(screen.queryByText(hostile)).toBeNull();
  fireEvent.click(show()); expect(within(originals()).getByText(hostile)).toBeTruthy(); s.client.dispose();
});

it.each(['candidate', 'revision', 'client', 'logout', 'session', 'role', 'expiry', 'unmount'] as const)('clears expanded private originals on %s replacement', async mode => {
  const s = setup(); await s.client.refresh(); const component = render(panel(s.client)); await read(); await idle(); fireEvent.click(show());
  expect(screen.getByText(hostile)).toBeTruthy();
  if (mode === 'candidate' || mode === 'revision') component.rerender(panel(s.client, mode === 'candidate' ? other : candidateId, mode === 'revision' ? 2 : 1));
  else if (mode === 'client') { const replacement = setup(); await replacement.client.refresh(); component.rerender(panel(replacement.client)); replacement.client.dispose(); }
  else if (mode === 'unmount') component.unmount();
  else if (mode === 'logout') await act(async () => { s.client.invalidate(); });
  else if (mode === 'expiry') {
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_001);
    await act(async () => { expect(s.client.isCurrent(s.client.epoch)).toBe(false); }); now.mockRestore();
  } else {
    s.session(mode === 'role' ? { role: 'salesperson' } : { revision: 'replacement-session' });
    await act(async () => { await expect(s.client.refresh()).rejects.toThrow(); });
  }
  expect(screen.queryByText(hostile)).toBeNull(); expect(screen.queryByRole('region', { name: /Captured original blocks/u })).toBeNull();
  expect(s.storage.setItem).not.toHaveBeenCalled(); s.client.dispose();
});

it.each(['candidate', 'session'] as const)('does not republish late originals after %s changes during a refreshed read', async mode => {
  const s = setup(); await s.client.refresh(); const component = render(panel(s.client)); await read(); await idle(); fireEvent.click(show());
  s.delay(); fireEvent.click(screen.getByRole('button', { name: 'Read qualification' }));
  await waitFor(() => { expect(s.reads).toHaveLength(2); });
  if (mode === 'candidate') component.rerender(panel(s.client, other, 2));
  else await act(async () => { s.client.invalidate(); });
  await act(async () => { s.resolve(view); });
  expect(screen.queryByText(hostile)).toBeNull(); expect(screen.queryByRole('button', { name: /Show captured original blocks/u })).toBeNull();
  s.client.dispose();
});

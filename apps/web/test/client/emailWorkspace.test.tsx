// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { type ReplyCardDto, type ReplyDraftContext } from '@fss/contracts';
import { BrowserClient, type InvalidationChannel } from '../../src/client/BrowserClient.ts';
import { BrowserEmailWorkspace } from '../../src/client/BrowserEmailWorkspace.tsx';

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const a = id(1), b = id(2), revision = 'a'.repeat(64);
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });
function card(messageId: string, firmName: string): ReplyCardDto {
  return { messageId, receivedAt: '2026-10-22T12:00:00Z', from: 'person@example.test', subject: `Subject ${firmName}`, body: { text: `Excerpt ${firmName}`, truncated: true },
    firmId: a, firmName, opportunityId: null, contactId: a, contactName: null, contactTitle: null,
    impact: { controlMode: 'manual', holds: [], ambiguous: false, candidates: [], contactsAtFirm: 1 }, deterministicClass: 'human', signals: [],
    proposedDisposition: null, proposedBy: 'none', confidence: null, supportingExcerpt: null, callbackProposal: null, modelName: null,
    promptVersion: null, requiresConfirmation: false, confirmation: null, nextAction: 'nothing_to_do', visibility: 'assigned_or_admin' };
}
function context(messageId: string): ReplyDraftContext {
  return { messageId, sourceRevision: revision, firmId: a, contactId: a, authorUserId: a,
    mailboxId: a, mailboxOwnerUserId: a, authorAddress: 'owner@example.test', authorizationRevision: 1,
    subject: `Original subject ${messageId}`, senderAddress: 'person@example.test', providerThreadId: 'shared-thread', inReplyTo: 'original', references: [],
    observedTo: ['owner@example.test'], observedCc: [], replyToMetadata: 'unavailable', envelope: { to: ['person@example.test'], cc: [] },
    recipientOptions: [{ address: 'person@example.test', contactId: a }], messageText: `Original ${messageId}`, priorContext: [], bookings: [], facts: [], availableFacts: [] };
}
const resources: BrowserClient[] = [];
function setup() {
  let broadcast: (() => void) | undefined;
  const channel: InvalidationChannel = { postMessage: vi.fn(), addEventListener: (_type, listener) => { broadcast = listener; }, removeEventListener: () => {}, close: () => {} };
  let cards = [card(a, 'Alpha'), card(b, 'Beta')], listStatus = 200;
  let read: (messageId: string) => Promise<Response> = async messageId => json({ ok: true, value: context(messageId) });
  let preview: (body: { messageId: string; text: string }) => Promise<Response> = async body => json({ ok: true, value: {
    sourceRevision: revision, draftRevision: 'b'.repeat(64), subject: 'Exact reply', body: body.text, envelope: context(body.messageId).envelope,
  } });
  const send = vi.fn<typeof fetch>(async (url, init) => {
    if (url === '/browser/session') return json({ status: 'signed_in', workspaceId: a, userId: a, deviceId: a, role: 'admin', revision: 'one', csrfToken: 'c'.repeat(40), expiresAt: new Date(Date.now() + 120000).toISOString() });
    if (url === '/browser/api/replies') return json({ businessDate: '2026-10-22', cards }, listStatus);
    if (url === '/browser/api/outreach/email-campaigns/control') return json({ campaigns: [], admissions: [], senders: [], sequences: [], sendingAuthority: 'unchanged' });
    const body = JSON.parse(String(init?.body)) as { messageId: string; text: string };
    if (url === '/browser/api/replies/composer/context') return read(body.messageId);
    if (url === '/browser/api/replies/composer/preview') return preview(body);
    throw new Error('Unexpected operation, no providers or sends allowed');
  });
  const client = new BrowserClient({ fetch: send, storage: sessionStorage, channel, navigate: vi.fn(), randomUUID: () => id(99) });
  resources.push(client);
  return { client, send, broadcast: () => { broadcast?.(); }, cards: (value: ReplyCardDto[]) => { cards = value; },
    listStatus: (value: number) => { listStatus = value; }, read: (value: typeof read) => { read = value; }, preview: (value: typeof preview) => { preview = value; } };
}
afterEach(() => { cleanup(); for (const client of resources.splice(0)) client.dispose(); sessionStorage.clear(); localStorage.clear(); });
async function mount(scope: ReturnType<typeof setup>) {
  await scope.client.refresh();
  const view = render(<BrowserEmailWorkspace client={scope.client} />);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh replies' }));
  await screen.findByRole('button', { name: 'Alpha: Subject Alpha' });
  return view;
}
async function select(messageId: string, name: string) {
  fireEvent.click(screen.getByRole('button', { name: `${name}: Subject ${name}` }));
  await screen.findByText(`Original ${messageId}`);
  return screen.getByRole('textbox', { name: 'Reply draft' });
}

it('separates automatic outbound from replies and makes no implicit generation or mutation', async () => {
  const scope = setup(); await scope.client.refresh(); render(<BrowserEmailWorkspace client={scope.client} />);
  expect(scope.send.mock.calls.map(([url]) => url)).toEqual(['/browser/session']);
  fireEvent.click(screen.getByRole('button', { name: 'Automatic outreach' }));
  expect(screen.queryByRole('region', { name: 'Replies' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh campaigns' }));
  await screen.findByText('No current admissions.');
  expect(screen.getByText(/without per-recipient review/u)).toBeTruthy();
  expect(screen.getByText('Campaign policy and one-time approval').closest('details')?.open).toBe(false);
  expect(screen.getByText(/not sent-message history/u)).toBeTruthy();
  expect(scope.send.mock.calls.every(([url]) => !String(url).match(/generate|approve|send|revoke/u))).toBe(true);
});

it('searches only loaded metadata/excerpts without a request, never treating it as server or full-history search', async () => {
  const scope = setup(); await mount(scope); const count = scope.send.mock.calls.length;
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search loaded replies' }), { target: { value: 'excerpt beta' } });
  expect(screen.queryByRole('button', { name: 'Alpha: Subject Alpha' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Beta: Subject Beta' })).toBeTruthy();
  expect(screen.getByText(/not your mailbox or full history/u)).toBeTruthy();
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'unmatched' } });
  expect(screen.getByText(/No loaded replies match/u)).toBeTruthy();
  expect(scope.send.mock.calls).toHaveLength(count);
});

it('keeps independent exact-message edits in memory across switching even in a shared provider thread', async () => {
  const scope = setup(); await mount(scope);
  fireEvent.change(await select(a, 'Alpha'), { target: { value: 'Alpha private edit' } });
  const beta = await select(b, 'Beta'); expect((beta as HTMLTextAreaElement).value).toBe('');
  fireEvent.change(beta, { target: { value: 'Beta private edit' } });
  const alpha = await select(a, 'Alpha'); expect((alpha as HTMLTextAreaElement).value).toBe('Alpha private edit');
  fireEvent.click(screen.getByRole('button', { name: 'Preview exact reply' }));
  const result = await screen.findByRole('article', { name: 'Final reply preview' });
  expect(within(result).getByText('Alpha private edit')).toBeTruthy();
  const request = scope.send.mock.calls.find(([url]) => String(url).endsWith('/preview'));
  expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({ messageId: a, text: 'Alpha private edit', envelope: context(a).envelope });
  expect(sessionStorage.length).toBe(0); expect(localStorage.length).toBe(0);
  expect((await select(b, 'Beta') as HTMLTextAreaElement).value).toBe('Beta private edit');
  expect(screen.queryByRole('article', { name: 'Final reply preview' })).toBeNull();
});

it.each(['revision', 'envelope', 'facts', 'mailbox'] as const)('fresh changed %s clears only the selected message scratch before reuse', async changed => {
  const scope = setup(); await mount(scope);
  fireEvent.change(await select(a, 'Alpha'), { target: { value: 'Stale private edit' } });
  fireEvent.change(await select(b, 'Beta'), { target: { value: 'Independent Beta edit' } });
  scope.read(async messageId => {
    const value = context(messageId);
    if (messageId === a) {
      if (changed === 'revision') value.sourceRevision = 'c'.repeat(64);
      if (changed === 'envelope') value.envelope.to = ['replacement@example.test'];
      if (changed === 'facts') value.facts = [{ id: a, version: 2, kind: 'product', text: 'Approved', approvedAt: '2026-10-22', retiredAt: null }];
      if (changed === 'mailbox') value.mailboxId = b;
    }
    return json({ ok: true, value });
  });
  expect((await select(a, 'Alpha') as HTMLTextAreaElement).value).toBe('');
  expect(screen.getByText(/Previous scratch was cleared/u)).toBeTruthy();
  expect((await select(b, 'Beta') as HTMLTextAreaElement).value).toBe('Independent Beta edit');
});

it('fences a late previous-message context read and does not unlock replacement work', async () => {
  const scope = setup(); await mount(scope); let release!: (response: Response) => void;
  scope.read(async messageId => messageId === a ? new Promise<Response>(resolve => { release = resolve; }) : json({ ok: true, value: context(b) }));
  fireEvent.click(screen.getByRole('button', { name: 'Alpha: Subject Alpha' }));
  await vi.waitFor(() => { expect(release).toBeTypeOf('function'); });
  fireEvent.change(await select(b, 'Beta'), { target: { value: 'Replacement private edit' } });
  await act(async () => { release(json({ ok: true, value: context(a) })); });
  expect(screen.queryByText(`Original ${a}`)).toBeNull();
  expect((screen.getByRole('textbox', { name: 'Reply draft' }) as HTMLTextAreaElement).value).toBe('Replacement private edit');
});

it('fences a late preview when selection changes', async () => {
  const scope = setup(); await mount(scope); let release!: (response: Response) => void;
  fireEvent.change(await select(a, 'Alpha'), { target: { value: 'Alpha review' } });
  scope.preview(async () => new Promise<Response>(resolve => { release = resolve; }));
  fireEvent.click(screen.getByRole('button', { name: 'Preview exact reply' }));
  await vi.waitFor(() => { expect(release).toBeTypeOf('function'); });
  fireEvent.change(await select(b, 'Beta'), { target: { value: 'Beta review' } });
  await act(async () => { release(json({ ok: true, value: { sourceRevision: revision, draftRevision: 'b'.repeat(64), subject: 'Late Alpha', body: 'Alpha review', envelope: context(a).envelope } })); });
  expect(screen.queryByRole('article', { name: 'Final reply preview' })).toBeNull();
  expect((screen.getByRole('textbox', { name: 'Reply draft' }) as HTMLTextAreaElement).value).toBe('Beta review');
});

it('renders only available escaped originals with explicit collapsed history, separate from anchored draft', async () => {
  const scope = setup(); scope.read(async messageId => json({ ok: true, value: { ...context(messageId), priorContext: Array.from({ length: 19 }, (_, index) => ({ direction: 'outgoing', text: `<img src="https://example.test/${index}" onerror="alert(1)">` })) } }));
  const view = await mount(scope); await select(a, 'Alpha');
  const history = screen.getByRole('region', { name: 'Available message history' });
  const originalDisclosure = screen.getByText(/Prior conversation context · 19/u).closest('details');
  expect(originalDisclosure?.open).toBe(false);
  const requests = scope.send.mock.calls.length;
  fireEvent.click(screen.getByText(/Prior conversation context · 19/u));
  expect(originalDisclosure?.open).toBe(true); expect(view.container.querySelector('img')).toBeNull();
  expect(within(history).getByText('<img src="https://example.test/18" onerror="alert(1)">')).toBeTruthy();
  expect(history.contains(screen.getByRole('textbox', { name: 'Reply draft' }))).toBe(false);
  expect(screen.getByText(/not a complete mailbox history/u)).toBeTruthy();
  expect(scope.send.mock.calls).toHaveLength(requests);
});

it('provides selection/focus and Back-to-list flow without persisting private edits on unmount', async () => {
  const scope = setup(); const view = await mount(scope);
  fireEvent.change(await select(a, 'Alpha'), { target: { value: 'Private navigation scratch' } });
  expect(screen.getByRole('button', { name: 'Alpha: Subject Alpha' }).getAttribute('aria-pressed')).toBe('true');
  expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Alpha', level: 3 }));
  fireEvent.click(screen.getByRole('button', { name: 'Back to conversations' }));
  expect(document.activeElement).toBe(screen.getByRole('searchbox'));
  expect((await select(a, 'Alpha') as HTMLTextAreaElement).value).toBe('Private navigation scratch');
  view.unmount(); await mount(scope);
  expect((await select(a, 'Alpha') as HTMLTextAreaElement).value).toBe('');
  expect(sessionStorage.length).toBe(0); expect(localStorage.length).toBe(0);
});

it('clears selected and offscreen drafts/search on cross-tab invalidation', async () => {
  const scope = setup(); await mount(scope);
  fireEvent.change(await select(a, 'Alpha'), { target: { value: 'Offscreen private' } });
  fireEvent.change(await select(b, 'Beta'), { target: { value: 'Selected private' } });
  await act(async () => { scope.broadcast(); });
  expect(screen.queryByRole('region', { name: 'Email workspace' })).toBeNull();
  await act(async () => { await scope.client.refresh(); });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh replies' })); await screen.findByRole('button', { name: 'Alpha: Subject Alpha' });
  expect((await select(a, 'Alpha') as HTMLTextAreaElement).value).toBe('');
  expect((await select(b, 'Beta') as HTMLTextAreaElement).value).toBe('');
});

it('distinguishes empty/error/loading and clears old loaded projections on explicit refresh', async () => {
  const scope = setup(); await mount(scope); fireEvent.change(await select(a, 'Alpha'), { target: { value: 'Old scratch' } });
  scope.listStatus(503); fireEvent.click(screen.getByRole('button', { name: 'Refresh replies' }));
  expect(screen.queryByDisplayValue('Old scratch')).toBeNull();
  expect(screen.getByText('Loading current replies…')).toBeTruthy();
  await screen.findByText('Current replies unavailable. No automatic retry.');
  expect(screen.queryByText('No current replies available.')).toBeNull();
  scope.listStatus(200); scope.cards([]); fireEvent.click(screen.getByRole('button', { name: 'Refresh replies' }));
  await screen.findByText('No current replies available.');
});

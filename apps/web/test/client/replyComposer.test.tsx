// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { TextEncoder } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { type ReplyDraftContext, type ReplyCardDto } from '@fss/contracts';
import { BrowserClient, type InvalidationChannel } from '../../src/client/BrowserClient.ts';
import { BrowserReplies } from '../../src/client/BrowserReplies.tsx';
import { BrowserReplyComposer } from '../../src/client/BrowserReplyComposer.tsx';
import { ReplyAttempt, REPLY_PENDING_KEY, replyAttemptSchema } from '../../src/client/ReplyAttempt.ts';

const id = '00000000-0000-4000-8000-000000000001';
const commandId = '00000000-0000-4000-8000-000000000002';
const revision = 'a'.repeat(64);
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });
const context = (): ReplyDraftContext => ({ messageId: id, sourceRevision: revision, firmId: id, contactId: id, authorUserId: id,
  mailboxId: id, mailboxOwnerUserId: id, authorAddress: 'owner@example.test', authorizationRevision: 1,
  subject: 'Synthetic reply', senderAddress: 'person@example.test', providerThreadId: 'thread', inReplyTo: 'original', references: [],
  observedTo: ['owner@example.test'], observedCc: [], replyToMetadata: 'unavailable',
  envelope: { to: ['person@example.test'], cc: [] }, recipientOptions: [{ address: 'person@example.test', contactId: id }],
  messageText: 'Private current original', priorContext: [{ direction: 'outgoing', text: 'Private prior passage' }], bookings: [],
  facts: [{ id, version: 1, kind: 'product', text: 'Approved synthetic fact', approvedAt: '2026-10-22', retiredAt: null }], availableFacts: [] });
const card: ReplyCardDto = { messageId: id, receivedAt: '2026-10-22T12:00:00Z', from: 'person@example.test', subject: 'Synthetic reply', body: null,
  firmId: id, firmName: 'Synthetic Firm', opportunityId: null, contactId: id, contactName: null, contactTitle: null,
  impact: { controlMode: 'manual', holds: [], ambiguous: false, candidates: [], contactsAtFirm: 1 }, deterministicClass: 'human', signals: [],
  proposedDisposition: null, proposedBy: 'none', confidence: null, supportingExcerpt: null, callbackProposal: null, modelName: null,
  promptVersion: null, requiresConfirmation: false, confirmation: null, nextAction: 'nothing_to_do', visibility: 'assigned_or_admin' };
const resources: { dispose(): void }[] = [];
function setup(storage: Storage = sessionStorage) {
  let session: unknown = { status: 'signed_in', workspaceId: id, userId: id, deviceId: id, role: 'admin', revision: 'session-one',
    csrfToken: 'c'.repeat(40), expiresAt: new Date(Date.now() + 60000).toISOString() };
  let sessionStatus = 200, source: ReplyDraftContext | null = context(), sourceStatus = 200, lose = false, generationStatus = 200;
  let generateWait: (() => Promise<Response>) | undefined, listWait: (() => Promise<Response>) | undefined, previewWait: (() => Promise<Response>) | undefined;
  let broadcast: (() => void) | undefined;
  const channel: InvalidationChannel = { postMessage: vi.fn(), addEventListener: (_type, listener) => { broadcast = listener; }, removeEventListener: () => {}, close: () => {} };
  const commands: unknown[] = [], previews: unknown[] = [];
  const send = vi.fn<typeof fetch>(async (url, init) => {
    if (url === '/browser/session') return json(session, sessionStatus);
    if (url === '/browser/logout') return json({ status: 'signed_out' });
    if (url === '/browser/api/replies') return listWait ? listWait() : json({ businessDate: '2026-10-22', cards: [card] });
    if (url === '/browser/api/replies/composer/context') return json(source === null ? { ok: false, reason: 'source_unavailable' } : { ok: true, value: source }, sourceStatus);
    if (url === '/browser/api/replies/composer/generate') {
      expect(storage.getItem(REPLY_PENDING_KEY)).not.toBeNull();
      commands.push(JSON.parse(String(init?.body)));
      if (generateWait) return generateWait();
      if (lose) throw new Error('Response lost');
      if (commands.length > 1) return json({ status: 'refused', replayed: true, reason: 'generation_already_attempted' });
      return json({ status: 'accepted', replayed: false, result: { ok: true, value: {
        sourceRevision: revision, draftRevision: 'b'.repeat(64), text: 'Private generated suggestion', factRefs: [{ id, version: 1 }], reviewRequired: true, reviewNotes: ['Review all claims.'],
      } } }, generationStatus);
    }
    if (url === '/browser/api/replies/composer/preview') {
      const body = JSON.parse(String(init?.body)) as { text: string }; previews.push(body);
      return previewWait ? previewWait() : json({ ok: true, value: { sourceRevision: revision, draftRevision: 'b'.repeat(64), subject: 'Re: Synthetic reply', body: body.text, envelope: context().envelope } });
    }
    throw new Error('Unexpected route');
  });
  const browser = new BrowserClient({ fetch: send, storage, channel, navigate: vi.fn(), randomUUID: () => commandId });
  const uuid = vi.fn(() => commandId), attempts = new ReplyAttempt(browser, storage, uuid);
  resources.push(browser, attempts);
  return { browser, attempts, uuid, commands, previews, send,
    session: (value: unknown) => { session = value; }, sessionStatus: (value: number) => { sessionStatus = value; },
    source: (value: ReplyDraftContext | null) => { source = value; }, sourceStatus: (value: number) => { sourceStatus = value; },
    lose: (value: boolean) => { lose = value; }, generationStatus: (value: number) => { generationStatus = value; }, broadcast: () => { broadcast?.(); },
    generateWait: (value: () => Promise<Response>) => { generateWait = value; }, listWait: (value: () => Promise<Response>) => { listWait = value; }, previewWait: (value: () => Promise<Response>) => { previewWait = value; } };
}
async function composer(scope: ReturnType<typeof setup>) {
  await scope.browser.refresh();
  render(<BrowserReplyComposer client={scope.browser} attempts={scope.attempts} messageId={id} />);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh current reply context' }));
  await screen.findByText('Private current original');
}
beforeEach(() => { vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('TextEncoder', TextEncoder); });
afterEach(() => { cleanup(); for (const resource of resources.splice(0)) resource.dispose(); sessionStorage.clear(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('browser reply composition over actual BrowserClient', () => {
  it('selects a real POST reply card, loads current original/prior context, manually previews without generation or send', async () => {
    const scope = setup(); await scope.browser.refresh(); render(<BrowserReplies client={scope.browser} />);
    expect(scope.commands).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh replies' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Synthetic Firm: Synthetic reply' }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh current reply context' }));
    await screen.findByText('Private prior passage');
    fireEvent.change(screen.getByRole('textbox', { name: 'Reply draft' }), { target: { value: 'Manually composed reply' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview exact reply' }));
    await screen.findByRole('article', { name: 'Final reply preview' });
    expect(scope.previews).toEqual([{ messageId: id, text: 'Manually composed reply', factRefs: [{ id, version: 1 }], envelope: context().envelope }]);
    fireEvent.change(screen.getByRole('textbox', { name: 'Reply draft' }), { target: { value: 'Edited reply' } });
    expect(screen.queryByRole('article', { name: 'Final reply preview' })).toBeNull();
    expect(scope.commands).toHaveLength(0); expect(sessionStorage.length).toBe(0);
    expect(scope.send.mock.calls.every(([url]) => !String(url).match(/send|confirm|settings|status/u))).toBe(true);
  });
  it('retains IDs before explicit generation, preserves typing, and requires explicit suggestion adoption', async () => {
    const scope = setup(); await composer(scope);
    let release!: (response: Response) => void;
    scope.generateWait(() => new Promise<Response>(resolve => { release = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: 'Generate suggestion' }));
    await vi.waitFor(() => { expect(scope.commands).toHaveLength(1); });
    fireEvent.change(screen.getByRole('textbox', { name: 'Reply draft' }), { target: { value: 'My newer typing' } });
    await act(async () => { release(json({ status: 'accepted', replayed: false, result: { ok: true, value: { sourceRevision: revision, draftRevision: 'b'.repeat(64), text: 'Controlled suggestion', factRefs: [{ id, version: 1 }], reviewRequired: true, reviewNotes: ['Review.'] } } })); });
    expect((screen.getByRole('textbox', { name: 'Reply draft' }) as HTMLTextAreaElement).value).toBe('My newer typing');
    fireEvent.click(screen.getByRole('button', { name: 'Use suggestion in draft' }));
    expect((screen.getByRole('textbox', { name: 'Reply draft' }) as HTMLTextAreaElement).value).toBe('Controlled suggestion');
    const raw = sessionStorage.getItem(REPLY_PENDING_KEY)!;
    expect(raw).not.toMatch(/@|Private|Controlled|typing|Approved|csrf/u);
    expect(replyAttemptSchema.parse(JSON.parse(raw))).toMatchObject({ commandId: expect.any(String), messageId: id, sourceRevision: revision, factRefs: [{ id, version: 1 }], envelopeSHA256: expect.stringMatching(/^[a-f0-9]{64}$/u) });
  });
  it('lost response survives reload, never replays automatically, and explicit same-attempt check uses identical UUID and payload', async () => {
    const scope = setup(); await scope.browser.refresh(); scope.lose(true);
    await expect(scope.attempts.generate(context(), false)).rejects.toThrow('unavailable');
    const held = sessionStorage.getItem(REPLY_PENDING_KEY);
    scope.attempts.dispose();
    const reloaded = new ReplyAttempt(scope.browser, sessionStorage, scope.uuid); resources.push(reloaded);
    render(<BrowserReplyComposer client={scope.browser} attempts={reloaded} messageId={id} />);
    expect(scope.commands).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh current reply context' })); await screen.findByText('Private current original');
    expect(scope.commands).toHaveLength(1); scope.lose(false);
    fireEvent.click(screen.getByRole('button', { name: 'Check same reply attempt' }));
    await screen.findByText(/Same attempt checked/u);
    expect(scope.commands).toHaveLength(2); expect(scope.commands[1]).toEqual(scope.commands[0]);
    expect(scope.uuid).toHaveBeenCalledTimes(1); expect(sessionStorage.getItem(REPLY_PENDING_KEY)).toBe(held);
    expect(screen.queryByRole('complementary', { name: 'Reply suggestion' })).toBeNull();
    expect((screen.getByRole('textbox', { name: 'Reply draft' }) as HTMLTextAreaElement).value).toBe('');
  });
  it('authenticated source loss or changed revision, facts or default envelope retain uncertain IDs and refuse reconstruction', async () => {
    const scope = setup(); await scope.browser.refresh(); scope.lose(true);
    await expect(scope.attempts.generate(context(), false)).rejects.toThrow(); const held = sessionStorage.getItem(REPLY_PENDING_KEY);
    scope.source(null); await expect(scope.attempts.generate(context(), true)).rejects.toThrow('refused');
    for (const changed of [{ ...context(), sourceRevision: 'c'.repeat(64) }, { ...context(), facts: [] }, { ...context(), envelope: { to: ['changed@example.test'], cc: [] } }]) {
      scope.source(changed); await expect(scope.attempts.generate(changed, true)).rejects.toThrow('refused');
      expect(sessionStorage.getItem(REPLY_PENDING_KEY)).toBe(held);
    }
    expect(scope.commands).toHaveLength(1); expect(scope.uuid).toHaveBeenCalledTimes(1);
  });
  it.each(['signed_out', 'refusal', 'cross_tab', 'logout', 'expiry', 'identity'] as const)('clears custody and projections on actual %s', async kind => {
    const scope = setup(); await composer(scope); await scope.attempts.generate(context(), false);
    fireEvent.change(screen.getByRole('textbox', { name: 'Reply draft' }), { target: { value: 'Private draft' } });
    await act(async () => {
      if (kind === 'signed_out') { scope.session({ status: 'signed_out', csrfToken: 'c'.repeat(40) }); await scope.browser.refresh().catch(() => {}); }
      if (kind === 'refusal') { scope.sourceStatus(401); await scope.attempts.context(id).catch(() => {}); }
      if (kind === 'cross_tab') scope.broadcast();
      if (kind === 'logout') await scope.browser.signOut().catch(() => {});
      if (kind === 'expiry') { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 61000); scope.browser.isCurrent(scope.browser.epoch); }
      if (kind === 'identity') { scope.session({ status: 'signed_in', workspaceId: id, userId: commandId, deviceId: id, role: 'admin', revision: 'other', csrfToken: 'c'.repeat(40), expiresAt: new Date(Date.now() + 60000).toISOString() }); await scope.browser.refresh().catch(() => {}); }
    });
    expect(sessionStorage.getItem(REPLY_PENDING_KEY)).toBeNull(); expect(screen.queryByText('Private current original')).toBeNull(); expect(screen.queryByDisplayValue('Private draft')).toBeNull();
  });
  it.each(['anonymous', '401', '409'] as const)('cold-start actual auth %s clears prior custody without generation dispatch', async outcome => {
    const original = setup(); await original.browser.refresh(); original.lose(true); await original.attempts.generate(context(), false).catch(() => {});
    original.attempts.dispose();
    const cold = setup();
    expect(sessionStorage.getItem(REPLY_PENDING_KEY)).not.toBeNull();
    if (outcome === 'anonymous') cold.session({ status: 'signed_out', csrfToken: 'c'.repeat(40) }); else cold.sessionStatus(Number(outcome));
    await cold.browser.refresh().catch(() => {});
    expect(sessionStorage.getItem(REPLY_PENDING_KEY)).toBeNull(); expect(cold.commands).toHaveLength(0);
  });
  it.each([200, 401, 'network'] as const)('late list %s cannot publish or unlock a newer operation after cross-tab reset', async outcome => {
    const scope = setup(); await scope.browser.refresh();
    const waits: { resolve(value: Response): void; reject(): void }[] = [];
    scope.listWait(() => new Promise<Response>((resolve, reject) => { waits.push({ resolve, reject: () => { reject(new Error('offline')); } }); }));
    render(<BrowserReplies client={scope.browser} />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh replies' }));
    await vi.waitFor(() => { expect(waits).toHaveLength(1); });
    await act(async () => { scope.broadcast(); await scope.browser.refresh(); });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh replies' }));
    await vi.waitFor(() => { expect(waits).toHaveLength(2); });
    await act(async () => { if (outcome === 'network') waits[0]!.reject(); else waits[0]!.resolve(json({ businessDate: '2026-10-22', cards: [{ ...card, firmName: 'Stale Firm' }] }, outcome)); });
    expect(screen.queryByRole('button', { name: /Stale Firm/u })).toBeNull();
    expect(screen.getByRole('button', { name: 'Refresh replies' }).hasAttribute('disabled')).toBe(true);
    await act(async () => { waits[1]!.resolve(json({ businessDate: '2026-10-22', cards: [card] })); });
    expect(screen.getByRole('button', { name: 'Refresh replies' }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('button', { name: 'Synthetic Firm: Synthetic reply' })).toBeTruthy();
  });
  it('edits during an awaited preview prevent stale preview publication', async () => {
    const scope = setup(); await composer(scope);
    let release!: (response: Response) => void;
    scope.previewWait(() => new Promise<Response>(resolve => { release = resolve; }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Reply draft' }), { target: { value: 'Before wait' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview exact reply' }));
    await vi.waitFor(() => { expect(scope.previews).toHaveLength(1); });
    fireEvent.change(screen.getByRole('textbox', { name: 'Reply draft' }), { target: { value: 'After wait' } });
    await act(async () => { release(json({ ok: true, value: { sourceRevision: revision, draftRevision: 'b'.repeat(64), subject: 'Reply', body: 'Before wait', envelope: context().envelope } })); });
    expect(screen.queryByRole('article', { name: 'Final reply preview' })).toBeNull();
    expect((screen.getByRole('textbox', { name: 'Reply draft' }) as HTMLTextAreaElement).value).toBe('After wait');
  });
  it('manual composition remains available when the generation port refuses under valid authority', async () => {
    const scope = setup(); await composer(scope);
    scope.generateWait(async () => json({ status: 'refused', replayed: false, reason: 'generation_unavailable' }));
    fireEvent.click(screen.getByRole('button', { name: 'Generate suggestion' }));
    await screen.findByText(/Suggestion unavailable under current controls/u);
    expect(scope.browser.current?.status).toBe('signed_in');
    fireEvent.change(screen.getByRole('textbox', { name: 'Reply draft' }), { target: { value: 'Manual with no provider' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview exact reply' }));
    await screen.findByRole('article', { name: 'Final reply preview' });
    expect(scope.commands).toHaveLength(1);
  });
  it('does not dispatch or replace an attempt when durable storage cannot be written', async () => {
    const scope = setup(); await scope.browser.refresh();
    const storage = { getItem: () => null, setItem: () => { throw new Error('Storage blocked'); }, removeItem: () => {} };
    const blocked = new ReplyAttempt(scope.browser, storage, scope.uuid); resources.push(blocked);
    await expect(blocked.generate(context(), false)).rejects.toThrow('storage_unavailable');
    expect(scope.commands).toHaveLength(0);
  });
  it('cancelled operation ownership before generation reconstruction prevents paid dispatch', async () => {
    const scope = setup(); await scope.browser.refresh();
    let owns = true;
    const result = scope.attempts.generate(context(), false, () => owns);
    owns = false;
    await expect(result).rejects.toThrow('session_changed');
    expect(scope.commands).toHaveLength(0); expect(scope.uuid).not.toHaveBeenCalled();
  });
  it.each([200, 401, 'network'] as const)('late generation %s cannot publish or unlock replacement composer work', async outcome => {
    const scope = setup(); await composer(scope);
    let release!: (response: Response) => void, reject!: () => void;
    scope.generateWait(() => new Promise<Response>((resolve, fail) => { release = resolve; reject = () => { fail(new Error('offline')); }; }));
    fireEvent.click(screen.getByRole('button', { name: 'Generate suggestion' }));
    await vi.waitFor(() => { expect(scope.commands).toHaveLength(1); });
    await act(async () => { scope.broadcast(); await scope.browser.refresh(); });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh current reply context' }));
    await screen.findByText('Private current original');
    fireEvent.change(screen.getByRole('textbox', { name: 'Reply draft' }), { target: { value: 'Replacement draft' } });
    await act(async () => {
      if (outcome === 'network') reject();
      else release(json({ status: 'accepted', replayed: false, result: { ok: true, value: { sourceRevision: revision, draftRevision: 'b'.repeat(64), text: 'Stale suggestion', factRefs: [{ id, version: 1 }], reviewRequired: true, reviewNotes: ['Review.'] } } }, outcome));
    });
    expect((screen.getByRole('textbox', { name: 'Reply draft' }) as HTMLTextAreaElement).value).toBe('Replacement draft');
    expect(screen.queryByText('Stale suggestion')).toBeNull();
    expect(scope.browser.current?.status).toBe('signed_in');
    expect(sessionStorage.getItem(REPLY_PENDING_KEY)).toBeNull();
  });
});

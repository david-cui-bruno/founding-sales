// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { TextEncoder } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { type ReplyDraftContext } from '@fss/contracts';
import { BrowserClient } from '../../src/client/BrowserClient.ts';
import { BrowserReplyComposer } from '../../src/client/BrowserReplyComposer.tsx';
import { REPLY_ATTEMPT_LIMIT, REPLY_PENDING_KEY, ReplyAttempt } from '../../src/client/ReplyAttempt.ts';

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const a = id(1), b = id(2), revision = 'a'.repeat(64);
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });
const context = (messageId: string): ReplyDraftContext => ({ messageId, sourceRevision: revision, firmId: a, contactId: a, authorUserId: a,
  mailboxId: a, mailboxOwnerUserId: a, authorAddress: 'owner@example.test', authorizationRevision: 1,
  subject: `Reply ${messageId}`, senderAddress: 'person@example.test', providerThreadId: 'thread', inReplyTo: 'original', references: [],
  observedTo: ['owner@example.test'], observedCc: [], replyToMetadata: 'unavailable',
  envelope: { to: ['person@example.test'], cc: [] }, recipientOptions: [{ address: 'person@example.test', contactId: a }],
  messageText: `Private original ${messageId}`, priorContext: [], bookings: [], facts: [], availableFacts: [] });
const resources: { dispose(): void }[] = [];
function setup(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = sessionStorage) {
  const commands: { messageId: string; commandId: string }[] = [];
  let outcome = 'settled', auth = 200, sequence = 100;
  const session = { status: 'signed_in', workspaceId: a, userId: a, deviceId: a, role: 'admin', revision: 'one',
    csrfToken: 'c'.repeat(40), expiresAt: new Date(Date.now() + 120000).toISOString() };
  const send = vi.fn<typeof fetch>(async (url, init) => {
    if (url === '/browser/session') return json(session, auth);
    const body = JSON.parse(String(init?.body)) as { messageId: string; commandId: string };
    if (url === '/browser/api/replies/composer/context') return json({ ok: true, value: context(body.messageId) });
    if (url === '/browser/api/replies/composer/generate') {
      commands.push(body);
      if (outcome === 'unknown') throw new Error('Lost response');
      if (outcome === 'mailbox_not_ready') return json({ status: 'refused', replayed: false, reason: outcome });
      return json({ status: 'accepted', replayed: commands.filter(item => item.commandId === body.commandId).length > 1,
        result: { ok: true, value: { sourceRevision: revision, draftRevision: 'b'.repeat(64), text: 'Private suggestion', factRefs: [], reviewRequired: true, reviewNotes: ['Review all claims.'] } } });
    }
    throw new Error('Unexpected route');
  });
  const browser = new BrowserClient({ fetch: send, storage, navigate: vi.fn(), randomUUID: () => id(999) });
  const uuid = vi.fn(() => id(sequence++));
  const attempts = new ReplyAttempt(browser, storage, uuid);
  resources.push(browser, attempts);
  return { browser, attempts, uuid, commands, outcome: (value: string) => { outcome = value; }, auth: (value: number) => { auth = value; } };
}
beforeEach(() => { vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('TextEncoder', TextEncoder); });
afterEach(() => { cleanup(); for (const resource of resources.splice(0)) resource.dispose(); sessionStorage.clear(); vi.unstubAllGlobals(); });
async function load(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: 'Refresh current reply context' }));
  await screen.findByRole('button', { name: 'Generate suggestion' });
}

it.each(['settled', 'unknown', 'mailbox_not_ready'])('%s A permits B, then exact A custody survives switching and cold reload without replay', async outcome => {
  const scope = setup(); await scope.browser.refresh(); scope.outcome(outcome);
  const view = render(<BrowserReplyComposer client={scope.browser} attempts={scope.attempts} messageId={a} />);
  await load(); fireEvent.click(screen.getByRole('button', { name: 'Generate suggestion' }));
  await screen.findByRole('complementary', { name: 'Retained reply attempt' });
  const heldA = scope.attempts.pending(a)!;
  if (outcome === 'settled') await screen.findByRole('complementary', { name: 'Reply suggestion' });
  else expect(screen.queryByText(`Private original ${a}`)).toBeNull();
  const legacy = sessionStorage.getItem(REPLY_PENDING_KEY)!;
  expect(JSON.parse(legacy)).toMatchObject({ messageId: a, commandId: heldA.commandId });
  view.rerender(<BrowserReplyComposer client={scope.browser} attempts={scope.attempts} messageId={b} />);
  expect(screen.queryByText(`Private original ${a}`)).toBeNull();
  expect(screen.queryByRole('complementary', { name: 'Reply suggestion' })).toBeNull();
  await load(); expect((screen.getByRole('button', { name: 'Generate suggestion' }) as HTMLButtonElement).disabled).toBe(false);
  scope.outcome('settled'); fireEvent.click(screen.getByRole('button', { name: 'Generate suggestion' }));
  await screen.findByRole('complementary', { name: 'Retained reply attempt' });
  expect(scope.commands).toHaveLength(2); expect(scope.attempts.pending(a)).toEqual(heldA);
  expect(scope.attempts.pending(b)?.commandId).not.toBe(heldA.commandId);
  const migrated = sessionStorage.getItem(REPLY_PENDING_KEY)!;
  expect(migrated).not.toMatch(/@|Private|csrf|suggestion/u);
  view.rerender(<BrowserReplyComposer client={scope.browser} attempts={scope.attempts} messageId={a} />);
  await load(); expect((screen.getByRole('button', { name: 'Generate suggestion' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole('complementary', { name: 'Retained reply attempt' }).textContent).toContain(heldA.commandId);
  expect(scope.commands).toHaveLength(2);
  view.unmount(); scope.attempts.dispose();
  const cold = setup();
  expect(sessionStorage.getItem(REPLY_PENDING_KEY)).toBe(migrated);
  await cold.browser.refresh();
  render(<BrowserReplyComposer client={cold.browser} attempts={cold.attempts} messageId={a} />);
  await load(); expect(cold.commands).toHaveLength(0); expect(cold.attempts.pending(a)).toEqual(heldA);
  fireEvent.click(screen.getByRole('button', { name: 'Check same reply attempt' }));
  await screen.findByText(/Same attempt checked/u);
  expect(cold.commands).toHaveLength(1); expect(cold.commands[0]).toEqual(scope.commands[0]); expect(cold.uuid).not.toHaveBeenCalled();
  expect(sessionStorage.getItem(REPLY_PENDING_KEY)).toBe(migrated);
  cold.auth(401);
  await act(async () => { await cold.attempts.context(a).catch(() => {}); });
  expect(sessionStorage.getItem(REPLY_PENDING_KEY)).toBeNull(); expect(cold.attempts.pending(a)).toBeNull(); expect(cold.attempts.pending(b)).toBeNull();
});

it('cold legacy custody survives discovery and explicit same-attempt reconciliation byte-for-byte', async () => {
  const original = setup(); await original.browser.refresh(); await original.attempts.requestSuggestion(context(a), false);
  const legacy = sessionStorage.getItem(REPLY_PENDING_KEY)!; original.attempts.dispose();
  const cold = setup(); expect(sessionStorage.getItem(REPLY_PENDING_KEY)).toBe(legacy); expect(cold.attempts.pending(a)).toBeNull();
  await cold.browser.refresh(); expect(cold.commands).toHaveLength(0);
  await cold.attempts.requestSuggestion(context(a), true);
  expect(cold.commands[0]).toEqual(original.commands[0]); expect(cold.uuid).not.toHaveBeenCalled();
  expect(sessionStorage.getItem(REPLY_PENDING_KEY)).toBe(legacy);
});

it.each(['malformed', 'oversize', 'duplicate', 'overfull'])('fails closed on %s custody without deleting or replacing uncertainty', async kind => {
  const original = setup(); await original.browser.refresh(); await original.attempts.requestSuggestion(context(a), false);
  const record = original.attempts.pending(a)!; original.attempts.dispose();
  const raw = kind === 'malformed' ? '{' : kind === 'oversize' ? ' '.repeat(131073) : JSON.stringify({ version: 2,
    records: kind === 'duplicate' ? [record, record] : Array.from({ length: REPLY_ATTEMPT_LIMIT + 1 }, (_, index) => ({ ...record, messageId: id(index + 10), commandId: id(index + 100) })) });
  sessionStorage.setItem(REPLY_PENDING_KEY, raw);
  const scope = setup(); await scope.browser.refresh();
  await expect(scope.attempts.requestSuggestion(context(b), false)).rejects.toThrow('storage_unavailable');
  expect(sessionStorage.getItem(REPLY_PENDING_KEY)).toBe(raw); expect(scope.commands).toHaveLength(0); expect(scope.uuid).not.toHaveBeenCalled();
});

it('full custody rejects new work but permits exact existing-attempt reconciliation', async () => {
  const scope = setup(); await scope.browser.refresh(); await scope.attempts.requestSuggestion(context(a), false);
  const record = scope.attempts.pending(a)!;
  const records = [record, ...Array.from({ length: REPLY_ATTEMPT_LIMIT - 1 }, (_, index) => ({ ...record, messageId: id(index + 10), commandId: id(index + 200) }))];
  sessionStorage.setItem(REPLY_PENDING_KEY, JSON.stringify({ version: 2, records }));
  const raw = sessionStorage.getItem(REPLY_PENDING_KEY);
  await expect(scope.attempts.requestSuggestion(context(b), false)).rejects.toThrow('storage_unavailable');
  expect(sessionStorage.getItem(REPLY_PENDING_KEY)).toBe(raw); expect(scope.commands).toHaveLength(1);
  await scope.attempts.requestSuggestion(context(a), true);
  expect(scope.commands[1]).toEqual(scope.commands[0]); expect(sessionStorage.getItem(REPLY_PENDING_KEY)).toBe(raw);
});

it.each(['read', 'write', 'verify', 'remove'])('storage %s failure never admits replacement paid work', async kind => {
  const seed = setup(); await seed.browser.refresh(); await seed.attempts.requestSuggestion(context(a), false);
  const raw = sessionStorage.getItem(REPLY_PENDING_KEY)!; seed.attempts.dispose();
  let failed = false;
  const storage = {
    getItem: (key: string) => { if (kind === 'read' || (kind === 'verify' && failed)) throw new Error('blocked'); return sessionStorage.getItem(key); },
    setItem: (key: string, value: string) => { failed = true; if (kind === 'write') throw new Error('full'); sessionStorage.setItem(key, value); },
    removeItem: (key: string) => { if (kind === 'remove') throw new Error('blocked'); sessionStorage.removeItem(key); },
  };
  const scope = setup(storage); await scope.browser.refresh();
  if (kind === 'remove') { scope.browser.invalidate(); await scope.browser.refresh(); }
  await expect(scope.attempts.requestSuggestion(context(b), false)).rejects.toThrow('storage_unavailable');
  expect(scope.commands).toHaveLength(0);
  if (kind !== 'verify') expect(sessionStorage.getItem(REPLY_PENDING_KEY)).toBe(raw);
});

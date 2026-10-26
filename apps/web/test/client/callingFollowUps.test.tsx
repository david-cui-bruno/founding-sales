// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { TextEncoder } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '../../src/client/schemaRuntime.ts';
import { callingFollowUpSaveCommandSchema, type CallingFollowUpMetadata, type CallingFollowUpView, type CallingFollowUpSaveInput } from '@fss/contracts';
import { BrowserClient } from '../../src/client/BrowserClient.ts';
import { BrowserEmailWorkspace } from '../../src/client/BrowserEmailWorkspace.tsx';
import { CALLING_FOLLOW_UP_PENDING_KEY, CallingFollowUpPending, installCallingFollowUpCustody } from '../../src/client/CallingFollowUpPending.ts';
import { CallingFollowUpDispatch } from '../../src/client/CallingFollowUpDispatch.ts';
import { privateDraftCanonicalJson, privateDraftSHA256 } from '../../src/client/PrivateDraftCustody.ts';
import { payloadHashOf } from '../../../api/src/auth/tokens.ts';

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const a = id(1), b = id(2), date = '2026-10-25T12:00:00Z';
const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status });
type BrowserSave = CallingFollowUpSaveInput & { commandId: string };
function metadata(draftId = a, revision = 1): CallingFollowUpMetadata {
  return { draftId, revision, availability: 'available', source: { kind: 'candidate', candidateId: id(3), candidateRevision: 7, attemptId: id(4) }, createdAt: date, updatedAt: date };
}
function available(draftId = a, revision = 1, body = `Saved body ${draftId}`): CallingFollowUpView {
  return { ...metadata(draftId, revision), availability: 'available', content: { subject: 'Promised material', body }, state: 'queued_for_review', recipient: 'unresolved', sendAuthority: 'not_granted' };
}
const clients: BrowserClient[] = [], observers: (() => void)[] = [];
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('TextEncoder', TextEncoder);
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: vi.fn(async (_name: string, _options: unknown, work: () => Promise<unknown>) => work()) } });
});
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.dispose(); for (const dispose of observers.splice(0)) dispose(); sessionStorage.clear(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function setup() {
  let list: (input: { afterId?: string }) => Promise<Response> = async () => json({ drafts: [metadata(a), metadata(b)], nextAfterId: null });
  let read: (input: { draftId: string; expectedRevision: number }) => Promise<Response> = async input => json({ draft: available(input.draftId, input.expectedRevision) });
  let save: (input: BrowserSave) => Promise<Response> = async input => json({ status: 'accepted', replayed: false, result: { draftId: input.draftId, revision: input.expectedRevision + 1 } });
  let receipt: () => Promise<Response> = async () => json({ state: 'unknown' });
  const send = vi.fn<typeof fetch>(async (url, init) => {
    if (url === '/browser/session') return json({ status: 'signed_in', workspaceId: a, userId: a, deviceId: a, role: 'admin', revision: 'one', csrfToken: 'c'.repeat(40), expiresAt: new Date(Date.now() + 120000).toISOString() });
    const input = JSON.parse(String(init?.body)) as BrowserSave & { afterId?: string };
    if (url === '/browser/api/calling/follow-ups/list') return list(input);
    if (url === '/browser/api/calling/follow-ups/read') return read(input);
    if (url === '/browser/api/calling/follow-ups/save') { expect(localStorage.getItem(CALLING_FOLLOW_UP_PENDING_KEY)).toContain(input.commandId); return save(input); }
    if (url === '/browser/api/calling/follow-ups/receipt') return receipt();
    throw Error('Unexpected endpoint. No provider, outbound, wrap or send allowed.');
  });
  const client = new BrowserClient({ fetch: send, storage: sessionStorage, navigate: vi.fn(), randomUUID: () => id(99) });
  clients.push(client);
  observers.push(installCallingFollowUpCustody(client));
  return { client, send, list: (value: typeof list) => { list = value; }, read: (value: typeof read) => { read = value; }, save: (value: typeof save) => { save = value; }, receipt: (value: typeof receipt) => { receipt = value; } };
}
async function mount(scope: ReturnType<typeof setup>, selectedFollowUpDraftId?: string) {
  await scope.client.refresh();
  const view = render(<BrowserEmailWorkspace client={scope.client} selectedFollowUpDraftId={selectedFollowUpDraftId ?? null} />);
  if (!selectedFollowUpDraftId) fireEvent.click(screen.getByRole('button', { name: 'Follow-ups' }));
  await screen.findByRole('button', { name: new RegExp(`Draft ${a}`, 'u') });
  return view;
}
async function open(draftId = a) {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^Draft ${draftId}`, 'u') }));
  return screen.findByRole('textbox', { name: 'Follow-up body' });
}
const calls = (scope: ReturnType<typeof setup>, end: string) => scope.send.mock.calls.filter(([url]) => String(url).endsWith(end));
async function loseSave(scope: ReturnType<typeof setup>) {
  scope.save(async () => { throw Error('lost response'); });
  fireEvent.click(screen.getByRole('button', { name: 'Save private follow-up' }));
  await screen.findByText(/Save outcome UNKNOWN/u);
  return localStorage.getItem(CALLING_FOLLOW_UP_PENDING_KEY)!;
}

it('lists metadata only and reads exactly selected revision, never notes or inferred recipient', async () => {
  const scope = setup(); await mount(scope);
  expect(calls(scope, '/read')).toHaveLength(0);
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.queryByText(/Saved body/u)).toBeNull();
  await open();
  expect(JSON.parse(String(calls(scope, '/read')[0]?.[1]?.body))).toEqual({ draftId: a, expectedRevision: 1 });
  expect(screen.getByText(/Recipient unresolved/u)).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Private promised email' })).toBe(document.activeElement);
  expect(screen.getByText('Exact saved source').closest('details')?.open).toBe(false);
  expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
});

it('saves explicit edits using CAS, durable hash-only custody and a fresh exact accepted-revision read', async () => {
  const scope = setup(); let saved: BrowserSave | undefined;
  scope.save(async input => { saved = input; return json({ status: 'accepted', replayed: false, result: { draftId: a, revision: 2 } }); });
  scope.read(async input => json({ draft: available(a, input.expectedRevision, input.expectedRevision === 2 ? 'Current saved content' : 'Original saved content') }));
  await mount(scope); fireEvent.change(await open(), { target: { value: 'My exact edited promise' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Follow-up subject' }), { target: { value: 'Edited subject' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save private follow-up' }));
  await screen.findByText(/saved for review at revision 2/u);
  expect(saved).toMatchObject({ operation: 'update', draftId: a, expectedRevision: 1, subject: 'Edited subject', body: 'My exact edited promise' });
  expect(saved).not.toHaveProperty('clientVersion');
  expect((screen.getByRole('textbox', { name: 'Follow-up body' }) as HTMLTextAreaElement).value).toBe('Current saved content');
  expect(JSON.parse(String(calls(scope, '/read').at(-1)?.[1]?.body))).toEqual({ draftId: a, expectedRevision: 2 });
  expect(localStorage.getItem(CALLING_FOLLOW_UP_PENDING_KEY)).toBeNull();
  expect(calls(scope, '/save')).toHaveLength(1);
});

it('withdraws only after explicit permanent confirmation and never reopens withdrawn content', async () => {
  const scope = setup(); scope.read(async input => json({ draft: input.expectedRevision === 1 ? available() : { ...metadata(a, 2), availability: 'withdrawn' } }));
  await mount(scope); await open(); fireEvent.click(screen.getByRole('button', { name: 'Withdraw private follow-up' }));
  expect(calls(scope, '/save')).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm permanent withdrawal' }));
  await screen.findByText(/Historical save accepted. Follow-up withdrawn/u);
  expect(JSON.parse(String(calls(scope, '/save')[0]?.[1]?.body))).toMatchObject({ operation: 'withdraw', draftId: a, expectedRevision: 1 });
  expect(screen.queryByRole('textbox')).toBeNull(); expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
});

it('retains UNKNOWN across unmount, never replays/remints, and recovers only by exact receipt then current read', async () => {
  const scope = setup(); const view = await mount(scope); fireEvent.change(await open(), { target: { value: 'Private uncertain edit' } });
  const bytes = await loseSave(scope), [held] = JSON.parse(bytes) as { commandId: string; payloadSHA256: string }[];
  expect(bytes).not.toMatch(/Private uncertain edit|Promised material|subject|body/u);
  expect(held?.payloadSHA256).toBe(await privateDraftSHA256(privateDraftCanonicalJson({ operation: 'update', draftId: a, expectedRevision: 1, subject: 'Promised material', body: 'Private uncertain edit' })));
  view.unmount(); render(<BrowserEmailWorkspace client={scope.client} selectedFollowUpDraftId={a} />);
  await screen.findByRole('button', { name: 'Check same follow-up receipt' });
  expect(calls(scope, '/save')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Check same follow-up receipt' }));
  await screen.findByText(/Save outcome UNKNOWN/u);
  expect(localStorage.getItem(CALLING_FOLLOW_UP_PENDING_KEY)).toBe(bytes);
  expect(JSON.parse(String(calls(scope, '/receipt')[0]?.[1]?.body))).toEqual({ operation: 'save', commandId: held?.commandId, payloadSHA256: held?.payloadSHA256 });
  scope.receipt(async () => json({ state: 'accepted', acceptance: { operation: 'save', result: { draftId: a, revision: 2 } } }));
  fireEvent.click(screen.getByRole('button', { name: 'Check same follow-up receipt' }));
  await screen.findByText(/saved for review at revision 2/u);
  expect(calls(scope, '/save')).toHaveLength(1); expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
  expect((screen.getByRole('textbox', { name: 'Follow-up body' }) as HTMLTextAreaElement).value).not.toBe('Private uncertain edit');
});

it('does not let an UNKNOWN on A block an independent save on B or restore A prose', async () => {
  const scope = setup(); await mount(scope); await open(); const bytes = await loseSave(scope);
  await open(b); scope.save(async input => json({ status: 'accepted', replayed: false, result: { draftId: b, revision: input.expectedRevision + 1 } }));
  fireEvent.click(screen.getByRole('button', { name: 'Save private follow-up' })); await screen.findByText(/saved for review at revision 2/u);
  expect(localStorage.getItem(CALLING_FOLLOW_UP_PENDING_KEY)).toBe(bytes);
  expect(calls(scope, '/save')).toHaveLength(2);
});

it('clears unavailable source content but preserves opaque uncertainty and receipt access', async () => {
  const scope = setup(); await mount(scope); await open(); const bytes = await loseSave(scope);
  scope.read(async () => json({ error: 'draft_unavailable' }));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh follow-ups' }));
  await screen.findByRole('button', { name: new RegExp(`^Draft ${a}`, 'u') });
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^Draft ${a}`, 'u') }));
  await screen.findByText(/Current follow-up unavailable or outcome unknown/u);
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.getByRole('button', { name: 'Check same follow-up receipt' })).toBeTruthy();
  expect(localStorage.getItem(CALLING_FOLLOW_UP_PENDING_KEY)).toBe(bytes);
});

it('rejects mismatched save/receipt identity without losing UNKNOWN or accepting history as current content', async () => {
  const scope = setup(); scope.save(async () => json({ status: 'accepted', replayed: false, result: { draftId: b, revision: 2 } }));
  await mount(scope); await open(); fireEvent.click(screen.getByRole('button', { name: 'Save private follow-up' }));
  await screen.findByText(/Save outcome UNKNOWN/u); const bytes = localStorage.getItem(CALLING_FOLLOW_UP_PENDING_KEY);
  scope.receipt(async () => json({ state: 'accepted', acceptance: { operation: 'save', result: { draftId: a, revision: 8 } } }));
  fireEvent.click(screen.getByRole('button', { name: 'Check same follow-up receipt' }));
  await screen.findByText(/Current follow-up unavailable or outcome unknown/u);
  expect(localStorage.getItem(CALLING_FOLLOW_UP_PENDING_KEY)).toBe(bytes); expect(screen.queryByRole('textbox')).toBeNull();
});

it('handles a recorded CAS refusal without signing out, overwriting, retrying or retaining editor prose', async () => {
  const scope = setup(); scope.save(async () => json({ status: 'refused', replayed: false, reason: 'stale_revision' }));
  await mount(scope); await open(); fireEvent.click(screen.getByRole('button', { name: 'Save private follow-up' }));
  await screen.findByText(/Save refused/u); expect(scope.client.current?.status).toBe('signed_in');
  expect(screen.queryByRole('textbox')).toBeNull(); expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0); expect(calls(scope, '/save')).toHaveLength(1);
});

it('replaces bounded metadata pages and never guesses a requested draft revision', async () => {
  const scope = setup(); scope.list(async input => json(input.afterId ? { drafts: [metadata(b, 9)], nextAfterId: null } : { drafts: [metadata()], nextAfterId: a }));
  await mount(scope, b); expect(calls(scope, '/read')).toHaveLength(0);
  await screen.findByText(/No revision is guessed/u);
  fireEvent.click(screen.getByRole('button', { name: 'Next follow-ups page' }));
  await screen.findByRole('textbox', { name: 'Follow-up body' });
  expect(screen.queryByRole('button', { name: new RegExp(`^Draft ${a}`, 'u') })).toBeNull();
  expect(JSON.parse(String(calls(scope, '/read')[0]?.[1]?.body))).toEqual({ draftId: b, expectedRevision: 9 });
  expect(JSON.parse(String(calls(scope, '/list').at(-1)?.[1]?.body))).toEqual({ afterId: a });
});

it('fences a late selected-message read and clears private content/custody on authentication loss', async () => {
  const scope = setup(); let resolve: (response: Response) => void = () => {};
  scope.read(async input => input.draftId === a ? new Promise<Response>(done => { resolve = done; }) : json({ draft: available(b) }));
  await mount(scope); fireEvent.click(screen.getByRole('button', { name: new RegExp(`^Draft ${a}`, 'u') }));
  await waitFor(() => { expect(calls(scope, '/read')).toHaveLength(1); }); await open(b);
  await act(async () => { resolve(json({ draft: available(a) })); });
  expect((screen.getByRole('textbox', { name: 'Follow-up body' }) as HTMLTextAreaElement).value).toBe(`Saved body ${b}`);
  await loseSave(scope); act(() => { scope.client.invalidate(); });
  expect(screen.queryByRole('textbox')).toBeNull(); expect(localStorage.getItem(CALLING_FOLLOW_UP_PENDING_KEY)).toBeNull();
});

it('clears custody offscreen through the root lifetime observer without remounting Email', async () => {
  const scope = setup(); const view = await mount(scope); await open(); await loseSave(scope);
  view.unmount(); expect(localStorage.getItem(CALLING_FOLLOW_UP_PENDING_KEY)).not.toBeNull();
  act(() => { scope.client.invalidate(); }); expect(localStorage.getItem(CALLING_FOLLOW_UP_PENDING_KEY)).toBeNull();
});

it('fails closed before dispatch when locks or verified storage are unavailable', async () => {
  const scope = setup(); await mount(scope); await open();
  Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
  fireEvent.click(screen.getByRole('button', { name: 'Save private follow-up' }));
  await screen.findByText(/Current follow-up unavailable or outcome unknown/u);
  expect(calls(scope, '/save')).toHaveLength(0); expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
});

it('does not dispatch after save lock wait if selection was abandoned', async () => {
  const scope = setup(); let grant: (() => Promise<unknown>) | undefined;
  await mount(scope); await open();
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (_name: string, _options: unknown, work: () => Promise<unknown>) => new Promise(resolve => { grant = async () => { try { resolve(await work()); } catch { resolve(undefined); } }; }) } });
  fireEvent.click(screen.getByRole('button', { name: 'Save private follow-up' }));
  await open(b); await act(async () => { await grant?.(); });
  expect(calls(scope, '/save')).toHaveLength(0); expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
});

it('does not dispatch or remint when verified pending storage cannot be written', async () => {
  const scope = setup(); await mount(scope); await open();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw Error('quota'); });
  fireEvent.click(screen.getByRole('button', { name: 'Save private follow-up' }));
  await screen.findByText(/Current follow-up unavailable or outcome unknown/u);
  expect(calls(scope, '/save')).toHaveLength(0); expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
});

it('keeps malformed existing custody fail-closed instead of replacing its unknown identity', async () => {
  const scope = setup(); localStorage.setItem(CALLING_FOLLOW_UP_PENDING_KEY, '{malformed');
  await mount(scope); await open();
  expect((screen.getByRole('button', { name: 'Save private follow-up' }) as HTMLButtonElement).disabled).toBe(true);
  expect(calls(scope, '/save')).toHaveLength(0);
  expect(localStorage.getItem(CALLING_FOLLOW_UP_PENDING_KEY)).toBe('{malformed');
});

it('keeps an unrecorded content-error response UNKNOWN, but a recorded receipt refusal releases it', async () => {
  const scope = setup(); scope.save(async () => json({ error: 'draft_unavailable' }));
  await mount(scope); await open(); fireEvent.click(screen.getByRole('button', { name: 'Save private follow-up' }));
  await screen.findByText(/Save outcome UNKNOWN/u);
  expect(scope.client.current?.status).toBe('signed_in'); expect(localStorage.length).toBe(1); expect(sessionStorage.length).toBe(0);
  scope.receipt(async () => json({ state: 'refused', reason: 'draft_unavailable' }));
  fireEvent.click(screen.getByRole('button', { name: 'Check same follow-up receipt' }));
  await screen.findByText(/Save refused/u); expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
  expect(calls(scope, '/save')).toHaveLength(1); expect(screen.queryByRole('textbox')).toBeNull();
});

it('rejects a mismatched exact read before displaying any private content', async () => {
  const scope = setup(); scope.read(async () => json({ draft: available(b, 2, 'Wrong private content') }));
  await mount(scope); fireEvent.click(screen.getByRole('button', { name: new RegExp(`^Draft ${a}`, 'u') }));
  await screen.findByText(/Current follow-up unavailable or outcome unknown/u);
  expect(screen.queryByRole('textbox')).toBeNull(); expect(screen.queryByText('Wrong private content')).toBeNull();
});

it('does not let accepted late save restore content or custody after session invalidation', async () => {
  const scope = setup(); let release: (response: Response) => void = () => {};
  scope.save(async () => new Promise<Response>(done => { release = done; }));
  await mount(scope); await open(); fireEvent.click(screen.getByRole('button', { name: 'Save private follow-up' }));
  await waitFor(() => { expect(calls(scope, '/save')).toHaveLength(1); });
  act(() => { scope.client.invalidate(); });
  await act(async () => { release(json({ status: 'accepted', replayed: false, result: { draftId: a, revision: 2 } })); });
  expect(calls(scope, '/read')).toHaveLength(1); expect(screen.queryByRole('textbox')).toBeNull(); expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
});

it('retains a dispatched late save as UNKNOWN after switching selection, without restoring old text', async () => {
  const scope = setup(); let release: (response: Response) => void = () => {};
  scope.save(async () => new Promise<Response>(done => { release = done; }));
  await mount(scope); await open(); fireEvent.click(screen.getByRole('button', { name: 'Save private follow-up' }));
  await waitFor(() => { expect(calls(scope, '/save')).toHaveLength(1); });
  await open(b); const bytes = localStorage.getItem(CALLING_FOLLOW_UP_PENDING_KEY);
  await act(async () => { release(json({ status: 'accepted', replayed: false, result: { draftId: a, revision: 2 } })); });
  expect((screen.getByRole('textbox', { name: 'Follow-up body' }) as HTMLTextAreaElement).value).toBe(`Saved body ${b}`);
  expect(localStorage.getItem(CALLING_FOLLOW_UP_PENDING_KEY)).toBe(bytes);
  expect(calls(scope, '/read')).toHaveLength(2);
});

it('rejects oversized metadata and provides Back focus without keeping private edits', async () => {
  const scope = setup(); await mount(scope); fireEvent.change(await open(), { target: { value: 'Discard on Back' } });
  fireEvent.click(screen.getByRole('button', { name: 'Back to follow-ups' }));
  expect(screen.getByRole('heading', { name: 'Calling follow-ups' })).toBe(document.activeElement);
  expect(screen.queryByRole('textbox')).toBeNull(); expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
  scope.list(async () => json({ drafts: Array.from({ length: 21 }, (_, index) => metadata(id(index + 10))), nextAfterId: null }));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh follow-ups' }));
  await screen.findByText(/Current follow-up metadata unavailable/u);
  expect(screen.queryByRole('button', { name: /^Draft /u })).toBeNull();
});

it('conserves both independent UNKNOWN records without reminting on duplicate clicks', async () => {
  const scope = setup(), mint = vi.spyOn(crypto, 'randomUUID'); await mount(scope); await open();
  scope.save(async () => { throw Error('uncertain'); });
  const save = screen.getByRole('button', { name: 'Save private follow-up' });
  fireEvent.click(save); fireEvent.click(save); await screen.findByText(/Save outcome UNKNOWN/u);
  await open(b); await loseSave(scope);
  const held = JSON.parse(localStorage.getItem(CALLING_FOLLOW_UP_PENDING_KEY)!) as { draftId: string }[];
  expect(held.map(value => value.draftId)).toEqual([a, b]); expect(mint).toHaveBeenCalledTimes(2); expect(calls(scope, '/save')).toHaveLength(2);
});

it('does not mint or dispatch invalid blank content and never treats a wrap receipt as save acceptance', async () => {
  const scope = setup(), mint = vi.spyOn(crypto, 'randomUUID'); await mount(scope);
  fireEvent.change(await open(), { target: { value: '   ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save private follow-up' }));
  expect(screen.getByText(/Enter a nonblank subject/u)).toBeTruthy(); expect(mint).not.toHaveBeenCalled(); expect(calls(scope, '/save')).toHaveLength(0);
  fireEvent.change(screen.getByRole('textbox', { name: 'Follow-up body' }), { target: { value: 'Explicit promise' } }); await loseSave(scope);
  const bytes = localStorage.getItem(CALLING_FOLLOW_UP_PENDING_KEY);
  scope.receipt(async () => json({ state: 'accepted', acceptance: { operation: 'wrap', result: { kind: 'firm', firmId: a, callLogId: id(6), staleIntroductions: 'stopped', attention: [], followUp: { state: 'not_requested' } } } }));
  fireEvent.click(screen.getByRole('button', { name: 'Check same follow-up receipt' }));
  await screen.findByText(/Current follow-up unavailable or outcome unknown/u);
  expect(localStorage.getItem(CALLING_FOLLOW_UP_PENDING_KEY)).toBe(bytes); expect(mint).toHaveBeenCalledTimes(1);
});

it('fences save preparation after hashing if selection changed, before UUID mint or storage', async () => {
  const scope = setup(), mint = vi.spyOn(crypto, 'randomUUID'); let release: (() => void) | undefined;
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...args) => {
    await new Promise<void>(resolve => { release = resolve; }); return digest(...args);
  });
  await mount(scope); await open(); fireEvent.click(screen.getByRole('button', { name: 'Save private follow-up' }));
  await waitFor(() => { expect(release).toBeDefined(); }); await open(b);
  await act(async () => { release?.(); await new Promise(resolve => { setTimeout(resolve, 0); }); });
  expect(mint).not.toHaveBeenCalled(); expect(calls(scope, '/save')).toHaveLength(0); expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
});

it.each(['update', 'withdraw'] as const)('omits browser clientVersion for %s while preserving envelope-free hash and exact receipt identity', async operation => {
  const scope = setup(), mint = vi.spyOn(crypto, 'randomUUID');
  const input: CallingFollowUpSaveInput = operation === 'update'
    ? { operation, draftId: a, expectedRevision: 1, subject: 'Promised material', body: 'Version-independent promise' }
    : { operation, draftId: a, expectedRevision: 1 };
  let serverPayloadHash: string | undefined;
  scope.save(async browserCommand => {
    expect(browserCommand).not.toHaveProperty('clientVersion');
    expect(browserCommand).toEqual({ ...input, commandId: expect.any(String) });
    // Model the existing gateway injection followed by runRouteCommand's envelope removal.
    const parsed = callingFollowUpSaveCommandSchema.parse({ ...browserCommand, clientVersion: '1.4.7' });
    const { commandId, clientVersion, ...payload } = parsed;
    expect(clientVersion).toBe('1.4.7'); expect(commandId).toBe(browserCommand.commandId);
    serverPayloadHash = payloadHashOf(payload);
    throw Error('Accepted response lost');
  });
  await mount(scope); fireEvent.change(await open(), { target: { value: 'Version-independent promise' } });
  if (operation === 'withdraw') {
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw private follow-up' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm permanent withdrawal' }));
  } else fireEvent.click(screen.getByRole('button', { name: 'Save private follow-up' }));
  await screen.findByText(/Save outcome UNKNOWN/u);
  const bytes = localStorage.getItem(CALLING_FOLLOW_UP_PENDING_KEY)!;
  const [held] = JSON.parse(bytes) as { commandId: string; payloadSHA256: string }[];
  expect(serverPayloadHash).toBe(await privateDraftSHA256(privateDraftCanonicalJson(input)));
  expect(held?.payloadSHA256).toBe(serverPayloadHash);
  fireEvent.click(screen.getByRole('button', { name: 'Check same follow-up receipt' }));
  await waitFor(() => { expect(calls(scope, '/receipt')).toHaveLength(1); });
  await waitFor(() => { expect((screen.getByRole('button', { name: 'Check same follow-up receipt' }) as HTMLButtonElement).disabled).toBe(false); });
  expect(JSON.parse(String(calls(scope, '/receipt')[0]?.[1]?.body))).toEqual({ operation: 'save', commandId: held?.commandId, payloadSHA256: serverPayloadHash });
  expect(localStorage.getItem(CALLING_FOLLOW_UP_PENDING_KEY)).toBe(bytes);
  expect(calls(scope, '/save')).toHaveLength(1); expect(mint).toHaveBeenCalledTimes(1);
});

function isolatedTabStorage(): Storage {
  const values = new Map<string, string>();
  return { get length() { return values.size; }, key: index => [...values.keys()][index] ?? null, clear: () => { values.clear(); },
    getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } };
}
function serializedTabLocks() {
  const queues = new Map<string, Promise<void>>(), held = new Set<string>();
  const request = vi.fn(async (name: string, _options: unknown, work: () => Promise<unknown>) => {
    const previous = queues.get(name) ?? Promise.resolve();
    let release = (): void => {};
    const next = new Promise<void>(resolve => { release = resolve; }); queues.set(name, previous.then(() => next));
    await previous; held.add(name);
    try { return await work(); } finally { held.delete(name); release(); }
  });
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } });
  return { request, held };
}
async function custodyTab(number: number, expiresAt = new Date(Date.now() + 180000).toISOString()) {
  const tabStorage = isolatedTabStorage();
  vi.stubGlobal('sessionStorage', tabStorage);
  let response: (input: BrowserSave) => Promise<Response> = async () => { throw Error('lost save response'); };
  const send = vi.fn<typeof fetch>(async (url, init) => {
    if (url === '/browser/session') return json({ status: 'signed_in', workspaceId: a, userId: a, deviceId: a, role: 'admin', revision: 'one', csrfToken: 'c'.repeat(40), expiresAt });
    if (url === '/browser/api/calling/follow-ups/save') return response(JSON.parse(String(init?.body)) as BrowserSave);
    if (url === '/browser/api/calling/follow-ups/receipt') return json({ state: 'accepted', acceptance: { operation: 'save', result: { draftId: a, revision: 2 } } });
    throw Error('Unexpected cross-tab operation');
  });
  const client = new BrowserClient({ fetch: send, storage: tabStorage, navigate: vi.fn(), randomUUID: () => id(90 + number) });
  clients.push(client); await client.refresh();
  const mint = vi.fn(() => id(70 + number));
  const custody = new CallingFollowUpPending(client, undefined, mint);
  observers.push(() => { custody.dispose(); }); observers.push(installCallingFollowUpCustody(client));
  const epoch = client.epoch, current = (): boolean => client.isCurrent(epoch) && client.current?.status === 'signed_in';
  return { client, custody, mint, send, current, tabStorage, dispatch: new CallingFollowUpDispatch(client, custody), response: (value: typeof response) => { response = value; } };
}
const sharedSave = (draftId = a): CallingFollowUpSaveInput => ({ operation: 'update', draftId, expectedRevision: 1, subject: 'Private promised subject', body: 'Private promised body' });

it('cross-tab UNKNOWN excludes tab B after tab A releases its lock and recovers only the same UUID/hash', async () => {
  const locks = serializedTabLocks(), tabA = await custodyTab(1), tabB = await custodyTab(2);
  expect(await tabA.dispatch.save(sharedSave(), tabA.current)).toEqual({ state: 'unknown' });
  const held = tabA.custody.read(a)!; expect(held).not.toBeNull(); expect(locks.held.size).toBe(0);
  tabA.custody.dispose(); // Screen unmount cannot discard the shared unknown.
  expect(await tabB.dispatch.save(sharedSave(), tabB.current)).toEqual({ state: 'unknown' });
  expect(tabB.send.mock.calls.filter(([url]) => String(url).endsWith('/save'))).toHaveLength(0);
  expect(tabB.mint).not.toHaveBeenCalled(); expect(tabB.custody.read(a)).toEqual(held);
  const bytes = localStorage.getItem(CALLING_FOLLOW_UP_PENDING_KEY)!;
  expect(bytes).not.toMatch(/Private promised subject|Private promised body|subject|body/u);
  expect(tabA.tabStorage.getItem(CALLING_FOLLOW_UP_PENDING_KEY)).toBeNull(); expect(tabB.tabStorage.getItem(CALLING_FOLLOW_UP_PENDING_KEY)).toBeNull();
  expect(await tabB.dispatch.reconcile(held, tabB.current)).toEqual({ state: 'accepted', draftId: a, revision: 2 });
  const receipt = tabB.send.mock.calls.find(([url]) => String(url).endsWith('/receipt'));
  expect(JSON.parse(String(receipt?.[1]?.body))).toEqual({ operation: 'save', commandId: held.commandId, payloadSHA256: held.payloadSHA256 });
  expect(localStorage.getItem(CALLING_FOLLOW_UP_PENDING_KEY)).toBeNull(); expect(tabA.mint).toHaveBeenCalledTimes(1); expect(tabB.mint).not.toHaveBeenCalled();
});

it('cross-tab different drafts conserve simultaneous UNKNOWN records and resolve one without erasing the other', async () => {
  const locks = serializedTabLocks(), expiry = new Date(Date.now() + 180000).toISOString();
  const tabA = await custodyTab(1, expiry), tabB = await custodyTab(2, expiry);
  expect(await Promise.all([tabA.dispatch.save(sharedSave(a), tabA.current), tabB.dispatch.save(sharedSave(b), tabB.current)])).toEqual([{ state: 'unknown' }, { state: 'unknown' }]);
  expect(tabA.custody.all().map(value => value.draftId).sort()).toEqual([a, b]);
  expect(tabB.custody.all()).toEqual(tabA.custody.all());
  const heldB = tabB.custody.read(b), heldA = tabA.custody.read(a)!;
  await tabB.dispatch.reconcile(heldA, tabB.current);
  expect(tabA.custody.read(a)).toBeNull(); expect(tabA.custody.read(b)).toEqual(heldB);
  expect(locks.request.mock.calls.filter(([name]) => name === 'callie.calling-follow-up-records').length).toBeGreaterThanOrEqual(3);
  expect(locks.held.size).toBe(0);
});

it('cross-tab shorter current lease cannot erase another valid pending save and offscreen auth clears it', async () => {
  serializedTabLocks(); const tabA = await custodyTab(1, new Date(Date.now() + 240000).toISOString());
  const tabB = await custodyTab(2, new Date(Date.now() + 120000).toISOString());
  await tabA.dispatch.save(sharedSave(), tabA.current); const held = tabA.custody.read(a)!;
  expect(tabB.custody.read(a)).toEqual(held);
  tabA.custody.dispose(); tabB.custody.dispose();
  act(() => { tabA.client.invalidate(); });
  expect(localStorage.getItem(CALLING_FOLLOW_UP_PENDING_KEY)).toBeNull(); expect(tabB.custody.read(a)).toBeNull();
});

it('cross-tab unrelated draft completes while another draft network response is still outstanding', async () => {
  const locks = serializedTabLocks(), expiry = new Date(Date.now() + 180000).toISOString();
  const tabA = await custodyTab(1, expiry), tabB = await custodyTab(2, expiry);
  let release: (response: Response) => void = () => {};
  tabA.response(async () => new Promise<Response>(resolve => { release = resolve; }));
  tabB.response(async input => {
    expect(locks.held.has('callie.calling-follow-up-records')).toBe(false);
    return json({ status: 'accepted', replayed: false, result: { draftId: input.draftId, revision: input.expectedRevision + 1 } });
  });
  const outstanding = tabA.dispatch.save(sharedSave(a), tabA.current);
  await waitFor(() => { expect(tabA.send.mock.calls.some(([url]) => String(url).endsWith('/save'))).toBe(true); });
  const heldA = tabA.custody.read(a);
  expect(await tabB.dispatch.save(sharedSave(b), tabB.current)).toEqual({ state: 'accepted', draftId: b, revision: 2 });
  expect(tabB.custody.read(a)).toEqual(heldA); expect(tabB.custody.read(b)).toBeNull();
  release(json({ error: 'draft_unavailable' })); expect(await outstanding).toEqual({ state: 'unknown' });
});

it('cross-tab registry wait rechecks auth before mint and cannot recreate cleared custody offscreen', async () => {
  const locks = serializedTabLocks(), tabA = await custodyTab(1); let release = (): void => {};
  const blocker = locks.request('callie.calling-follow-up-records', {}, async () => new Promise<void>(resolve => { release = resolve; }));
  await waitFor(() => { expect(locks.held.has('callie.calling-follow-up-records')).toBe(true); });
  const result = tabA.dispatch.save(sharedSave(), tabA.current).catch(() => ({ state: 'blocked' }));
  await waitFor(() => { expect(locks.request.mock.calls.filter(([name]) => name === 'callie.calling-follow-up-records')).toHaveLength(2); });
  tabA.custody.dispose(); act(() => { tabA.client.invalidate(); }); release(); await blocker;
  expect(await result).toEqual({ state: 'blocked' }); expect(tabA.mint).not.toHaveBeenCalled();
  expect(tabA.send.mock.calls.filter(([url]) => String(url).endsWith('/save'))).toHaveLength(0); expect(localStorage.getItem(CALLING_FOLLOW_UP_PENDING_KEY)).toBeNull();
});

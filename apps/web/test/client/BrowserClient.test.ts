import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { BrowserClient, PENDING_KEY, type BrowserClientOptions, type InvalidationChannel } from '../../src/client/BrowserClient.ts';

const id = '00000000-0000-4000-8000-000000000001';
const session = { status: 'signed_in' as const, workspaceId: id, userId: id, deviceId: id, role: 'admin' as const, revision: 'revision-one', csrfToken: 'c'.repeat(40), expiresAt: new Date(Date.now() + 120_000).toISOString() };
const draft = { meetingId: id, expectedRevision: 0, debrief: 'Synthetic fixture notes', speakerMappings: [], itemOverrides: [], sufficient: false };
const response = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve: value => { resolve(value); } };
}
function storage(): BrowserClientOptions['storage'] {
  const values = new Map<string, string>();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } };
}
class Channel implements InvalidationChannel {
  listener: (() => void) | undefined;
  sent: unknown[] = [];
  postMessage(value: unknown): void { this.sent.push(value); }
  addEventListener(_type: 'message', listener: () => void): void { this.listener = listener; }
  removeEventListener(): void { this.listener = undefined; }
  close(): void {}
}
function setup(send: typeof fetch, store = storage(), channel = new Channel()) {
  const navigate = vi.fn();
  const client = new BrowserClient({ fetch: send, storage: store, channel, navigate, randomUUID: () => id });
  return { client, store, channel, navigate };
}

describe('real browser manager generation and custody', () => {
  it('uses only same-origin cookie transport, exact revision and CSRF headers', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(response(session)).mockResolvedValueOnce(response(session)).mockResolvedValueOnce(response({ value: 'ok' }));
    const { client } = setup(send);
    await client.refresh();
    await expect(client.request('/today', z.strictObject({ value: z.string() }))).resolves.toEqual({ value: 'ok' });
    expect(send.mock.calls[2]?.[0]).toBe('/browser/api/today');
    expect(send.mock.calls[2]?.[1]).toMatchObject({ credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { 'x-callie-session': session.revision, 'x-callie-csrf': session.csrfToken } });
    expect(JSON.stringify(send.mock.calls)).not.toMatch(/authorization|deviceSecret|accessToken/u);
  });
  it('fences logout while waiting for session refresh BEFORE command dispatch', async () => {
    const wait = deferred<Response>();
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(response(session)).mockImplementationOnce(async () => await wait.promise);
    const { client } = setup(send);
    await client.refresh();
    const work = client.request('/meetings/notes', z.unknown(), draft);
    const rejected = expect(work).rejects.toMatchObject({ reason: 'session_changed' });
    client.invalidate();
    wait.resolve(response(session));
    await rejected;
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('fences a response JSON body that finishes after logout', async () => {
    const body = deferred<unknown>();
    const answer = response(null);
    answer.json = async () => await body.promise;
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(response(session)).mockResolvedValueOnce(response(session)).mockResolvedValueOnce(answer);
    const { client } = setup(send);
    await client.refresh();
    const work = client.request('/today', z.unknown());
    const rejected = expect(work).rejects.toMatchObject({ reason: 'session_changed' });
    await vi.waitFor(() => { expect(send).toHaveBeenCalledTimes(3); });
    client.invalidate();
    body.resolve({ private: 'late' });
    await rejected;
    expect(client.current).toBeNull();
  });
  it.each(['revision', 'role', 'userId', 'workspaceId', 'deviceId'] as const)('clears pending and refuses dispatch after %s transition', async field => {
    const next = { ...session, [field]: field === 'role' ? 'salesperson' : field === 'revision' ? 'revision-two' : '00000000-0000-4000-8000-000000000002' };
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(response(session)).mockResolvedValueOnce(response(next));
    const { client, store, channel } = setup(send);
    await client.refresh();
    client.retainPending(client.prepareNotes(draft));
    await expect(client.request('/meetings/notes', z.unknown(), draft)).rejects.toMatchObject({ reason: 'session_changed' });
    expect(store.getItem(PENDING_KEY)).toBeNull();
    expect(channel.sent).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('persists exact command before dispatch, reloads without retry and explicitly reuses identity after lost response', async () => {
    const store = storage();
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(response(session)).mockResolvedValueOnce(response(session)).mockImplementationOnce(async () => {
      expect(store.getItem(PENDING_KEY)).not.toBeNull();
      throw new Error('lost response');
    });
    const { client } = setup(send, store);
    await client.refresh();
    const pending = client.prepareNotes(draft);
    await expect(client.request('/meetings/notes', z.unknown(), { ...draft, commandId: pending.commandId }, () => { client.retainPending(pending); })).rejects.toMatchObject({ reason: 'unavailable' });
    expect(send).toHaveBeenCalledTimes(3);
    const reloadSend = vi.fn<typeof fetch>().mockResolvedValue(response(session));
    const reloaded = setup(reloadSend, store).client;
    await reloaded.refresh();
    expect(reloadSend).toHaveBeenCalledTimes(1);
    expect(reloaded.prepareNotes(draft)).toEqual(pending);
    expect(() => reloaded.prepareNotes({ ...draft, debrief: 'Changed' })).toThrow();
    reloaded.completePending(pending.commandId);
    expect(store.getItem(PENDING_KEY)).toBeNull();
  });
  it('refuses dispatch if durable retention fails', async () => {
    const send = vi.fn<typeof fetch>().mockImplementation(async () => response(session));
    const broken = storage();
    broken.setItem = () => { throw new Error('storage denied'); };
    const { client } = setup(send, broken);
    await client.refresh();
    expect(() => client.prepareNotes(draft)).toThrow('storage_unavailable');
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('clears on cross-tab invalidation, does not broadcast-loop or auto retry', async () => {
    const send = vi.fn<typeof fetch>().mockImplementation(async () => response(session));
    const { client, channel, store } = setup(send);
    await client.refresh(); client.retainPending(client.prepareNotes(draft));
    channel.listener?.();
    expect(client.current).toBeNull();
    expect(store.getItem(PENDING_KEY)).toBeNull();
    expect(channel.sent).toEqual([]);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('remote logout failure clears locally but never claims success', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(response(session)).mockRejectedValueOnce(new Error('offline'));
    const { client, store } = setup(send);
    await client.refresh(); client.retainPending(client.prepareNotes(draft));
    await expect(client.signOut()).rejects.toMatchObject({ reason: 'unavailable' });
    expect(client.current).toBeNull(); expect(store.getItem(PENDING_KEY)).toBeNull();
  });
  it.each([401, 403, 409])('auth or revision refusal %s clears pending and never replays mutation', async status => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(response(session)).mockResolvedValueOnce(response(session)).mockResolvedValueOnce(response({ error: 'refused' }, status));
    const { client, store } = setup(send);
    await client.refresh(); const held = client.prepareNotes(draft);
    await expect(client.request('/meetings/notes', z.unknown(), draft, () => { client.retainPending(held); })).rejects.toMatchObject({ reason: 'refused' });
    expect(client.current).toBeNull(); expect(store.getItem(PENDING_KEY)).toBeNull(); expect(send).toHaveBeenCalledTimes(3);
  });
  it('normal auth navigation uses only authorizationUrl and sign-in has anonymous CSRF', async () => {
    const anonymous = { status: 'signed_out', csrfToken: 'a'.repeat(40) };
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(response(anonymous)).mockResolvedValueOnce(response({ authorizationUrl: 'https://local-idp.example/authorize?state=public' }));
    const { client, navigate } = setup(send);
    await client.signIn(id, 'Test browser');
    expect(navigate).toHaveBeenCalledWith('https://local-idp.example/authorize?state=public');
    expect(send.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ workspaceId: id, deviceLabel: 'Test browser' }));
  });
});

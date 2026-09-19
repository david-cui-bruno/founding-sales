import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { diagnosticsViewSchema } from '../../../src/shared/contracts/v1Contract';
import { ClientCore } from './clientCore';
import { TODAY_LAST_GOOD_FILE } from './lastGood';
import { TokenStore, type SafeStorageLike } from './tokenStore';

/**
 * The orchestration behind the five IPC channels, on a programmable fetch: pairing with a code or a code
 * file, reads and commands with the bearer, the honest outcomes, and the two 401 reasons that forget the
 * token. The token store is the real one on a fake safeStorage; the last-good file is the real file.
 */
const endpoint = 'https://worker.example.test';
const fakeSafeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.concat([Buffer.from('FAKE1'), Buffer.from(value, 'utf8').map((byte) => byte ^ 0x5a)]),
  decryptString: (buffer) => Buffer.from(buffer.subarray(5).map((byte) => byte ^ 0x5a)).toString('utf8'),
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const secret = () => randomBytes(32).toString('base64url');
const NOW = '2026-09-18T12:00:00.000Z';

const diagnostics = () => diagnosticsViewSchema.parse({
  asOf: NOW,
  attempts: [{ at: NOW, kind: 'pairing', outcome: 'ok', reason: null, detail: { code: 'device_paired' }, durationMs: 12, ref: null }],
  lastTick: null,
  devices: [{ deviceId: randomUUID(), label: 'David MacBook', createdAt: NOW, lastSeenAt: null, revokedAt: null, expiresAt: '2026-12-17T12:00:00.000Z' }],
});

let root: string;
let clientDirectory: string;
let fetch: ReturnType<typeof vi.fn>;
let core: ClientCore;
const newCore = (resolution: { endpoint: string | null } = { endpoint }) => new ClientCore({
  clientDirectory,
  tokenStore: new TokenStore({ directory: clientDirectory, safeStorage: fakeSafeStorage }),
  endpoint: resolution.endpoint === null ? { endpoint: null, source: 'none', problem: 'unconfigured' } : { endpoint: resolution.endpoint, source: 'environment' },
  fetch: fetch as unknown as typeof globalThis.fetch,
  now: () => NOW,
});
const pairedCore = async () => {
  const token = secret(); const deviceId = randomUUID();
  fetch.mockResolvedValueOnce(json(200, { deviceToken: token, deviceId, workspaceId: 'ws' }));
  const result = await core.pair({ codeOrPath: secret() });
  expect(result.outcome).toBe('paired');
  fetch.mockClear();
  return { token, deviceId };
};
const lastCall = () => fetch.mock.calls[fetch.mock.calls.length - 1] as [string, RequestInit];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'client-core-'));
  clientDirectory = join(root, 'client');
  fetch = vi.fn();
  core = newCore();
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('status', () => {
  it('is unpaired with the resolved endpoint before any pairing', async () => {
    expect(await core.status()).toEqual({ state: 'unpaired', endpoint, endpointSource: 'environment', deviceId: null, workspaceId: null, pairedAt: null, notice: null });
  });
  it('names an unconfigured endpoint honestly', async () => {
    expect((await newCore({ endpoint: null }).status()).endpointSource).toBe('none');
  });
});

describe('pair', () => {
  it('redeems a pasted code once and stores the device', async () => {
    const token = secret(); const deviceId = randomUUID(); const code = secret();
    fetch.mockResolvedValueOnce(json(200, { deviceToken: token, deviceId, workspaceId: 'ws' }));
    const result = await core.pair({ codeOrPath: code });
    expect(result).toEqual({ outcome: 'paired', codeFileDeleted: false, status: { state: 'paired', endpoint, endpointSource: 'environment', deviceId, workspaceId: 'ws', pairedAt: NOW, notice: null } });
    const [url, init] = lastCall();
    expect(url).toBe(`${endpoint}/v1/pair/redeem`);
    expect(init.body).toBe(JSON.stringify({ code }));
    expect(new Headers(init.headers).has('authorization')).toBe(false);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(await core.status()).toMatchObject({ state: 'paired', deviceId });
  });

  it('reads the code from a file the user chose and deletes the file after the redeem', async () => {
    const path = join(root, 'device-code'); const code = secret();
    writeFileSync(path, `${code}\n`);
    fetch.mockResolvedValueOnce(json(200, { deviceToken: secret(), deviceId: randomUUID(), workspaceId: 'ws' }));
    const result = await core.pair({ codeOrPath: path });
    expect(result).toMatchObject({ outcome: 'paired', codeFileDeleted: true });
    expect(existsSync(path)).toBe(false);
    expect(JSON.parse(String(lastCall()[1].body))).toEqual({ code });
  });

  it('keeps the code file when the worker refuses the code', async () => {
    const path = join(root, 'device-code');
    writeFileSync(path, `${secret()}\n`);
    fetch.mockResolvedValueOnce(json(400, { error: 'pair_refused', reason: 'code_expired' }));
    expect(await core.pair({ codeOrPath: path })).toEqual({ outcome: 'refused', reason: 'code_expired', sentence: 'The worker refused this code: code_expired.' });
    expect(existsSync(path)).toBe(true);
    expect(await core.status()).toMatchObject({ state: 'unpaired' });
  });

  it('refuses locally what is neither a code nor a code file, without calling the worker', async () => {
    expect(await core.pair({ codeOrPath: 'nope' })).toEqual({ outcome: 'refused', reason: 'code_invalid', sentence: 'That is neither a pairing code nor the absolute path of a code file.' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses when no endpoint is configured', async () => {
    expect(await newCore({ endpoint: null }).pair({ codeOrPath: secret() })).toMatchObject({ outcome: 'refused', reason: 'endpoint_unconfigured' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports the worker as unavailable after the one retry', async () => {
    fetch.mockRejectedValue(new TypeError('fetch failed'));
    expect(await core.pair({ codeOrPath: secret() })).toEqual({ outcome: 'unavailable', reason: 'network', sentence: 'The worker could not be reached.' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('refuses a redeem answer that does not match the contract', async () => {
    fetch.mockResolvedValueOnce(json(200, { deviceToken: secret() }));
    expect(await core.pair({ codeOrPath: secret() })).toMatchObject({ outcome: 'unavailable', reason: 'invalid_response' });
    expect(await core.status()).toMatchObject({ state: 'unpaired' });
  });
});

describe('get', () => {
  it('is unpaired before pairing, without calling the worker', async () => {
    expect(await core.get({ view: '/v1/diagnostics' })).toEqual({ outcome: 'unpaired', sentence: 'This Mac is not paired.' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reads Diagnostics with the bearer and the kind filter and validates the view', async () => {
    const { token } = await pairedCore();
    const view = diagnostics();
    fetch.mockResolvedValueOnce(json(200, view));
    expect(await core.get({ view: '/v1/diagnostics', kind: 'command' })).toEqual({ outcome: 'ok', fetchedAt: NOW, view, source: 'worker' });
    const [url, init] = lastCall();
    expect(url).toBe(`${endpoint}/v1/diagnostics?kind=command`);
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${token}`);
    expect(existsSync(join(clientDirectory, TODAY_LAST_GOOD_FILE))).toBe(false);
  });

  it('persists the last good /v1/today answer with its fetched-at stamp, and serves it as last_good when the worker does not answer', async () => {
    await pairedCore();
    const today = { asOf: NOW, list: null, reason: 'not_built_yet', postures: [], statesWithoutPosture: ['RI'] };
    // Nothing on disk yet: a failed read is unavailable, never an invented list.
    fetch.mockResolvedValueOnce(json(503, { error: 'unavailable' }));
    expect(await core.get({ view: '/v1/today' })).toMatchObject({ outcome: 'unavailable', reason: 'unavailable', status: 503 });
    fetch.mockResolvedValueOnce(json(200, today));
    expect(await core.get({ view: '/v1/today' })).toEqual({ outcome: 'ok', fetchedAt: NOW, view: today, source: 'worker' });
    expect(JSON.parse(readFileSync(join(clientDirectory, TODAY_LAST_GOOD_FILE), 'utf8'))).toEqual({ fetchedAt: NOW, view: today });
    // The worker fails: the last good answer is served with its own stamp and the failure's sentence; the file is untouched.
    fetch.mockResolvedValueOnce(json(503, { error: 'unavailable' }));
    expect(await core.get({ view: '/v1/today' })).toEqual({ outcome: 'ok', fetchedAt: NOW, view: today, source: 'last_good', sentence: "The worker's store is unavailable right now." });
    expect(JSON.parse(readFileSync(join(clientDirectory, TODAY_LAST_GOOD_FILE), 'utf8')).fetchedAt).toBe(NOW);
    // A view the contract refuses is unavailable as invalid_response and is not written over the good one.
    fetch.mockResolvedValueOnce(json(200, { list: null, reason: 'not_built' }));
    expect(await core.get({ view: '/v1/today' })).toMatchObject({ outcome: 'ok', source: 'last_good' });
    // A refused token is never papered over with the old list.
    fetch.mockResolvedValueOnce(json(401, { error: 'unauthenticated' }));
    expect(await core.get({ view: '/v1/today' })).toMatchObject({ outcome: 'unauthenticated', cleared: false });
  });

  it('refuses a view that does not match the contract', async () => {
    await pairedCore();
    fetch.mockResolvedValueOnce(json(200, { asOf: NOW, attempts: [], devices: [] }));
    expect(await core.get({ view: '/v1/diagnostics' })).toMatchObject({ outcome: 'unavailable', reason: 'invalid_response', status: 200 });
  });

  it.each([
    ['device_expired', 'The worker refused this device: its token expired. Pair again with a new code.'],
    ['device_revoked', 'The worker refused this device: it was revoked. Pair again with a new code.'],
  ] as const)('a 401 %s forgets the token and returns to Pair with the sentence', async (reason, sentence) => {
    await pairedCore();
    fetch.mockResolvedValueOnce(json(401, { error: 'unauthenticated', reason }));
    expect(await core.get({ view: '/v1/diagnostics' })).toEqual({ outcome: 'unauthenticated', reason, cleared: true, sentence });
    expect(await core.status()).toMatchObject({ state: 'unpaired', deviceId: null, notice: sentence });
    expect(existsSync(join(clientDirectory, 'device-token.bin'))).toBe(false);
  });

  it('keeps the token on a 401 without a reason and says so', async () => {
    const { deviceId } = await pairedCore();
    fetch.mockResolvedValueOnce(json(401, { error: 'unauthenticated' }));
    expect(await core.get({ view: '/v1/diagnostics' })).toEqual({ outcome: 'unauthenticated', reason: null, cleared: false, sentence: "The worker refused this device's token. Unpair and pair again with a new code." });
    expect(await core.status()).toMatchObject({ state: 'paired', deviceId, notice: null });
  });

  it.each([
    [404, { error: 'not_found' }, 'not_found', 'The worker does not serve this view yet.'],
    [400, { error: 'invalid_request' }, 'invalid_request', 'The worker refused the request as malformed.'],
    [500, { error: 'worker_error' }, 'worker_error', 'The worker reported its own error.'],
    [503, { error: 'unavailable' }, 'unavailable', "The worker's store is unavailable right now."],
    [502, 'bad gateway', 'http_502', 'The worker answered with status 502.'],
  ])('reports status %i as unavailable with its reason', async (status, body, reason, sentence) => {
    await pairedCore();
    fetch.mockResolvedValueOnce(typeof body === 'string' ? new Response(body, { status }) : json(status, body));
    expect(await core.get({ view: '/v1/diagnostics' })).toEqual({ outcome: 'unavailable', reason, status, sentence });
  });

  it('reports a timeout and a network failure as unavailable', async () => {
    await pairedCore();
    fetch.mockRejectedValue(new TypeError('fetch failed'));
    expect(await core.get({ view: '/v1/diagnostics' })).toEqual({ outcome: 'unavailable', reason: 'network', status: null, sentence: 'The worker could not be reached.' });
  });
});

describe('command', () => {
  it('posts the command with the bearer and returns the receipt', async () => {
    const { token } = await pairedCore();
    const command = { commandId: randomUUID(), kind: 'revoke_device' as const, deviceId: randomUUID() };
    fetch.mockResolvedValueOnce(json(200, { commandId: command.commandId, outcome: 'applied', reason: null }));
    expect(await core.command(command)).toEqual({ outcome: 'ok', receipt: { commandId: command.commandId, outcome: 'applied', reason: null } });
    const [url, init] = lastCall();
    expect(url).toBe(`${endpoint}/v1/commands`);
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify(command));
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${token}`);
  });

  it('retries the same command once on a network error, never with a new id', async () => {
    await pairedCore();
    const command = { commandId: randomUUID(), kind: 'revoke_device' as const, deviceId: randomUUID() };
    fetch.mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(json(200, { commandId: command.commandId, outcome: 'duplicate', reason: 'applied' }));
    expect(await core.command(command)).toMatchObject({ outcome: 'ok', receipt: { outcome: 'duplicate' } });
    expect(fetch.mock.calls.map(call => String((call[1] as RequestInit).body))).toEqual([JSON.stringify(command), JSON.stringify(command)]);
  });

  it('is unpaired before pairing and forgets the token on a 401 device_revoked', async () => {
    const command = { commandId: randomUUID(), kind: 'revoke_device' as const, deviceId: randomUUID() };
    expect(await core.command(command)).toEqual({ outcome: 'unpaired', sentence: 'This Mac is not paired.' });
    await pairedCore();
    fetch.mockResolvedValueOnce(json(401, { error: 'unauthenticated', reason: 'device_revoked' }));
    expect(await core.command(command)).toMatchObject({ outcome: 'unauthenticated', reason: 'device_revoked', cleared: true });
    expect(await core.status()).toMatchObject({ state: 'unpaired' });
  });
});

describe('unpair', () => {
  it('forgets the token, clears any notice and never calls the worker', async () => {
    await pairedCore();
    fetch.mockResolvedValueOnce(json(401, { error: 'unauthenticated', reason: 'device_expired' }));
    await core.get({ view: '/v1/diagnostics' });
    expect((await core.status()).notice).not.toBeNull();
    fetch.mockClear();
    expect(await core.unpair()).toEqual({ state: 'unpaired', endpoint, endpointSource: 'environment', deviceId: null, workspaceId: null, pairedAt: null, notice: null });
    expect(fetch).not.toHaveBeenCalled();
    expect(existsSync(join(clientDirectory, 'device-token.bin'))).toBe(false);
  });

  it('reports a token file it cannot read as a notice and treats the Mac as unpaired', async () => {
    await pairedCore();
    writeFileSync(join(clientDirectory, 'device-token.bin'), Buffer.from('junk'));
    const status = await core.status();
    expect(status).toMatchObject({ state: 'unpaired', notice: 'The stored device token could not be read. Pair again with a new code.' });
  });
});

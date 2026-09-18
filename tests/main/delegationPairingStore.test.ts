import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { PairingStore } from '../../src/main/delegation/pairingStore';
import { SqlDelegationConfiguration, SqlDelegationTransport } from '../../src/main/delegation/delegationSync';
import { createPmFixture, PM_NOW } from '../fixtures/pmAccounts';
import type { SafeStorage } from '../../src/main/outreach/providers/providerTypes';
import { WorkerAuth } from '../../cloud/lambdas/delegated-worker/src/workerAuth';
import { ConditionalCommandHarness } from '../../cloud/lambdas/delegated-worker/test/sdkHarness';
import { createWorkerHandler } from '../../cloud/lambdas/delegated-worker/src/handler';
const key = randomBytes(32);
const safeStorage: SafeStorage = { isEncryptionAvailable: () => true,
  encryptString: value => { const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', key, iv); const body = Buffer.concat([c.update(value, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), body]); },
  decryptString: value => { const c = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); c.setAuthTag(value.subarray(12, 28)); return Buffer.concat([c.update(value.subarray(28)), c.final()]).toString('utf8'); } };
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await mkdtemp(join(process.env.JCODE_SCRATCH_DIR ?? process.cwd(), '.fictional-pairing-')); dirs.push(dir);
  const directory = join(dir, 'pairing');
  const auth = new WorkerAuth({ dynamo: new ConditionalCommandHarness(), tableName: 'fictional', workspaceId: 'paired-workspace', clock: { now: () => '2026-09-08T12:00:00.000Z' } });
  const { code } = await auth.issuePairing({ scopes: ['commands:write', 'events:read'], expiresInSeconds: 300 });
  const handler = createWorkerHandler({ auth, host: 'worker.example.test' });
  const http: typeof fetch = async (url, init) => {
    const parsed = new URL(String(url));
    const result = await handler({ version: '2.0', rawPath: parsed.pathname, rawQueryString: '', body: String(init?.body),
      headers: { host: parsed.host, 'x-forwarded-proto': 'https' }, requestContext: { domainName: parsed.host, http: { method: 'POST', sourceIp: 'fixture' } } });
    return new Response(result.body, { status: result.statusCode });
  };
  return { directory, code, auth, store: new PairingStore({ directory, safeStorage, fetch: http }) };
}
it('is absent and inactive by default without creating files or contacting an endpoint', async () => {
  const f = await fixture();
  expect(await f.store.load()).toBeNull();
  await expect(stat(f.directory)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('persists only authenticated exact-workspace pairing encrypted and private across restart', async () => {
  const f = await fixture();
  const result = await f.store.redeem({ endpoint: 'https://worker.example.test', expectedWorkspaceId: 'paired-workspace', code: f.code }, new AbortController().signal);
  expect(result).toMatchObject({ workspaceId: 'paired-workspace', state: 'paired' });
  expect(JSON.stringify(result)).not.toMatch(/credential|Bearer/);
  const restarted = new PairingStore({ directory: f.directory, safeStorage });
  const loaded = await restarted.load();
  expect(loaded).toMatchObject({ workspaceId: 'paired-workspace', endpoint: 'https://worker.example.test', generation: 0 });
  const bytes = await readFile(join(f.directory, 'pairing.json'), 'utf8');
  expect(bytes).not.toContain(loaded!.credential);
  expect(bytes).not.toContain('paired-workspace');
  expect((await stat(join(f.directory, 'pairing.json'))).mode & 0o777).toBe(0o600);
});
it('refuses cross-workspace redemption without persisting rights', async () => {
  const f = await fixture();
  await expect(f.store.redeem({ endpoint: 'https://worker.example.test', expectedWorkspaceId: 'other', code: f.code }, new AbortController().signal)).rejects.toThrow();
  expect(await f.store.load()).toBeNull();
});
it('refuses insecure endpoints and insecure stored permissions', async () => {
  const f = await fixture();
  await expect(f.store.redeem({ endpoint: 'http://worker.example.test', expectedWorkspaceId: 'paired-workspace', code: f.code }, new AbortController().signal)).rejects.toThrow();
  await f.store.redeem({ endpoint: 'https://worker.example.test', expectedWorkspaceId: 'paired-workspace', code: f.code }, new AbortController().signal);
  await chmod(join(f.directory, 'pairing.json'), 0o644);
  await expect(f.store.load()).rejects.toThrow();
});
it('does not replace a pairing admitted by another store while redemption is in flight', async () => {
  const f = await fixture();
  let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
  const delayed = new PairingStore({ directory: f.directory, safeStorage, fetch: async () => {
    entered(); await wait;
    return Response.json({ workspaceId: 'paired-workspace', pairingId: 'second-pairing', credential: 'B'.repeat(43), emergencyCredential: 'C'.repeat(43),
      generation: 0, scopes: ['commands:write', 'events:read'] });
  } });
  const second = delayed.redeem({ endpoint: 'https://worker.example.test', expectedWorkspaceId: 'paired-workspace', code: 'D'.repeat(43) }, new AbortController().signal);
  await ready;
  await f.store.redeem({ endpoint: 'https://worker.example.test', expectedWorkspaceId: 'paired-workspace', code: f.code }, new AbortController().signal);
  const original = await f.store.load(); release();
  await expect(second).rejects.toThrow();
  expect(await f.store.load()).toEqual(original);
});

const endpoint = 'https://worker.example.test';
const widened = ['commands:write', 'events:read', 'google:grant', 'pairing:revoke'] as const;
async function pairedFixture() {
  const f = await fixture();
  await f.store.redeem({ endpoint, expectedWorkspaceId: 'paired-workspace', code: f.code }, new AbortController().signal);
  const before = (await f.store.load())!;
  return { ...f, before };
}
it('describes the stored pairing without any credential and reads nothing when no pairing is stored', async () => {
  const f = await fixture();
  expect(await f.store.describe()).toBeNull();
  await expect(stat(f.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  await f.store.redeem({ endpoint, expectedWorkspaceId: 'paired-workspace', code: f.code }, new AbortController().signal);
  const summary = await f.store.describe();
  const stored = (await f.store.load())!;
  expect(summary).toEqual({ workspaceId: 'paired-workspace', pairingId: stored.pairingId, endpoint, generation: 0, scopes: ['commands:write', 'events:read'] });
  expect(JSON.stringify(summary)).not.toMatch(/credential|Bearer/);
  expect(JSON.stringify(summary)).not.toContain(stored.credential);
});
it('rotates the credential in place through the real worker handler: same pairing id, generation plus one, new scopes, old credential dead', async () => {
  const f = await pairedFixture();
  const rotation = await f.auth.issueRotation({ pairingId: f.before.pairingId, scopes: [...widened], expiresInSeconds: 300 });
  const result = await f.store.rotate({ pairingId: f.before.pairingId, expectedGeneration: 0, code: rotation.code }, new AbortController().signal);
  expect(result).toEqual({ state: 'rotated', workspaceId: 'paired-workspace', pairingId: f.before.pairingId, generation: 1, scopes: [...widened] });
  expect(JSON.stringify(result)).not.toMatch(/credential|Bearer/);
  const after = (await new PairingStore({ directory: f.directory, safeStorage }).load())!;
  expect(after).toMatchObject({ workspaceId: 'paired-workspace', pairingId: f.before.pairingId, endpoint, generation: 1, scopes: [...widened] });
  expect(after.credential).not.toBe(f.before.credential);
  expect(after.emergencyCredential).not.toBe(f.before.emergencyCredential);
  // The worker refuses the previous credentials and accepts the stored ones with the scopes they lacked.
  await expect(f.auth.authenticate(`Bearer ${f.before.credential}`, ['commands:write'])).rejects.toThrow('worker_unauthorized');
  await expect(f.auth.authenticate(`Bearer ${f.before.emergencyCredential}`, ['emergency:stop'])).rejects.toThrow('worker_unauthorized');
  expect((await f.auth.authenticate(`Bearer ${after.credential}`, ['google:grant', 'pairing:revoke'])).generation).toBe(1);
  expect((await f.auth.authenticate(`Bearer ${after.emergencyCredential}`, ['emergency:stop'])).kind).toBe('emergency');
  // The file is still private, holds no plaintext, and no temporary file is left behind.
  expect((await stat(join(f.directory, 'pairing.json'))).mode & 0o777).toBe(0o600);
  const bytes = await readFile(join(f.directory, 'pairing.json'), 'utf8');
  expect(bytes).not.toContain(after.credential); expect(bytes).not.toContain(f.before.credential);
  expect((await readdir(f.directory)).sort()).toEqual(['pairing.json']);
});
it('recovers when a rotation committed on the worker but its reply never reached this Mac: the next code is accepted at any higher generation', async () => {
  const f = await pairedFixture();
  // Generation 1 commits on the worker; the Mac never saves it (the reply was lost), so its stored credential is dead.
  const lost = await f.auth.issueRotation({ pairingId: f.before.pairingId, scopes: [...widened], expiresInSeconds: 300 });
  await f.auth.redeemPairing(lost.code, '198.51.100.7');
  await expect(f.auth.authenticate(`Bearer ${f.before.credential}`, ['commands:write'])).rejects.toThrow('worker_unauthorized');
  expect((await f.store.load())!.generation).toBe(0);
  // The operator mints another code; the Mac still holds generation 0 and receives generation 2. That is the recovery.
  const again = await f.auth.issueRotation({ pairingId: f.before.pairingId, scopes: [...widened], expiresInSeconds: 300 });
  const result = await f.store.rotate({ pairingId: f.before.pairingId, expectedGeneration: 0, code: again.code }, new AbortController().signal);
  expect(result).toMatchObject({ state: 'rotated', pairingId: f.before.pairingId, generation: 2 });
  const after = (await f.store.load())!;
  expect(after.generation).toBe(2);
  expect((await f.auth.authenticate(`Bearer ${after.credential}`, ['google:grant'])).generation).toBe(2);
});
it('keeps every desktop row keyed by the pairing id readable after rotation on a real migrated encrypted database', async () => {
  const f = await pairedFixture();
  const db = await createPmFixture();
  try {
    const clock = { now: () => PM_NOW };
    const transport = new SqlDelegationTransport({ database: db.db, workspaceId: f.before.workspaceId, pairingId: f.before.pairingId, clock });
    const attempt = transport.begin(); transport.finish(attempt, null, true);
    const configuration = new SqlDelegationConfiguration({ database: db.db, workspaceId: f.before.workspaceId, pairingId: f.before.pairingId, clock });
    configuration.configure({ expectedRevision: 0, configuration: { version: 1, state: 'active', research: null } });
    const rotation = await f.auth.issueRotation({ pairingId: f.before.pairingId, scopes: [...widened], expiresInSeconds: 300 });
    await f.store.rotate({ pairingId: f.before.pairingId, expectedGeneration: 0, code: rotation.code }, new AbortController().signal);
    const after = (await f.store.load())!;
    expect(after.pairingId).toBe(f.before.pairingId); expect(after.generation).toBe(1);
    // The same identity opens the same rows: nothing was orphaned, nothing was rewritten.
    expect(new SqlDelegationTransport({ database: db.db, workspaceId: after.workspaceId, pairingId: after.pairingId, clock }).current()).toMatchObject({ state: 'complete', revision: 1 });
    expect(new SqlDelegationConfiguration({ database: db.db, workspaceId: after.workspaceId, pairingId: after.pairingId, clock }).read()).toMatchObject({ revision: 1, configuration: { state: 'active' } });
    expect(db.db.raw.prepare('SELECT pairing_id FROM delegated_transport_state').all()).toEqual([{ pairing_id: f.before.pairingId }]);
    expect(db.db.raw.prepare('SELECT pairing_id FROM delegated_local_configuration').all()).toEqual([{ pairing_id: f.before.pairingId }]);
  } finally { db.close(); }
});
it.each([
  ['a different pairing id', { pairingId: '22222222-2222-4222-8222-222222222222', generation: 1 }],
  ['the same generation', { generation: 0 }],
  ['another workspace', { workspaceId: 'other-workspace', generation: 1 }],
  ['a scope set without commands:write', { generation: 1, scopes: ['events:read', 'google:grant'] }],
] as const)('refuses a rotation reply carrying %s and keeps the stored pairing byte for byte', async (_label, reply) => {
  const f = await pairedFixture();
  const originalBytes = await readFile(join(f.directory, 'pairing.json'));
  const store = new PairingStore({ directory: f.directory, safeStorage, fetch: async () => Response.json({
    workspaceId: 'paired-workspace', pairingId: f.before.pairingId, credential: 'B'.repeat(43), emergencyCredential: 'C'.repeat(43), scopes: [...widened], ...reply }) });
  await expect(store.rotate({ pairingId: f.before.pairingId, expectedGeneration: 0, code: 'D'.repeat(43) }, new AbortController().signal)).rejects.toThrow('pairing_identity_mismatch');
  expect(await readFile(join(f.directory, 'pairing.json'))).toEqual(originalBytes);
  expect(await f.store.load()).toEqual(f.before);
  expect((await readdir(f.directory)).sort()).toEqual(['pairing.json']);
});
it('refuses a rotation request that names a pairing or generation other than the stored one before contacting the worker', async () => {
  const f = await pairedFixture();
  let calls = 0;
  const store = new PairingStore({ directory: f.directory, safeStorage, fetch: async () => { calls++; throw Error('unexpected'); } });
  await expect(store.rotate({ pairingId: '22222222-2222-4222-8222-222222222222', expectedGeneration: 0, code: 'D'.repeat(43) }, new AbortController().signal)).rejects.toThrow('pairing_identity_mismatch');
  await expect(store.rotate({ pairingId: f.before.pairingId, expectedGeneration: 1, code: 'D'.repeat(43) }, new AbortController().signal)).rejects.toThrow('pairing_identity_mismatch');
  expect(calls).toBe(0);
  expect(await f.store.load()).toEqual(f.before);
});
it('refuses a rotation when no pairing is stored, and Pair worker still refuses when one is', async () => {
  const f = await fixture();
  let calls = 0;
  const store = new PairingStore({ directory: f.directory, safeStorage, fetch: async () => { calls++; throw Error('unexpected'); } });
  await expect(store.rotate({ pairingId: '22222222-2222-4222-8222-222222222222', expectedGeneration: 0, code: 'D'.repeat(43) }, new AbortController().signal)).rejects.toThrow('pairing_unconfigured');
  expect(calls).toBe(0);
  await expect(stat(f.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  await f.store.redeem({ endpoint, expectedWorkspaceId: 'paired-workspace', code: f.code }, new AbortController().signal);
  await expect(f.store.redeem({ endpoint, expectedWorkspaceId: 'paired-workspace', code: f.code }, new AbortController().signal)).rejects.toThrow('pairing_already_configured');
});
it('refuses a replayed rotation code and a rotation for a revoked pairing without touching the stored pairing', async () => {
  const f = await pairedFixture();
  const rotation = await f.auth.issueRotation({ pairingId: f.before.pairingId, scopes: [...widened], expiresInSeconds: 300 });
  await f.store.rotate({ pairingId: f.before.pairingId, expectedGeneration: 0, code: rotation.code }, new AbortController().signal);
  const rotated = (await f.store.load())!;
  await expect(f.store.rotate({ pairingId: f.before.pairingId, expectedGeneration: 1, code: rotation.code }, new AbortController().signal)).rejects.toThrow('pairing_unavailable');
  expect(await f.store.load()).toEqual(rotated);
  const second = await f.auth.issueRotation({ pairingId: f.before.pairingId, scopes: [...widened], expiresInSeconds: 300 });
  await f.auth.revokePairing(f.before.pairingId);
  await expect(f.store.rotate({ pairingId: f.before.pairingId, expectedGeneration: 1, code: second.code }, new AbortController().signal)).rejects.toThrow('pairing_unavailable');
  expect(await f.store.load()).toEqual(rotated);
});

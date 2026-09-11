import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { PairingStore } from '../../src/main/delegation/pairingStore';
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
  return { directory, code, store: new PairingStore({ directory, safeStorage, fetch: http }) };
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

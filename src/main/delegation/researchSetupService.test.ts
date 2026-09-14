import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdtemp, rm, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppDatabase } from '../db/database';
import type { SafeStorage } from '../outreach/providers/providerTypes';
import { createDelegationRuntime, type DelegationRuntime } from './delegationRuntime';
import { ResearchSetupRequestStore } from './researchSetupRequestStore';
import { accountFingerprint } from '../domain/accounts/accountEvidence';
import { researchSetupRequestSchema, type ResearchSetupRequest, type ResearchSetupReceipt, type ResearchSetupApproveInput } from '../../shared/contracts/researchSetupContract';

const key = randomBytes(32);
const safeStorage: SafeStorage = { isEncryptionAvailable: () => true,
  encryptString: value => { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, c.update(value), c.final(), c.getAuthTag()]); },
  decryptString: value => { const c = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); c.setAuthTag(value.subarray(-16)); return Buffer.concat([c.update(value.subarray(12, -16)), c.final()]).toString(); } };
const identity = { endpoint: 'https://worker.example.test', workspaceId: 'setup-fiction', pairingId: '11111111-1111-4111-8111-111111111111' };
const pairing = { ...identity, credential: 'A'.repeat(43), emergencyCredential: 'B'.repeat(43), generation: 0, scopes: ['events:read' as const, 'commands:write' as const] };
const now = '2026-09-14T01:00:00.000Z';
const proposal = (): ResearchSetupApproveInput => ({ expectedRevision: 0, descriptorFingerprint: 'a'.repeat(64), audience: { residential: true, regions: ['Fictional region'], terms: ['property management'] }, permittedSources: ['https://official.example.test/'], maxCompanies: 1, maxPages: 1, maxBytes: 10000, discoveryCeilingMicros: 100, researchCeilingMicros: 100, disclosureAcknowledged: true });
const receipt = (r: ResearchSetupRequest, cancelled = false): ResearchSetupReceipt => ({ requestId: r.requestId, workspaceId: r.workspaceId, pairingId: r.pairingId, kind: r.kind, fingerprint: accountFingerprint(researchSetupRequestSchema.parse(r)), ...(cancelled ? { status: 'cancelled' as const, revision: null, state: null } : { status: 'applied' as const, revision: 1, state: 'active' as const }) });
const status = (ack: ResearchSetupReceipt | null = null): import('../../shared/contracts/researchSetupContract').ResearchSetupRemoteStatus => ({ workspaceId: identity.workspaceId, pairingId: identity.pairingId, selector: null, discoveryLedger: null, researchLedger: null, descriptor: null, descriptorFingerprint: null, credentialParameterDeclared: false, blockers: ['operator_descriptor_missing'], checkedAt: now, receipt: ack });
const directories: string[] = [], runtimes: DelegationRuntime[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(runtimes.splice(0).map(r => r.dispose())); await Promise.all(directories.splice(0).map(dir => rm(dir, { force: true, recursive: true }))); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; }
async function fixture() {
  const root = await mkdtemp(join(process.env.JCODE_SCRATCH_DIR ?? join(homedir(), '.jcode', 'scratch'), 'research-service-test-')); directories.push(root);
  const directory = join(root, 'journal'), store = new ResearchSetupRequestStore({ directory, safeStorage });
  let activeLeases = 0, gateWait: Promise<unknown> | undefined;
  const database = new Proxy({} as AppDatabase, { get() { throw Error('Research setup must never access a database'); } });
  const create = (http: typeof fetch, researchSetupStore = store, customPairing: typeof pairing | null = pairing) => {
    const runtime = createDelegationRuntime({ pairing: customPairing, researchSetupStore, fetch: http, clock: { now: () => now }, databaseGate: {
      async withDatabase(fn) { if (gateWait) await gateWait; activeLeases++; try { return await fn(database); } finally { activeLeases--; } },
    } }); runtimes.push(runtime); return runtime;
  };
  return { root, directory, store, create, activeLeases: () => activeLeases, gate: (wait: Promise<unknown>) => { gateWait = wait; } };
}

describe('pure research setup runtime with actual filesystem journal and no native DB', () => {
  it('startup and Refresh never replay, unknown writes persist before HTTP, exact Retry sends same original bytes', async () => {
    const f = await fixture(), calls: { path: string; body: unknown }[] = [];
    let failWrite = true;
    const http: typeof fetch = async (url, init) => {
      const path = new URL(String(url)).pathname, body = JSON.parse(String(init?.body)); calls.push({ path, body });
      expect(init).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store' });
      if (path.endsWith('/status')) return Response.json(status());
      expect((await f.store.load(identity))?.request).toEqual(body);
      if (failWrite) throw Error('credential SECRET private targeting');
      return Response.json(receipt(body));
    };
    const first = f.create(http); expect(calls).toEqual([]);
    await expect(first.researchSetup!.approve(proposal())).rejects.toThrow(/^research_setup_unavailable$/);
    const stored = await f.store.load(identity); expect(stored).not.toBeNull();
    await first.dispose(); const restarted = f.create(http); expect(calls).toHaveLength(1);
    const read = await restarted.researchSetup!.status(); expect(read.pending?.requestId).toBe(stored?.request.requestId); expect(read.blockers).toContain('local_pending');
    expect(calls.map(c => c.path)).toEqual(['/research/setup', '/research/setup/status']);
    await expect(restarted.researchSetup!.approve(proposal())).rejects.toThrow(); expect(calls).toHaveLength(2);
    failWrite = false; expect(await restarted.researchSetup!.retry()).toMatchObject({ status: 'applied' });
    expect(calls[2].body).toEqual(calls[0].body); expect(await f.store.load(identity)).toBeNull(); expect(f.activeLeases()).toBe(0);
  });
  it.each([false, true])('Cancel carries original and accepts only exact applied/cancelled winner %s', async cancelled => {
    const f = await fixture(), sent: unknown[] = []; let uncertain = true;
    const runtime = f.create(async (_url, init) => { const body = JSON.parse(String(init?.body)); sent.push(body); if (uncertain) throw Error('unknown'); return Response.json(receipt(body.originalRequest, cancelled)); });
    await expect(runtime.researchSetup!.approve(proposal())).rejects.toThrow(); uncertain = false;
    expect(await runtime.researchSetup!.cancelPending()).toMatchObject({ status: cancelled ? 'cancelled' : 'applied' });
    expect(sent[1]).toEqual({ version: 1, kind: 'cancel', originalRequest: sent[0] }); expect(await f.store.load(identity)).toBeNull();
  });
  it.each(['missing', 'wrong-fingerprint', 'wrong-workspace', 'network'])('status %s receipt preserves pending and performs no write', async defect => {
    const f = await fixture(); let saved!: ResearchSetupRequest;
    const writer = f.create(async (_url, init) => { saved = JSON.parse(String(init?.body)); throw Error('unknown'); });
    await expect(writer.researchSetup!.approve(proposal())).rejects.toThrow();
    const http = vi.fn<typeof fetch>(async () => {
      if (defect === 'network') throw Error('network');
      const ack = defect === 'missing' ? null : { ...receipt(saved), ...(defect === 'wrong-fingerprint' ? { fingerprint: 'f'.repeat(64) } : { workspaceId: 'other' }) };
      return Response.json(status(ack));
    });
    const result = await f.create(http).researchSetup!.status(); expect(result.pending?.requestId).toBe(saved.requestId); expect(await f.store.load(identity)).not.toBeNull();
    expect(http).toHaveBeenCalledTimes(1); expect(String(http.mock.calls[0][0])).toMatch(/\/research\/setup\/status$/);
  });
  it('status reconciles only the exact authenticated receipt without retrying the write', async () => {
    const f = await fixture(); let saved!: ResearchSetupRequest;
    const first = f.create(async (_url, init) => { saved = JSON.parse(String(init?.body)); throw Error('unknown'); });
    await expect(first.researchSetup!.approve(proposal())).rejects.toThrow();
    const http = vi.fn<typeof fetch>(async () => Response.json(status(receipt(saved, true))));
    const result = await f.create(http).researchSetup!.status(); expect(result.pending).toBeNull(); expect(result.blockers).not.toContain('local_pending'); expect(http).toHaveBeenCalledOnce();
  });
  it('no HTTP follows a failed request fsync, even when its slot is visible and Retry loads it', async () => {
    const f = await fixture(); let fail = true;
    const store = new ResearchSetupRequestStore({ directory: f.directory, safeStorage, sync: async (handle, kind) => { if (fail && kind === 'directory' && await lstat(join(f.directory, '000001.request.json')).then(() => true, () => false)) throw Error('disk'); await handle.sync(); } });
    const http = vi.fn<typeof fetch>(async (_url, init) => Response.json(receipt(JSON.parse(String(init?.body))))), runtime = f.create(http, store);
    await expect(runtime.researchSetup!.approve(proposal())).rejects.toThrow(); expect(http).not.toHaveBeenCalled();
    await expect(runtime.researchSetup!.retry()).rejects.toThrow(); expect(http).not.toHaveBeenCalled();
    fail = false; await runtime.researchSetup!.retry(); expect(http).toHaveBeenCalledOnce();
  });
  it('captures parsed input and paired identity before awaiting the operation lease', async () => {
    const f = await fixture(), wait = deferred<void>(); f.gate(wait.promise);
    const http = vi.fn<typeof fetch>(async (_url, init) => Response.json(receipt(JSON.parse(String(init?.body)))));
    const selectedPairing = structuredClone(pairing), raw = proposal(), expected = structuredClone(raw), runtime = f.create(http, f.store, selectedPairing);
    const operation = runtime.researchSetup!.approve(raw); raw.audience.regions[0] = 'mutated'; raw.permittedSources[0] = 'https://mutated.test'; selectedPairing.endpoint = 'https://wrong.test'; selectedPairing.workspaceId = 'wrong';
    wait.resolve(); await operation;
    expect(JSON.parse(String(http.mock.calls[0][1]?.body))).toMatchObject({ workspaceId: identity.workspaceId, input: expected }); expect(String(http.mock.calls[0][0])).toBe(`${identity.endpoint}/research/setup`);
  });
  it.each(['lock', 'dispose', 'timeout'] as const)('one flight, %s aborts lease and rejects late responses without acknowledgement', async action => {
    const f = await fixture(), started = deferred<void>(), reply = deferred<Response>(), timeout = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    const runtime = f.create(async () => { started.resolve(); return reply.promise; });
    const result = runtime.researchSetup!.approve(proposal()); const rejected = expect(result).rejects.toThrow(/^research_setup_unavailable$/); await started.promise;
    expect(f.activeLeases()).toBe(1); expect(timeoutSpy).toHaveBeenCalledWith(15000);
    await expect(runtime.researchSetup!.retry()).rejects.toThrow(); await expect(runtime.researchSetup!.status()).rejects.toThrow();
    const pending = await f.store.load(identity);
    if (action === 'lock') runtime.invalidate(true);
    if (action === 'dispose') await runtime.dispose();
    if (action === 'timeout') timeout.abort();
    await rejected; expect(f.activeLeases()).toBe(0);
    reply.resolve(Response.json(receipt(pending!.request))); await new Promise(resolve => setImmediate(resolve));
    expect(await f.store.load(identity)).toEqual(pending);
    if (action === 'lock') { await expect(runtime.researchSetup!.status()).rejects.toThrow(); runtime.invalidate(false); }
  });
  it('holds missing pairing or unavailable journal safely and rejects malformed renderer identities before any await/effect', async () => {
    const f = await fixture(), http = vi.fn<typeof fetch>();
    expect(await f.create(http, f.store, null).researchSetup!.status()).toEqual({ remote: null, pending: null, blockers: ['needs_pairing'] });
    const store = new ResearchSetupRequestStore({ directory: f.directory, safeStorage: { ...safeStorage, isEncryptionAvailable: () => false } });
    const runtime = f.create(http, store); expect((await runtime.researchSetup!.status()).blockers).toEqual(['local_journal_unavailable']);
    const invalid = { ...proposal(), workspaceId: 'renderer' };
    await expect(runtime.researchSetup!.approve(invalid)).rejects.toThrow(/^research_setup_unavailable$/); expect(http).not.toHaveBeenCalled();
  });
});

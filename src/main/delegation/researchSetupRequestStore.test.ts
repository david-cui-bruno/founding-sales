import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SafeStorage } from '../outreach/providers/providerTypes';
import { accountFingerprint } from '../domain/accounts/accountEvidence';
import { researchSetupRequestSchema, type ResearchSetupReceipt, type ResearchSetupRequest } from '../../shared/contracts/researchSetupContract';
import { ResearchSetupRequestStore, researchSetupJournalLimits, matchResearchSetupReceipt } from './researchSetupRequestStore';

const key = randomBytes(32);
const safeStorage: SafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: value => { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, c.update(value, 'utf8'), c.final(), c.getAuthTag()]); },
  decryptString: value => { const c = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); c.setAuthTag(value.subarray(-16)); return Buffer.concat([c.update(value.subarray(12, -16)), c.final()]).toString('utf8'); },
};
const identity = { endpoint: 'https://worker.example.test', workspaceId: 'setup-fiction', pairingId: '11111111-1111-4111-8111-111111111111' };
const now = '2026-09-14T01:00:00.000Z';
const request = (): ResearchSetupRequest => ({ version: 1, kind: 'set-state', workspaceId: identity.workspaceId, pairingId: identity.pairingId, requestId: randomUUID(), input: { state: 'paused', expectedRevision: 1, disclosureAcknowledged: true } });
const receipt = (r: ResearchSetupRequest, cancelled = false): ResearchSetupReceipt => ({ workspaceId: r.workspaceId, pairingId: r.pairingId, requestId: r.requestId, kind: r.kind, fingerprint: accountFingerprint(researchSetupRequestSchema.parse(r)), ...(cancelled ? { status: 'cancelled' as const, revision: null, state: null } : { status: 'applied' as const, revision: 2, state: 'paused' as const }) });
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture(sync?: ConstructorParameters<typeof ResearchSetupRequestStore>[0]['sync']) {
  const root = await mkdtemp(join(process.env.JCODE_SCRATCH_DIR ?? join(homedir(), '.jcode', 'scratch'), 'research-journal-test-')); dirs.push(root);
  const directory = join(root, 'journal');
  return { root, directory, store: new ResearchSetupRequestStore({ directory, safeStorage, sync }), restart: () => new ResearchSetupRequestStore({ directory, safeStorage }) };
}
async function rewrite(directory: string, name: string, mutate: (value: Record<string, unknown>) => void) {
  const path = join(directory, name), envelope = JSON.parse(await readFile(path, 'utf8'));
  const value = JSON.parse(await safeStorage.decryptString(Buffer.from(envelope.ciphertext, 'base64'))); mutate(value);
  envelope.ciphertext = (await safeStorage.encryptString(JSON.stringify(value))).toString('base64');
  await writeFile(path, JSON.stringify(envelope));
}

describe('immutable encrypted research setup journal, real filesystem and fake encryption', () => {
  it('is inert on construction/load and stores encrypted exact request privately across restart', async () => {
    const f = await fixture(); expect(await f.store.load(identity)).toBeNull();
    await expect(lstat(f.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    const original = request(), pending = await f.store.prepare(identity, original, now);
    expect(await f.restart().load(identity)).toEqual(pending);
    for (const name of await readdir(f.directory)) {
      expect(await readFile(join(f.directory, name), 'utf8')).not.toMatch(/setup-fiction|paused|expectedRevision/);
      const stat = await lstat(join(f.directory, name)); expect(stat.mode & 0o777).toBe(0o600); expect(stat.nlink).toBe(2);
    }
    expect((await lstat(f.directory)).mode & 0o777).toBe(0o700);
    await expect(f.store.prepare(identity, request(), now)).rejects.toThrow(/^research_setup_journal_unavailable$/);
  });
  it('agrees with the frozen backend canonical digest and rejects all receipt identity/fingerprint defects', () => {
    const original = { ...request(), requestId: '22222222-2222-4222-8222-222222222222' };
    expect(accountFingerprint(researchSetupRequestSchema.parse(original))).toBe('52654eedc9c62c5aa2d1991dd8c6cc59eeec6cb79f618fc699e1306a7a0513ac');
    for (const defect of [{ workspaceId: 'other' }, { pairingId: randomUUID() }, { requestId: randomUUID() }, { kind: 'approve' }, { fingerprint: 'f'.repeat(64) }]) expect(() => matchResearchSetupReceipt(original, { ...receipt(original), ...defect })).toThrow();
  });
  it.each([false, true])('terminates only matching %s receipt and old acknowledgement never deletes a successor', async cancelled => {
    const f = await fixture(), pending = await f.store.prepare(identity, request(), now), ack = receipt(pending.request, cancelled);
    await f.store.acknowledge(identity, pending, ack); expect(await f.restart().load(identity)).toBeNull();
    const successor = await f.restart().prepare(identity, request(), now);
    await f.store.acknowledge(identity, pending, ack);
    expect(await f.restart().load(identity)).toEqual(successor);
    await expect(f.store.acknowledge(identity, pending, receipt(pending.request, !cancelled))).rejects.toThrow();
    expect(successor.previousReceiptFingerprint).toBe(accountFingerprint(ack));
  });
  it('two competing instances publish exactly one request and only the winning caller may send', async () => {
    const f = await fixture(); let ready = 0, release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const sync: ConstructorParameters<typeof ResearchSetupRequestStore>[0]['sync'] = async (handle, kind) => { if (kind === 'file' && (await handle.stat()).nlink === 1) { if (++ready === 2) release(); await gate; } await handle.sync(); };
    const stores = [0, 1].map(() => new ResearchSetupRequestStore({ directory: f.directory, safeStorage, sync }));
    const sent: ResearchSetupRequest[] = [];
    const results = await Promise.allSettled(stores.map(store => store.prepare(identity, request(), now).then(p => { sent.push(p.request); return p; })));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1); expect(sent).toHaveLength(1);
    expect((await f.restart().load(identity))?.request).toEqual(sent[0]);
  });
  it('concurrent exact receipts converge, but applied vs cancelled has one immutable winner', async () => {
    const f = await fixture(), pending = await f.store.prepare(identity, request(), now);
    const results = await Promise.allSettled([f.store.acknowledge(identity, pending, receipt(pending.request)), f.restart().acknowledge(identity, pending, receipt(pending.request, true))]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1); expect(await f.restart().load(identity)).toBeNull();
    const next = await f.store.prepare(identity, request(), now), ack = receipt(next.request);
    await Promise.all([f.store.acknowledge(identity, next, ack), f.restart().acknowledge(identity, next, ack)]);
    expect(await f.store.load(identity)).toBeNull();
  });
  it('link then directory-fsync failure remains pending and Retry must establish durability', async () => {
    let directory = '', failing = true;
    const f = await fixture(async (handle, kind) => { if (failing && kind === 'directory' && await lstat(join(directory, '000001.request.json')).then(() => true, () => false)) throw Error('secret filesystem path'); await handle.sync(); }); directory = f.directory;
    await expect(f.store.prepare(identity, request(), now)).rejects.toThrow(/^research_setup_journal_unavailable$/);
    const pending = await f.store.load(identity); expect(pending).not.toBeNull();
    await expect(f.store.ensureDurable(identity, pending!)).rejects.toThrow();
    failing = false; await f.store.ensureDurable(identity, pending!); expect(await f.restart().load(identity)).toEqual(pending);
  });
  it('receipt fsync failure cannot clear pending or authorize successor until durably retried', async () => {
    let failReceipt = false;
    const f = await fixture(async (handle, kind) => { if (failReceipt && kind === 'directory') throw Error('disk'); await handle.sync(); });
    const pending = await f.store.prepare(identity, request(), now); failReceipt = true;
    await expect(f.store.acknowledge(identity, pending, receipt(pending.request))).rejects.toThrow();
    expect(await f.store.load(identity)).toEqual(pending);
    await expect(f.store.prepare(identity, request(), now)).rejects.toThrow();
    failReceipt = false; await f.store.acknowledge(identity, pending, receipt(pending.request));
    expect(await f.store.load(identity)).toBeNull(); expect((await f.store.prepare(identity, request(), now)).generation).toBe(2);
  });
  it('crash before publication leaves only inert encrypted orphan anchors without a permanent lock', async () => {
    const f = await fixture(async (handle, kind) => { if (kind === 'file') throw Error('crash'); await handle.sync(); });
    await expect(f.store.prepare(identity, request(), now)).rejects.toThrow();
    const names = await readdir(f.directory); expect(names).toHaveLength(1); expect(names[0]).toMatch(/^blob-/);
    expect(await f.restart().load(identity)).toBeNull(); expect((await f.restart().prepare(identity, request(), now)).generation).toBe(1);
    expect(await readdir(f.directory)).toContain(names[0]);
  });
  it.each(['endpoint', 'workspaceId', 'pairingId'] as const)('fails closed on changed %s even after terminal receipt', async field => {
    const f = await fixture(), pending = await f.store.prepare(identity, request(), now); await f.store.acknowledge(identity, pending, receipt(pending.request));
    const changed = { ...identity, [field]: field === 'endpoint' ? 'https://other.example.test' : field === 'pairingId' ? randomUUID() : 'other' };
    await expect(f.store.load(changed)).rejects.toThrow();
  });
  it.each(['directory-mode', 'file-mode', 'extra-link', 'symlink', 'corrupt', 'oversize', 'gap', 'wrong-anchor', 'predecessor'] as const)('rejects %s instead of treating unsafe state as empty', async defect => {
    const f = await fixture(), pending = await f.store.prepare(identity, request(), now), path = join(f.directory, '000001.request.json');
    if (defect === 'directory-mode') await chmod(f.directory, 0o755);
    if (defect === 'file-mode') await chmod(path, 0o644);
    if (defect === 'extra-link') await link(path, join(f.root, 'unexpected-link'));
    if (defect === 'symlink') await symlink(path, join(f.directory, `blob-${randomUUID()}.json`));
    if (defect === 'corrupt') await writeFile(path, 'corrupt secret request');
    if (defect === 'oversize') await writeFile(path, Buffer.alloc(researchSetupJournalLimits.fileBytes + 1));
    if (defect === 'gap') await link(path, join(f.directory, '000003.request.json'));
    if (defect === 'wrong-anchor') { const envelope = JSON.parse(await readFile(path, 'utf8')); envelope.anchor = `blob-${randomUUID()}.json`; await writeFile(path, JSON.stringify(envelope)); }
    if (defect === 'predecessor') { await f.store.acknowledge(identity, pending, receipt(pending.request)); await f.store.prepare(identity, request(), now); await rewrite(f.directory, '000002.request.json', value => { value.previousReceiptFingerprint = 'f'.repeat(64); }); }
    await expect(f.store.load(identity)).rejects.toThrow(/^research_setup_journal_unavailable$/);
  });
  it('bounds orphan count and never performs cleanup at exhaustion', async () => {
    const f = await fixture(); await mkdir(f.directory, { mode: 0o700 });
    await Promise.all(Array.from({ length: researchSetupJournalLimits.entries + 1 }, () => writeFile(join(f.directory, `blob-${randomUUID()}.json`), '', { mode: 0o600, flag: 'wx' })));
    await expect(f.store.load(identity)).rejects.toThrow(); await expect(f.store.prepare(identity, request(), now)).rejects.toThrow();
    expect(await readdir(f.directory)).toHaveLength(researchSetupJournalLimits.entries + 1);
  });
  it('requires encryption and captures mutable request before any await', async () => {
    const f = await fixture(); const unavailable = new ResearchSetupRequestStore({ directory: f.directory, safeStorage: { ...safeStorage, isEncryptionAvailable: () => false } });
    await expect(unavailable.load(identity)).rejects.toThrow();
    const raw = request(), original = structuredClone(raw), preparing = f.store.prepare(identity, raw, now);
    raw.input.expectedRevision = 99;
    expect((await preparing).request).toEqual(original);
  });
  it('validates a complete 128-generation chain then refuses generation 129 without cleanup', async () => {
    const f = await fixture(); await mkdir(f.directory, { mode: 0o700 });
    const publish = async (name: string, value: unknown) => {
      const anchor = `blob-${randomUUID()}.json`, encrypted = await safeStorage.encryptString(JSON.stringify(value));
      await writeFile(join(f.directory, anchor), JSON.stringify({ format: 'callie-research-setup', version: 1, anchor, ciphertext: encrypted.toString('base64') }), { flag: 'wx', mode: 0o600 });
      await link(join(f.directory, anchor), join(f.directory, name));
    };
    let previousReceiptFingerprint: string | null = null;
    for (let generation = 1; generation <= researchSetupJournalLimits.generations; generation++) {
      const original = request(), ack = receipt(original), prefix = String(generation).padStart(6, '0');
      await publish(`${prefix}.request.json`, { generation, identity, previousReceiptFingerprint, request: original, createdAt: now });
      await publish(`${prefix}.receipt.json`, { generation, identity, receipt: ack });
      previousReceiptFingerprint = accountFingerprint(ack);
    }
    expect(await f.store.load(identity)).toBeNull();
    await expect(f.store.prepare(identity, request(), now)).rejects.toThrow(/^research_setup_journal_unavailable$/);
    expect(await readdir(f.directory)).toHaveLength(128 * 4);
  });
});

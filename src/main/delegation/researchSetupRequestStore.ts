import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, opendir, link, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SafeStorage } from '../outreach/providers/providerTypes';
import { accountFingerprint } from '../domain/accounts/accountEvidence';
import { accountIdSchema, accountInstantSchema } from '../../shared/contracts/accountContract';
import { researchSetupRequestSchema, researchSetupReceiptSchema, type ResearchSetupRequest, type ResearchSetupReceipt } from '../../shared/contracts/researchSetupContract';

function fail(): never { throw Error('research_setup_journal_unavailable'); }
const absent = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const owned = (stats: Stats) => typeof process.getuid !== 'function' || stats.uid === process.getuid();
const sameFile = (a: Stats, b: Stats) => a.ino === b.ino && a.dev === b.dev;
// Fixed bounds, including crash-orphan anchors. Exhaustion needs operator review,
// not automatic deletion, compaction, adoption, or a fresh request ID.
export const researchSetupJournalLimits = Object.freeze({ generations: 128, entries: 1024, fileBytes: 2 * 1024 * 1024 });
const identitySchema = z.strictObject({ endpoint: z.url().refine(value => {
  const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash && u.pathname === '/';
}).transform(value => new URL(value).origin), workspaceId: accountIdSchema, pairingId: z.uuid() });
export type ResearchSetupIdentity = z.infer<typeof identitySchema>;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const generationSchema = z.number().int().min(1).max(researchSetupJournalLimits.generations);
const pendingSchema = z.strictObject({ generation: generationSchema, identity: identitySchema, previousReceiptFingerprint: hash.nullable(), request: researchSetupRequestSchema, createdAt: accountInstantSchema });
export type StoredResearchSetupRequest = z.infer<typeof pendingSchema>;
const terminalSchema = z.strictObject({ generation: generationSchema, identity: identitySchema, receipt: researchSetupReceiptSchema });
const blobName = /^blob-[a-f0-9-]{36}\.json$/;
const slotName = /^(\d{6})\.(request|receipt)\.json$/;
const envelopeSchema = z.strictObject({ format: z.literal('callie-research-setup'), version: z.literal(1), anchor: z.string().regex(blobName), ciphertext: z.string().min(1).max(researchSetupJournalLimits.fileBytes).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/) });
const slot = (generation: number, kind: 'request' | 'receipt') => `${String(generation).padStart(6, '0')}.${kind}.json`;
const equal = (a: unknown, b: unknown) => accountFingerprint(a) === accountFingerprint(b);
function privateFile(stats: Stats, published: boolean): void {
  if (!stats.isFile() || stats.isSymbolicLink() || !owned(stats) || (stats.mode & 0o777) !== 0o600 || stats.size > researchSetupJournalLimits.fileBytes || (published ? stats.nlink !== 2 : stats.nlink !== 1 && stats.nlink !== 2)) fail();
}
export function matchResearchSetupReceipt(request: ResearchSetupRequest, raw: unknown): ResearchSetupReceipt {
  const receipt = researchSetupReceiptSchema.parse(raw);
  if (receipt.requestId !== request.requestId || receipt.workspaceId !== request.workspaceId || receipt.pairingId !== request.pairingId || receipt.kind !== request.kind || receipt.fingerprint !== accountFingerprint(researchSetupRequestSchema.parse(request))) fail();
  return receipt;
}
type Snapshot = { directory: Stats | null; requests: StoredResearchSetupRequest[]; receipts: (ResearchSetupReceipt | null)[] };

/** Immutable append-only journal. A permanent encrypted anchor plus an exclusive
 * hardlink is the publication primitive. Exactly two links are intentional and
 * checked against the named anchor. Crashes leave inert anchors, never locks.
 * There is no mutable pending pointer, unlink, plaintext file, or automatic replay.
 */
export class ResearchSetupRequestStore {
  constructor(private readonly input: { directory: string; safeStorage: SafeStorage;
    /** Fault-injection seam for pure filesystem tests. Production uses fsync. */
    sync?: (handle: FileHandle, kind: 'file' | 'directory') => Promise<void>;
  }) { if (!isAbsolute(input.directory)) fail(); }

  async load(rawIdentity: ResearchSetupIdentity): Promise<StoredResearchSetupRequest | null> {
    return this.safe(async () => {
      const snapshot = await this.snapshot(identitySchema.parse(rawIdentity));
      const last = snapshot.requests.at(-1);
      if (!last) return null;
      if (!snapshot.receipts.at(-1)) return last;
      // A previous process may have linked a receipt then failed/crashed before
      // directory fsync. Do not report cleared until durability is established.
      try {
        await this.syncSlot(slot(last.generation, 'request'));
        await this.syncSlot(slot(last.generation, 'receipt'));
        await this.syncDirectory(snapshot.directory!);
      } catch { return last; }
      return null;
    });
  }

  async prepare(rawIdentity: ResearchSetupIdentity, rawRequest: ResearchSetupRequest, createdAt: string, assertCurrent: () => void = (): void => undefined): Promise<StoredResearchSetupRequest> {
    // Capture all caller-owned input before the first await.
    return this.safe(async () => {
      const identity = identitySchema.parse(rawIdentity), request = researchSetupRequestSchema.parse(rawRequest);
      if (identity.workspaceId !== request.workspaceId || identity.pairingId !== request.pairingId) fail();
      const capturedAt = accountInstantSchema.parse(createdAt);
      assertCurrent(); await this.available();
      const directory = await this.directory(true); if (!directory) return fail();
      const snapshot = await this.snapshot(identity);
      if (!snapshot.directory || !sameFile(directory, snapshot.directory) || snapshot.requests.length >= researchSetupJournalLimits.generations) fail();
      const previous = snapshot.requests.at(-1), receipt = snapshot.receipts.at(-1);
      if (previous && !receipt) fail();
      // A visible but un-fsynced terminal link cannot authorize a successor.
      if (previous) { await this.syncSlot(slot(previous.generation, 'request')); await this.syncSlot(slot(previous.generation, 'receipt')); }
      await this.syncDirectory(directory); assertCurrent();
      const pending = pendingSchema.parse({ generation: snapshot.requests.length + 1, identity, previousReceiptFingerprint: receipt ? accountFingerprint(receipt) : null, request, createdAt: capturedAt });
      await this.publish(slot(pending.generation, 'request'), pending, directory, assertCurrent);
      await this.ensureDurable(identity, pending, assertCurrent);
      return pending;
    });
  }

  /** Explicit Retry must re-establish durability even after link/fsync failure. */
  async ensureDurable(rawIdentity: ResearchSetupIdentity, rawPending: StoredResearchSetupRequest, assertCurrent: () => void = (): void => undefined): Promise<void> {
    return this.safe(async () => {
      const identity = identitySchema.parse(rawIdentity), pending = pendingSchema.parse(rawPending);
      const snapshot = await this.snapshot(identity), current = snapshot.requests[pending.generation - 1];
      if (!snapshot.directory || !current || !equal(current, pending) || pending.generation !== snapshot.requests.length) fail();
      await this.syncSlot(slot(pending.generation, 'request'));
      if (snapshot.receipts[pending.generation - 1]) await this.syncSlot(slot(pending.generation, 'receipt'));
      await this.syncDirectory(snapshot.directory); assertCurrent();
    });
  }

  async acknowledge(rawIdentity: ResearchSetupIdentity, rawPending: StoredResearchSetupRequest, rawReceipt: ResearchSetupReceipt, assertCurrent: () => void = (): void => undefined): Promise<void> {
    return this.safe(async () => {
      const identity = identitySchema.parse(rawIdentity), pending = pendingSchema.parse(rawPending);
      const receipt = matchResearchSetupReceipt(pending.request, rawReceipt);
      const snapshot = await this.snapshot(identity), current = snapshot.requests[pending.generation - 1];
      if (!snapshot.directory || !current || !equal(current, pending)) fail();
      await this.syncSlot(slot(pending.generation, 'request'));
      const existing = snapshot.receipts[pending.generation - 1];
      if (existing && !equal(existing, receipt)) fail();
      if (!existing) {
        try { await this.publish(slot(pending.generation, 'receipt'), { generation: pending.generation, identity, receipt }, snapshot.directory, assertCurrent); }
        catch (error) {
          // Only an exact concurrently published terminal receipt is acceptable.
          // Still fsync below, including after an ambiguous publish/fsync failure.
          if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
          const raced = await this.snapshot(identity);
          if (!equal(raced.receipts[pending.generation - 1], receipt)) fail();
        }
      }
      await this.syncSlot(slot(pending.generation, 'receipt'));
      await this.syncDirectory(snapshot.directory); assertCurrent();
    });
  }

  private async safe<T>(operation: () => Promise<T>): Promise<T> { try { return await operation(); } catch { return fail(); } }
  private async available(): Promise<void> { if (await this.input.safeStorage.isEncryptionAvailable() !== true) fail(); }
  private async directory(create: boolean): Promise<Stats | null> {
    let metadata: Stats;
    try { metadata = await lstat(this.input.directory); }
    catch (error) {
      if (!absent(error)) throw error;
      if (!create) return null;
      try { await mkdir(this.input.directory, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') throw e; }
      metadata = await lstat(this.input.directory);
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || !owned(metadata) || (metadata.mode & 0o777) !== 0o700) fail();
    return metadata;
  }
  private async entries(directory: Stats): Promise<Set<string>> {
    const names = new Set<string>();
    const iterator = await opendir(this.input.directory);
    for await (const entry of iterator) {
      if (names.size >= researchSetupJournalLimits.entries || !blobName.test(entry.name) && !slotName.test(entry.name)) fail();
      const metadata = await lstat(join(this.input.directory, entry.name));
      privateFile(metadata, slotName.test(entry.name));
      names.add(entry.name);
    }
    const after = await this.directory(false); if (!after || !sameFile(directory, after)) fail();
    return names;
  }
  private async snapshot(identity: ResearchSetupIdentity): Promise<Snapshot> {
    await this.available();
    const directory = await this.directory(false);
    const result: Snapshot = { directory, requests: [], receipts: [] };
    if (!directory) return result;
    const names = await this.entries(directory);
    const published = [...names].filter(name => slotName.test(name));
    let previousReceipt: ResearchSetupReceipt | null = null;
    for (let generation = 1; generation <= researchSetupJournalLimits.generations; generation++) {
      const requestName = slot(generation, 'request');
      if (!names.has(requestName)) break;
      const request = pendingSchema.parse(await this.read(requestName));
      if (request.generation !== generation || !equal(request.identity, identity) || request.request.workspaceId !== identity.workspaceId || request.request.pairingId !== identity.pairingId || request.previousReceiptFingerprint !== (previousReceipt ? accountFingerprint(previousReceipt) : null) || generation > 1 && !previousReceipt) fail();
      result.requests.push(request);
      const receiptName = slot(generation, 'receipt');
      let receipt: ResearchSetupReceipt | null = null;
      if (names.has(receiptName)) {
        const terminal = terminalSchema.parse(await this.read(receiptName));
        if (terminal.generation !== generation || !equal(terminal.identity, identity)) fail();
        receipt = matchResearchSetupReceipt(request.request, terminal.receipt);
      }
      result.receipts.push(receipt); previousReceipt = receipt;
    }
    // No holes, standalone receipts, out-of-range slots or malformed tails.
    if (published.length !== result.requests.length + result.receipts.filter(Boolean).length) fail();
    const after = await this.directory(false); if (!after || !sameFile(directory, after)) fail();
    return result;
  }
  private async read(name: string): Promise<unknown> {
    const path = join(this.input.directory, name), metadata = await lstat(path); privateFile(metadata, true);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let serialized: string;
    try {
      const opened = await handle.stat(); privateFile(opened, true); if (!sameFile(opened, metadata)) fail();
      const buffer = Buffer.alloc(researchSetupJournalLimits.fileBytes + 1);
      try {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > researchSetupJournalLimits.fileBytes) fail();
        serialized = buffer.subarray(0, bytesRead).toString('utf8');
      } finally { buffer.fill(0); }
      const after = await handle.stat(); privateFile(after, true); if (after.size !== opened.size) fail();
    } finally { await handle.close(); }
    const envelope = envelopeSchema.parse(JSON.parse(serialized));
    const anchor = await lstat(join(this.input.directory, envelope.anchor)); privateFile(anchor, true);
    if (!sameFile(anchor, metadata)) fail();
    const encrypted = Buffer.from(envelope.ciphertext, 'base64');
    try {
      const decrypted = await this.input.safeStorage.decryptString(encrypted);
      if (typeof decrypted !== 'string' || Buffer.byteLength(decrypted) > researchSetupJournalLimits.fileBytes) fail();
      return JSON.parse(decrypted) as unknown;
    } finally { encrypted.fill(0); }
  }
  private async publish(name: string, value: unknown, directory: Stats, assertCurrent: () => void): Promise<void> {
    const plaintext = JSON.stringify(value); if (Buffer.byteLength(plaintext) > researchSetupJournalLimits.fileBytes / 2) fail();
    const encrypted = await this.input.safeStorage.encryptString(plaintext);
    if (!Buffer.isBuffer(encrypted)) fail();
    const anchor = `blob-${randomUUID()}.json`;
    let serialized: string;
    try {
      if (!encrypted.length || encrypted.length > researchSetupJournalLimits.fileBytes / 2) fail();
      serialized = JSON.stringify({ format: 'callie-research-setup', version: 1, anchor, ciphertext: encrypted.toString('base64') });
    } finally { encrypted.fill(0); }
    assertCurrent();
    const names = await this.entries(directory); if (names.size + 2 > researchSetupJournalLimits.entries) fail();
    const handle = await open(join(this.input.directory, anchor), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(serialized, 'utf8'); await this.sync(handle, 'file'); } finally { await handle.close(); }
    const current = await this.directory(false); if (!current || !sameFile(current, directory)) fail();
    assertCurrent();
    await link(join(this.input.directory, anchor), join(this.input.directory, name));
    await this.syncDirectory(directory); assertCurrent();
  }
  private async sync(handle: FileHandle, kind: 'file' | 'directory'): Promise<void> { await (this.input.sync ? this.input.sync(handle, kind) : handle.sync()); }
  private async syncSlot(name: string): Promise<void> {
    const metadata = await lstat(join(this.input.directory, name)); privateFile(metadata, true);
    const handle = await open(join(this.input.directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const opened = await handle.stat(); privateFile(opened, true); if (!sameFile(opened, metadata)) fail(); await this.sync(handle, 'file'); }
    finally { await handle.close(); }
  }
  private async syncDirectory(expected: Stats): Promise<void> {
    const current = await this.directory(false); if (!current || !sameFile(current, expected)) fail();
    const handle = await open(this.input.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { if (!sameFile(await handle.stat(), expected)) fail(); await this.sync(handle, 'directory'); } finally { await handle.close(); }
    // Persist creation of the dedicated directory as well as its entries.
    const parent = await open(dirname(this.input.directory), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { if (!owned(await parent.stat())) fail(); await this.sync(parent, 'directory'); } finally { await parent.close(); }
  }
}

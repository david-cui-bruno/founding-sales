import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, link, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SafeStorage } from '../outreach/providers/providerTypes';
import { accountIdSchema } from '../../shared/contracts/accountContract';
const fail = (): never => { throw new Error('pairing_unavailable'); };
const endpointSchema = z.string().url().refine(value => { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash && u.pathname === '/'; }).transform(value => new URL(value).origin);
const credential = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const grantSchema = z.strictObject({ workspaceId: accountIdSchema, pairingId: accountIdSchema, credential, emergencyCredential: credential, generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), scopes: z.array(z.enum(['commands:write', 'events:read', 'google:grant', 'pairing:revoke', 'emergency:stop'])) });
const storedPairingSchema = grantSchema.extend({ endpoint: endpointSchema });
export type StoredPairing = z.infer<typeof storedPairingSchema>;

const maxBytes = 256 * 1024;
const envelopeSchema = z.object({ format: z.literal('callie-worker-pairing'), version: z.literal(1),
  ciphertext: z.string().min(1).max(maxBytes).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
}).strict();
const absent = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const owned = (stats: Stats) => typeof process.getuid !== 'function' || stats.uid === process.getuid();
function privateFile(stats: Stats): void {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || !owned(stats)
    || (stats.mode & 0o777) !== 0o600 || stats.size > maxBytes) fail();
}

/** Dedicated private directory beneath the application's private userData directory.
 * No home-directory fallback, no implicit import, no plaintext intermediate file.
 */
export class PairingStore {
  private readonly path: string;
  constructor(private readonly input: { directory: string; safeStorage: SafeStorage; fetch?: typeof globalThis.fetch }) {
    if (!isAbsolute(input.directory)) fail();
    this.path = join(input.directory, 'pairing.json');
  }

  async load(): Promise<StoredPairing | null> {
    await this.available();
    try {
      if (!await this.directory(false)) return null;
      let metadata: Stats;
      try { metadata = await lstat(this.path); } catch (error) { if (absent(error)) return null; throw error; }
      privateFile(metadata);
      const handle = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let serialized: string;
      try {
        const opened = await handle.stat();
        privateFile(opened);
        if (opened.ino !== metadata.ino || opened.dev !== metadata.dev) fail();
        const buffer = Buffer.alloc(maxBytes + 1);
        try {
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          if (bytesRead > maxBytes) fail();
          serialized = buffer.subarray(0, bytesRead).toString('utf8');
        } finally { buffer.fill(0); }
      } finally { await handle.close(); }
      const envelope = envelopeSchema.parse(JSON.parse(serialized));
      const encrypted = Buffer.from(envelope.ciphertext, 'base64');
      try {
        const decrypted = await this.input.safeStorage.decryptString(encrypted);
        if (typeof decrypted !== 'string' || Buffer.byteLength(decrypted) > maxBytes) fail();
        return storedPairingSchema.parse(JSON.parse(decrypted)) as StoredPairing;
      } finally { encrypted.fill(0); }
    } catch { throw new Error('pairing_unavailable'); }
  }

  private async save(value: StoredPairing, assertMayCommit: () => void = () => undefined): Promise<void> {
    await this.available();
    let temporary: string | null = null;
    try {
      const parsed = storedPairingSchema.safeParse(value);
      if (!parsed.success) fail();
      const directory = await this.directory(true);
      if (!directory) throw new Error('pairing_unavailable');
      await this.inspectExisting();
      const encrypted = await this.input.safeStorage.encryptString(JSON.stringify(parsed.data));
      if (!Buffer.isBuffer(encrypted) || encrypted.length === 0 || encrypted.length > maxBytes / 2) fail();
      let serialized: string;
      try { serialized = JSON.stringify({ format: 'callie-worker-pairing', version: 1, ciphertext: encrypted.toString('base64') }); }
      finally { encrypted.fill(0); }
      temporary = join(this.input.directory, `.pairing-${randomUUID()}.tmp`);
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(serialized, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      const current = await this.directory(false);
      if (!current || current.ino !== directory.ino || current.dev !== directory.dev) fail();
      await this.inspectExisting();
      assertMayCommit();
      // Pairing identity is write-once. A concurrent redemption must not replace it.
      await link(temporary, this.path);
      await rm(temporary);
      temporary = null;
      const parent = await open(this.input.directory, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await parent.sync(); } finally { await parent.close(); }
    } catch { throw new Error('pairing_unavailable'); }
    finally { if (temporary !== null) await rm(temporary, { force: true }).catch((): undefined => undefined); }
  }

  /** Explicit trusted setup operation. Never called by load or startup. */
  async redeem(request: { endpoint: string; expectedWorkspaceId: string; code: string }, signal: AbortSignal) {
    const value = z.strictObject({ endpoint: endpointSchema, expectedWorkspaceId: accountIdSchema, code: credential }).parse(request);
    signal.throwIfAborted();
    await this.available();
    if (await this.load()) throw new Error('pairing_already_configured');
    const response = await (this.input.fetch ?? globalThis.fetch)(`${value.endpoint}/pairing/redeem`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: value.code }),
      redirect: 'error', cache: 'no-store', signal });
    signal.throwIfAborted();
    if (!response.ok) throw new Error('pairing_unavailable');
    const text = await response.text();
    if (text.length > 16384) throw new Error('pairing_unavailable');
    const grant = grantSchema.parse(JSON.parse(text));
    if (grant.workspaceId !== value.expectedWorkspaceId || !grant.scopes.includes('commands:write') || !grant.scopes.includes('events:read')) throw new Error('pairing_identity_mismatch');
    await this.save({ ...grant, endpoint: value.endpoint }, () => signal.throwIfAborted());
    return Object.freeze({ state: 'paired' as const, workspaceId: grant.workspaceId, pairingId: grant.pairingId });
  }

  private async available(): Promise<void> {
    try { if (await this.input.safeStorage.isEncryptionAvailable() !== true) fail(); }
    catch { fail(); }
  }
  private async directory(create: boolean): Promise<Stats | null> {
    let metadata: Stats;
    try { metadata = await lstat(this.input.directory); }
    catch (error) {
      if (!absent(error)) throw error;
      if (!create) return null;
      await mkdir(this.input.directory, { mode: 0o700 });
      metadata = await lstat(this.input.directory);
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || !owned(metadata)
      || (metadata.mode & 0o777) !== 0o700) fail();
    return metadata;
  }
  private async inspectExisting(): Promise<void> {
    try { privateFile(await lstat(this.path)); }
    catch (error) { if (!absent(error)) throw error; }
  }
}

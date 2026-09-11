import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SafeStorage, StoredCredentials } from './providerTypes';
import { fail, safeError, storedCredentialsSchema } from './providerValidation';

const maxBytes = 256 * 1024;
const envelopeSchema = z.object({ format: z.literal('callie-outreach-credentials'), version: z.literal(1),
  ciphertext: z.string().min(1).max(maxBytes).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
}).strict();
const absent = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const owned = (stats: Stats) => typeof process.getuid !== 'function' || stats.uid === process.getuid();
function privateFile(stats: Stats): void {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || !owned(stats)
    || (stats.mode & 0o777) !== 0o600 || stats.size > maxBytes) fail('credentials_corrupt');
}

/** Dedicated private directory beneath the application's private userData directory.
 * No home-directory fallback, no implicit import, no plaintext intermediate file.
 */
export class CredentialStore {
  private readonly path: string;
  constructor(private readonly input: { directory: string; safeStorage: SafeStorage }) {
    if (!isAbsolute(input.directory)) fail('invalid_configuration');
    this.path = join(input.directory, 'credentials.json');
  }

  async load(): Promise<StoredCredentials | null> {
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
        if (opened.ino !== metadata.ino || opened.dev !== metadata.dev) fail('credentials_corrupt');
        const buffer = Buffer.alloc(maxBytes + 1);
        try {
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          if (bytesRead > maxBytes) fail('credentials_corrupt');
          serialized = buffer.subarray(0, bytesRead).toString('utf8');
        } finally { buffer.fill(0); }
      } finally { await handle.close(); }
      const envelope = envelopeSchema.parse(JSON.parse(serialized));
      const encrypted = Buffer.from(envelope.ciphertext, 'base64');
      try {
        const decrypted = await this.input.safeStorage.decryptString(encrypted);
        if (typeof decrypted !== 'string' || Buffer.byteLength(decrypted) > maxBytes) fail('credentials_corrupt');
        return storedCredentialsSchema.parse(JSON.parse(decrypted)) as StoredCredentials;
      } finally { encrypted.fill(0); }
    } catch (error) { throw safeError(error, 'credentials_corrupt'); }
  }

  async save(value: StoredCredentials, assertMayCommit: () => void = () => undefined): Promise<void> {
    await this.available();
    let temporary: string | null = null;
    try {
      const parsed = storedCredentialsSchema.safeParse(value);
      if (!parsed.success) fail('invalid_configuration');
      const previous = await this.load();
      if (previous?.gmail.grant && parsed.data.gmail.grant && previous.gmail.grant.subject !== parsed.data.gmail.grant.subject) fail('oauth_identity_invalid');
      if (previous?.gmail.grant && parsed.data.gmail.refreshToken
        && previous.gmail.grant.capabilities.some(capability => !parsed.data.gmail.grant?.capabilities.includes(capability))) fail('oauth_denied');
      const directory = await this.directory(true);
      await this.inspectExisting();
      const encrypted = await this.input.safeStorage.encryptString(JSON.stringify(parsed.data));
      if (!Buffer.isBuffer(encrypted) || encrypted.length === 0 || encrypted.length > maxBytes / 2) fail('credentials_unavailable');
      let serialized: string;
      try { serialized = JSON.stringify({ format: 'callie-outreach-credentials', version: 1, ciphertext: encrypted.toString('base64') }); }
      finally { encrypted.fill(0); }
      temporary = join(this.input.directory, `.credentials-${randomUUID()}.tmp`);
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(serialized, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      const current = await this.directory(false);
      if (!current || current.ino !== directory.ino || current.dev !== directory.dev) fail('credentials_corrupt');
      await this.inspectExisting();
      assertMayCommit();
      await rename(temporary, this.path);
      temporary = null;
      const parent = await open(this.input.directory, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await parent.sync(); } finally { await parent.close(); }
    } catch (error) { throw safeError(error, 'credentials_unavailable'); }
    finally { if (temporary !== null) await rm(temporary, { force: true }).catch((): undefined => undefined); }
  }

  private async available(): Promise<void> {
    try { if (await this.input.safeStorage.isEncryptionAvailable() !== true) fail('credentials_locked'); }
    catch { fail('credentials_locked'); }
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
      || (metadata.mode & 0o777) !== 0o700) fail('credentials_corrupt');
    return metadata;
  }
  private async inspectExisting(): Promise<void> {
    try { privateFile(await lstat(this.path)); }
    catch (error) { if (!absent(error)) throw error; }
  }
}

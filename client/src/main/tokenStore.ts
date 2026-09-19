import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * The one device token this Mac holds, in a safeStorage-encrypted file under the client's directory
 * beneath userData (`client/device-token.bin`). Electron's safeStorage encrypts the JSON record with a key
 * the operating system protects for this app; the file on disk is ciphertext only. Beside the token the
 * record keeps the public identifiers the views need (device id, workspace, endpoint, pairing instant).
 * There is no second copy anywhere: forgetting the pairing is deleting this file.
 */
export const DEVICE_TOKEN_FILE = 'device-token.bin';

export type SafeStorageLike = {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(buffer: Buffer): string;
};

export const storedDeviceSchema = z.strictObject({
  deviceToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  deviceId: z.string().uuid(),
  workspaceId: z.string().min(1),
  endpoint: z.string().url(),
  pairedAt: z.iso.datetime({ precision: 3 }),
});
export type StoredDevice = z.infer<typeof storedDeviceSchema>;

export class TokenStoreError extends Error {
  constructor(readonly reason: 'unavailable' | 'corrupt' | 'io') {
    super(`token_store_${reason}`);
    this.name = 'TokenStoreError';
  }
}

const isAbsent = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';

export class TokenStore {
  readonly path: string;

  constructor(private readonly input: { directory: string; safeStorage: SafeStorageLike }) {
    this.path = join(input.directory, DEVICE_TOKEN_FILE);
  }

  private requireEncryption(): void {
    let available = false;
    try { available = this.input.safeStorage.isEncryptionAvailable() === true; } catch { available = false; }
    if (!available) throw new TokenStoreError('unavailable');
  }

  /** The stored device, null when this Mac is not paired. A file that cannot be decrypted or parsed is `corrupt`, and kept. */
  async load(): Promise<StoredDevice | null> {
    this.requireEncryption();
    let bytes: Buffer;
    try {
      bytes = await readFile(this.path);
    } catch (error) {
      if (isAbsent(error)) return null;
      throw new TokenStoreError('io');
    }
    try {
      return storedDeviceSchema.parse(JSON.parse(this.input.safeStorage.decryptString(bytes)));
    } catch {
      throw new TokenStoreError('corrupt');
    }
  }

  /** Writes the encrypted record privately (directory 0700, file 0600) and atomically over any previous one. */
  async save(device: StoredDevice): Promise<void> {
    this.requireEncryption();
    const value = storedDeviceSchema.parse(device);
    await mkdir(this.input.directory, { recursive: true, mode: 0o700 });
    await chmod(this.input.directory, 0o700);
    const encrypted = this.input.safeStorage.encryptString(JSON.stringify(value));
    if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) throw new TokenStoreError('unavailable');
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        await handle.writeFile(encrypted);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.path);
    } catch {
      await rm(temporary, { force: true }).catch((): undefined => undefined);
      throw new TokenStoreError('io');
    }
  }

  /** Forgets the pairing. Harmless when nothing is stored. */
  async clear(): Promise<void> {
    await rm(this.path, { force: true });
  }
}

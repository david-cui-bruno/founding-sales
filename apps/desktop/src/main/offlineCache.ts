import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { CACHE_LIFETIME_MS, cachedTodaySchema, type CachedToday } from '../shared/contract.ts';
import type { SecretVault } from './keychain.ts';

/**
 * The encrypted 24-hour offline cache (specification 5.3, 14.2, Appendix G 24).
 *
 * "The encrypted offline cache expires after 24 hours, contains no message bodies,
 * drafts, attachments, or mailbox diagnostics, and is wiped on the next successful
 * revocation check."
 *
 * Four properties, each made structural rather than remembered:
 *
 *   * **Encrypted.** AES-256-GCM with a key that lives in the macOS Keychain beside
 *     the device secret. The file on disk is ciphertext and an authentication tag.
 *   * **Expiring.** The expiry is written inside the ciphertext, so moving the
 *     system clock back does not extend it and editing the file does not either —
 *     the tag would fail first.
 *   * **Bounded in content.** `cachedTodaySchema` is `strictObject` throughout: there
 *     is no field a body, a draft or a diagnostic could go in, so writing one is a
 *     parse failure rather than a policy someone has to follow.
 *   * **Wipeable.** `wipe()` removes the file and the key, and the session manager
 *     calls it the moment the API says this device or membership is gone.
 */

export const CACHE_FILE = 'today.cache';
export const CACHE_KEY_ACCOUNT = 'offline-cache-key';

const envelopeSchema = z.strictObject({
  version: z.literal(1),
  iv: z.string().regex(/^[0-9a-f]{24}$/),
  tag: z.string().regex(/^[0-9a-f]{32}$/),
  ciphertext: z.string().min(1),
});

const payloadSchema = z.strictObject({
  writtenAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
  today: cachedTodaySchema,
});

export type CacheReadOutcome =
  | { readonly state: 'fresh'; readonly today: CachedToday; readonly asOf: string }
  | { readonly state: 'stale'; readonly today: CachedToday; readonly asOf: string }
  | { readonly state: 'absent' }
  /** The file could not be decrypted or parsed. Treated as absent, and removed. */
  | { readonly state: 'unreadable' };

export interface OfflineCacheOptions {
  readonly directory: string;
  readonly vault: SecretVault;
  readonly now: () => Date;
  /** How long a cached list may be shown at all. Defaults to the contract's 24 hours. */
  readonly lifetimeMs?: number;
}

export interface OfflineCache {
  write(today: CachedToday): Promise<void>;
  read(): Promise<CacheReadOutcome>;
  wipe(): Promise<void>;
}

export function createOfflineCache(options: OfflineCacheOptions): OfflineCache {
  const path = join(options.directory, CACHE_FILE);
  const lifetimeMs = options.lifetimeMs ?? CACHE_LIFETIME_MS;

  const key = async (create: boolean): Promise<Buffer | null> => {
    const existing = await options.vault.read(CACHE_KEY_ACCOUNT);
    if (existing !== null) return Buffer.from(existing, 'base64');
    if (!create) return null;
    const fresh = randomBytes(32);
    await options.vault.write(CACHE_KEY_ACCOUNT, fresh.toString('base64'));
    return fresh;
  };

  return {
    async write(today) {
      const parsed = cachedTodaySchema.parse(today);
      const now = options.now();
      const payload = JSON.stringify({
        writtenAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + lifetimeMs).toISOString(),
        today: parsed,
      });

      const cacheKey = await key(true);
      if (cacheKey === null) throw new Error('offline cache has no key');
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', cacheKey, iv);
      const ciphertext = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);

      await mkdir(options.directory, { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(
          temporary,
          JSON.stringify({
            version: 1,
            iv: iv.toString('hex'),
            tag: cipher.getAuthTag().toString('hex'),
            ciphertext: ciphertext.toString('base64'),
          }),
          { mode: 0o600, flag: 'wx' },
        );
        await rename(temporary, path);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    },

    async read() {
      let raw: string;
      try {
        raw = await readFile(path, 'utf8');
      } catch {
        return { state: 'absent' };
      }
      const cacheKey = await key(false);
      if (cacheKey === null) return { state: 'unreadable' };

      try {
        const envelope = envelopeSchema.parse(JSON.parse(raw));
        const decipher = createDecipheriv('aes-256-gcm', cacheKey, Buffer.from(envelope.iv, 'hex'));
        decipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
        const plaintext = Buffer.concat([
          decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
          decipher.final(),
        ]).toString('utf8');
        const payload = payloadSchema.parse(JSON.parse(plaintext));
        const expired = Date.parse(payload.expiresAt) <= options.now().getTime();
        return {
          state: expired ? 'stale' : 'fresh',
          today: payload.today,
          asOf: payload.writtenAt,
        };
      } catch {
        // A tampered or corrupt file is not shown and is not kept.
        await rm(path, { force: true }).catch(() => undefined);
        return { state: 'unreadable' };
      }
    },

    async wipe() {
      await rm(path, { force: true }).catch(() => undefined);
      await options.vault.remove(CACHE_KEY_ACCOUNT);
    },
  };
}

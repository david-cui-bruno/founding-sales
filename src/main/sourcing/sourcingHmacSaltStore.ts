/**
 * Membership HMAC salt storage (plan Task 4).
 *
 * Mirrors `sourcingCredentialStore`'s envelope pattern exactly: the shared
 * salt (provisioned once, pasted by the founder via `sourcing.setHmacSalt`)
 * lives in an OS-protected safeStorage envelope on disk
 * (`callie.sourcing-hmac-salt.json`), never in plaintext. Without a salt the
 * membership upload omits `contact_hmacs` entirely; that state is surfaced
 * as `hmacSaltState: 'none'` on `sourcing.status`.
 */
import { readFile, rename, rm, writeFile } from 'node:fs/promises';

import { z } from 'zod';

import type { Clock } from '../domain/support/clock';
import type { AsyncSafeStorage } from '../security/safeStorageKeyProtector';
import type { SourcingHmacSaltState } from '../../shared/contracts/sourcingContract';

const envelopeSchema = z.object({
  format: z.literal('callie-sourcing-hmac-salt'),
  version: z.literal(1),
  protectedSaltBase64: z.string().min(1),
  createdAt: z.string().min(1),
}).strict();

const saltSchema = z.string().trim().min(1).max(512);

export class HmacSaltProtectionUnavailableError extends Error {
  constructor() {
    super('The HMAC salt cannot be saved because protected storage is unavailable.');
    this.name = 'HmacSaltProtectionUnavailableError';
  }
}

export class SourcingHmacSaltStore {
  private readonly safeStorage: AsyncSafeStorage;
  private readonly envelopePath: string;
  private readonly clock: Clock;

  constructor(input: {
    safeStorage: AsyncSafeStorage;
    envelopePath: string;
    clock: Clock;
  }) {
    this.safeStorage = input.safeStorage;
    this.envelopePath = input.envelopePath;
    this.clock = input.clock;
  }

  /** The decrypted salt, or null when unprovisioned or unreadable. */
  async load(): Promise<string | null> {
    let content: string;
    try {
      content = await readFile(this.envelopePath, 'utf8');
    } catch {
      return null;
    }
    try {
      const envelope = envelopeSchema.parse(JSON.parse(content));
      const decrypted = await this.safeStorage.decryptStringAsync(
        Buffer.from(envelope.protectedSaltBase64, 'base64'),
      );
      return saltSchema.parse(decrypted.result);
    } catch {
      // A corrupted envelope reads as unprovisioned; the founder re-pastes.
      return null;
    }
  }

  async state(): Promise<SourcingHmacSaltState> {
    return (await this.load()) === null ? 'none' : 'set';
  }

  /**
   * Persists the founder-pasted salt into the protected envelope. Unlike the
   * credential store's best-effort mirror, this write must succeed: there is
   * no fallback source for the salt.
   */
  async set(salt: string): Promise<void> {
    const parsed = saltSchema.parse(salt);
    if (!(await this.safeStorage.isAsyncEncryptionAvailable())) {
      throw new HmacSaltProtectionUnavailableError();
    }
    const protectedValue = await this.safeStorage.encryptStringAsync(parsed);
    const envelope = JSON.stringify({
      format: 'callie-sourcing-hmac-salt',
      version: 1,
      protectedSaltBase64: Buffer.from(protectedValue).toString('base64'),
      createdAt: this.clock.now(),
    } satisfies z.infer<typeof envelopeSchema>);
    const temporaryPath = `${this.envelopePath}.tmp`;
    try {
      await writeFile(temporaryPath, envelope, { mode: 0o600 });
      await rename(temporaryPath, this.envelopePath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch((): undefined => undefined);
      throw error;
    }
  }
}

/**
 * Sourcing-inbox credential storage (plan Task 3).
 *
 * Mirrors the workspace-key pattern: the secret lives in an OS-protected
 * envelope on disk. `electron.safeStorage` string encryption is backed by the
 * macOS Keychain (service `com.callie.sourcing-inbox` semantics: the app's
 * Keychain entry protects every safeStorage envelope), so the JSON envelope
 * next to the workspace key never contains plaintext credentials.
 *
 * Resolution order:
 * 1. Protected envelope (reported as `keychain`).
 * 2. One-time import file `~/.callie-sourcing-app-inbox-key.json` (verbatim
 *    `aws iam create-access-key` output, reported as `file`). When the file
 *    is used the store immediately writes the protected envelope and logs
 *    that the plaintext file can be deleted.
 * 3. Nothing provisioned (`none`) — the poller idles, not an error.
 */
import { readFile, rename, rm, writeFile } from 'node:fs/promises';

import { z } from 'zod';

import type { Clock } from '../domain/support/clock';
import type { AsyncSafeStorage } from '../security/safeStorageKeyProtector';
import {
  createFileInboxCredentialProvider,
  type InboxCredentials,
} from './inboxClient';
import type { SafeLogger } from '../logging/safeLogger';

export type SourcingCredentialSource = 'keychain' | 'file' | 'none';

export type LoadedSourcingCredentials = {
  credentials: InboxCredentials | null;
  source: SourcingCredentialSource;
};

const envelopeSchema = z.object({
  format: z.literal('callie-sourcing-inbox-credentials'),
  version: z.literal(1),
  protectedCredentialsBase64: z.string().min(1),
  createdAt: z.string().min(1),
}).strict();

const storedCredentialsSchema = z.object({
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
}).strict();

export class SourcingCredentialStore {
  private readonly safeStorage: AsyncSafeStorage;
  private readonly envelopePath: string;
  private readonly fallbackKeyFilePath: string | null;
  private readonly clock: Clock;
  private readonly log: (message: string) => void;
  private readonly logger: SafeLogger;

  constructor(input: {
    safeStorage: AsyncSafeStorage;
    envelopePath: string;
    fallbackKeyFilePath: string | null;
    clock: Clock;
    log?: (message: string) => void;
    logger?: SafeLogger;
  }) {
    this.safeStorage = input.safeStorage;
    this.envelopePath = input.envelopePath;
    this.fallbackKeyFilePath = input.fallbackKeyFilePath;
    this.clock = input.clock;
    this.log = input.log ?? (() => undefined);
    this.logger = input.logger ?? {
      log: (_level, eventCode, fields) => this.log(`${eventCode} ${JSON.stringify(fields ?? {})}`),
    };
  }

  async load(): Promise<LoadedSourcingCredentials> {
    const fromEnvelope = await this.readEnvelope();
    if (fromEnvelope !== null) {
      return { credentials: fromEnvelope, source: 'keychain' };
    }

    if (this.fallbackKeyFilePath === null) {
      return { credentials: null, source: 'none' };
    }
    const fileProvider = createFileInboxCredentialProvider(this.fallbackKeyFilePath);
    const fromFile = await fileProvider();
    if (fromFile !== null) {
      await this.tryPersist(fromFile);
      return { credentials: fromFile, source: 'file' };
    }

    return { credentials: null, source: 'none' };
  }

  private async readEnvelope(): Promise<InboxCredentials | null> {
    let content: string;
    try {
      content = await readFile(this.envelopePath, 'utf8');
    } catch {
      return null;
    }
    try {
      const envelope = envelopeSchema.parse(JSON.parse(content));
      const decrypted = await this.safeStorage.decryptStringAsync(
        Buffer.from(envelope.protectedCredentialsBase64, 'base64'),
      );
      return storedCredentialsSchema.parse(JSON.parse(decrypted.result));
    } catch {
      // A corrupted envelope falls back to the import file; the next
      // successful file read rewrites it.
      return null;
    }
  }

  private async tryPersist(credentials: InboxCredentials): Promise<void> {
    try {
      if (!(await this.safeStorage.isAsyncEncryptionAvailable())) {
        return;
      }
      const plaintext = JSON.stringify(storedCredentialsSchema.parse(credentials));
      const protectedValue = await this.safeStorage.encryptStringAsync(plaintext);
      const envelope = JSON.stringify({
        format: 'callie-sourcing-inbox-credentials',
        version: 1,
        protectedCredentialsBase64: Buffer.from(protectedValue).toString('base64'),
        createdAt: this.clock.now(),
      } satisfies z.infer<typeof envelopeSchema>);
      const temporaryPath = `${this.envelopePath}.tmp`;
      await writeFile(temporaryPath, envelope, { mode: 0o600 });
      await rename(temporaryPath, this.envelopePath);
      this.logger.log('info', 'SOURCING_CREDENTIALS_PROTECTED', {
        component: 'sourcing-credential-store',
        status: 'protected',
      });
    } catch {
      // Never fail a poll because the protected write failed; the file
      // provider remains the source until the next attempt.
      await rm(`${this.envelopePath}.tmp`, { force: true }).catch((): undefined => undefined);
    }
  }
}

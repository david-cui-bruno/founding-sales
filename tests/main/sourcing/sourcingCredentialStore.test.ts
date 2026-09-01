import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AsyncSafeStorage } from '../../../src/main/security/safeStorageKeyProtector';
import {
  SourcingCredentialStore,
} from '../../../src/main/sourcing/sourcingCredentialStore';

const NOW = '2026-09-01T12:00:00.000Z';

/** Reversible fake: "encryption" is base64 wrapping tagged with a prefix. */
function fakeSafeStorage(overrides: Partial<AsyncSafeStorage> = {}): AsyncSafeStorage {
  return {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (plainText) => Buffer.from(`protected:${plainText}`, 'utf8'),
    decryptStringAsync: async (encrypted) => {
      const text = encrypted.toString('utf8');
      if (!text.startsWith('protected:')) throw new Error('not protected');
      return { result: text.slice('protected:'.length), shouldReEncrypt: false };
    },
    ...overrides,
  };
}

describe('SourcingCredentialStore', () => {
  let directory: string;
  let envelopePath: string;
  let keyFilePath: string;
  let logged: string[];

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'callie-sourcing-credentials-'));
    envelopePath = join(directory, 'callie.sourcing-inbox-credentials.json');
    keyFilePath = join(directory, 'app-inbox-key.json');
    logged = [];
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function buildStore(safeStorage: AsyncSafeStorage = fakeSafeStorage()): SourcingCredentialStore {
    return new SourcingCredentialStore({
      safeStorage,
      envelopePath,
      fallbackKeyFilePath: keyFilePath,
      clock: { now: () => NOW },
      log: (message) => logged.push(message),
    });
  }

  function writeKeyFile(): void {
    writeFileSync(keyFilePath, JSON.stringify({
      AccessKey: {
        UserName: 'callie-sourcing-app-inbox',
        AccessKeyId: 'AKIAEXAMPLEKEYID',
        Status: 'Active',
        SecretAccessKey: 'example-secret',
        CreateDate: '2026-09-01T00:00:00+00:00',
      },
    }), { mode: 0o600 });
  }

  it('returns none when neither the envelope nor the key file exists', async () => {
    const result = await buildStore().load();
    expect(result).toEqual({ credentials: null, source: 'none' });
  });

  it('never reads the key file when the fallback path is disabled', async () => {
    writeKeyFile();
    const store = new SourcingCredentialStore({
      safeStorage: fakeSafeStorage(),
      envelopePath,
      fallbackKeyFilePath: null,
      clock: { now: () => NOW },
      log: (message) => logged.push(message),
    });

    const result = await store.load();

    expect(result).toEqual({ credentials: null, source: 'none' });
  });

  it('imports the key file into a protected envelope and reports the file source', async () => {
    writeKeyFile();

    const result = await buildStore().load();

    expect(result).toEqual({
      credentials: {
        accessKeyId: 'AKIAEXAMPLEKEYID',
        secretAccessKey: 'example-secret',
      },
      source: 'file',
    });
    const envelope = JSON.parse(readFileSync(envelopePath, 'utf8')) as {
      format: string; version: number; createdAt: string;
    };
    expect(envelope).toMatchObject({
      format: 'callie-sourcing-inbox-credentials',
      version: 1,
      createdAt: NOW,
    });
    expect(readFileSync(envelopePath, 'utf8')).not.toContain('example-secret');
    expect(logged.join('\n')).toContain(keyFilePath);
    expect(logged.join('\n')).toContain('can be deleted');
  });

  it('prefers the protected envelope on subsequent loads', async () => {
    writeKeyFile();
    await buildStore().load();
    rmSync(keyFilePath);

    const result = await buildStore().load();

    expect(result).toEqual({
      credentials: {
        accessKeyId: 'AKIAEXAMPLEKEYID',
        secretAccessKey: 'example-secret',
      },
      source: 'keychain',
    });
  });

  it('still returns file credentials when the envelope cannot be written', async () => {
    writeKeyFile();
    const store = buildStore(fakeSafeStorage({
      isAsyncEncryptionAvailable: async () => false,
    }));

    const result = await store.load();

    expect(result.source).toBe('file');
    expect(result.credentials?.accessKeyId).toBe('AKIAEXAMPLEKEYID');
  });

  it('falls back to the key file when the envelope is corrupted', async () => {
    writeFileSync(envelopePath, '{not json', { mode: 0o600 });
    writeKeyFile();

    const result = await buildStore().load();

    expect(result.source).toBe('file');
    expect(result.credentials?.accessKeyId).toBe('AKIAEXAMPLEKEYID');
  });

  it('returns none when the envelope is corrupted and no key file exists', async () => {
    writeFileSync(envelopePath, JSON.stringify({
      format: 'callie-sourcing-inbox-credentials',
      version: 1,
      protectedCredentialsBase64: Buffer.from('garbage').toString('base64'),
      createdAt: NOW,
    }), { mode: 0o600 });

    const result = await buildStore().load();

    expect(result).toEqual({ credentials: null, source: 'none' });
  });
});

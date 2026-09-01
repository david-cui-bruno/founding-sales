import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AsyncSafeStorage } from '../../../src/main/security/safeStorageKeyProtector';
import {
  SourcingHmacSaltStore,
} from '../../../src/main/sourcing/sourcingHmacSaltStore';

const NOW = '2026-09-01T12:00:00.000Z';

/** Reversible fake: "encryption" is utf8 wrapping tagged with a prefix. */
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

describe('SourcingHmacSaltStore', () => {
  let directory: string;
  let envelopePath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'callie-sourcing-hmac-salt-'));
    envelopePath = join(directory, 'callie.sourcing-hmac-salt.json');
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function buildStore(safeStorage: AsyncSafeStorage = fakeSafeStorage()): SourcingHmacSaltStore {
    return new SourcingHmacSaltStore({
      safeStorage,
      envelopePath,
      clock: { now: () => NOW },
    });
  }

  it('reports none and loads null before any salt is set', async () => {
    const store = buildStore();
    expect(await store.load()).toBeNull();
    expect(await store.state()).toBe('none');
  });

  it('round-trips a salt through the protected envelope', async () => {
    const store = buildStore();
    await store.set('shared-membership-salt');

    expect(await store.load()).toBe('shared-membership-salt');
    expect(await store.state()).toBe('set');

    const envelope = JSON.parse(readFileSync(envelopePath, 'utf8')) as {
      format: string;
      version: number;
      protectedSaltBase64: string;
      createdAt: string;
    };
    expect(envelope.format).toBe('callie-sourcing-hmac-salt');
    expect(envelope.version).toBe(1);
    expect(envelope.createdAt).toBe(NOW);
    // The plaintext salt never appears in the envelope file.
    expect(readFileSync(envelopePath, 'utf8')).not.toContain('shared-membership-salt');
  });

  it('a fresh store instance reads the persisted envelope', async () => {
    await buildStore().set('salt-value');
    expect(await buildStore().load()).toBe('salt-value');
  });

  it('rejects setting a salt when protected storage is unavailable', async () => {
    const store = buildStore(fakeSafeStorage({
      isAsyncEncryptionAvailable: async () => false,
    }));
    await expect(store.set('salt-value')).rejects.toThrow(/protected storage/i);
    expect(await store.state()).toBe('none');
  });

  it('treats a corrupted envelope as none', async () => {
    await buildStore().set('salt-value');
    const store = buildStore(fakeSafeStorage({
      decryptStringAsync: async () => {
        throw new Error('decryption failed');
      },
    }));
    expect(await store.load()).toBeNull();
    expect(await store.state()).toBe('none');
  });
});

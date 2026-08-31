import { describe, expect, it } from 'vitest';

import {
  SafeStorageKeyProtector,
  type AsyncSafeStorage,
} from '../../src/main/security/safeStorageKeyProtector';
import {
  InvalidKeyProtectorResultError,
  InvalidProtectedWorkspaceKeyError,
  WorkspaceKeyEnvelopeCorruptedError,
  WorkspaceKeyTemporarilyUnavailableError,
} from '../../src/main/security/keyProtector';

const NO_DECRYPT_OVERRIDE = Symbol('no-decrypt-override');

class FakeSafeStorage implements AsyncSafeStorage {
  available = true;
  availabilityError: Error | undefined;
  encryptError: Error | undefined;
  decryptError: Error | undefined;
  encryptInputs: string[] = [];
  decryptInputs: Buffer[] = [];
  encryptedResult: unknown = Buffer.from('protected-value');
  decryptedResult = '';
  shouldReEncrypt = false;
  decryptedPayload: unknown = NO_DECRYPT_OVERRIDE;

  async isAsyncEncryptionAvailable(): Promise<boolean> {
    if (this.availabilityError !== undefined) {
      throw this.availabilityError;
    }
    return this.available;
  }

  async encryptStringAsync(plainText: string): Promise<Buffer> {
    this.encryptInputs.push(plainText);
    if (this.encryptError !== undefined) {
      throw this.encryptError;
    }
    return this.encryptedResult as Buffer;
  }

  async decryptStringAsync(
    encrypted: Buffer,
  ): Promise<{ result: string; shouldReEncrypt: boolean }> {
    this.decryptInputs.push(encrypted);
    if (this.decryptError !== undefined) {
      throw this.decryptError;
    }
    return (this.decryptedPayload === NO_DECRYPT_OVERRIDE ? {
      result: this.decryptedResult,
      shouldReEncrypt: this.shouldReEncrypt,
    } : this.decryptedPayload) as { result: string; shouldReEncrypt: boolean };
  }
}

describe('SafeStorageKeyProtector', () => {
  it('protects exactly 32 bytes through the asynchronous safeStorage boundary', async () => {
    const safeStorage = new FakeSafeStorage();
    const protector = new SafeStorageKeyProtector(safeStorage);
    const key = Buffer.alloc(32, 0x2a);

    const protectedValue = await protector.protect(key);

    expect(safeStorage.encryptInputs).toEqual([
      'KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio=',
    ]);
    expect(protectedValue).toEqual(Buffer.from('protected-value'));
    expect(protectedValue).not.toBe(safeStorage.encryptedResult);
    expect(safeStorage.encryptedResult).toEqual(Buffer.alloc('protected-value'.length));
    expect(protectedValue).toEqual(Buffer.from('protected-value'));
  });

  it('unprotects exactly 32 bytes and maps the re-encryption signal', async () => {
    const safeStorage = new FakeSafeStorage();
    safeStorage.decryptedResult = Buffer.alloc(32, 0x2a).toString('base64');
    safeStorage.shouldReEncrypt = true;
    const protector = new SafeStorageKeyProtector(safeStorage);
    const protectedValue = Buffer.from('ciphertext');

    const result = await protector.unprotect(protectedValue);

    expect(result).toEqual({
      value: Buffer.alloc(32, 0x2a),
      shouldReprotect: true,
    });
    expect(safeStorage.decryptInputs).toHaveLength(1);
    expect(safeStorage.decryptInputs[0]).toEqual(Buffer.alloc(protectedValue.byteLength));
    expect(safeStorage.decryptInputs[0]).not.toBe(protectedValue);
  });

  it('rejects plaintext inputs that are not exactly 32 bytes before safeStorage is called', async () => {
    const safeStorage = new FakeSafeStorage();
    const protector = new SafeStorageKeyProtector(safeStorage);

    await expect(protector.protect(Buffer.alloc(31))).rejects.toThrow(
      'Workspace key must contain exactly 32 bytes.',
    );
    expect(safeStorage.encryptInputs).toEqual([]);
  });

  it.each([
    ['non-base64 plaintext', 'not base64'],
    ['non-canonical base64 plaintext', `${Buffer.alloc(32, 0x2a).toString('base64')}=`],
    ['wrong decoded length', Buffer.alloc(31, 0x2a).toString('base64')],
  ])('rejects %s returned by safeStorage with a constant safe error', async (_name, plaintext) => {
    const safeStorage = new FakeSafeStorage();
    safeStorage.decryptedResult = plaintext;
    const protector = new SafeStorageKeyProtector(safeStorage);

    const operation = protector.unprotect(Buffer.from('ciphertext'));

    await expect(operation).rejects.toBeInstanceOf(InvalidProtectedWorkspaceKeyError);
    await expect(operation).rejects.toThrow('Protected workspace key is invalid.');
  });

  it('maps unavailable Keychain state to the typed temporary error', async () => {
    const safeStorage = new FakeSafeStorage();
    safeStorage.available = false;
    const protector = new SafeStorageKeyProtector(safeStorage);

    const operation = protector.protect(Buffer.alloc(32, 0x2a));

    await expect(operation).rejects.toBeInstanceOf(
      WorkspaceKeyTemporarilyUnavailableError,
    );
    await expect(operation).rejects.toThrow('Workspace key protection is temporarily unavailable.');
  });

  it.each(['availability', 'encrypt'] as const)(
    'does not leak provider details when temporary %s fails',
    async (failurePoint) => {
      const safeStorage = new FakeSafeStorage();
      safeStorage.decryptedResult = Buffer.alloc(32, 0x2a).toString('base64');
      const providerMessage = 'Keychain item SECRET-ACCOUNT-NAME is locked';
      if (failurePoint === 'availability') {
        safeStorage.availabilityError = new Error(providerMessage);
      } else if (failurePoint === 'encrypt') {
        safeStorage.encryptError = new Error(providerMessage);
      }
      const protector = new SafeStorageKeyProtector(safeStorage);

      const operation = protector.protect(Buffer.alloc(32, 0x2a));

      await expect(operation).rejects.toBeInstanceOf(
        WorkspaceKeyTemporarilyUnavailableError,
      );
      await expect(operation).rejects.not.toThrow(providerMessage);
    },
  );

  it('maps a decrypt rejection to permanent envelope corruption without leaking details', async () => {
    const safeStorage = new FakeSafeStorage();
    const providerMessage = 'ciphertext SECRET-CONTENT failed authentication';
    safeStorage.decryptError = new Error(providerMessage);
    const protector = new SafeStorageKeyProtector(safeStorage);

    const operation = protector.unprotect(Buffer.from('ciphertext'));

    await expect(operation).rejects.toBeInstanceOf(WorkspaceKeyEnvelopeCorruptedError);
    await expect(operation).rejects.toThrow('Workspace key envelope cannot be decrypted.');
    await expect(operation).rejects.not.toThrow(providerMessage);
  });

  it('rejects and clears a malformed non-Buffer encryption result', async () => {
    const safeStorage = new FakeSafeStorage();
    safeStorage.encryptedResult = 'not-a-buffer';
    const protector = new SafeStorageKeyProtector(safeStorage);

    await expect(protector.protect(Buffer.alloc(32, 0x2a))).rejects.toBeInstanceOf(
      InvalidKeyProtectorResultError,
    );
  });

  it('rejects and clears an empty Buffer encryption result', async () => {
    const safeStorage = new FakeSafeStorage();
    safeStorage.encryptedResult = Buffer.alloc(0);
    const protector = new SafeStorageKeyProtector(safeStorage);

    await expect(protector.protect(Buffer.alloc(32, 0x2a))).rejects.toBeInstanceOf(
      InvalidKeyProtectorResultError,
    );
    expect(safeStorage.encryptedResult).toEqual(Buffer.alloc(0));
  });

  it.each([
    ['null result', null],
    ['non-string plaintext', { result: 42, shouldReEncrypt: false }],
    [
      'non-boolean reprotection flag',
      { result: Buffer.alloc(32, 0x2a).toString('base64'), shouldReEncrypt: 'yes' },
    ],
  ])('rejects a malformed decrypt response: %s', async (_name, payload) => {
    const safeStorage = new FakeSafeStorage();
    safeStorage.decryptedPayload = payload;
    const protector = new SafeStorageKeyProtector(safeStorage);

    await expect(protector.unprotect(Buffer.from('ciphertext'))).rejects.toBeInstanceOf(
      InvalidKeyProtectorResultError,
    );
  });

  it('clears a Buffer found in a malformed decrypt response', async () => {
    const malformedResult = Buffer.alloc(32, 0x2a);
    const safeStorage = new FakeSafeStorage();
    safeStorage.decryptedPayload = { result: malformedResult, shouldReEncrypt: false };
    const protector = new SafeStorageKeyProtector(safeStorage);

    await expect(protector.unprotect(Buffer.from('ciphertext'))).rejects.toBeInstanceOf(
      InvalidKeyProtectorResultError,
    );
    expect(malformedResult).toEqual(Buffer.alloc(32));
  });
});

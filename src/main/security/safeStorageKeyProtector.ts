import type { KeyProtector } from './keyProtector';
import {
  InvalidProtectedWorkspaceKeyError,
  WorkspaceKeyTemporarilyUnavailableError,
} from './keyProtector';

export interface AsyncSafeStorage {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(plainText: string): Promise<Buffer>;
  decryptStringAsync(encrypted: Buffer): Promise<{
    result: string;
    shouldReEncrypt: boolean;
  }>;
}

const WORKSPACE_KEY_BYTE_LENGTH = 32;

export class SafeStorageKeyProtector implements KeyProtector {
  constructor(private readonly safeStorage: AsyncSafeStorage) {}

  async protect(value: Buffer): Promise<Buffer> {
    assertWorkspaceKeyBytes(value);
    await this.assertAvailable();

    const base64Value = value.toString('base64');
    let protectedValue: Buffer | undefined;
    try {
      protectedValue = await this.safeStorage.encryptStringAsync(base64Value);
      return Buffer.from(protectedValue);
    } catch {
      throw new WorkspaceKeyTemporarilyUnavailableError();
    } finally {
      protectedValue?.fill(0);
    }
  }

  async unprotect(value: Buffer): Promise<{
    value: Buffer;
    shouldReprotect: boolean;
  }> {
    await this.assertAvailable();

    const protectedInput = Buffer.from(value);
    let decrypted: { result: string; shouldReEncrypt: boolean };
    try {
      decrypted = await this.safeStorage.decryptStringAsync(protectedInput);
    } catch {
      throw new WorkspaceKeyTemporarilyUnavailableError();
    } finally {
      protectedInput.fill(0);
    }

    const workspaceKey = decodeCanonicalBase64Key(decrypted.result);
    return {
      value: workspaceKey,
      shouldReprotect: decrypted.shouldReEncrypt,
    };
  }

  private async assertAvailable(): Promise<void> {
    try {
      if (!(await this.safeStorage.isAsyncEncryptionAvailable())) {
        throw new WorkspaceKeyTemporarilyUnavailableError();
      }
    } catch (error) {
      if (error instanceof WorkspaceKeyTemporarilyUnavailableError) {
        throw error;
      }
      throw new WorkspaceKeyTemporarilyUnavailableError();
    }
  }
}

function assertWorkspaceKeyBytes(value: Buffer): void {
  if (!Buffer.isBuffer(value) || value.byteLength !== WORKSPACE_KEY_BYTE_LENGTH) {
    throw new RangeError('Workspace key must contain exactly 32 bytes.');
  }
}

function decodeCanonicalBase64Key(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    throw new InvalidProtectedWorkspaceKeyError();
  }

  const decoded = Buffer.from(value, 'base64');
  if (
    decoded.byteLength !== WORKSPACE_KEY_BYTE_LENGTH
    || decoded.toString('base64') !== value
  ) {
    decoded.fill(0);
    throw new InvalidProtectedWorkspaceKeyError();
  }

  return decoded;
}

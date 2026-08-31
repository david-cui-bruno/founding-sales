import type { KeyProtector } from './keyProtector';
import {
  InvalidKeyProtectorResultError,
  InvalidProtectedWorkspaceKeyError,
  WorkspaceKeyEnvelopeCorruptedError,
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
    let protectedValue: unknown;
    try {
      protectedValue = await this.safeStorage.encryptStringAsync(base64Value);
      if (!Buffer.isBuffer(protectedValue) || protectedValue.byteLength === 0) {
        throw new InvalidKeyProtectorResultError();
      }
      return Buffer.from(protectedValue);
    } catch (error) {
      if (error instanceof InvalidKeyProtectorResultError) {
        throw error;
      }
      throw new WorkspaceKeyTemporarilyUnavailableError();
    } finally {
      if (Buffer.isBuffer(protectedValue)) {
        protectedValue.fill(0);
      }
    }
  }

  async unprotect(value: Buffer): Promise<{
    value: Buffer;
    shouldReprotect: boolean;
  }> {
    await this.assertAvailable();

    const protectedInput = Buffer.from(value);
    let decrypted: unknown;
    try {
      decrypted = await this.safeStorage.decryptStringAsync(protectedInput);
    } catch {
      throw new WorkspaceKeyEnvelopeCorruptedError();
    } finally {
      protectedInput.fill(0);
    }

    const parsedResult = parseDecryptResult(decrypted);
    const workspaceKey = decodeCanonicalBase64Key(parsedResult.result);
    return {
      value: workspaceKey,
      shouldReprotect: parsedResult.shouldReEncrypt,
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

function parseDecryptResult(value: unknown): {
  result: string;
  shouldReEncrypt: boolean;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidKeyProtectorResultError();
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 2
    || keys[0] !== 'result'
    || keys[1] !== 'shouldReEncrypt'
    || typeof record.result !== 'string'
    || typeof record.shouldReEncrypt !== 'boolean'
  ) {
    if (Buffer.isBuffer(record.result)) {
      record.result.fill(0);
    }
    throw new InvalidKeyProtectorResultError();
  }

  return {
    result: record.result,
    shouldReEncrypt: record.shouldReEncrypt,
  };
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

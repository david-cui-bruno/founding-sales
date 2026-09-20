import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Envelope encryption for refresh tokens (invariant 6, Appendix F).
 *
 * "Refresh tokens are envelope-encrypted." The shape is the ordinary one: a fresh
 * 256-bit data key per token, AES-256-GCM over the plaintext, and the data key itself
 * wrapped by a key this process never holds. `mailbox_tokens` stores the wrapped data
 * key, the ciphertext, the nonce and the tag, and nothing that could decrypt them.
 *
 * The wrapping is behind `DataKeyWrapper`, which has two methods and no AWS in it.
 * `localDataKeyWrapper` is what a laptop and every test use: a master key generated
 * when the process starts, so no test has a key to leak and no fixture contains one.
 * `envelopeKms.ts` is the single production implementation.
 *
 * Nothing here logs, and nothing here returns a plaintext except `decrypt`, whose
 * result is passed straight to the Gmail client and never stored, hashed or printed.
 */

export const ENVELOPE_ALGORITHM = 'aes-256-gcm';
const DATA_KEY_BYTES = 32;
const NONCE_BYTES = 12;

export interface EnvelopeCiphertext {
  /** A public identifier for the wrapping key: a KMS alias or ARN, or the local name. */
  readonly keyId: string;
  readonly algorithm: typeof ENVELOPE_ALGORITHM;
  readonly wrappedDataKey: Buffer;
  readonly ciphertext: Buffer;
  readonly iv: Buffer;
  readonly authTag: Buffer;
}

export interface EnvelopeCipher {
  encrypt(plaintext: string): Promise<EnvelopeCiphertext>;
  decrypt(envelope: EnvelopeCiphertext): Promise<string>;
}

/** A generated data key and the same key wrapped. The plaintext half never persists. */
export interface WrappedDataKey {
  readonly plaintext: Buffer;
  readonly wrapped: Buffer;
}

/**
 * What a key-management service is narrowed to: make me a data key, and give me back
 * the plaintext of one I wrapped earlier. Two methods, so a fake is ten lines.
 */
export interface DataKeyWrapper {
  readonly keyId: string;
  generateDataKey(): Promise<WrappedDataKey>;
  unwrapDataKey(wrapped: Buffer): Promise<Buffer>;
}

export class EnvelopeError extends Error {
  constructor(
    readonly code: 'ALGORITHM_UNKNOWN' | 'KEY_MISMATCH' | 'DECRYPT_FAILED' | 'PLAINTEXT_EMPTY',
    message: string,
  ) {
    super(message);
    this.name = 'EnvelopeError';
  }
}

export function envelopeCipher(wrapper: DataKeyWrapper): EnvelopeCipher {
  return {
    encrypt: async plaintext => {
      if (plaintext.length === 0) {
        throw new EnvelopeError('PLAINTEXT_EMPTY', 'there is no envelope for an empty secret');
      }
      const key = await wrapper.generateDataKey();
      const iv = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv(ENVELOPE_ALGORITHM, key.plaintext, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const envelope: EnvelopeCiphertext = {
        keyId: wrapper.keyId,
        algorithm: ENVELOPE_ALGORITHM,
        wrappedDataKey: key.wrapped,
        ciphertext,
        iv,
        authTag: cipher.getAuthTag(),
      };
      // The plaintext data key is dead the moment the ciphertext exists.
      key.plaintext.fill(0);
      return envelope;
    },

    decrypt: async envelope => {
      if (envelope.algorithm !== ENVELOPE_ALGORITHM) {
        throw new EnvelopeError('ALGORITHM_UNKNOWN', `${envelope.algorithm} is not the envelope algorithm`);
      }
      if (envelope.keyId !== wrapper.keyId) {
        // A row wrapped under a key this deployment does not have is not something to
        // guess at: it is a restore or a rotation, and both want an operator.
        throw new EnvelopeError('KEY_MISMATCH', 'the envelope names a key this process was not given');
      }
      const dataKey = await wrapper.unwrapDataKey(envelope.wrappedDataKey);
      try {
        const decipher = createDecipheriv(ENVELOPE_ALGORITHM, dataKey, envelope.iv);
        decipher.setAuthTag(envelope.authTag);
        return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]).toString('utf8');
      } catch {
        // The tag failed. Say so without saying anything about the bytes.
        throw new EnvelopeError('DECRYPT_FAILED', 'the envelope did not authenticate');
      } finally {
        dataKey.fill(0);
      }
    },
  };
}

/**
 * The local wrapper: a master key generated when it is constructed.
 *
 * Right for a laptop and for every test, and wrong for production, which is why the
 * key id says so out loud — a row that says `local-envelope` in production is a
 * deployment that never got its KMS configuration, and it is visible in one query.
 */
export function localDataKeyWrapper(keyId = 'local-envelope'): DataKeyWrapper {
  const master = randomBytes(DATA_KEY_BYTES);
  return {
    keyId,
    generateDataKey: async () => {
      const plaintext = randomBytes(DATA_KEY_BYTES);
      const iv = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv(ENVELOPE_ALGORITHM, master, iv);
      const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      await Promise.resolve();
      return { plaintext, wrapped: Buffer.concat([iv, cipher.getAuthTag(), body]) };
    },
    unwrapDataKey: async wrapped => {
      await Promise.resolve();
      const iv = wrapped.subarray(0, NONCE_BYTES);
      const tag = wrapped.subarray(NONCE_BYTES, NONCE_BYTES + 16);
      const body = wrapped.subarray(NONCE_BYTES + 16);
      const decipher = createDecipheriv(ENVELOPE_ALGORITHM, master, iv);
      decipher.setAuthTag(tag);
      try {
        return Buffer.concat([decipher.update(body), decipher.final()]);
      } catch {
        throw new EnvelopeError('DECRYPT_FAILED', 'the wrapped data key did not authenticate');
      }
    },
  };
}

/** The laptop and test cipher, in one call. */
export function localEnvelopeCipher(keyId?: string): EnvelopeCipher {
  return envelopeCipher(localDataKeyWrapper(keyId));
}

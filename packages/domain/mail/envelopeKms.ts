import type { DataKeyWrapper, WrappedDataKey } from './envelope.ts';

/**
 * The one place the mail lane is allowed to know AWS exists.
 *
 * `envelope.ts` knows nothing about KMS: it takes a `DataKeyWrapper` with two
 * methods. This file is the other side of that seam — the mapping on to
 * `GenerateDataKey` and `Decrypt`, and the one lazy import of the SDK. It is the same
 * shape `packages/domain/jobs/metricsCloudWatch.ts` uses, for the same three reasons:
 * the API and the worker should not pay to load an SDK they may not use, a laptop
 * with no credentials must still be able to run everything else, and the transport is
 * one narrow interface so nothing in a test can reach AWS.
 *
 * No test exercises `loadKmsTransport`. Every test that needs a wrapper uses
 * `localDataKeyWrapper`, whose master key is generated when it is constructed — so
 * the test suite holds no key, and no fixture in this repository contains one.
 *
 * The specifier is a variable, so the module graph does not resolve it statically and
 * a deployment that has not installed the SDK fails with a clear error at the first
 * envelope rather than at import time. See `docs/decisions/g7-kms-adapter.md`.
 */

export interface KmsGenerateDataKeyInput {
  readonly KeyId: string;
  readonly KeySpec: 'AES_256';
  readonly EncryptionContext?: Readonly<Record<string, string>>;
}

export interface KmsGenerateDataKeyOutput {
  readonly Plaintext: Uint8Array;
  readonly CiphertextBlob: Uint8Array;
}

export interface KmsDecryptInput {
  readonly KeyId: string;
  readonly CiphertextBlob: Uint8Array;
  readonly EncryptionContext?: Readonly<Record<string, string>>;
}

export interface KmsDecryptOutput {
  readonly Plaintext: Uint8Array;
}

/** What the SDK is narrowed to. Two methods, so a fake is a handful of lines. */
export interface KmsTransport {
  generateDataKey(input: KmsGenerateDataKeyInput): Promise<KmsGenerateDataKeyOutput>;
  decrypt(input: KmsDecryptInput): Promise<KmsDecryptOutput>;
}

export interface KmsWrapperOptions {
  /** The envelope key: `infra/modules/secrets` output `envelope_kms_key_arn`. */
  readonly keyId: string;
  readonly transport: KmsTransport;
  /**
   * The KMS encryption context. Bound to the workspace and the mailbox, so a
   * ciphertext lifted from one row cannot be decrypted against another: KMS refuses
   * a `Decrypt` whose context differs from the `GenerateDataKey` that made it.
   */
  readonly encryptionContext?: Readonly<Record<string, string>> | undefined;
}

export function kmsDataKeyWrapper(options: KmsWrapperOptions): DataKeyWrapper {
  const context = options.encryptionContext;
  return {
    keyId: options.keyId,
    generateDataKey: async (): Promise<WrappedDataKey> => {
      const result = await options.transport.generateDataKey({
        KeyId: options.keyId,
        KeySpec: 'AES_256',
        ...(context === undefined ? {} : { EncryptionContext: { ...context } }),
      });
      return { plaintext: Buffer.from(result.Plaintext), wrapped: Buffer.from(result.CiphertextBlob) };
    },
    unwrapDataKey: async wrapped => {
      const result = await options.transport.decrypt({
        KeyId: options.keyId,
        CiphertextBlob: wrapped,
        ...(context === undefined ? {} : { EncryptionContext: { ...context } }),
      });
      return Buffer.from(result.Plaintext);
    },
  };
}

/**
 * The KMS encryption context every recorded-seam envelope is bound to (lane g59).
 *
 * `fss admin drill seed-evidence` and `fss drill` are two processes in a rehearsal,
 * both on `FSS_DEPENDENCIES=recorded`, and the drill has to read the refresh token the
 * seed stored. `localDataKeyWrapper` makes a master key per process, so it could not,
 * and every mailbox step of the drill failed to unwrap. The fix is the environment's
 * own envelope key through the production wrapper, with this context on both calls:
 *
 *   * a live process asks KMS without it, so KMS refuses to decrypt a recorded-seam
 *     envelope for a live worker, and a live envelope for a recorded process;
 *   * the drill's IAM grant (`infra/modules/cluster`) is conditioned on it, so the
 *     drill identity can unwrap only what a recorded seed wrapped, never a real
 *     mailbox's token, even in an environment that holds real ones.
 */
export const RECORDED_SEAM_ENCRYPTION_CONTEXT: Readonly<Record<string, string>> = Object.freeze({
  fss_envelope_seam: 'recorded',
});

/** The prefix a recorded-seam envelope's key id carries in `mailbox_tokens.key_id`. */
export const RECORDED_SEAM_KEY_PREFIX = 'recorded-seam:';

/**
 * The environment's KMS envelope key, for the recorded seam only (lane g59).
 *
 * The production wrapper, unchanged, with `RECORDED_SEAM_ENCRYPTION_CONTEXT`. The key
 * id an envelope records is labelled `recorded-seam:<key>`, so a live process, whose
 * wrapper names the bare key, refuses the row locally with `KEY_MISMATCH` before it
 * ever asks KMS, and the row says which seam wrapped it in one query, as
 * `local-envelope` does for a laptop. KMS is still called with the bare key.
 */
export function recordedSeamDataKeyWrapper(options: {
  readonly keyId: string;
  readonly transport: KmsTransport;
}): DataKeyWrapper {
  const inner = kmsDataKeyWrapper({
    keyId: options.keyId,
    transport: options.transport,
    encryptionContext: RECORDED_SEAM_ENCRYPTION_CONTEXT,
  });
  return {
    keyId: `${RECORDED_SEAM_KEY_PREFIX}${options.keyId}`,
    generateDataKey: inner.generateDataKey,
    unwrapDataKey: inner.unwrapDataKey,
  };
}

/**
 * Build the real transport. The only line in the mail lane that loads an AWS SDK and
 * the only one that can reach the network.
 *
 * Credentials come from the task role through the SDK's default provider chain; this
 * process never holds, reads or logs one.
 */
export async function loadKmsTransport(region: string): Promise<KmsTransport> {
  const specifier = '@aws-sdk/client-kms';
  const sdk = (await import(specifier)) as {
    KMSClient: new (configuration: { region: string }) => { send(command: unknown): Promise<unknown> };
    GenerateDataKeyCommand: new (input: KmsGenerateDataKeyInput) => unknown;
    DecryptCommand: new (input: KmsDecryptInput) => unknown;
  };
  const client = new sdk.KMSClient({ region });
  return {
    generateDataKey: async input =>
      (await client.send(new sdk.GenerateDataKeyCommand(input))) as KmsGenerateDataKeyOutput,
    decrypt: async input => (await client.send(new sdk.DecryptCommand(input))) as KmsDecryptOutput,
  };
}

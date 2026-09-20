import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { CarryKind, OldRecord } from './oldShapes.ts';
import { manifestCounts, manifestDigest, type CarryManifest } from './manifest.ts';

/**
 * The carry artifact: one encrypted file, one plaintext receipt (lane G11;
 * specification 2 "Data carry").
 *
 * ## Two files, and what is in each
 *
 * The **artifact** holds the manifest and every carried record, gzipped and sealed.
 * It contains prospect data, it lives outside git and outside the repository
 * directory, and it is shredded as the runbook's last step.
 *
 * The **receipt** holds the artifact id, the watermark, the four per-kind counts,
 * the manifest digest and the sha256 of the sealed bytes. No name, no handle, no
 * address — only numbers and digests — so David can read it aloud, keep it after the
 * artifact is gone, and hand it to the parity check without decrypting anything.
 * A test asserts the receipt contains none of the fixtures' business strings.
 *
 * ## Why the per-item hashes are inside the artifact rather than in the receipt
 *
 * A hash of a firm's fields is not the firm's fields, but it is a stable identifier
 * for them, and a file of eight hundred of them beside the ciphertext is a
 * correlation surface for no benefit. Parity is checked at import, where both sides
 * are already in memory; the receipt's one manifest digest is what proves the
 * manifest inside is the one this receipt describes.
 *
 * ## The cipher is a port
 *
 * `ageCipher` is the production choice and it spawns the `age` command; `aesGcmCipher`
 * is a real AES-256-GCM used locally and by every test. See
 * `docs/decisions/g11-artifact-encryption.md` for why age rather than KMS.
 */

export const CARRY_ARTIFACT_SCHEMA = 'fss.carry.artifact.v1';

export interface ArtifactCipher {
  /** What sealed the file, for the receipt. A word, never a key or a recipient. */
  readonly description: string;
  seal(plaintext: Buffer): Promise<Buffer>;
  open(sealed: Buffer): Promise<Buffer>;
}

export interface CarryReceipt {
  readonly schema: typeof CARRY_ARTIFACT_SCHEMA;
  readonly artifactId: string;
  readonly watermarkAt: string;
  readonly createdAt: string;
  readonly cipher: string;
  readonly counts: Readonly<Record<CarryKind, number>>;
  readonly manifestDigest: string;
  readonly sealedSha256: string;
  readonly sealedBytes: number;
}

export interface SealedArtifact {
  readonly sealed: Buffer;
  readonly receipt: CarryReceipt;
}

interface ArtifactBody {
  readonly schema: typeof CARRY_ARTIFACT_SCHEMA;
  readonly manifest: CarryManifest;
  readonly records: readonly OldRecord[];
}

const sha256 = (value: Buffer): string => createHash('sha256').update(value).digest('hex');

export async function sealArtifact(input: {
  readonly manifest: CarryManifest;
  readonly records: readonly OldRecord[];
  readonly cipher: ArtifactCipher;
}): Promise<SealedArtifact> {
  const body: ArtifactBody = {
    schema: CARRY_ARTIFACT_SCHEMA,
    manifest: input.manifest,
    records: input.records,
  };
  const sealed = await input.cipher.seal(gzipSync(Buffer.from(JSON.stringify(body), 'utf8')));
  return {
    sealed,
    receipt: {
      schema: CARRY_ARTIFACT_SCHEMA,
      artifactId: input.manifest.artifactId,
      watermarkAt: input.manifest.watermarkAt,
      createdAt: input.manifest.createdAt,
      cipher: input.cipher.description,
      counts: manifestCounts(input.manifest),
      manifestDigest: manifestDigest(input.manifest),
      sealedSha256: sha256(sealed),
      sealedBytes: sealed.byteLength,
    },
  };
}

export type OpenRefusal =
  | 'artifact_digest_mismatch'
  | 'artifact_unreadable'
  | 'artifact_schema_unknown'
  | 'manifest_digest_mismatch';

export type OpenResult =
  | { readonly ok: true; readonly value: { readonly manifest: CarryManifest; readonly records: readonly OldRecord[] } }
  | { readonly ok: false; readonly reason: OpenRefusal };

/**
 * Open a sealed artifact against its receipt.
 *
 * The order matters: the bytes are checked against the receipt *before* the key is
 * used, so a truncated or edited file is reported as what it is rather than as a
 * decryption failure; and the manifest digest is checked after, so a file that
 * decrypts cleanly but carries another export's manifest is refused rather than
 * imported against the wrong counts.
 */
export async function openArtifact(input: {
  readonly sealed: Buffer;
  readonly receipt: CarryReceipt;
  readonly cipher: ArtifactCipher;
}): Promise<OpenResult> {
  if (sha256(input.sealed) !== input.receipt.sealedSha256) return { ok: false, reason: 'artifact_digest_mismatch' };

  let body: unknown;
  try {
    body = JSON.parse(gunzipSync(await input.cipher.open(input.sealed)).toString('utf8'));
  } catch {
    return { ok: false, reason: 'artifact_unreadable' };
  }
  if (typeof body !== 'object' || body === null) return { ok: false, reason: 'artifact_unreadable' };
  const parsed = body as Partial<ArtifactBody>;
  if (parsed.schema !== CARRY_ARTIFACT_SCHEMA) return { ok: false, reason: 'artifact_schema_unknown' };
  if (parsed.manifest === undefined || !Array.isArray(parsed.records)) return { ok: false, reason: 'artifact_unreadable' };
  if (manifestDigest(parsed.manifest) !== input.receipt.manifestDigest) {
    return { ok: false, reason: 'manifest_digest_mismatch' };
  }
  return { ok: true, value: { manifest: parsed.manifest, records: parsed.records } };
}

/* ------------------------------------------------------------------------- */
/* The ciphers.                                                               */
/* ------------------------------------------------------------------------- */

const AES_IV_BYTES = 12;
const AES_TAG_BYTES = 16;

/**
 * AES-256-GCM with a caller-supplied key.
 *
 * This is what the tests use, and it is deliberately real: a fake that returned the
 * plaintext would have proved nothing about the tamper checks above. It is also what
 * a rehearsal uses on a machine with no `age` binary. It is *not* the production
 * choice, because it would put key handling in this tool's hands, and the decision
 * doc says why that is worse than an `age` identity in David's password manager.
 */
export function aesGcmCipher(key: Buffer): ArtifactCipher {
  if (key.byteLength !== 32) throw new Error('an AES-256 key is 32 bytes');
  return {
    description: 'aes-256-gcm',
    seal: async plaintext => {
      const iv = randomBytes(AES_IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const sealed = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return await Promise.resolve(Buffer.concat([iv, cipher.getAuthTag(), sealed]));
    },
    open: async sealed => {
      if (sealed.byteLength < AES_IV_BYTES + AES_TAG_BYTES) throw new Error('the sealed file is too short');
      const iv = sealed.subarray(0, AES_IV_BYTES);
      const tag = sealed.subarray(AES_IV_BYTES, AES_IV_BYTES + AES_TAG_BYTES);
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return await Promise.resolve(
        Buffer.concat([decipher.update(sealed.subarray(AES_IV_BYTES + AES_TAG_BYTES)), decipher.final()]),
      );
    },
  };
}

/** The arguments `age` is given to encrypt. A recipient, never a passphrase. */
export function ageEncryptArguments(recipient: string): readonly string[] {
  return ['--encrypt', '--recipient', recipient];
}

/** The arguments `age` is given to decrypt. An identity *file*, never an inline key. */
export function ageDecryptArguments(identityFile: string): readonly string[] {
  return ['--decrypt', '--identity', identityFile];
}

/** Run a command with `input` on stdin and collect stdout. Supplied by the CLI. */
export type RunCommand = (command: string, args: readonly string[], input: Buffer) => Promise<Buffer>;

export interface AgeCipherOptions {
  readonly command: string;
  /** David's age *public* key. A public identifier; it is safe in a runbook. */
  readonly recipient: string;
  /** Where the private identity is mounted at import time. A path, never a key. */
  readonly identityFile: string;
  readonly run: RunCommand;
}

/**
 * The production cipher: the `age` command, with a recipient public key.
 *
 * No key material passes through this process, no environment variable holds one,
 * and nothing here is logged. The public recipient may appear in the runbook; the
 * identity file is a path to something David mounts and unmounts.
 */
export function ageCipher(options: AgeCipherOptions): ArtifactCipher {
  return {
    description: 'age',
    seal: async plaintext => await options.run(options.command, ageEncryptArguments(options.recipient), plaintext),
    open: async sealed => await options.run(options.command, ageDecryptArguments(options.identityFile), sealed),
  };
}

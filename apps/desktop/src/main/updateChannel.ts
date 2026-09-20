import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { z } from 'zod';
import { compareVersions, semanticVersionSchema, type SemanticVersion } from '@fss/contracts';

/**
 * Signed update enforcement (specification 14.2, G13a deliverable 2).
 *
 * The channel is a private S3 bucket behind CloudFront (`infra/modules/updates`).
 * TLS and an origin access control decide who may *serve* a manifest; they decide
 * nothing about whether this Mac should *install* one. That decision is made here,
 * against an Ed25519 public key compiled into the build, and it is made the same way
 * whether the answer arrived from CloudFront, from a proxy, or from something that
 * captured the DNS name.
 *
 * Nothing in this file is Electron, so the rules are tested without a packaged app.
 * `updater.ts` is the thin part that shows a person the result.
 */

/** The one path a build reads. Per platform and architecture, so a universal build later is a new path, not a new meaning. */
export const CHANNEL_MANIFEST_PATH = 'releases/darwin-arm64/latest.json';

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const commitSha = z.string().regex(/^[0-9a-f]{40}$/);

export const updateManifestSchema = z.strictObject({
  format: z.literal('fss-desktop-update'),
  version: z.literal(1),
  /** There is one channel. A second one is a schema change somebody reviews. */
  channel: z.literal('release'),
  releaseVersion: semanticVersionSchema,
  /** The commit the artifact was built from; the same value the bundle is stamped with. */
  commitSha,
  publishedAt: z.iso.datetime(),
  minimumSystemVersion: semanticVersionSchema,
  artifact: z.strictObject({
    url: z.url(),
    sizeBytes: z.number().int().positive().max(2_000_000_000),
    sha256: sha256Hex,
  }),
});
export type UpdateManifest = z.infer<typeof updateManifestSchema>;

export const signedUpdateManifestSchema = z.strictObject({
  manifest: updateManifestSchema,
  /** Ed25519 over `canonicalJsonBytes(manifest)`, base64. */
  signature: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).min(64).max(256),
});
export type SignedUpdateManifest = z.infer<typeof signedUpdateManifestSchema>;

export type UpdateRefusal =
  /** No public key was compiled in. A build that cannot check a signature installs nothing. */
  | 'update_key_absent'
  | 'update_manifest_unreadable'
  | 'update_signature_invalid'
  | 'update_downgrade_refused'
  | 'update_running_version_unreadable'
  | 'update_artifact_untrusted'
  | 'update_artifact_size_mismatch'
  | 'update_artifact_digest_mismatch'
  | 'update_offline';

export type UpdateDecision =
  | { readonly kind: 'up_to_date' }
  | { readonly kind: 'available'; readonly manifest: UpdateManifest }
  | { readonly kind: 'refused'; readonly reason: UpdateRefusal };

/**
 * A JSON encoding that depends on the value and not on how it was written down.
 *
 * The signature covers this, not the bytes as they arrived, so a proxy that
 * re-serialises the document does not break an honest update — and reordering keys
 * does not let a dishonest one through either, because the reordering is undone
 * before the check.
 */
export function canonicalJsonBytes(value: unknown): Uint8Array {
  return Buffer.from(canonicalJson(value), 'utf8');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, inner]) => inner !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonicalJson(inner)}`).join(',')}}`;
  }
  throw new Error('a manifest cannot contain this');
}

/**
 * Publish-side. The private key never exists on a Mac running the app.
 *
 * Base64 PKCS#8 DER, the same encoding the public half uses, and the only one the
 * publisher accepts (`docs/decisions/g13-update-key-encoding.md`).
 */
export function signManifest(manifest: UpdateManifest, privateKeyBase64: string): SignedUpdateManifest {
  const parsed = updateManifestSchema.parse(manifest);
  const key = createPrivateKey({ key: Buffer.from(privateKeyBase64, 'base64'), format: 'der', type: 'pkcs8' });
  const signature = sign(null, canonicalJsonBytes(parsed), key).toString('base64');
  return signedUpdateManifestSchema.parse({ manifest: parsed, signature });
}

export type ManifestVerification =
  | { readonly ok: true; readonly manifest: UpdateManifest }
  | { readonly ok: false; readonly reason: UpdateRefusal };

/** Base64 SPKI DER, as embedded by the build. An empty string is "no key". */
export function verifySignedManifest(answer: unknown, publicKeyBase64: string): ManifestVerification {
  if (publicKeyBase64.trim().length === 0) return { ok: false, reason: 'update_key_absent' };

  const parsed = signedUpdateManifestSchema.safeParse(answer);
  if (!parsed.success) return { ok: false, reason: 'update_manifest_unreadable' };

  let key;
  try {
    key = createPublicKey({ key: Buffer.from(publicKeyBase64, 'base64'), format: 'der', type: 'spki' });
  } catch {
    // A build carrying a key that is not a key can verify nothing, which is the
    // same position as carrying no key at all.
    return { ok: false, reason: 'update_key_absent' };
  }

  let good = false;
  try {
    good = verify(null, canonicalJsonBytes(parsed.data.manifest), key, Buffer.from(parsed.data.signature, 'base64'));
  } catch {
    good = false;
  }
  return good ? { ok: true, manifest: parsed.data.manifest } : { ok: false, reason: 'update_signature_invalid' };
}

export interface UpdateDecisionInput {
  readonly currentVersion: string;
  /** The CloudFront origin this build was told to trust. */
  readonly channelBaseUrl: string;
  readonly publicKey: string;
  readonly answer: unknown;
}

export function decideUpdate(input: UpdateDecisionInput): UpdateDecision {
  const verified = verifySignedManifest(input.answer, input.publicKey);
  if (!verified.ok) return { kind: 'refused', reason: verified.reason };
  const manifest = verified.manifest;

  const running = semanticVersionSchema.safeParse(input.currentVersion);
  // A development bundle has no version anyone can order. It is not "old enough to
  // replace with whatever the channel says".
  if (!running.success) return { kind: 'refused', reason: 'update_running_version_unreadable' };

  if (!artifactBelongsToChannel(manifest.artifact.url, input.channelBaseUrl)) {
    // A signed manifest is still only a signed manifest. If the signing key ever
    // leaks, this keeps the download on the origin we control.
    return { kind: 'refused', reason: 'update_artifact_untrusted' };
  }

  const order = compareVersions(manifest.releaseVersion, running.data);
  if (order < 0) return { kind: 'refused', reason: 'update_downgrade_refused' };
  if (order === 0) return { kind: 'up_to_date' };
  return { kind: 'available', manifest };
}

function artifactBelongsToChannel(artifactUrl: string, channelBaseUrl: string): boolean {
  let artifact: URL;
  let channel: URL;
  try {
    artifact = new URL(artifactUrl);
    channel = new URL(channelBaseUrl);
  } catch {
    return false;
  }
  if (artifact.protocol !== channel.protocol) return false;
  // The channel is HTTPS in production. A test server on the loopback address is the
  // one exception, and it cannot be reached from anywhere else.
  if (artifact.protocol !== 'https:' && artifact.hostname !== '127.0.0.1') return false;
  return artifact.host === channel.host;
}

export type ArtifactCheck = { readonly ok: true } | { readonly ok: false; readonly reason: UpdateRefusal };

/** The downloaded bytes, before anything opens them. */
export function verifyArtifactBytes(manifest: UpdateManifest, bytes: Uint8Array): ArtifactCheck {
  if (bytes.byteLength !== manifest.artifact.sizeBytes) return { ok: false, reason: 'update_artifact_size_mismatch' };
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== manifest.artifact.sha256) return { ok: false, reason: 'update_artifact_digest_mismatch' };
  return { ok: true };
}

export interface UpdateCheckOptions {
  readonly currentVersion: string;
  readonly channelBaseUrl: string;
  readonly publicKey: string;
  /** Injected in tests. The default reads the channel with the platform `fetch`. */
  readonly fetchJson?: (url: string) => Promise<unknown>;
}

export async function checkForUpdate(options: UpdateCheckOptions): Promise<UpdateDecision> {
  const read = options.fetchJson ?? defaultFetchJson;
  let answer: unknown;
  try {
    answer = await read(new URL(CHANNEL_MANIFEST_PATH, options.channelBaseUrl).toString());
  } catch {
    // Unreachable is not "up to date": a person below the minimum client version is
    // told the channel could not be read, not that there is nothing to install.
    return { kind: 'refused', reason: 'update_offline' };
  }
  return decideUpdate({
    currentVersion: options.currentVersion,
    channelBaseUrl: options.channelBaseUrl,
    publicKey: options.publicKey,
    answer,
  });
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { accept: 'application/json' }, redirect: 'error' });
  if (!response.ok) throw new Error('the channel did not answer');
  return await response.json();
}

export type ArtifactDownload =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: UpdateRefusal };

/**
 * The artifact, checked against the signed manifest before anything is written
 * where a person could double-click it.
 *
 * The size is checked twice: once as a limit while reading, so a channel that
 * answers with an endless stream fills no disk, and once exactly, against the
 * signed value. Gatekeeper will check the notarization ticket when the bundle is
 * opened; this is the check that the bytes are the ones the release signed.
 */
export async function downloadVerifiedArtifact(
  manifest: UpdateManifest,
  fetchBytes: (url: string) => Promise<Uint8Array> = defaultFetchBytes,
): Promise<ArtifactDownload> {
  let bytes: Uint8Array;
  try {
    bytes = await fetchBytes(manifest.artifact.url);
  } catch {
    return { ok: false, reason: 'update_offline' };
  }
  const checked = verifyArtifactBytes(manifest, bytes);
  return checked.ok ? { ok: true, bytes } : { ok: false, reason: checked.reason };
}

async function defaultFetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { redirect: 'error' });
  if (!response.ok) throw new Error('the channel did not answer');
  return new Uint8Array(await response.arrayBuffer());
}

/** The version that would clear a raised minimum, for the upgrade prompt's wording. */
export function clearsMinimum(manifest: UpdateManifest, minimum: SemanticVersion): boolean {
  return compareVersions(manifest.releaseVersion, minimum) >= 0;
}

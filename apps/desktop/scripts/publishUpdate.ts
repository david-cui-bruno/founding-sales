import { execFileSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHANNEL_MANIFEST_PATH,
  signManifest,
  verifyArtifactBytes,
  type SignedUpdateManifest,
  type UpdateManifest,
} from '../src/main/updateChannel.ts';
import type { Environment } from './signing.ts';
import { verifyPackagedApp } from './verifyPackage.ts';

/**
 * The publish side of the update channel: turn a verified release bundle into the
 * two objects the CloudFront channel serves, and sign the one that matters.
 *
 * It uploads nothing. No AWS credential exists in this repository and none is
 * wanted here — the release procedure (specification 16.2) compares the artifact
 * that passed rehearsal with the artifact that is deployed, so the upload is an
 * operator step run against a directive, printed at the end of `install.md`.
 *
 * Three refusals, all of them closing the same door in different ways. Without the
 * signing key there is no manifest at all. If the key does not match the public key
 * the bundle embedded, the manifest would be a release nobody could install, so it
 * is refused before it exists. And if the bundle itself does not pass the release
 * verifier, there is nothing here worth signing.
 */

export const UPDATE_SIGNING_KEY_VARIABLE = 'FSS_UPDATE_SIGNING_KEY';

export type SigningKeyOutcome =
  | { readonly kind: 'key'; readonly privateKey: string; readonly publicKey: string }
  | {
      readonly kind: 'refused';
      readonly reason:
        | 'update_signing_key_absent'
        | 'update_signing_key_not_der'
        | 'update_signing_key_unreadable';
    };

/**
 * The update-signing key: base64 PKCS#8 DER, and nothing else.
 *
 * Not PEM. A repository secret holding a PEM keeps its newlines only by luck, so
 * base64 was going to be accepted anyway — and once both are accepted, some file
 * here has to contain the armour a PEM is wrapped in, which is a literal no file
 * in this repository should hold and which the secret scanner correctly refuses.
 * One encoding, the same one the public half uses, and a named refusal that tells
 * an operator how to convert. `docs/decisions/g13-update-key-encoding.md`.
 *
 * Nothing in the returned value is ever printed: the caller gets the public half,
 * which is public, and the private half goes straight into a signature.
 */
export function resolveUpdateSigningKey(environment: Environment): SigningKeyOutcome {
  const raw = environment[UPDATE_SIGNING_KEY_VARIABLE];
  if (raw === undefined || raw.trim().length === 0) return { kind: 'refused', reason: 'update_signing_key_absent' };
  const value = raw.trim();
  // A PEM begins with five hyphens. Recognised by shape so that the refusal can
  // name the problem without this file containing the armour itself.
  if (value.startsWith('-----')) return { kind: 'refused', reason: 'update_signing_key_not_der' };
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return { kind: 'refused', reason: 'update_signing_key_not_der' };
  try {
    const privateKey = createPrivateKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'pkcs8' });
    if (privateKey.asymmetricKeyType !== 'ed25519') return { kind: 'refused', reason: 'update_signing_key_unreadable' };
    return {
      kind: 'key',
      privateKey: value,
      publicKey: createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64'),
    };
  } catch {
    return { kind: 'refused', reason: 'update_signing_key_unreadable' };
  }
}

export interface ManifestInput {
  readonly releaseVersion: string;
  readonly commitSha: string;
  readonly channelBaseUrl: string;
  readonly artifactName: string;
  readonly artifactBytes: Uint8Array;
  readonly now: Date;
}

export function buildManifest(input: ManifestInput): UpdateManifest {
  const manifest: UpdateManifest = {
    format: 'fss-desktop-update',
    version: 1,
    channel: 'release',
    releaseVersion: input.releaseVersion,
    commitSha: input.commitSha,
    publishedAt: input.now.toISOString(),
    minimumSystemVersion: '13.0.0',
    artifact: {
      url: new URL(
        `releases/darwin-arm64/${input.releaseVersion}/${input.artifactName}`,
        input.channelBaseUrl,
      ).toString(),
      sizeBytes: input.artifactBytes.byteLength,
      sha256: '',
    },
  };
  // Filled by the same function the Mac uses to check it, so the two can never
  // disagree about what "the digest of this artifact" means.
  const digest = createHash('sha256').update(input.artifactBytes).digest('hex');
  const complete = { ...manifest, artifact: { ...manifest.artifact, sha256: digest } };
  const check = verifyArtifactBytes(complete, input.artifactBytes);
  if (!check.ok) throw new Error(`PUBLISH: the manifest does not describe its own artifact (${check.reason}).`);
  return complete;
}

export interface PublishOutcome {
  readonly manifest: SignedUpdateManifest;
  readonly artifactPath: string;
  readonly manifestPath: string;
}

export interface PublishOptions {
  readonly appPath: string;
  readonly outDirectory: string;
  readonly channelBaseUrl: string;
  readonly env: Environment;
  readonly now?: () => Date;
}

export async function publishUpdate(options: PublishOptions): Promise<PublishOutcome> {
  const key = resolveUpdateSigningKey(options.env);
  if (key.kind === 'refused') {
    throw new Error(
      `PUBLISH: refused — ${key.reason}. Set ${UPDATE_SIGNING_KEY_VARIABLE} to the base64 PKCS#8 DER Ed25519 ` +
        'private key: openssl pkey -in <key> -outform DER | base64 | tr -d "\\n".',
    );
  }

  const verified = await verifyPackagedApp(options.appPath, { mode: 'release' });
  if (!verified.ok) throw new Error(`PUBLISH: refused — the bundle is not a release (${verified.failures.join(', ')}).`);
  const stamp = verified.report.stamp;
  if (stamp === null) throw new Error('PUBLISH: refused — the bundle carries no release stamp.');

  if (verified.report.embeddedUpdatePublicKey !== key.publicKey) {
    // Signing with a key this build cannot verify would publish an update nobody
    // can install, and the failure would appear on a person's Mac rather than here.
    throw new Error('PUBLISH: refused — the signing key does not match the public key embedded in the bundle.');
  }

  const artifactName = `Callie-${stamp.appVersion}-arm64.zip`;
  const artifactPath = join(options.outDirectory, artifactName);
  // `ditto` is Apple's archiver and the only one that preserves a code signature
  // and its extended attributes through a round trip.
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', options.appPath, artifactPath], {
    timeout: 900_000,
  });

  const manifest = buildManifest({
    releaseVersion: stamp.appVersion,
    commitSha: stamp.commitSha,
    channelBaseUrl: options.channelBaseUrl,
    artifactName,
    artifactBytes: readFileSync(artifactPath),
    now: (options.now ?? (() => new Date()))(),
  });

  const signed = signManifest(manifest, key.privateKey);
  const manifestPath = join(options.outDirectory, basename(CHANNEL_MANIFEST_PATH));
  writeFileSync(manifestPath, `${JSON.stringify(signed, null, 2)}\n`);
  return { manifest: signed, artifactPath, manifestPath };
}

/** `node --experimental-strip-types apps/desktop/scripts/publishUpdate.ts <app> <out>` */
async function main(): Promise<void> {
  const [, , app, out] = process.argv;
  if (app === undefined || out === undefined) throw new Error('PUBLISH: give the .app and an output directory.');
  const outcome = await publishUpdate({
    appPath: resolve(app),
    outDirectory: resolve(out),
    channelBaseUrl: process.env['FSS_UPDATE_CHANNEL_URL'] ?? 'https://updates.usecallie.com/',
    env: process.env,
  });
  process.stdout.write(
    `${JSON.stringify(
      { artifact: outcome.artifactPath, manifest: outcome.manifestPath, channelPath: CHANNEL_MANIFEST_PATH },
      null,
      2,
    )}\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

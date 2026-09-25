import { describe, expect, it } from 'vitest';
import {
  canonicalJsonBytes,
  CHANNEL_MANIFEST_PATH,
  decideUpdate,
  macOsVersion,
  signManifest,
  verifyArtifactBytes,
  type SignedUpdateManifest,
  type UpdateManifest,
} from '../../src/main/updateChannel.ts';
import { generateUpdateKeyPair, sha256Hex } from '../support/updateKeys.ts';

/** The macOS these fixtures run on: above the 13.0.0 every fixture manifest asks for. */
const MAC_OS = '15.4.1';

/**
 * The update channel (specification 14.2: "signed update enforcement"; G13a
 * deliverable 2).
 *
 * The channel is a CloudFront distribution in front of a private bucket, so the
 * transport is authenticated and encrypted — and none of that is what makes an
 * update safe. What makes it safe is that the manifest is signed with a key the
 * build embedded, and that a build refuses anything it cannot verify against that
 * key. Every case below is a way of getting the Mac to install something, and every
 * one of them has to end in a refusal.
 */

const CHANNEL = 'https://d111111abcdef8.cloudfront.net/';

const artifactBody = 'a throwaway zip';

function manifest(over: Partial<UpdateManifest> = {}): UpdateManifest {
  return {
    format: 'fss-desktop-update',
    version: 1,
    channel: 'release',
    releaseVersion: '1.5.0',
    commitSha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    publishedAt: '2026-09-20T09:00:00.000Z',
    minimumSystemVersion: '13.0.0',
    artifact: {
      url: `${CHANNEL}releases/1.5.0/Callie-1.5.0-arm64.zip`,
      sizeBytes: Buffer.byteLength(artifactBody),
      sha256: sha256Hex(artifactBody),
    },
    ...over,
  };
}

describe('the update manifest is believed only when its signature verifies', () => {
  it('accepts a newer release signed by the embedded key', () => {
    const keys = generateUpdateKeyPair();
    const answer = signManifest(manifest(), keys.privateKey);

    const decision = decideUpdate({
      currentVersion: '1.4.0',
      systemVersion: MAC_OS,
      channelBaseUrl: CHANNEL,
      publicKey: keys.publicKey,
      answer,
    });

    expect(decision).toEqual({ kind: 'available', manifest: manifest() });
  });

  it('refuses every update when no public key was embedded at build time', () => {
    const keys = generateUpdateKeyPair();
    const answer = signManifest(manifest(), keys.privateKey);

    // An unsigned development bundle, or a build step that forgot the key. Either
    // way the only safe answer is "no update", never "install it anyway".
    expect(
      decideUpdate({ currentVersion: '1.4.0', systemVersion: MAC_OS, channelBaseUrl: CHANNEL, publicKey: '', answer }),
    ).toEqual({ kind: 'refused', reason: 'update_key_absent' });
  });

  it('refuses a manifest signed by a different key', () => {
    const mine = generateUpdateKeyPair();
    const theirs = generateUpdateKeyPair();
    const answer = signManifest(manifest(), theirs.privateKey);

    expect(
      decideUpdate({ currentVersion: '1.4.0', systemVersion: MAC_OS, channelBaseUrl: CHANNEL, publicKey: mine.publicKey, answer }),
    ).toEqual({ kind: 'refused', reason: 'update_signature_invalid' });
  });

  it('refuses a manifest whose fields were edited after signing', () => {
    const keys = generateUpdateKeyPair();
    const signed = signManifest(manifest(), keys.privateKey);
    const tampered: SignedUpdateManifest = {
      ...signed,
      manifest: { ...signed.manifest, artifact: { ...signed.manifest.artifact, url: 'https://evil.invalid/x.zip' } },
    };

    expect(
      decideUpdate({ currentVersion: '1.4.0', systemVersion: MAC_OS, channelBaseUrl: CHANNEL, publicKey: keys.publicKey, answer: tampered }),
    ).toEqual({ kind: 'refused', reason: 'update_signature_invalid' });
  });

  it('refuses an answer with no signature at all', () => {
    expect(
      decideUpdate({
        currentVersion: '1.4.0',
        systemVersion: MAC_OS,
        channelBaseUrl: CHANNEL,
        publicKey: generateUpdateKeyPair().publicKey,
        answer: { manifest: manifest() },
      }),
    ).toEqual({ kind: 'refused', reason: 'update_manifest_unreadable' });
  });

  it('refuses an answer carrying a field the contract does not name', () => {
    const keys = generateUpdateKeyPair();
    const signed = signManifest(manifest(), keys.privateKey);

    expect(
      decideUpdate({
        currentVersion: '1.4.0',
        systemVersion: MAC_OS,
        channelBaseUrl: CHANNEL,
        publicKey: keys.publicKey,
        answer: { ...signed, installSilently: true },
      }),
    ).toEqual({ kind: 'refused', reason: 'update_manifest_unreadable' });
  });

  it('verifies the signature over a canonical encoding, not over the bytes as they arrived', () => {
    const keys = generateUpdateKeyPair();
    const signed = signManifest(manifest(), keys.privateKey);
    // The same manifest with its keys in a different order is the same manifest.
    const reordered = JSON.parse(
      JSON.stringify({ signature: signed.signature, manifest: reverseKeys(signed.manifest) }),
    ) as unknown;

    expect(
      decideUpdate({ currentVersion: '1.4.0', systemVersion: MAC_OS, channelBaseUrl: CHANNEL, publicKey: keys.publicKey, answer: reordered }),
    ).toEqual({ kind: 'available', manifest: manifest() });
  });

  it('canonical bytes are stable under key order', () => {
    expect(canonicalJsonBytes({ b: 1, a: { d: 2, c: 3 } })).toEqual(canonicalJsonBytes({ a: { c: 3, d: 2 }, b: 1 }));
  });
});

describe('a signed manifest still has to be a newer build from this channel', () => {
  it('refuses a downgrade, however well signed', () => {
    const keys = generateUpdateKeyPair();
    const answer = signManifest(manifest({ releaseVersion: '1.3.0' }), keys.privateKey);

    expect(
      decideUpdate({ currentVersion: '1.4.0', systemVersion: MAC_OS, channelBaseUrl: CHANNEL, publicKey: keys.publicKey, answer }),
    ).toEqual({ kind: 'refused', reason: 'update_downgrade_refused' });
  });

  it('says nothing is needed when the channel holds the running version', () => {
    const keys = generateUpdateKeyPair();
    const answer = signManifest(manifest({ releaseVersion: '1.4.0' }), keys.privateKey);

    expect(
      decideUpdate({ currentVersion: '1.4.0', systemVersion: MAC_OS, channelBaseUrl: CHANNEL, publicKey: keys.publicKey, answer }),
    ).toEqual({ kind: 'up_to_date' });
  });

  it('refuses an artifact hosted somewhere other than the configured channel', () => {
    const keys = generateUpdateKeyPair();
    const answer = signManifest(
      manifest({
        artifact: {
          url: 'https://updates.evil.invalid/releases/1.5.0/Callie.zip',
          sizeBytes: 10,
          sha256: sha256Hex('x'),
        },
      }),
      keys.privateKey,
    );

    expect(
      decideUpdate({ currentVersion: '1.4.0', systemVersion: MAC_OS, channelBaseUrl: CHANNEL, publicKey: keys.publicKey, answer }),
    ).toEqual({ kind: 'refused', reason: 'update_artifact_untrusted' });
  });

  it('refuses a plaintext artifact URL on the right host', () => {
    const keys = generateUpdateKeyPair();
    const answer = signManifest(
      manifest({
        artifact: {
          url: 'http://d111111abcdef8.cloudfront.net/releases/1.5.0/Callie.zip',
          sizeBytes: 10,
          sha256: sha256Hex('x'),
        },
      }),
      keys.privateKey,
    );

    expect(
      decideUpdate({ currentVersion: '1.4.0', systemVersion: MAC_OS, channelBaseUrl: CHANNEL, publicKey: keys.publicKey, answer }),
    ).toEqual({ kind: 'refused', reason: 'update_artifact_untrusted' });
  });

  it('refuses an unreadable running version rather than guessing it is old', () => {
    const keys = generateUpdateKeyPair();
    const answer = signManifest(manifest(), keys.privateKey);

    expect(
      decideUpdate({ currentVersion: 'dev', systemVersion: MAC_OS, channelBaseUrl: CHANNEL, publicKey: keys.publicKey, answer }),
    ).toEqual({ kind: 'refused', reason: 'update_running_version_unreadable' });
  });

  it('names the one path on the channel it reads', () => {
    expect(CHANNEL_MANIFEST_PATH).toBe('releases/darwin-arm64/latest.json');
  });
});

/**
 * Lane g86, audit N07: the signed manifest's `minimumSystemVersion` used to be carried
 * and never read. The trap is a check that never refuses, so the first case requires a
 * refusal of the very manifest the Mac on 15.4.1 accepts above, signed the same way.
 */
describe('the manifest’s minimum macOS is enforced', () => {
  const keys = generateUpdateKeyPair();
  const decide = (systemVersion: string, over: Partial<UpdateManifest> = {}) =>
    decideUpdate({
      currentVersion: '1.4.0',
      systemVersion,
      channelBaseUrl: CHANNEL,
      publicKey: keys.publicKey,
      answer: signManifest(manifest(over), keys.privateKey),
    });

  it('refuses an update whose minimum is above this Mac', () => {
    expect(decide(MAC_OS, { minimumSystemVersion: '15.5.0' })).toEqual({ kind: 'refused', reason: 'update_system_too_old' });
    expect(decide('12.7.6')).toEqual({ kind: 'refused', reason: 'update_system_too_old' });
  });

  it('offers it at the minimum and above, including a macOS with no patch number', () => {
    expect(decide('13.0')).toMatchObject({ kind: 'available' });
    expect(decide('26.0')).toMatchObject({ kind: 'available' });
    expect(decide(MAC_OS, { minimumSystemVersion: '15.4.1' })).toMatchObject({ kind: 'available' });
  });

  it('refuses rather than guess when this Mac’s version cannot be read', () => {
    for (const unreadable of ['', 'dev', '15.4.1.2', 'Version 15.4']) {
      expect(decide(unreadable), unreadable).toEqual({ kind: 'refused', reason: 'update_system_version_unreadable' });
    }
  });

  it('leaves an up-to-date Mac up to date whatever the manifest asks of the next one', () => {
    const answer = signManifest(manifest({ releaseVersion: '1.4.0', minimumSystemVersion: '99.0.0' }), keys.privateKey);
    expect(
      decideUpdate({ currentVersion: '1.4.0', systemVersion: MAC_OS, channelBaseUrl: CHANNEL, publicKey: keys.publicKey, answer }),
    ).toEqual({ kind: 'up_to_date' });
  });

  it('reads macOS versions the way Electron reports them', () => {
    expect(macOsVersion('15.4.1')).toBe('15.4.1');
    expect(macOsVersion(' 26.0 ')).toBe('26.0.0');
    expect(macOsVersion('15')).toBe('15.0.0');
    expect(macOsVersion('15.04')).toBe('15.4.0');
    expect(macOsVersion('')).toBeNull();
  });
});

describe('the downloaded artifact is checked against the manifest before anything opens it', () => {
  it('accepts bytes with the signed size and digest', () => {
    expect(verifyArtifactBytes(manifest(), Buffer.from(artifactBody))).toEqual({ ok: true });
  });

  it('refuses bytes of the wrong length', () => {
    expect(verifyArtifactBytes(manifest(), Buffer.from(`${artifactBody} `))).toEqual({
      ok: false,
      reason: 'update_artifact_size_mismatch',
    });
  });

  it('refuses bytes of the right length and the wrong content', () => {
    const swapped = Buffer.from(artifactBody.split('').reverse().join(''));
    expect(verifyArtifactBytes(manifest(), swapped)).toEqual({
      ok: false,
      reason: 'update_artifact_digest_mismatch',
    });
  });
});

function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (typeof value !== 'object' || value === null) return value;
  const entries = Object.entries(value as Record<string, unknown>).reverse();
  return Object.fromEntries(entries.map(([key, inner]) => [key, reverseKeys(inner)]));
}

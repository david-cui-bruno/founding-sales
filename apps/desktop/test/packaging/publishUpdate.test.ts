import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildManifest, resolveUpdateSigningKey, UPDATE_SIGNING_KEY_VARIABLE } from '../../scripts/publishUpdate.ts';
import { decideUpdate, signManifest, verifyArtifactBytes } from '../../src/main/updateChannel.ts';
import { generateUpdateKeyPair, sha256Hex } from '../support/updateKeys.ts';

/**
 * The publish side, round-tripped against the client side.
 *
 * The valuable case is the last one: a manifest made by the publisher, signed with
 * the publisher's key, and accepted by exactly the function the Mac runs — because
 * a signing format that only the signer agrees with is discovered on somebody's
 * laptop rather than here.
 */

const CHANNEL = 'https://d111111abcdef8.cloudfront.net/';
const artifact = new TextEncoder().encode('a bundle, pretend');

describe('the update-signing key is read from one named variable and never printed', () => {
  it('refuses when the variable is absent or blank', () => {
    expect(resolveUpdateSigningKey({})).toEqual({ kind: 'refused', reason: 'update_signing_key_absent' });
    expect(resolveUpdateSigningKey({ [UPDATE_SIGNING_KEY_VARIABLE]: '  ' })).toEqual({
      kind: 'refused',
      reason: 'update_signing_key_absent',
    });
  });

  it('refuses something that is not a key', () => {
    expect(resolveUpdateSigningKey({ [UPDATE_SIGNING_KEY_VARIABLE]: 'bm90IGEga2V5' })).toEqual({
      kind: 'refused',
      reason: 'update_signing_key_unreadable',
    });
  });

  it('refuses a key of the wrong kind', () => {
    // RSA signs perfectly well and is not what the client verifies with.
    expect(resolveUpdateSigningKey({ [UPDATE_SIGNING_KEY_VARIABLE]: generateRsaDer() })).toEqual({
      kind: 'refused',
      reason: 'update_signing_key_unreadable',
    });
  });

  it('refuses an armoured key, and says so as its own reason', () => {
    // A correct Ed25519 key in the wrong encoding is an operator mistake with an
    // obvious fix, and it deserves a message that is not "unreadable".
    const keys = generateUpdateKeyPair();
    const armoured = ['-----BEGIN', 'PRIVATE KEY-----', keys.privateKey, '-----END', 'PRIVATE KEY-----'].join('\n');
    expect(resolveUpdateSigningKey({ [UPDATE_SIGNING_KEY_VARIABLE]: armoured })).toEqual({
      kind: 'refused',
      reason: 'update_signing_key_not_der',
    });
  });

  it('refuses anything that is not base64 at all', () => {
    expect(resolveUpdateSigningKey({ [UPDATE_SIGNING_KEY_VARIABLE]: 'not a key, not base64 either!' })).toEqual({
      kind: 'refused',
      reason: 'update_signing_key_not_der',
    });
  });

  it('accepts base64 PKCS#8 DER and derives the public half the build embeds', () => {
    const keys = generateUpdateKeyPair();
    expect(resolveUpdateSigningKey({ [UPDATE_SIGNING_KEY_VARIABLE]: keys.privateKey })).toEqual({
      kind: 'key',
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
    });
  });

  it('tolerates the whitespace a copied secret arrives with', () => {
    const keys = generateUpdateKeyPair();
    const outcome = resolveUpdateSigningKey({ [UPDATE_SIGNING_KEY_VARIABLE]: `  ${keys.privateKey}\n` });
    expect(outcome.kind).toBe('key');
    if (outcome.kind !== 'key') throw new Error('unreachable');
    expect(outcome.publicKey).toBe(keys.publicKey);
  });
});

describe('a published manifest is one the client accepts', () => {
  const manifest = buildManifest({
    releaseVersion: '1.5.0',
    commitSha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    channelBaseUrl: CHANNEL,
    artifactName: 'Callie-1.5.0-arm64.zip',
    artifactBytes: artifact,
    now: new Date('2026-09-20T09:00:00.000Z'),
  });

  it('describes the artifact it was built from', () => {
    expect(manifest.artifact.sha256).toBe(sha256Hex(artifact));
    expect(manifest.artifact.sizeBytes).toBe(artifact.byteLength);
    expect(manifest.artifact.url).toBe(`${CHANNEL}releases/darwin-arm64/1.5.0/Callie-1.5.0-arm64.zip`);
    expect(verifyArtifactBytes(manifest, artifact)).toEqual({ ok: true });
  });

  it('is accepted by the client when signed, and only then', () => {
    const keys = generateUpdateKeyPair();
    const signed = signManifest(manifest, keys.privateKey);

    expect(
      decideUpdate({ currentVersion: '1.4.0', channelBaseUrl: CHANNEL, publicKey: keys.publicKey, answer: signed }),
    ).toEqual({ kind: 'available', manifest });

    expect(
      decideUpdate({
        currentVersion: '1.4.0',
        channelBaseUrl: CHANNEL,
        publicKey: generateUpdateKeyPair().publicKey,
        answer: signed,
      }),
    ).toEqual({ kind: 'refused', reason: 'update_signature_invalid' });
  });
});

function generateRsaDer(): string {
  return generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ format: 'der', type: 'pkcs8' })
    .toString('base64');
}

import { createHash, generateKeyPairSync } from 'node:crypto';

/**
 * An update-signing key pair, made when the test runs and thrown away with it.
 *
 * Nothing in this repository holds a private key, and the public half is a build
 * input rather than a committed constant, so the tests have to produce both. A
 * committed key pair would be a key pair someone else could sign a release with.
 */

export interface UpdateKeyPair {
  /** Base64 SPKI DER. This is what a build embeds. */
  readonly publicKey: string;
  /** PKCS#8 PEM. Never leaves the test process. */
  readonly privateKey: string;
}

export function generateUpdateKeyPair(): UpdateKeyPair {
  const pair = generateKeyPairSync('ed25519');
  return {
    publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKey: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  };
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

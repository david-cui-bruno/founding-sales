import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createSign, generateKeyPairSync, createPublicKey, randomBytes, type KeyObject } from 'node:crypto';

/**
 * A local stand-in for Google's OpenID Connect provider.
 *
 * Every key is generated when the stub starts and the issuer is this process's own
 * loopback address, so a test never reaches the network and no real client id, key or
 * token appears anywhere in the tree. It serves the three documents the API reads —
 * the discovery document, the JWKS, and the token endpoint — and nothing else.
 *
 * What a test can do with it: mint an id token with any claims it likes (including
 * wrong ones), rotate the signing key, count how often the JWKS was fetched, and see
 * exactly what the API posted to the token endpoint.
 */

export interface StubKeyPair {
  readonly kid: string;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
}

export interface TokenExchangeRecord {
  readonly grantType: string;
  readonly code: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly clientId: string;
  /** Whether a client secret was presented. The value itself is never recorded. */
  readonly clientSecretPresented: boolean;
}

export interface IdTokenClaims {
  readonly iss?: string;
  readonly aud?: string | readonly string[];
  readonly azp?: string;
  readonly sub?: string;
  readonly email?: string;
  readonly email_verified?: boolean;
  readonly hd?: string;
  readonly name?: string;
  readonly nonce?: string;
  readonly iat?: number;
  readonly exp?: number;
  readonly nbf?: number;
}

export interface GoogleStub {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly discoveryUrl: string;
  readonly jwksFetches: () => number;
  readonly tokenExchanges: () => readonly TokenExchangeRecord[];
  /** Mint a signed id token. Claims given here override the well-formed defaults. */
  signIdToken(claims: IdTokenClaims, options?: { readonly kid?: string; readonly algorithm?: string }): string;
  /** Queue the id token the next token exchange will answer with. */
  nextIdToken(token: string): void;
  /** Register an authorization code the token endpoint will accept exactly once. */
  issueCode(code: string): void;
  /** Replace the published key with a new one, as a real rotation would. */
  rotateKey(): StubKeyPair;
  /** Serve a JWKS that omits every key, so an unknown `kid` is observable. */
  hideKeys(hidden: boolean): void;
  stop(): Promise<void>;
}

const base64url = (value: Buffer | string): string =>
  Buffer.from(value).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

function newKeyPair(): StubKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid: `k-${randomBytes(8).toString('hex')}`, privateKey, publicKey };
}

function jwkOf(pair: StubKeyPair): Record<string, string> {
  const jwk = createPublicKey(pair.publicKey).export({ format: 'jwk' }) as { n?: string; e?: string };
  return { kty: 'RSA', use: 'sig', alg: 'RS256', kid: pair.kid, n: jwk.n ?? '', e: jwk.e ?? '' };
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function startGoogleStub(): Promise<GoogleStub> {
  // Generated per run: no literal client id, secret or key exists in this repository.
  const clientId = `${randomBytes(12).toString('hex')}.apps.googleusercontent.test`;
  const clientSecret = randomBytes(24).toString('base64url');
  let keys: StubKeyPair[] = [newKeyPair()];
  let hidden = false;
  let jwksFetches = 0;
  const codes = new Set<string>();
  const queuedIdTokens: string[] = [];
  const exchanges: TokenExchangeRecord[] = [];
  let issuer = 'http://127.0.0.1';

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const path = new URL(request.url ?? '/', issuer).pathname;
      const send = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
        const payload = JSON.stringify(body);
        response.writeHead(status, { 'content-type': 'application/json', ...headers });
        response.end(payload);
      };
      if (path === '/.well-known/openid-configuration') {
        send(200, {
          issuer,
          authorization_endpoint: `${issuer}/o/oauth2/v2/auth`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          code_challenge_methods_supported: ['S256'],
        });
        return;
      }
      if (path === '/jwks') {
        jwksFetches += 1;
        send(200, { keys: hidden ? [] : keys.map(jwkOf) }, { 'cache-control': 'public, max-age=60' });
        return;
      }
      if (path === '/token') {
        const form = new URLSearchParams(await readBody(request));
        const code = form.get('code') ?? '';
        exchanges.push({
          grantType: form.get('grant_type') ?? '',
          code,
          codeVerifier: form.get('code_verifier') ?? '',
          redirectUri: form.get('redirect_uri') ?? '',
          clientId: form.get('client_id') ?? '',
          clientSecretPresented: (form.get('client_secret') ?? '').length > 0,
        });
        // An authorization code is single use: the second exchange of one Google
        // already answered is `invalid_grant`, exactly as Google answers it.
        if (!codes.delete(code)) {
          send(400, { error: 'invalid_grant' });
          return;
        }
        const idToken = queuedIdTokens.shift();
        if (idToken === undefined) {
          send(500, { error: 'stub_has_no_id_token' });
          return;
        }
        send(200, {
          access_token: randomBytes(16).toString('base64url'),
          token_type: 'Bearer',
          expires_in: 3599,
          id_token: idToken,
        });
        return;
      }
      send(404, { error: 'not_found' });
    })();
  });

  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  issuer = `http://127.0.0.1:${String(address.port)}`;

  const sign = (claims: IdTokenClaims, options: { kid?: string; algorithm?: string } = {}): string => {
    const pair = keys.find(key => key.kid === options.kid) ?? keys[0];
    if (pair === undefined) throw new Error('the stub has no signing key');
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: options.algorithm ?? 'RS256', kid: options.kid ?? pair.kid, typ: 'JWT' };
    const payload = {
      iss: issuer,
      aud: clientId,
      azp: clientId,
      sub: `stub-sub-${randomBytes(8).toString('hex')}`,
      email_verified: true,
      iat: now,
      exp: now + 3600,
      ...claims,
    };
    const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
    if (header.alg === 'none') return `${signingInput}.`;
    const signer = createSign('RSA-SHA256');
    signer.update(signingInput);
    return `${signingInput}.${base64url(signer.sign(pair.privateKey))}`;
  };

  return {
    issuer,
    clientId,
    clientSecret,
    discoveryUrl: `${issuer}/.well-known/openid-configuration`,
    jwksFetches: () => jwksFetches,
    tokenExchanges: () => exchanges,
    signIdToken: sign,
    nextIdToken: token => queuedIdTokens.push(token),
    issueCode: code => codes.add(code),
    rotateKey: () => {
      const pair = newKeyPair();
      keys = [pair];
      return pair;
    },
    hideKeys: value => {
      hidden = value;
    },
    stop: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close(error => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}

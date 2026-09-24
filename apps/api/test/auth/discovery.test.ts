import { createSign, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createGoogleClient,
  handleCallback,
  sha256Hex,
  startSignIn,
  validateIdToken,
  type GoogleOidcConfig,
  type HttpFetch,
  type HttpRequest,
  type HttpResponse,
} from '../../src/auth/index.ts';
import { GOOGLE_OIDC_DISCOVERY_URL, GOOGLE_OIDC_ISSUER } from '../../src/bootstrap/deployment.ts';
import { recordingLogger } from '../../src/bootstrap/log.ts';
import { CURRENT_CLIENT_VERSION, createAuthFixture, stateOf, type AuthFixture } from '../support/authFixture.ts';

/**
 * The discovery rule against Google's real document, and the failures it used to hide.
 *
 * Production's first real sign-in (24 September 2026, release runbook 8.0u) was refused
 * `token_exchange_failed` four times because `discovery()` required every endpoint to
 * share the issuer's origin and Google's document does not: its token endpoint is on
 * `oauth2.googleapis.com` and its key set on `www.googleapis.com`. The loopback provider
 * every other identity test uses serves all three endpoints from its own origin, which is
 * why nothing here noticed. So these tests use the production issuer and discovery URL
 * constants and a document with Google's real hosts, behind an injected `fetch` that
 * reaches nothing.
 */

/** The shape Google publishes at `https://accounts.google.com/.well-known/openid-configuration`. */
const GOOGLE_DISCOVERY_DOCUMENT = Object.freeze({
  issuer: 'https://accounts.google.com',
  authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  device_authorization_endpoint: 'https://oauth2.googleapis.com/device/code',
  token_endpoint: 'https://oauth2.googleapis.com/token',
  userinfo_endpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
  revocation_endpoint: 'https://oauth2.googleapis.com/revoke',
  jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
  response_types_supported: ['code', 'token', 'id_token', 'code token', 'code id_token', 'token id_token', 'none'],
  subject_types_supported: ['public'],
  id_token_signing_alg_values_supported: ['RS256'],
  scopes_supported: ['openid', 'email', 'profile'],
  token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
  code_challenge_methods_supported: ['plain', 'S256'],
  grant_types_supported: [
    'authorization_code',
    'refresh_token',
    'urn:ietf:params:oauth:grant-type:device_code',
    'urn:ietf:params:oauth:grant-type:jwt-bearer',
  ],
});

function productionConfig(): GoogleOidcConfig {
  // Generated per run: no literal client id or secret exists in this repository.
  return {
    issuer: GOOGLE_OIDC_ISSUER,
    discoveryUrl: GOOGLE_OIDC_DISCOVERY_URL,
    clientId: `${randomBytes(12).toString('hex')}.apps.googleusercontent.test`,
    clientSecret: randomBytes(24).toString('base64url'),
    redirectUri: 'https://api.fss.example/auth/google/callback',
    hostedDomain: 'callie.example',
    clockSkewSeconds: 60,
  };
}

interface RecordedRequest {
  readonly url: string;
  readonly request: HttpRequest | undefined;
}

/**
 * A Google that serves `document` at the discovery URL, `token` to any POST, and `keys`
 * as the JWKS at whatever `jwks_uri` the document names.
 */
function fakeGoogle(
  document: Readonly<Record<string, unknown>>,
  token: HttpResponse = { status: 404, headers: {}, body: '' },
  keys: readonly Readonly<Record<string, string>>[] = [],
): { readonly fetch: HttpFetch; readonly requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetch: HttpFetch = (url, request) => {
    requests.push({ url, request });
    if (url === GOOGLE_OIDC_DISCOVERY_URL) {
      return Promise.resolve({
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' },
        body: JSON.stringify(document),
      });
    }
    if (request?.method === 'POST') return Promise.resolve(token);
    if (url === document['jwks_uri']) {
      return Promise.resolve({
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' },
        body: JSON.stringify({ keys }),
      });
    }
    return Promise.resolve({ status: 404, headers: {}, body: '' });
  };
  return { fetch, requests };
}

const json = (status: number, body: unknown): HttpResponse => ({
  status,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const now = (): Date => new Date('2026-09-24T04:20:00Z');

describe("Google's real discovery document (24 September 2026)", () => {
  it('accepts the document, whose token endpoint and key set are on googleapis.com hosts', async () => {
    const google = fakeGoogle(GOOGLE_DISCOVERY_DOCUMENT);
    const client = createGoogleClient({ fetch: google.fetch, now });

    expect(await client.discovery(productionConfig())).toEqual({
      issuer: 'https://accounts.google.com',
      authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
    });
  });

  it('exchanges the code at https://oauth2.googleapis.com/token and returns the id token', async () => {
    const idToken = `${randomUUID()}.${randomUUID()}.${randomUUID()}`;
    const google = fakeGoogle(
      GOOGLE_DISCOVERY_DOCUMENT,
      json(200, { access_token: randomUUID(), token_type: 'Bearer', expires_in: 3599, id_token: idToken }),
    );
    const client = createGoogleClient({ fetch: google.fetch, now });
    const config = productionConfig();

    const result = await client.exchangeCode(config, { code: `code-${randomUUID()}`, codeVerifier: randomUUID() });

    expect(result).toEqual({ ok: true, idToken });
    const posts = google.requests.filter(entry => entry.request?.method === 'POST');
    expect(posts.map(entry => entry.url)).toEqual(['https://oauth2.googleapis.com/token']);
    const form = new URLSearchParams(posts[0]?.request?.body ?? '');
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('redirect_uri')).toBe(config.redirectUri);
  });
});

describe('a discovery document that sends the client anywhere else is still refused', () => {
  const elsewhere = [
    ['an attacker host', 'https://evil.example/token'],
    ['a googleapis.com host over plain HTTP', 'http://oauth2.googleapis.com/token'],
    ['the issuer host over plain HTTP', 'http://accounts.google.com/token'],
    ['a host that only starts with a googleapis.com name', 'https://oauth2.googleapis.com.evil.example/token'],
    ['a host that ends in googleapis.com without the dot', 'https://evilgoogleapis.com/token'],
    ['googleapis.com in the path', 'https://evil.example/.googleapis.com/token'],
    ['googleapis.com as userinfo', 'https://oauth2.googleapis.com@evil.example/token'],
    ['something that is not a URL', 'not a url'],
  ] as const;

  for (const [what, tokenEndpoint] of elsewhere) {
    it(`refuses a token endpoint on ${what}, and never posts the code to it`, async () => {
      const google = fakeGoogle({ ...GOOGLE_DISCOVERY_DOCUMENT, token_endpoint: tokenEndpoint }, json(200, {}));
      const client = createGoogleClient({ fetch: google.fetch, now });
      const config = productionConfig();

      expect(await client.discovery(config)).toBeNull();
      expect(await client.exchangeCode(config, { code: `code-${randomUUID()}`, codeVerifier: randomUUID() })).toEqual({
        ok: false,
        idToken: null,
        reason: 'discovery_unavailable',
        providerError: null,
      });
      expect(google.requests.filter(entry => entry.request?.method === 'POST')).toEqual([]);
    });
  }

  it('refuses a key set or an authorization endpoint on an attacker host', async () => {
    for (const override of [
      { jwks_uri: 'https://evil.example/certs' },
      { authorization_endpoint: 'https://evil.example/o/oauth2/v2/auth' },
    ]) {
      const google = fakeGoogle({ ...GOOGLE_DISCOVERY_DOCUMENT, ...override });
      expect(await createGoogleClient({ fetch: google.fetch, now }).discovery(productionConfig())).toBeNull();
    }
  });

  it('refuses a document for another issuer even when every endpoint is on a Google host', async () => {
    for (const issuer of ['https://evil.example', 'https://accounts.google.com.evil.example', 'http://accounts.google.com']) {
      const google = fakeGoogle({ ...GOOGLE_DISCOVERY_DOCUMENT, issuer });
      expect(await createGoogleClient({ fetch: google.fetch, now }).discovery(productionConfig())).toBeNull();
    }
  });
});

describe('a failed token exchange says why', () => {
  const exchange = async (token: HttpResponse): Promise<unknown> => {
    const google = fakeGoogle(GOOGLE_DISCOVERY_DOCUMENT, token);
    return await createGoogleClient({ fetch: google.fetch, now }).exchangeCode(productionConfig(), {
      code: `code-${randomUUID()}`,
      codeVerifier: randomUUID(),
    });
  };

  it("surfaces Google's error code on a 400, and nothing else from the body", async () => {
    const result = await exchange(json(400, { error: 'invalid_grant', error_description: 'Malformed auth code.' }));
    expect(result).toEqual({
      ok: false,
      idToken: null,
      reason: 'token_endpoint_status_400',
      providerError: 'invalid_grant',
    });
    expect(JSON.stringify(result)).not.toContain('Malformed');
  });

  it('gives the status and no provider code when the error body is not JSON', async () => {
    expect(await exchange({ status: 502, headers: {}, body: '<html>Bad Gateway</html>' })).toEqual({
      ok: false,
      idToken: null,
      reason: 'token_endpoint_status_502',
      providerError: null,
    });
  });

  it('does not pass on an error field that is not shaped like a code', async () => {
    expect(await exchange(json(401, { error: 'a sentence with spaces and a " quote' }))).toMatchObject({
      reason: 'token_endpoint_status_401',
      providerError: null,
    });
  });

  it('calls a 200 without an id token id_token_absent', async () => {
    expect(await exchange(json(200, { access_token: randomUUID(), token_type: 'Bearer' }))).toEqual({
      ok: false,
      idToken: null,
      reason: 'id_token_absent',
      providerError: null,
    });
  });
});

describe('the id token issuer, in both forms Google documents', () => {
  // Google's validation guide: `iss` "is equal to accounts.google.com or
  // https://accounts.google.com". The key set is served from Google's real
  // www.googleapis.com host, through the real discovery document, so this is the whole
  // path a genuine token takes after the exchange.
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = `k-${randomBytes(8).toString('hex')}`;
  const exported = publicKey.export({ format: 'jwk' }) as { n?: string; e?: string };
  const jwk = { kty: 'RSA', use: 'sig', alg: 'RS256', kid, n: exported.n ?? '', e: exported.e ?? '' };
  const config = productionConfig();
  const nonce = randomUUID();
  const subject = '109876543210987654321';
  const client = createGoogleClient({ fetch: fakeGoogle(GOOGLE_DISCOVERY_DOCUMENT, undefined, [jwk]).fetch, now });

  const segment = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  const tokenFrom = (iss: string): string => {
    const issuedAt = Math.floor(now().getTime() / 1000);
    const signingInput = `${segment({ alg: 'RS256', kid, typ: 'JWT' })}.${segment({
      iss,
      aud: config.clientId,
      azp: config.clientId,
      sub: subject,
      email: 'callie@callie.example',
      email_verified: true,
      hd: 'callie.example',
      nonce,
      iat: issuedAt,
      exp: issuedAt + 3600,
    })}`;
    const signer = createSign('RSA-SHA256');
    signer.update(signingInput);
    return `${signingInput}.${signer.sign(privateKey).toString('base64url')}`;
  };
  const validate = async (iss: string): Promise<unknown> =>
    await validateIdToken({
      token: tokenFrom(iss),
      config,
      google: client,
      now: now(),
      expectedNonceHash: sha256Hex(nonce),
    });

  for (const iss of ['https://accounts.google.com', 'accounts.google.com']) {
    it(`accepts a token whose iss is ${iss}`, async () => {
      expect(await validate(iss)).toMatchObject({ valid: true, claims: { subject, hostedDomain: 'callie.example' } });
    });
  }

  for (const iss of [
    'https://accounts.google.com.evil.example',
    'accounts.google.com.evil.example',
    'http://accounts.google.com',
    'https://accounts.google.com/',
    'ACCOUNTS.GOOGLE.COM',
    'https://evil.example',
  ]) {
    it(`refuses a token whose iss is ${iss} as issuer_mismatch`, async () => {
      expect(await validate(iss)).toEqual({ valid: false, refusal: 'issuer_mismatch' });
    });
  }
});

describe('sign-in logs what it used to swallow', () => {
  let fixture: AuthFixture;

  beforeAll(async () => {
    fixture = await createAuthFixture();
  });

  afterAll(async () => {
    await fixture.stop();
  });

  it('logs oidc_discovery_unavailable, once, when start falls back', async () => {
    const log = recordingLogger();
    const unreachable: HttpFetch = () => Promise.resolve({ status: 503, headers: {}, body: '' });
    const deps = { ...fixture.deps, google: createGoogleClient({ fetch: unreachable, now: fixture.deps.now }), log };

    const started = await startSignIn(deps, {
      workspaceId: fixture.alpha.workspaceId,
      deviceLabel: fixture.collidingDeviceLabel,
      clientVersion: CURRENT_CLIENT_VERSION,
    });

    expect(started.started).toBe(true);
    if (!started.started) return;
    expect(started.authorizationUrl.startsWith(`${fixture.deps.config.oidc.issuer}/o/oauth2/v2/auth?`)).toBe(true);
    expect(log.lines).toEqual([
      expect.objectContaining({
        level: 'warn',
        event: 'oidc_discovery_unavailable',
        step: 'sign_in_start',
        fallback: 'authorization_endpoint',
      }),
    ]);
  });

  it('logs nothing at start when discovery answers', async () => {
    const log = recordingLogger();
    const started = await startSignIn(
      { ...fixture.deps, log },
      {
        workspaceId: fixture.alpha.workspaceId,
        deviceLabel: fixture.collidingDeviceLabel,
        clientVersion: CURRENT_CLIENT_VERSION,
      },
    );
    expect(started.started).toBe(true);
    expect(log.lines).toEqual([]);
  });

  it('logs one token_exchange_failed with the reason, and never the code, the verifier or the secret', async () => {
    const log = recordingLogger();
    const deps = { ...fixture.deps, log };
    const started = await startSignIn(deps, {
      workspaceId: fixture.alpha.workspaceId,
      deviceLabel: fixture.collidingDeviceLabel,
      clientVersion: CURRENT_CLIENT_VERSION,
    });
    if (!started.started) throw new Error(`sign-in did not start: ${started.refusal}`);

    // A code the provider never issued: it answers `invalid_grant`, as Google does.
    const code = `code-${randomUUID()}`;
    const state = stateOf(started.authorizationUrl);
    const outcome = await handleCallback(deps, { state, code });

    expect(outcome).toEqual({ authenticated: false, refusal: 'token_exchange_failed' });
    const failures = log.lines.filter(line => line['event'] === 'token_exchange_failed');
    expect(failures).toEqual([
      expect.objectContaining({
        level: 'warn',
        reason: 'token_endpoint_status_400',
        provider_error: 'invalid_grant',
      }),
    ]);
    expect(log.lines).toHaveLength(1);

    const verifier = fixture.google.tokenExchanges().find(entry => entry.code === code)?.codeVerifier ?? '';
    expect(verifier.length).toBeGreaterThan(0);
    const written = JSON.stringify(log.lines);
    for (const secret of [code, state, verifier, fixture.deps.config.oidc.clientSecret, started.handoffSecret]) {
      expect(written).not.toContain(secret);
    }
  });
});

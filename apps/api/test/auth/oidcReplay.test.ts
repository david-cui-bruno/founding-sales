import { createSign, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AUTH_REFUSAL_CODES } from '@fss/contracts';
import { createGoogleClient, type GoogleClient, type HttpFetch } from '../../src/auth/googleClient.ts';
import { validateIdToken } from '../../src/auth/idToken.ts';
import { sha256Hex } from '../../src/auth/tokens.ts';
import {
  DEPLOYMENT_ENVIRONMENT_VARIABLES,
  GOOGLE_OIDC_DISCOVERY_URL,
  GOOGLE_OIDC_ISSUER,
  readApiDeployment,
} from '../../src/bootstrap/deployment.ts';

/**
 * Appendix G 23: "OIDC state, nonce, code and token-audience replay are refused."
 *
 * The API auth suite replays all four against a real Google fake: a state already
 * consumed, a nonce belonging to a different authorization request, a code Google
 * answers `invalid_grant` for, and an id token minted for another audience or
 * another authorized party. This check adds the validator's own shape — the order it
 * checks things in, and the fact that each of the four has a refusal code of its own.
 *
 * ## The vacuous-pass trap
 *
 * Replaying against an expired request is refused for expiry, not for replay, and
 * the two are indistinguishable from outside unless the codes differ. The lane test
 * closes it by replaying inside the validity window. This file closes the code-set
 * half: `authorization_request_unknown` and `authorization_request_expired` are
 * asserted to be two codes, so a rewrite that answered both with one would make the
 * lane test unable to tell what it had proved. The second `it` closes a nastier
 * variant — a token whose claims are read before its signature is verified would
 * report `audience_mismatch` for an unsigned forgery and look like a correct
 * refusal.
 */

describe('Appendix G 23: each replay is refused for being that replay', () => {
  it('gives replay and expiry separate codes, and gives each of the four its own', () => {
    for (const code of [
      'authorization_request_unknown',
      'authorization_request_expired',
      'nonce_mismatch',
      'audience_mismatch',
      'authorized_party_mismatch',
      'token_exchange_failed',
    ] as const) {
      expect(AUTH_REFUSAL_CODES).toContain(code);
    }
    expect(new Set(AUTH_REFUSAL_CODES).size).toBe(AUTH_REFUSAL_CODES.length);
  });
});

/**
 * The release gate G12b added: every refusal above is dead code in a deployment
 * that has no sign-in at all.
 *
 * G12 shipped `ApiOptions.auth` deliberately absent — an API that serves
 * `/healthz`, `/readyz` and the client-version notice and refuses everything
 * else. That is the right answer for a build with no Google configuration and
 * the wrong one for production, where it is a deployment nobody can sign in
 * to, reached by omission and visible only to whoever reads the startup line.
 * So a live deployment builds identity or refuses to start.
 *
 * ## The vacuous-pass trap
 *
 * Four refusals in a row prove nothing if the environment they start from was
 * already unusable for some fifth reason — every case would pass against a
 * reader that threw unconditionally. The positive control is first: the
 * complete live environment yields a configured sign-in with the redirect URI
 * fixed by hostname. Each later case removes exactly one thing from that same
 * environment, and the last one asserts the *wiring* rather than the reader,
 * because a bootstrap that built `auth` and never handed it to the server
 * would satisfy every other assertion here.
 */
describe('Appendix G 23: a production API cannot run without sign-in configured', () => {
  const V = DEPLOYMENT_ENVIRONMENT_VARIABLES;

  const loadKms = async (): Promise<never> =>
    await Promise.resolve({ generateDataKey: async () => ({}), decrypt: async () => ({}) } as never);
  const putObject = async (): Promise<'written'> => await Promise.resolve('written');

  function productionEnvironment(
    overrides: Record<string, string | undefined> = {},
  ): Record<string, string | undefined> {
    return {
      [V.environmentName]: 'production',
      [V.dependencies]: 'live',
      [V.region]: 'us-east-1',
      [V.publicOrigin]: 'https://api.example.test',
      [V.envelopeKeyId]: 'arn:aws:kms:us-east-1:000000000000:key/example',
      [V.journalBucket]: 'fss-prod-suppression-journal',
      [V.pushAudience]: 'https://api.example.test/integrations/gmail/push',
      [V.pushServiceAccount]: 'push@example.iam.gserviceaccount.test',
      [V.pushTopic]: 'projects/example/topics/example-gmail-push',
      [V.hostedDomain]: 'example.test',
      [V.sendingEnabled]: 'false',
      [V.upgradeUrl]: 'https://updates.example.test/releases/darwin-arm64/latest.json',
      // Generated when the test runs. Nothing in this file is a credential.
      [V.sessionSigningKey]: randomBytes(48).toString('base64'),
      [V.gmailOAuthClient]: JSON.stringify({
        client_id: 'gmail.apps.googleusercontent.test',
        client_secret: randomBytes(24).toString('hex'),
      }),
      [V.oidcClient]: JSON.stringify({
        client_id: 'signin.apps.googleusercontent.test',
        client_secret: randomBytes(24).toString('hex'),
      }),
      ...overrides,
    };
  }

  it('the positive control: a complete production environment has sign-in', async () => {
    const deployment = await readApiDeployment(productionEnvironment(), { loadKms, putObject });
    expect(deployment.signInSource).toBe('google');
    expect(deployment.auth?.oidc.redirectUri).toBe('https://api.example.test/auth/google/callback');
    expect(deployment.auth?.oidc.hostedDomain).toBe('example.test');
    expect(deployment.auth?.oidc.issuer).toBe('https://accounts.google.com');
  });

  for (const [what, missing] of [
    ['the sign-in client', V.oidcClient],
    ['the session signing key', V.sessionSigningKey],
    ['the Workspace domain', V.hostedDomain],
    ['the public origin the redirect is derived from', V.publicOrigin],
  ] as const) {
    it(`refuses to start without ${what}`, async () => {
      await expect(
        readApiDeployment(productionEnvironment({ [missing]: undefined }), { loadKms, putObject }),
      ).rejects.toThrow();
    });
  }

  it('cannot reach the no-sign-in branch by omission, because production refuses every other switch', async () => {
    for (const [value, code] of [
      [undefined, 'DEPENDENCIES_UNSET'],
      ['none', 'PRODUCTION_REQUIRES_LIVE'],
      ['recorded', 'PRODUCTION_REQUIRES_LIVE'],
    ] as const) {
      await expect(
        readApiDeployment(productionEnvironment({ [V.dependencies]: value }), { loadKms, putObject }),
      ).rejects.toMatchObject({ code });
    }
  });

  it('restricts sign-in to the same Workspace domain the mailbox check uses', async () => {
    const deployment = await readApiDeployment(
      productionEnvironment({ [V.hostedDomain]: 'one-domain.test' }),
      { loadKms, putObject },
    );
    expect(deployment.auth?.oidc.hostedDomain).toBe('one-domain.test');
    expect(deployment.mailConfig?.hostedDomain).toBe('one-domain.test');
  });
});

/**
 * The release gate the first real sign-in added (24 September 2026, runbook 8.0u): the
 * API accepts Google's own discovery document.
 *
 * Production refused its first four real sign-ins `token_exchange_failed` because
 * `discovery()` required every endpoint to share the issuer's origin, and Google's
 * document puts the token endpoint on `oauth2.googleapis.com` and the key set on
 * `www.googleapis.com`. The rehearsal never talks to Google and the lane tests' local
 * provider serves everything from one origin, so nothing before production could see it.
 * This asserts the rule against Google's real hosts, with the production issuer and
 * discovery URL constants, behind a `fetch` that reaches nothing.
 *
 * ## The vacuous-pass trap
 *
 * Each half is the other's control. A client that refused every document would pass the
 * refusal case, and one that accepted every document would pass the positive case; only
 * the rule itself passes both. The refusal case moves exactly one field of the same
 * document, so it cannot be refused for some other reason.
 */
describe("Appendix G 23: the API accepts Google's own discovery document", () => {
  const googleDocument = {
    issuer: 'https://accounts.google.com',
    authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    token_endpoint: 'https://oauth2.googleapis.com/token',
    userinfo_endpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
    revocation_endpoint: 'https://oauth2.googleapis.com/revoke',
    jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
  };

  const oidc = {
    issuer: GOOGLE_OIDC_ISSUER,
    discoveryUrl: GOOGLE_OIDC_DISCOVERY_URL,
    clientId: 'signin.apps.googleusercontent.test',
    // Generated when the test runs. Nothing in this file is a credential.
    clientSecret: randomBytes(24).toString('hex'),
    redirectUri: 'https://api.example.test/auth/google/callback',
    hostedDomain: 'example.test',
    clockSkewSeconds: 60,
  };

  const serving = (document: Record<string, string>): HttpFetch => url =>
    Promise.resolve(
      url === GOOGLE_OIDC_DISCOVERY_URL
        ? { status: 200, headers: {}, body: JSON.stringify(document) }
        : { status: 404, headers: {}, body: '' },
    );

  it("the positive control: Google's token endpoint and key set hosts are accepted", async () => {
    const client = createGoogleClient({ fetch: serving(googleDocument), now: () => new Date() });
    expect(await client.discovery(oidc)).toMatchObject({
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
    });
  });

  it('a token endpoint on another host, or on a Google host over plain HTTP, is refused', async () => {
    for (const tokenEndpoint of ['https://evil.example/token', 'http://oauth2.googleapis.com/token']) {
      const client = createGoogleClient({
        fetch: serving({ ...googleDocument, token_endpoint: tokenEndpoint }),
        now: () => new Date(),
      });
      expect(await client.discovery(oidc), tokenEndpoint).toBeNull();
    }
  });

  /**
   * The second Google-side check a first real sign-in reaches: the id token's `iss`.
   * Google documents two forms, `https://accounts.google.com` and `accounts.google.com`,
   * and an exact comparison with the configured issuer refuses the second. The validator
   * accepts the configured issuer with and without its `https://` scheme and nothing
   * else. The vacuous-pass trap is the same pairing as above: a validator that accepted
   * any issuer passes the positive half, one that refused the short form passes the
   * negative half, and every token here is otherwise valid, so a refusal can only be the
   * issuer's.
   */
  it("accepts both forms of Google's issuer in an id token, and nothing near them", async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const google: GoogleClient = {
      ...createGoogleClient({ fetch: serving(googleDocument), now: () => new Date() }),
      signingKey: async () => await Promise.resolve(publicKey),
    };
    const nonce = randomUUID();
    const segment = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
    const outcomeFor = async (iss: string): Promise<unknown> => {
      const issuedAt = Math.floor(Date.now() / 1000);
      const signingInput = `${segment({ alg: 'RS256', kid: 'release-check', typ: 'JWT' })}.${segment({
        iss,
        aud: oidc.clientId,
        sub: '109876543210987654321',
        email: 'admin@example.test',
        email_verified: true,
        hd: oidc.hostedDomain,
        nonce,
        iat: issuedAt,
        exp: issuedAt + 3600,
      })}`;
      const signer = createSign('RSA-SHA256');
      signer.update(signingInput);
      const token = `${signingInput}.${signer.sign(privateKey).toString('base64url')}`;
      return await validateIdToken({ token, config: oidc, google, now: new Date(), expectedNonceHash: sha256Hex(nonce) });
    };

    for (const iss of ['https://accounts.google.com', 'accounts.google.com']) {
      expect(await outcomeFor(iss), iss).toMatchObject({ valid: true });
    }
    for (const iss of ['https://accounts.google.com.evil.example', 'http://accounts.google.com', 'https://evil.example']) {
      expect(await outcomeFor(iss), iss).toEqual({ valid: false, refusal: 'issuer_mismatch' });
    }
  });
});

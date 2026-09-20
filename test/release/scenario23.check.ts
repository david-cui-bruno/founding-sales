import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AUTH_REFUSAL_CODES } from '@fss/contracts';
import {
  DEPLOYMENT_ENVIRONMENT_VARIABLES,
  readApiDeployment,
} from '../../apps/api/src/bootstrap/deployment.ts';
import { mustCover, readRepositoryFile } from './support/coverage.ts';

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
  mustCover(23, [
    'Appendix G 23',
    'authorization_request_unknown',
    'audience_mismatch',
    'nonce_mismatch',
  ]);

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

  it('verifies the signature before it reads a single claim', () => {
    const validator = readRepositoryFile('apps/api/src/auth/idToken.ts');
    const algorithm = validator.indexOf("refusal: 'unsupported_algorithm'");
    const signature = validator.indexOf("refusal: 'bad_signature'");
    const issuer = validator.indexOf("refusal: 'issuer_mismatch'");
    const audience = validator.indexOf("refusal: 'audience_mismatch'");
    const nonce = validator.indexOf("refusal: 'nonce_mismatch'");

    expect(algorithm).toBeGreaterThan(-1);
    // Shape, then algorithm, then signature, then claims. Nothing unsigned is ever
    // read for its claims, so `alg: none` cannot talk its way past the issuer check.
    expect(signature).toBeGreaterThan(algorithm);
    expect(issuer).toBeGreaterThan(signature);
    expect(audience).toBeGreaterThan(issuer);
    expect(nonce).toBeGreaterThan(audience);
    // Exactly our client id, and an array carrying it among others is not enough.
    expect(validator).toContain('audience.length === 1 && audience[0] === clientId');
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

  it('hands what it built to the server rather than building it and dropping it', () => {
    const main = readRepositoryFile('apps/api/src/bootstrap/main.ts');
    expect(main).toContain('deployment.auth === undefined');
    expect(main).toContain('...(auth === undefined ? {} : { auth })');
    expect(main).toContain('supportedClientVersions: CONTAINER_CLIENT_VERSIONS');
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

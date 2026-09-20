import { createSign, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PUSH_TOKEN_POLICY, decidePushToken, type HttpFetch } from '@fss/domain/mail';
import {
  DEPLOYMENT_ENVIRONMENT_VARIABLES,
  DeploymentConfigError,
  GOOGLE_OIDC_CERTS_URL,
  describeDeployment,
  googleOidcPushTokenVerifier,
  readApiDeployment,
  readSigningKey,
} from '../src/bootstrap/deployment.ts';
import { JournalConfigurationError } from '../src/journal/index.ts';

/**
 * The credentialed API bootstrap and the two defaults it must never reach.
 *
 * `ApiOptions.suppressionJournal` falls back to `localNoopSuppressionJournal()` and
 * `ApiOptions.mail` may be absent; both are right for a route test and wrong for
 * production. The release gate is that a *live* deployment cannot get either by
 * omission — `requireDurableJournal` throws and every missing Gmail part is a named
 * refusal.
 *
 * ## The vacuous-pass trap, named
 *
 * A refusal test proves nothing if the environment it starts from was already
 * unusable. The first test here builds the complete live deployment and asserts it
 * produced a durable journal, an HTTPS Gmail client, a KMS envelope and a Google JWKS
 * verifier; every later case removes exactly one thing from that same environment.
 *
 * Key material is generated when the test runs. Nothing in this file is a credential,
 * and no PEM armour line appears anywhere (G13a's lesson).
 */

const V = DEPLOYMENT_ENVIRONMENT_VARIABLES;

function liveEnvironment(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    [V.environmentName]: 'production',
    [V.dependencies]: 'live',
    [V.region]: 'us-east-1',
    [V.publicOrigin]: 'https://api.example.test/',
    [V.envelopeKeyId]: 'arn:aws:kms:us-east-1:000000000000:key/example',
    [V.journalBucket]: 'fss-prod-suppression-journal',
    [V.pushAudience]: 'https://api.example.test/integrations/gmail/push',
    [V.pushServiceAccount]: 'fss-prod-gmail-push@example.iam.gserviceaccount.test',
    [V.sendingEnabled]: 'false',
    [V.sessionSigningKey]: randomBytes(48).toString('base64'),
    [V.gmailOAuthClient]: JSON.stringify({
      client_id: 'example.apps.googleusercontent.test',
      client_secret: randomBytes(24).toString('hex'),
      push_topic: 'projects/example/topics/fss-prod-gmail-push',
      hosted_domain: 'example.test',
    }),
    ...overrides,
  };
}

const loadKms = async (): Promise<never> =>
  await Promise.resolve({ generateDataKey: async () => ({}), decrypt: async () => ({}) } as never);

const putObject = async (): Promise<'written'> => await Promise.resolve('written');

describe('the live API deployment', () => {
  it('has a durable journal, an https Gmail client, a KMS envelope and Google key verification', async () => {
    const deployment = await readApiDeployment(liveEnvironment(), { loadKms, putObject });
    expect(deployment.journalDescription).toBe('s3');
    expect(deployment.gmailSource).toBe('https');
    expect(deployment.envelopeSource).toBe('kms');
    expect(deployment.pushVerifierSource).toBe('google_jwks');
    expect(deployment.mail).toBeDefined();
    // The redirect is derived from the origin, with the trailing slash removed, so it
    // equals the URI registered with Google exactly.
    expect(deployment.mailConfig?.redirectUri).toBe('https://api.example.test/oauth/gmail/callback');
    expect(deployment.sendingEnabled).toBe(false);
  });

  it('refuses to start rather than journal into a no-op', async () => {
    // The bucket is named but no credentialed put was supplied: `resolveSuppressionJournal`
    // would hand back the local no-op, and `requireDurableJournal` refuses it. This is
    // the exact accident the coordinator's note names.
    await expect(readApiDeployment(liveEnvironment(), { loadKms })).rejects.toBeInstanceOf(
      JournalConfigurationError,
    );
  });

  it('refuses to start with no journal bucket at all', async () => {
    await expect(
      readApiDeployment(liveEnvironment({ [V.journalBucket]: undefined }), { loadKms, putObject }),
    ).rejects.toBeInstanceOf(JournalConfigurationError);
  });

  for (const missing of [
    V.region,
    V.publicOrigin,
    V.envelopeKeyId,
    V.pushAudience,
    V.pushServiceAccount,
    V.gmailOAuthClient,
    V.sessionSigningKey,
  ]) {
    it(`refuses to start when ${missing} is absent`, async () => {
      await expect(
        readApiDeployment(liveEnvironment({ [missing]: undefined }), { loadKms, putObject }),
      ).rejects.toBeInstanceOf(DeploymentConfigError);
    });
  }

  it('reads 16.2 deployment flag rather than reporting a literal false', async () => {
    const deployment = await readApiDeployment(liveEnvironment({ [V.sendingEnabled]: 'true' }), {
      loadKms,
      putObject,
    });
    expect(deployment.sendingEnabled).toBe(true);
  });

  it('refuses a sending flag that is neither true nor false', async () => {
    await expect(
      readApiDeployment(liveEnvironment({ [V.sendingEnabled]: 'yes' }), { loadKms, putObject }),
    ).rejects.toBeInstanceOf(DeploymentConfigError);
  });
});

describe('a production API can never reach the unconfigured branch', () => {
  for (const [value, code] of [
    [undefined, 'DEPENDENCIES_UNSET'],
    ['none', 'PRODUCTION_REQUIRES_LIVE'],
    ['recorded', 'PRODUCTION_REQUIRES_LIVE'],
    ['whatever', 'DEPENDENCIES_INVALID'],
  ] as const) {
    it(`refuses ${value ?? 'an unset switch'}`, async () => {
      await expect(
        readApiDeployment(liveEnvironment({ [V.dependencies]: value }), { loadKms, putObject }),
      ).rejects.toMatchObject({ code });
    });
  }

  it('a rehearsal must name its own push verifier rather than inherit one', async () => {
    await expect(
      readApiDeployment(
        liveEnvironment({ [V.environmentName]: 'rehearsal', [V.dependencies]: 'recorded' }),
        { loadKms, putObject },
      ),
    ).rejects.toBeInstanceOf(DeploymentConfigError);
  });

  it('a rehearsal with a named verifier uses the recorded client and a local key', async () => {
    const deployment = await readApiDeployment(
      liveEnvironment({ [V.environmentName]: 'rehearsal', [V.dependencies]: 'recorded' }),
      { loadKms, putObject, pushVerifier: { verify: async () => await Promise.resolve(null) } },
    );
    expect(deployment.gmailSource).toBe('recorded');
    expect(deployment.envelopeSource).toBe('local');
    expect(deployment.pushVerifierSource).toBe('fixture');
  });
});

describe('the signing key format', () => {
  it('refuses PEM by name', () => {
    // Deliberately not a real armour line: the string is assembled so this file never
    // contains one, which is what the history scan flags for ever.
    const armour = ['-', '-', '-', '-', '-'].join('') + 'BEGIN SOMETHING';
    expect(() => readSigningKey(armour, V.sessionSigningKey)).toThrow(/PEM/u);
  });

  it('refuses something too short to be a key', () => {
    expect(() => readSigningKey(randomBytes(8).toString('base64'), V.sessionSigningKey)).toThrow(
      DeploymentConfigError,
    );
  });

  it('accepts 32 bytes or more of base64', () => {
    expect(readSigningKey(randomBytes(32).toString('base64'), V.sessionSigningKey)).toHaveLength(32);
  });
});

describe('the Google key-set push verifier', () => {
  const base64url = (value: Buffer | string): string =>
    (typeof value === 'string' ? Buffer.from(value, 'utf8') : value).toString('base64url');

  function signedToken(privateKey: KeyObject): string {
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const nowSeconds = Math.floor(Date.now() / 1000);
    const payload = base64url(
      JSON.stringify({
        iss: 'https://accounts.google.com',
        aud: 'https://api.example.test/integrations/gmail/push',
        email: 'fss-prod-gmail-push@example.iam.gserviceaccount.test',
        email_verified: true,
        exp: nowSeconds + 600,
        iat: nowSeconds,
      }),
    );
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${payload}`, 'utf8');
    return `${header}.${payload}.${signer.sign(privateKey).toString('base64url')}`;
  }

  function certsFetch(jwks: unknown): HttpFetch {
    return async url => {
      expect(url).toBe(GOOGLE_OIDC_CERTS_URL);
      return await Promise.resolve({ status: 200, headers: {}, body: JSON.stringify(jwks) });
    };
  }

  it('accepts a token signed by any key in the set, and the claims still decide', async () => {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = pair.publicKey.export({ format: 'jwk' });
    const decoy = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'jwk' });
    const verifier = googleOidcPushTokenVerifier({ fetch: certsFetch({ keys: [decoy, jwk] }) });

    const claims = await verifier.verify(signedToken(pair.privateKey));
    expect(claims).not.toBeNull();
    // Appendix G 27: a valid Google signature is not an accepted notification.
    expect(
      decidePushToken(
        claims!,
        {
          ...DEFAULT_PUSH_TOKEN_POLICY,
          audience: 'https://api.example.test/integrations/gmail/push',
          serviceAccountEmail: 'fss-prod-gmail-push@example.iam.gserviceaccount.test',
        },
        Math.floor(Date.now() / 1000),
      ).accepted,
    ).toBe(true);
    expect(
      decidePushToken(
        claims!,
        {
          ...DEFAULT_PUSH_TOKEN_POLICY,
          audience: 'https://api.example.test/somewhere/else',
          serviceAccountEmail: 'fss-prod-gmail-push@example.iam.gserviceaccount.test',
        },
        Math.floor(Date.now() / 1000),
      ),
    ).toEqual({ accepted: false, refusal: 'audience_mismatch' });
  });

  it('refuses a token signed by a key that is not in the set', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const published = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'jwk' });
    const verifier = googleOidcPushTokenVerifier({ fetch: certsFetch({ keys: [published] }) });
    expect(await verifier.verify(signedToken(other.privateKey))).toBeNull();
  });

  it('refuses everything when the key set cannot be fetched', async () => {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const verifier = googleOidcPushTokenVerifier({
      fetch: async () => await Promise.resolve({ status: 503, headers: {}, body: '' }),
    });
    expect(await verifier.verify(signedToken(pair.privateKey))).toBeNull();
  });
});

describe('the startup line', () => {
  it('names the parts and no value', async () => {
    const secret = `zz-${randomBytes(12).toString('hex')}-zz`;
    const deployment = await readApiDeployment(
      liveEnvironment({
        [V.gmailOAuthClient]: JSON.stringify({
          client_id: 'example.apps.googleusercontent.test',
          client_secret: secret,
          push_topic: 'projects/example/topics/fss-prod-gmail-push',
          hosted_domain: 'example.test',
        }),
      }),
      { loadKms, putObject },
    );
    const described = JSON.stringify(describeDeployment(deployment));
    expect(described).not.toContain(secret);
    expect(JSON.parse(described)).toMatchObject({
      dependencies: 'live',
      gmail_client: 'https',
      envelope_key: 'kms',
      push_verifier: 'google_jwks',
      journal: 's3',
      sending_enabled: false,
    });
  });
});

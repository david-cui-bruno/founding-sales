import { createSign, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type HttpFetch } from '@fss/domain/mail/gmailClientHttp.ts';
import { DEFAULT_PUSH_TOKEN_POLICY, decidePushToken } from '@fss/domain/mail/pushToken.ts';
import type { GoogleClient } from '../src/auth/googleClient.ts';
import {
  DEPLOYMENT_ENVIRONMENT_VARIABLES,
  DeploymentConfigError,
  GOOGLE_OIDC_CERTS_URL,
  describeDeployment,
  googleOidcPushTokenVerifier,
  readApiDeployment,
  readSigningKey,
  readUpgradeUrl,
} from '../src/bootstrap/deployment.ts';
import { DEFAULT_UPGRADE_URL } from '../src/routes/types.ts';
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
    [V.upgradeUrl]: 'https://updates.example.test/releases/darwin-arm64/latest.json',
    [V.sessionSigningKey]: randomBytes(48).toString('base64'),
    // The shape after G12b: the two public identifiers arrive in the task
    // environment and each secret carries only its own client id and secret.
    [V.pushTopic]: 'projects/example/topics/fss-prod-gmail-push',
    [V.hostedDomain]: 'example.test',
    [V.gmailOAuthClient]: JSON.stringify({
      client_id: 'example.apps.googleusercontent.test',
      client_secret: randomBytes(24).toString('hex'),
    }),
    [V.oidcClient]: JSON.stringify({
      client_id: 'signin.apps.googleusercontent.test',
      client_secret: randomBytes(24).toString('hex'),
    }),
    ...overrides,
  };
}

/** The shape G12 shipped: both public identifiers inside the Gmail secret. */
function secretCarriedEnvironment(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return liveEnvironment({
    [V.pushTopic]: undefined,
    [V.hostedDomain]: undefined,
    [V.gmailOAuthClient]: JSON.stringify({
      client_id: 'example.apps.googleusercontent.test',
      client_secret: randomBytes(24).toString('hex'),
      push_topic: 'projects/example/topics/fss-prod-gmail-push',
      hosted_domain: 'example.test',
    }),
    ...overrides,
  });
}

const loadKms = async (): Promise<never> =>
  await Promise.resolve({ generateDataKey: async () => ({}), decrypt: async () => ({}) } as never);

const putObject = async (): Promise<'written'> => await Promise.resolve('written');

/** A sign-in client that reaches nothing, which is what a rehearsal must name. */
function fixtureSignInClient(): GoogleClient {
  return {
    discovery: async () => await Promise.resolve(null),
    signingKey: async () => await Promise.resolve(null),
    exchangeCode: async () =>
      await Promise.resolve({ ok: false, idToken: null, reason: 'discovery_unavailable', providerError: null }),
    verifySignature: () => false,
  };
}

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
    V.oidcClient,
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
      {
        loadKms,
        putObject,
        pushVerifier: { verify: async () => await Promise.resolve(null) },
        signInClient: fixtureSignInClient(),
      },
    );
    expect(deployment.gmailSource).toBe('recorded');
    expect(deployment.envelopeSource).toBe('local');
    expect(deployment.pushVerifierSource).toBe('fixture');
  });
});

/**
 * Deliverable 2: the Pub/Sub topic and the Workspace domain are public
 * identifiers `infra/modules/stack` now puts in both task definitions. The
 * bootstrap reads the environment first and falls back to the secret JSON for
 * one release.
 *
 * ## The vacuous-pass trap
 *
 * A reader that ignored the environment would pass a test whose two sources
 * agreed, so the preference case gives them different values. The reported
 * source is asserted in every case, so a field that always said `environment`
 * fails the fallback one.
 */
describe('the two public identifiers the task environment now carries', () => {
  it('prefers the environment over the secret and says which it used', async () => {
    const deployment = await readApiDeployment(
      secretCarriedEnvironment({
        [V.pushTopic]: 'projects/example/topics/from-the-environment',
        [V.hostedDomain]: 'environment.test',
      }),
      { loadKms, putObject },
    );
    expect(deployment.mailConfig?.pushTopicName).toBe('projects/example/topics/from-the-environment');
    expect(deployment.mailConfig?.hostedDomain).toBe('environment.test');
    expect(deployment.pushTopicSource).toBe('environment');
    expect(deployment.hostedDomainSource).toBe('environment');
    // Sign-in restricts `hd` to the same domain, so the two cannot disagree.
    expect(deployment.auth?.oidc.hostedDomain).toBe('environment.test');
  });

  it('falls back to the secret JSON for one release, and says so', async () => {
    const deployment = await readApiDeployment(secretCarriedEnvironment(), { loadKms, putObject });
    expect(deployment.mailConfig?.pushTopicName).toBe('projects/example/topics/fss-prod-gmail-push');
    expect(deployment.mailConfig?.hostedDomain).toBe('example.test');
    expect(deployment.pushTopicSource).toBe('secret');
    expect(deployment.hostedDomainSource).toBe('secret');
  });

  for (const [variable, field] of [
    [V.pushTopic, 'push_topic'],
    [V.hostedDomain, 'hosted_domain'],
  ] as const) {
    it(`refuses when neither the environment nor the secret carries ${field}`, async () => {
      await expect(
        readApiDeployment(liveEnvironment({ [variable]: undefined }), { loadKms, putObject }),
      ).rejects.toThrow(new RegExp(`${variable}.*${field}`, 'u'));
    });
  }
});

/**
 * Deliverable 3: Google sign-in, which G12 deliberately left absent.
 *
 * `ApiOptions.auth` being optional is right for a route test and wrong for
 * production: an API with no identity serves `/healthz`, `/readyz` and the
 * client-version notice and refuses every command, which is a deployment
 * nobody can sign in to. A live deployment therefore builds it or refuses.
 *
 * ## The vacuous-pass trap
 *
 * Every refusal below would also be produced by a reader that threw on
 * everything, so the first case is the positive control: the complete live
 * environment yields a configured sign-in with the fixed redirect URI, the
 * hosted-domain restriction and a real Google client. Each later case removes
 * exactly one thing from that same environment.
 */
describe('Google sign-in in a live deployment', () => {
  it('is configured from the sign-in secret, the hostname and the session signing key', async () => {
    const deployment = await readApiDeployment(liveEnvironment(), { loadKms, putObject });
    expect(deployment.signInSource).toBe('google');
    expect(deployment.auth).toBeDefined();
    expect(deployment.auth?.oidc.clientId).toBe('signin.apps.googleusercontent.test');
    // Fixed by hostname, exactly as registered with Google
    // (.context/FSS-GREENFIELD-ACCOUNT-IDENTIFIERS-20260920.md).
    expect(deployment.auth?.oidc.redirectUri).toBe('https://api.example.test/auth/google/callback');
    expect(deployment.auth?.oidc.issuer).toBe('https://accounts.google.com');
    expect(deployment.auth?.oidc.hostedDomain).toBe('example.test');
    expect(deployment.auth?.stateSigningKey.length).toBeGreaterThanOrEqual(32);
    expect(deployment.auth?.sessions.accessSessionSeconds).toBe(3600);
    expect(deployment.auth?.sessions.fullSignInSeconds).toBe(30 * 24 * 3600);
  });

  it('uses a different client from the Gmail grant, because 5.1 keeps them separate', async () => {
    const deployment = await readApiDeployment(liveEnvironment(), { loadKms, putObject });
    expect(deployment.auth?.oidc.clientId).not.toBe(deployment.mailConfig?.clientId);
  });

  for (const bad of ['not json at all', '[]', '{}', '{"client_id":"a"}', '{"client_secret":"b"}']) {
    it(`refuses a sign-in secret that is ${bad}`, async () => {
      await expect(
        readApiDeployment(liveEnvironment({ [V.oidcClient]: bad }), { loadKms, putObject }),
      ).rejects.toBeInstanceOf(DeploymentConfigError);
    });
  }

  it('refuses when nothing carries the hosted domain, rather than admitting every Google account', async () => {
    await expect(
      readApiDeployment(liveEnvironment({ [V.hostedDomain]: undefined }), { loadKms, putObject }),
    ).rejects.toMatchObject({ code: 'MISSING' });
  });

  it('a rehearsal must name its own sign-in client rather than reach Google', async () => {
    await expect(
      readApiDeployment(liveEnvironment({ [V.environmentName]: 'rehearsal', [V.dependencies]: 'recorded' }), {
        loadKms,
        putObject,
        pushVerifier: { verify: async () => await Promise.resolve(null) },
      }),
    ).rejects.toBeInstanceOf(DeploymentConfigError);
  });

  it('a rehearsal with a named sign-in client says the client is a fixture', async () => {
    const deployment = await readApiDeployment(
      liveEnvironment({ [V.environmentName]: 'rehearsal', [V.dependencies]: 'recorded' }),
      {
        loadKms,
        putObject,
        pushVerifier: { verify: async () => await Promise.resolve(null) },
        signInClient: fixtureSignInClient(),
      },
    );
    expect(deployment.signInSource).toBe('fixture');
    expect(deployment.auth).toBeDefined();
  });

  it('has no sign-in at all when dependencies are none, which production cannot select', async () => {
    const deployment = await readApiDeployment(
      liveEnvironment({ [V.environmentName]: 'laptop', [V.dependencies]: 'none' }),
      { loadKms },
    );
    expect(deployment.auth).toBeUndefined();
    expect(deployment.signInSource).toBe('absent');
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
    const signInSecret = `yy-${randomBytes(12).toString('hex')}-yy`;
    const deployment = await readApiDeployment(
      liveEnvironment({
        [V.gmailOAuthClient]: JSON.stringify({
          client_id: 'example.apps.googleusercontent.test',
          client_secret: secret,
        }),
        [V.oidcClient]: JSON.stringify({
          client_id: 'signin.apps.googleusercontent.test',
          client_secret: signInSecret,
        }),
      }),
      { loadKms, putObject },
    );
    const described = JSON.stringify(describeDeployment(deployment));
    expect(described).not.toContain(secret);
    expect(described).not.toContain(signInSecret);
    // Not the client id either: the line names parts, not values.
    expect(described).not.toContain('signin.apps.googleusercontent.test');
    // Nor the upgrade address, which is public: its source is enough.
    expect(described).not.toContain('updates.example.test');
    expect(JSON.parse(described)).toMatchObject({
      upgrade_notice_source: 'environment',
      dependencies: 'live',
      gmail_client: 'https',
      envelope_key: 'kms',
      push_verifier: 'google_jwks',
      journal: 's3',
      sending_enabled: false,
      sign_in: 'google',
      sign_in_client_configured: true,
      sign_in_redirect_configured: true,
      sign_in_hosted_domain_configured: true,
      session_signing_key_configured: true,
      push_topic_source: 'environment',
      hosted_domain_source: 'environment',
    });
  });
});

/**
 * Lane g86: what `/auth/client-version` publishes as `upgradeUrl`.
 *
 * The trap is a reader that returns the placeholder whatever it is given, which every
 * "outside production" case would pass. So the first case requires the configured value
 * to come back, and the production cases require a refusal where the placeholder would
 * otherwise have been published.
 */
describe('the upgrade notice address', () => {
  const MANIFEST = 'https://updates.example.test/releases/darwin-arm64/latest.json';

  it('publishes what the task environment says, and says where it came from', async () => {
    expect(readUpgradeUrl({ [V.upgradeUrl]: ` ${MANIFEST} ` })).toEqual({ value: MANIFEST, source: 'environment' });
    const deployment = await readApiDeployment(liveEnvironment(), { loadKms, putObject });
    expect(deployment.upgradeUrl).toBe(MANIFEST);
    expect(deployment.upgradeUrlSource).toBe('environment');
  });

  it('keeps the placeholder outside production, where nothing sets it', async () => {
    expect(readUpgradeUrl({})).toEqual({ value: DEFAULT_UPGRADE_URL, source: 'placeholder' });
    expect(readUpgradeUrl({ [V.environmentName]: 'rehearsal', [V.upgradeUrl]: '  ' })).toEqual({
      value: DEFAULT_UPGRADE_URL,
      source: 'placeholder',
    });
    const laptop = await readApiDeployment({});
    expect(laptop.upgradeUrl).toBe(DEFAULT_UPGRADE_URL);
    expect(describeDeployment(laptop)).toMatchObject({ upgrade_notice_source: 'placeholder' });
  });

  it('refuses to start in production without one, or with the placeholder', async () => {
    await expect(
      readApiDeployment(liveEnvironment({ [V.upgradeUrl]: undefined }), { loadKms, putObject }),
    ).rejects.toMatchObject({ code: 'MISSING' });
    expect(() => readUpgradeUrl({ [V.environmentName]: 'production', [V.upgradeUrl]: DEFAULT_UPGRADE_URL })).toThrow(
      DeploymentConfigError,
    );
  });

  it('refuses an address that is not plain https, anywhere', () => {
    for (const bad of [
      'not a url',
      'http://updates.example.test/releases/darwin-arm64/latest.json',
      `${MANIFEST}?X-Amz-Signature=abc`,
      `${MANIFEST}#fragment`,
      'https://someone:pw@updates.example.test/latest.json',
    ]) {
      expect(() => readUpgradeUrl({ [V.upgradeUrl]: bad }), bad).toThrow(DeploymentConfigError);
    }
  });
});

import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DEPLOYMENT_ENVIRONMENT_VARIABLES,
  DeploymentConfigError,
  describeDeployment,
  readGoogleClientBundle,
  readWorkerDeployment,
} from '../src/bootstrap/deployment.ts';
import { composeHandlers } from '../src/bootstrap/main.ts';

/**
 * The credentialed worker bootstrap (coordinator note, 20 September).
 *
 * Before this the worker called `mailHandlers(undefined)` and `outboundSendHandoff()`
 * with no deps, so no mail handler was registered and every dispatch refused
 * `mailbox_disconnected`. The release-gate question is not "can it be configured" —
 * it is "can a production deployment reach the unconfigured branch by accident", and
 * the answer has to be no.
 *
 * ## The vacuous-pass trap, named
 *
 * Every test here could pass against a reader that threw on everything. So each
 * refusal case is paired with the *same* environment minus one variable, and the
 * suite's first test proves the complete environment succeeds and produces real
 * adapters. A refusal test whose environment was already broken for another reason
 * would fail that positive control first.
 *
 * No value in this file is a credential. The client secret and the signing key are
 * `randomBytes` made when the test starts, which is also how the secret-scanner rule
 * is satisfied without an allowlist entry.
 */

const V = DEPLOYMENT_ENVIRONMENT_VARIABLES;

/** A marker that is unmistakable in any output. Generated, never a literal secret. */
function marker(): string {
  return `zz-${randomBytes(12).toString('hex')}-zz`;
}

function liveEnvironment(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    [V.environmentName]: 'production',
    [V.dependencies]: 'live',
    [V.region]: 'us-east-1',
    [V.publicOrigin]: 'https://api.example.test',
    [V.envelopeKeyId]: 'arn:aws:kms:us-east-1:000000000000:key/example',
    [V.journalBucket]: 'fss-prod-suppression-journal',
    [V.pushAudience]: 'https://api.example.test/integrations/gmail/push',
    [V.pushServiceAccount]: 'fss-prod-gmail-push@example.iam.gserviceaccount.test',
    [V.sendingEnabled]: 'false',
    [V.researchProviders]: 'none',
    // The shape after G12b: the two public identifiers come from the task
    // definition, and the secret carries only the client id and secret.
    [V.pushTopic]: 'projects/example/topics/fss-prod-gmail-push',
    [V.hostedDomain]: 'example.test',
    [V.gmailOAuthClient]: JSON.stringify({
      client_id: 'example.apps.googleusercontent.test',
      client_secret: marker(),
    }),
    ...overrides,
  };
}

/**
 * The shape G12 shipped: nothing in the environment, both public identifiers
 * pasted into the secret beside the client id. Supported for one release.
 */
function secretCarriedEnvironment(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return liveEnvironment({
    [V.pushTopic]: undefined,
    [V.hostedDomain]: undefined,
    [V.gmailOAuthClient]: JSON.stringify({
      client_id: 'example.apps.googleusercontent.test',
      client_secret: marker(),
      push_topic: 'projects/example/topics/fss-prod-gmail-push',
      hosted_domain: 'example.test',
    }),
    ...overrides,
  });
}

/** A KMS transport that reaches nothing, so the live branch is provable offline. */
const loadKms = async (): Promise<{
  generateDataKey: () => Promise<never>;
  decrypt: () => Promise<never>;
}> =>
  await Promise.resolve({
    generateDataKey: async (): Promise<never> => {
      throw new Error('no kms in a test');
    },
    decrypt: async (): Promise<never> => {
      throw new Error('no kms in a test');
    },
  });

describe('the live deployment', () => {
  it('builds the real Gmail configuration from the deployed environment', async () => {
    const deployment = await readWorkerDeployment(liveEnvironment(), {
      loadKms: loadKms as never,
    });
    expect(deployment.dependencies).toBe('live');
    expect(deployment.gmail).toBeDefined();
    expect(deployment.gmail?.gmailSource).toBe('https');
    expect(deployment.gmail?.envelopeSource).toBe('kms');
    expect(deployment.gmail?.config.pushTopicName).toBe('projects/example/topics/fss-prod-gmail-push');
    expect(deployment.gmail?.config.pushAudience).toBe('https://api.example.test/integrations/gmail/push');
    expect(deployment.gmail?.config.redirectUri).toBe('https://api.example.test/oauth/gmail/callback');
    expect(deployment.gmail?.config.hostedDomain).toBe('example.test');
    expect(deployment.gmail?.secrets.names()).toEqual(['gmail_oauth_client_secret']);
  });

  it('registers the mail handlers and a dispatching send hand-off', async () => {
    const deployment = await readWorkerDeployment(liveEnvironment(), { loadKms: loadKms as never });
    const composition = await composeHandlers(deployment, undefined, {
      journal: { append: async () => await Promise.resolve() },
      region: 'us-east-1',
    });
    expect(composition.mail).toBeDefined();
    expect(composition.send).toBeDefined();
    expect(composition.send?.deploymentSendingEnabled).toBe(false);
  });

  it('carries 16.2 deployment flag through to the send deps when it is on', async () => {
    const deployment = await readWorkerDeployment(liveEnvironment({ [V.sendingEnabled]: 'true' }), {
      loadKms: loadKms as never,
    });
    const composition = await composeHandlers(deployment, undefined, {
      journal: { append: async () => await Promise.resolve() },
    });
    expect(composition.send?.deploymentSendingEnabled).toBe(true);
  });

  for (const missing of [
    V.region,
    V.publicOrigin,
    V.envelopeKeyId,
    V.journalBucket,
    V.pushAudience,
    V.pushServiceAccount,
    V.gmailOAuthClient,
    V.researchProviders,
  ]) {
    it(`refuses to start when ${missing} is absent`, async () => {
      await expect(
        readWorkerDeployment(liveEnvironment({ [missing]: undefined }), { loadKms: loadKms as never }),
      ).rejects.toBeInstanceOf(DeploymentConfigError);
    });
  }

  for (const field of ['client_id', 'client_secret']) {
    it(`refuses a Google client bundle without ${field}`, () => {
      const bundle: Record<string, string> = { client_id: 'a', client_secret: 'b' };
      delete bundle[field];
      expect(() => readGoogleClientBundle(JSON.stringify(bundle), V.gmailOAuthClient)).toThrow(
        DeploymentConfigError,
      );
    });
  }
});

/**
 * Deliverable 2: the Pub/Sub topic and the Workspace domain are public
 * identifiers that `infra/modules/stack` now puts in both task definitions.
 * The bootstrap reads the environment first and falls back to the secret JSON
 * for one release; `docs/decisions/g12b-two-public-identifiers-move-out-of-the-secret.md`
 * says when the fallback goes.
 *
 * ## The vacuous-pass trap
 *
 * A reader that ignored the environment entirely would pass a test that set
 * both sources to the same string. So the preference case sets them to
 * *different* values and requires the environment's, and every case asserts
 * the reported source as well as the value — a source field that always said
 * `environment` would fail the fallback case.
 */
describe('the two public identifiers the task environment now carries', () => {
  it('prefers the environment over the secret and says which it used', async () => {
    const deployment = await readWorkerDeployment(
      secretCarriedEnvironment({
        [V.pushTopic]: 'projects/example/topics/from-the-environment',
        [V.hostedDomain]: 'environment.test',
      }),
      { loadKms: loadKms as never },
    );
    expect(deployment.gmail?.config.pushTopicName).toBe('projects/example/topics/from-the-environment');
    expect(deployment.gmail?.config.hostedDomain).toBe('environment.test');
    expect(deployment.gmail?.pushTopicSource).toBe('environment');
    expect(deployment.gmail?.hostedDomainSource).toBe('environment');
  });

  it('falls back to the secret JSON for one release, and says so', async () => {
    const deployment = await readWorkerDeployment(secretCarriedEnvironment(), {
      loadKms: loadKms as never,
    });
    expect(deployment.gmail?.config.pushTopicName).toBe('projects/example/topics/fss-prod-gmail-push');
    expect(deployment.gmail?.config.hostedDomain).toBe('example.test');
    expect(deployment.gmail?.pushTopicSource).toBe('secret');
    expect(deployment.gmail?.hostedDomainSource).toBe('secret');
  });

  for (const [variable, field] of [
    [V.pushTopic, 'push_topic'],
    [V.hostedDomain, 'hosted_domain'],
  ] as const) {
    it(`refuses when neither the environment nor the secret carries ${field}`, async () => {
      await expect(
        readWorkerDeployment(
          liveEnvironment({
            [variable]: undefined,
            [V.gmailOAuthClient]: JSON.stringify({ client_id: 'a', client_secret: marker() }),
          }),
          { loadKms: loadKms as never },
        ),
      ).rejects.toMatchObject({ code: 'MISSING' });
    });

    it(`names both places it looked for ${field}`, async () => {
      await expect(
        readWorkerDeployment(
          liveEnvironment({
            [variable]: undefined,
            [V.gmailOAuthClient]: JSON.stringify({ client_id: 'a', client_secret: marker() }),
          }),
          { loadKms: loadKms as never },
        ),
      ).rejects.toThrow(new RegExp(`${variable}.*${field}`, 'u'));
    });
  }
});

describe('a production deployment can never reach the unconfigured branch', () => {
  it('refuses when the dependency switch is unset', async () => {
    const environment = liveEnvironment({ [V.dependencies]: undefined });
    await expect(readWorkerDeployment(environment)).rejects.toMatchObject({ code: 'DEPENDENCIES_UNSET' });
  });

  it('refuses none in production', async () => {
    const environment = liveEnvironment({ [V.dependencies]: 'none' });
    await expect(readWorkerDeployment(environment)).rejects.toMatchObject({ code: 'PRODUCTION_REQUIRES_LIVE' });
  });

  it('refuses recorded in production', async () => {
    const environment = liveEnvironment({ [V.dependencies]: 'recorded' });
    await expect(readWorkerDeployment(environment)).rejects.toMatchObject({ code: 'PRODUCTION_REQUIRES_LIVE' });
  });

  it('refuses a switch value nobody defined', async () => {
    const environment = liveEnvironment({ [V.dependencies]: 'fake' });
    await expect(readWorkerDeployment(environment)).rejects.toMatchObject({ code: 'DEPENDENCIES_INVALID' });
  });

  it('refuses recorded research providers beside a live deployment', async () => {
    const environment = liveEnvironment({ [V.researchProviders]: 'recorded' });
    await expect(readWorkerDeployment(environment, { loadKms: loadKms as never })).rejects.toBeInstanceOf(
      DeploymentConfigError,
    );
  });
});

describe('the rehearsal deployment selects its fakes by name', () => {
  it('uses the recorded Gmail client and a local envelope key, and says so', async () => {
    const deployment = await readWorkerDeployment(
      liveEnvironment({ [V.environmentName]: 'rehearsal', [V.dependencies]: 'recorded' }),
    );
    expect(deployment.gmail?.gmailSource).toBe('recorded');
    expect(deployment.gmail?.envelopeSource).toBe('local');
  });

  it('never selects a fake because a variable was missing', async () => {
    // The same environment with the switch removed outside production is `none`, not
    // `recorded`: reaching the recorded client by omission is exactly the failure this
    // deliverable exists to prevent, so the two absences give different answers.
    const deployment = await readWorkerDeployment(
      liveEnvironment({ [V.environmentName]: 'rehearsal', [V.dependencies]: undefined }),
    );
    expect(deployment.dependencies).toBe('none');
    expect(deployment.gmail).toBeUndefined();
  });
});

describe('the startup line', () => {
  it('names every part and prints no value', async () => {
    const secret = marker();
    const signingLike = marker();
    const environment = liveEnvironment({
      [V.pushTopic]: `projects/example/topics/${signingLike}`,
      [V.gmailOAuthClient]: JSON.stringify({
        client_id: 'example.apps.googleusercontent.test',
        client_secret: secret,
      }),
    });
    const deployment = await readWorkerDeployment(environment, { loadKms: loadKms as never });
    const described = JSON.stringify(describeDeployment(deployment));
    expect(described).not.toContain(secret);
    // The topic is a public identifier, but the line reports *whether* it is
    // configured rather than what it is, so no operator-supplied string leaks at all.
    expect(described).not.toContain(signingLike);
    expect(JSON.parse(described)).toMatchObject({
      dependencies: 'live',
      gmail_configured: true,
      gmail_client: 'https',
      envelope_key: 'kms',
      push_topic_configured: true,
      push_topic_source: 'environment',
      hosted_domain_configured: true,
      hosted_domain_source: 'environment',
      journal: 'configured',
      research_providers: 'none',
      sending_enabled: false,
    });
  });
});

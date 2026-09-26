import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { RECORDED_SEAM_ENCRYPTION_CONTEXT, type KmsTransport } from '@fss/domain/mail/envelopeKms.ts';
import { DeploymentConfigError, readGoogleClientBundle } from '@fss/domain/release/deployment.ts';
import { DEPLOYMENT_ENVIRONMENT_VARIABLES, describeDeployment, readWorkerDeployment } from '../src/bootstrap/deployment.ts';
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
    // Terraform still injects this into the worker (infra/modules/stack) until a later
    // infra release removes it. Nothing reads it any more.
    FSS_RESEARCH_PROVIDERS: 'none',
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

  it('carries the worker image digest through to the send deps, and leaves it absent when unknown', async () => {
    // Lane g71: the send gate compares this with the worker digest of the release
    // record the attestation names. Absent is unknown, and unknown holds every send.
    const deployment = await readWorkerDeployment(liveEnvironment({ [V.sendingEnabled]: 'true' }), {
      loadKms: loadKms as never,
    });
    const digest = `sha256:${'b'.repeat(64)}`;
    const composed = await composeHandlers(deployment, undefined, {
      journal: { append: async () => await Promise.resolve() },
      imageDigest: digest,
    });
    expect(composed.send?.workerImageDigest).toBe(digest);
    const unknown = await composeHandlers(deployment, undefined, {
      journal: { append: async () => await Promise.resolve() },
    });
    expect(unknown.send?.workerImageDigest).toBeUndefined();
  });

  it('tells the send gate whether this is production, from FSS_ENVIRONMENT', async () => {
    // Production binds only the CI gate's release records; a rehearsal stack also binds
    // a rehearsal's by its reference. The same comparison the dependency switch makes.
    for (const [name, production] of [['production', true], [' Production ', true], ['rehearsal', false]] as const) {
      const deployment = await readWorkerDeployment(liveEnvironment({ [V.environmentName]: name }), {
        loadKms: loadKms as never,
      });
      const composed = await composeHandlers(deployment, undefined, {
        journal: { append: async () => await Promise.resolve() },
      });
      expect(composed.send?.production, name).toBe(production);
    }
  });

  for (const missing of [
    V.region,
    V.publicOrigin,
    V.envelopeKeyId,
    V.journalBucket,
    V.pushAudience,
    V.pushServiceAccount,
    V.gmailOAuthClient,
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

  it('starts whether the retired FSS_RESEARCH_PROVIDERS is present, absent or anything else', async () => {
    for (const value of ['none', undefined, 'recorded', '']) {
      const deployment = await readWorkerDeployment(liveEnvironment({ FSS_RESEARCH_PROVIDERS: value }), {
        loadKms: loadKms as never,
      });
      expect(deployment.dependencies).toBe('live');
      expect(describeDeployment(deployment)).not.toHaveProperty('research_providers');
    }
  });
});

/**
 * A KMS stand-in with one master key and KMS's own rule about encryption context: a
 * `Decrypt` whose context differs from the `GenerateDataKey` that made the blob is
 * refused. Built per test, so no key exists anywhere but in this process's memory.
 */
function contextCheckingKms(): { readonly transport: KmsTransport; readonly calls: string[] } {
  const master = randomBytes(32);
  const calls: string[] = [];
  const label = (context: Readonly<Record<string, string>> | undefined): Buffer =>
    Buffer.from(JSON.stringify(Object.entries(context ?? {}).sort()));
  return {
    calls,
    transport: {
      generateDataKey: async input => {
        calls.push(`generate:${input.KeyId}:${JSON.stringify(input.EncryptionContext ?? {})}`);
        const plaintext = randomBytes(32);
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', master, iv);
        cipher.setAAD(label(input.EncryptionContext));
        const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        return await Promise.resolve({
          Plaintext: plaintext,
          CiphertextBlob: Buffer.concat([iv, cipher.getAuthTag(), body]),
        });
      },
      decrypt: async input => {
        calls.push(`decrypt:${input.KeyId}:${JSON.stringify(input.EncryptionContext ?? {})}`);
        const blob = Buffer.from(input.CiphertextBlob);
        const decipher = createDecipheriv('aes-256-gcm', master, blob.subarray(0, 12));
        decipher.setAAD(label(input.EncryptionContext));
        decipher.setAuthTag(blob.subarray(12, 28));
        // Throws on a context mismatch, which is KMS's InvalidCiphertextException.
        return await Promise.resolve({
          Plaintext: Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]),
        });
      },
    },
  };
}

describe('the rehearsal deployment selects its fakes by name', () => {
  it('uses the recorded Gmail client and the environment’s envelope key on the recorded seam, and says so', async () => {
    const kms = contextCheckingKms();
    const deployment = await readWorkerDeployment(
      liveEnvironment({ [V.environmentName]: 'rehearsal', [V.dependencies]: 'recorded' }),
      { loadKms: async () => await Promise.resolve(kms.transport) },
    );
    expect(deployment.gmail?.gmailSource).toBe('recorded');
    expect(deployment.gmail?.envelopeSource).toBe('kms_recorded_seam');
    expect(describeDeployment(deployment)).toMatchObject({ envelope_key: 'kms_recorded_seam' });
  });

  it('keeps the per-process local key where no envelope key is configured, as a laptop has none', async () => {
    const deployment = await readWorkerDeployment(
      liveEnvironment({ [V.environmentName]: 'rehearsal', [V.dependencies]: 'recorded', [V.envelopeKeyId]: undefined }),
    );
    expect(deployment.gmail?.envelopeSource).toBe('local');
  });

  /**
   * Lane g59. The drill evidence seed and `fss drill` are two tasks, and the drill has
   * to unwrap the refresh token the seed stored. With a per-process local key it could
   * not; with the environment's key on the recorded seam, two separately read
   * deployments share it — and a live deployment reading the same row is refused, both
   * by the key id it records and by KMS's context rule.
   */
  it('lets a second recorded process unwrap what the first wrapped, and refuses a live one', async () => {
    const kms = contextCheckingKms();
    const recorded = liveEnvironment({ [V.environmentName]: 'rehearsal', [V.dependencies]: 'recorded' });
    const seed = await readWorkerDeployment(recorded, { loadKms: async () => await Promise.resolve(kms.transport) });
    const drill = await readWorkerDeployment(recorded, { loadKms: async () => await Promise.resolve(kms.transport) });
    const plaintext = `token-${randomBytes(8).toString('hex')}`;
    const envelope = await seed.gmail?.cipher.encrypt(plaintext);
    expect(envelope).toBeDefined();
    if (envelope === undefined) return;
    expect(envelope.keyId).toBe('recorded-seam:arn:aws:kms:us-east-1:000000000000:key/example');
    expect(await drill.gmail?.cipher.decrypt(envelope)).toBe(plaintext);
    // KMS itself is asked with the bare key and the recorded context, on both sides.
    const context = JSON.stringify(RECORDED_SEAM_ENCRYPTION_CONTEXT);
    expect(kms.calls).toEqual([
      `generate:arn:aws:kms:us-east-1:000000000000:key/example:${context}`,
      `decrypt:arn:aws:kms:us-east-1:000000000000:key/example:${context}`,
    ]);

    // A live process names the bare key, so the row is refused before KMS is asked.
    const live = await readWorkerDeployment(liveEnvironment({ [V.environmentName]: 'rehearsal' }), {
      loadKms: async () => await Promise.resolve(kms.transport),
    });
    await expect(live.gmail?.cipher.decrypt(envelope)).rejects.toMatchObject({ code: 'KEY_MISMATCH' });
    // And were that check ever bypassed, KMS refuses a decrypt without the context.
    const callsBefore = kms.calls.length;
    await expect(
      live.gmail?.cipher.decrypt({ ...envelope, keyId: 'arn:aws:kms:us-east-1:000000000000:key/example' }),
    ).rejects.toThrow();
    expect(kms.calls.slice(callsBefore)).toEqual(['decrypt:arn:aws:kms:us-east-1:000000000000:key/example:{}']);
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
      sending_enabled: false,
    });
  });
});

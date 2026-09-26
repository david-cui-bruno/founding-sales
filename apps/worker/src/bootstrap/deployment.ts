import { type MailPublicConfig } from '@fss/domain/mail/config.ts';
import { envelopeCipher, localDataKeyWrapper, type EnvelopeCipher } from '@fss/domain/mail/envelope.ts';
import { kmsDataKeyWrapper, loadKmsTransport, recordedSeamDataKeyWrapper } from '@fss/domain/mail/envelopeKms.ts';
import { type GmailClient, type GmailOAuthConfig } from '@fss/domain/mail/gmailClient.ts';
import { recordedGmailClient } from '@fss/domain/mail/gmailClientFake.ts';
import { createGmailHttpClient, httpFetch } from '@fss/domain/mail/gmailClientHttp.ts';
import { staticSecretProvider, type SecretProvider } from '@fss/domain/mail/secretProvider.ts';
import { CLASSIFIER_SECRET_ENVIRONMENT_VARIABLES } from '@fss/domain/classification/anthropicClient.ts';
import {
  DeploymentConfigError,
  REHEARSAL_MAILBOX_ADDRESS,
  SHARED_DEPLOYMENT_VARIABLES,
  readBooleanFlag,
  readDependencySelection,
  readGoogleClientBundle,
  readMailPublicConfig,
  requiredVariable,
  type DependencySelection,
  type DeploymentEnvironment,
  type PublicIdentifierSource,
} from '@fss/domain/release/deployment.ts';
import {
  SuppressionJournalError,
  journalObjectBody,
  journalObjectKey,
  type SuppressionJournal,
} from '@fss/domain/suppression/journal.ts';
import { createLogger, type LogFields, type Logger } from './log.ts';

/**
 * What a deployed worker was actually given, and what it refuses to start without: the
 * difference between "this deployment has no Gmail configuration" and "this deployment
 * was *meant* to have one and does not" is a refusal to start rather than a queue that
 * quietly never drains.
 *
 * The switch, the shared variable names and the Google bundle are read by
 * `@fss/domain/release/deployment.ts`, the same code the API reads them with. Nothing
 * here logs a value; `describeDeployment` names the parts and their sources.
 */

/** Re-exported for the callers that name the worker's reader (`bootstrap/main.ts`, `tools/fss.ts`). */
export { DeploymentConfigError };

/** The deployment contract, as data: the shared names and the one only the worker reads. */
export const DEPLOYMENT_ENVIRONMENT_VARIABLES = Object.freeze({
  ...SHARED_DEPLOYMENT_VARIABLES,
  /**
   * Not a logical secret name: the classifier reads the key as `FSS_LLM_CLASSIFIER_API_KEY`
   * (`environmentClassifierSecrets`), and `infra/modules/cluster` maps the entry to it.
   */
  classifierApiKey: CLASSIFIER_SECRET_ENVIRONMENT_VARIABLES.llm_classifier_api_key,
} as const);

const VARIABLES = DEPLOYMENT_ENVIRONMENT_VARIABLES;

export interface GmailDeployment {
  readonly config: MailPublicConfig;
  readonly gmail: GmailClient;
  readonly oauth: GmailOAuthConfig;
  readonly cipher: EnvelopeCipher;
  readonly secrets: SecretProvider;
  /**
   * `kms` in production. In a recorded deployment, `kms_recorded_seam` when the task
   * carries the environment's envelope key (every deployed rehearsal task does), and
   * `local` on a laptop or in a test without one. Never a key and never a ciphertext.
   */
  readonly envelopeSource: 'kms' | 'kms_recorded_seam' | 'local';
  readonly gmailSource: 'https' | 'recorded';
  /** `environment` once the stack module carries it; `secret` is the old shape. */
  readonly pushTopicSource: PublicIdentifierSource;
  readonly hostedDomainSource: PublicIdentifierSource;
}

export interface WorkerDeployment {
  readonly environmentName: string;
  readonly dependencies: DependencySelection;
  /** Absent only when `dependencies` is `none`. */
  readonly gmail: GmailDeployment | undefined;
  /** 16.2's deployment half, handed to the send gate. Never true by omission. */
  readonly sendingEnabled: boolean;
  /** The journal bucket, or null when none is configured. A name, not a credential. */
  readonly journalBucket: string | null;
}

/**
 * The Gmail configuration, built once at startup.
 *
 * `loadKms` is a parameter so a test can prove the live branch is taken without an
 * AWS credential: the production default is `loadKmsTransport`, which is the only line
 * in this file that can reach the network.
 */
export async function readGmailDeployment(
  environment: DeploymentEnvironment,
  dependencies: DependencySelection,
  options: { readonly loadKms?: typeof loadKmsTransport } = {},
): Promise<GmailDeployment> {
  const bundle = readGoogleClientBundle(
    requiredVariable(environment, VARIABLES.gmailOAuthClient),
    VARIABLES.gmailOAuthClient,
  );
  const { config, pushTopicSource, hostedDomainSource } = readMailPublicConfig(bundle, environment);
  const secrets = staticSecretProvider({ gmail_oauth_client_secret: bundle.clientSecret });
  const oauth: GmailOAuthConfig = {
    clientId: config.clientId,
    clientSecret: await secrets.read('gmail_oauth_client_secret'),
    redirectUri: config.redirectUri,
    authorizationEndpoint: config.authorizationEndpoint,
    tokenEndpoint: config.tokenEndpoint,
    revocationEndpoint: config.revocationEndpoint,
    apiBaseUrl: config.apiBaseUrl,
  };

  if (dependencies === 'recorded') {
    // The rehearsal selection, and it is named rather than inferred. `recordedGmailClient`
    // answers from a fixture and reaches nothing.
    //
    // The envelope is the environment's own KMS key when the task carries it (lane g59).
    // `localDataKeyWrapper` makes a master key per process, so a refresh token the drill
    // evidence seed wrapped in one task could not be unwrapped by `fss drill` in the next,
    // and every mailbox step of the drill failed on it. Both tasks carry
    // `FSS_ENVELOPE_KEY_ID`, so both now wrap and unwrap through the production wrapper,
    // bound to `RECORDED_SEAM_ENCRYPTION_CONTEXT`: KMS will not decrypt one of these
    // envelopes for a live process, and the drill's grant is conditioned on that context.
    // A laptop or a test with no key id keeps the per-process local key, as before.
    const envelopeKeyId = environment[VARIABLES.envelopeKeyId]?.trim() ?? '';
    const recordedSeam = envelopeKeyId.length > 0;
    const cipher = recordedSeam
      ? envelopeCipher(
          recordedSeamDataKeyWrapper({
            keyId: envelopeKeyId,
            transport: await (options.loadKms ?? loadKmsTransport)(requiredVariable(environment, VARIABLES.region)),
          }),
        )
      : envelopeCipher(localDataKeyWrapper('rehearsal-envelope'));
    return {
      config,
      gmail: recordedGmailClient({ emailAddress: REHEARSAL_MAILBOX_ADDRESS, historyId: '1', messages: [] }),
      oauth,
      cipher,
      secrets,
      envelopeSource: recordedSeam ? 'kms_recorded_seam' : 'local',
      gmailSource: 'recorded',
      pushTopicSource,
      hostedDomainSource,
    };
  }

  const region = requiredVariable(environment, VARIABLES.region);
  const keyId = requiredVariable(environment, VARIABLES.envelopeKeyId);
  const transport = await (options.loadKms ?? loadKmsTransport)(region);
  return {
    config,
    gmail: createGmailHttpClient({ fetch: httpFetch, apiBaseUrl: config.apiBaseUrl }),
    oauth,
    cipher: envelopeCipher(kmsDataKeyWrapper({ keyId, transport })),
    secrets,
    envelopeSource: 'kms',
    gmailSource: 'https',
    pushTopicSource,
    hostedDomainSource,
  };
}

export async function readWorkerDeployment(
  environment: DeploymentEnvironment,
  options: { readonly loadKms?: typeof loadKmsTransport } = {},
): Promise<WorkerDeployment> {
  const environmentName = environment[VARIABLES.environmentName]?.trim() ?? 'unset';
  const dependencies = readDependencySelection(environment);
  const journalBucket = environment[VARIABLES.journalBucket]?.trim() ?? '';
  const sendingEnabled = readBooleanFlag(environment, VARIABLES.sendingEnabled);

  if (dependencies === 'none') {
    return {
      environmentName,
      dependencies,
      gmail: undefined,
      sendingEnabled,
      journalBucket: journalBucket.length > 0 ? journalBucket : null,
    };
  }

  if (dependencies === 'live' && journalBucket.length === 0) {
    // 10.2: "Each event and supersession ... is written to the object-locked S3 journal
    // before acknowledgement." The worker records prospect opt-outs during mail sync,
    // so a live worker without a bucket would acknowledge a suppression it cannot
    // replay after a restore. `requireDurableJournal` says the same thing in the API.
    throw new DeploymentConfigError(
      'MISSING',
      `${VARIABLES.journalBucket} is not set; a live worker records suppressions and must journal them`,
    );
  }

  return {
    environmentName,
    dependencies,
    gmail: await readGmailDeployment(environment, dependencies, options),
    sendingEnabled,
    journalBucket: journalBucket.length > 0 ? journalBucket : null,
  };
}

/**
 * The startup line and `--selftest`: which parts are configured, and no value.
 *
 * Every field here is a boolean, a name the operator chose, or one of a closed set.
 * `test/release/scenario42.check.ts` asserts that no secret value can appear in it by
 * feeding the reader a recognisable marker and searching the output for it.
 */
export function describeDeployment(deployment: WorkerDeployment): LogFields {
  return {
    environment: deployment.environmentName,
    dependencies: deployment.dependencies,
    gmail_configured: deployment.gmail !== undefined,
    gmail_client: deployment.gmail?.gmailSource ?? 'absent',
    envelope_key: deployment.gmail?.envelopeSource ?? 'absent',
    push_audience_configured: (deployment.gmail?.config.pushAudience ?? '').length > 0,
    push_topic_configured: (deployment.gmail?.config.pushTopicName ?? '').length > 0,
    push_topic_source: deployment.gmail?.pushTopicSource ?? 'absent',
    hosted_domain_configured: (deployment.gmail?.config.hostedDomain ?? '').length > 0,
    hosted_domain_source: deployment.gmail?.hostedDomainSource ?? 'absent',
    oauth_secret_configured: deployment.gmail?.secrets.names().length === 1,
    journal: deployment.journalBucket === null ? 'absent' : 'configured',
    sending_enabled: deployment.sendingEnabled,
  };
}

/**
 * The two pieces of `@aws-sdk/client-s3` the journal uses, narrowed so a test can hand
 * in a fake client and prove what a refused put does without an AWS credential.
 */
export interface S3JournalSdk {
  readonly S3Client: new (configuration: { region: string }) => { send(command: unknown): Promise<unknown> };
  readonly PutObjectCommand: new (input: Record<string, unknown>) => unknown;
}

/**
 * What a conditional put's refusal proves about the object at the key (audit S12,
 * lane g81).
 *
 * `IfNoneMatch: '*'` asks S3 to write only if nothing is at the key, and the key is the
 * deterministic event id: the same suppression always lands on the same key. So:
 *
 * * **`412 PreconditionFailed`** means an object *is* at the key. That is what a replay
 *   of the same event looks like — the append ran, the command's transaction rolled
 *   back, the command was retried — and the object already written is durable, which
 *   is the only thing the caller needed to know.
 * * **`409 ConditionalRequestConflict`** means another write to the same key was in
 *   flight when this one arrived. It proves nothing about whether an object exists:
 *   the other write may yet fail. Until this lane both names were read as "already
 *   durable", so a conflict could acknowledge a suppression that no object records,
 *   and Appendix E's replay after a restore would lose it. It is now a failure of this
 *   write, and the command fails; its retry meets either the object (`412`) or an
 *   empty key it writes itself.
 */
export function journalPutRefusalIsDurable(errorName: string): boolean {
  return errorName === 'PreconditionFailed';
}

/**
 * The S3 suppression journal the worker appends to, or null when none is configured.
 *
 * The SDK is loaded lazily and only here, exactly as `loadKmsTransport` and
 * `loadCloudWatchTransport` do: a process that never journals never imports it, and
 * this lane adds no client to any module that domain code imports. `sdk` is for
 * tests; production passes none.
 *
 * A `412 PreconditionFailed` is success and nothing else is: see
 * `journalPutRefusalIsDurable`.
 *
 * Every other refusal logs `suppression_journal_write_failed` before it throws (lane
 * g81). That is the event `infra/modules/observability` turns into
 * `SuppressionJournalWriteFailures`, which 13.3 makes immediately critical, and until
 * this lane nothing wrote it, so the alarm could not fire. The line names the writer
 * and the error's name and nothing else: not the bucket, not the key, and not the
 * event id, which is a digest of the suppressed number or address. `log` is for
 * tests; a process that passes none logs on stdout, which is what the awslogs driver
 * reads.
 */
export async function loadS3SuppressionJournal(options: {
  readonly bucket: string;
  readonly region: string;
  readonly sdk?: S3JournalSdk | undefined;
  readonly log?: Logger | undefined;
}): Promise<SuppressionJournal> {
  const specifier = '@aws-sdk/client-s3';
  const sdk = options.sdk ?? ((await import(specifier)) as S3JournalSdk);
  const client = new sdk.S3Client({ region: options.region });
  const log = options.log ?? createLogger({ component: 'worker', instanceKey: 'suppression-journal' });
  return {
    append: async record => {
      try {
        await client.send(
          new sdk.PutObjectCommand({
            Bucket: options.bucket,
            Key: journalObjectKey(record),
            Body: journalObjectBody(record),
            ContentType: 'application/json',
            IfNoneMatch: '*',
          }),
        );
      } catch (error) {
        const name = error instanceof Error ? error.name : 'unknown';
        // The object is already there, which is what a replay of a deterministic id
        // looks like and is indistinguishable from success for the caller.
        if (journalPutRefusalIsDurable(name)) return;
        // The exact event the SuppressionJournalWriteFailures metric filter counts.
        log.log('error', 'suppression_journal_write_failed', { writer: 'worker', error_name: name });
        // Redacted: the bucket and the key are operational detail, and the command's
        // caller learns only that the journal was unavailable.
        throw new SuppressionJournalError(
          'JOURNAL_UNAVAILABLE',
          `the suppression journal did not accept the record: ${name}`,
        );
      }
    },
  };
}

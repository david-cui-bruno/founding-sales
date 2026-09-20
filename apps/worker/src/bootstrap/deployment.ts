import {
  createGmailHttpClient,
  envelopeCipher,
  httpFetch,
  kmsDataKeyWrapper,
  loadKmsTransport,
  localDataKeyWrapper,
  recordedGmailClient,
  staticSecretProvider,
  type EnvelopeCipher,
  type GmailClient,
  type GmailOAuthConfig,
  type MailPublicConfig,
  type SecretProvider,
} from '@fss/domain/mail';
import type { LogFields } from './log.ts';
import {
  SuppressionJournalError,
  journalObjectKey,
  type SuppressionJournal,
  type SuppressionJournalRecord,
} from '@fss/domain/suppression';

/**
 * What a deployed worker was actually given, and what it refuses to start without.
 *
 * Before this file the worker called `mailHandlers(undefined)`,
 * `researchHandlers({ providers: {} })` and `outboundSendHandoff()` with no deps, and
 * the comments above those calls said, honestly, that the change which reads a
 * deployment's client secret and KMS key would be reviewed on its own. This is that
 * change. Its whole job is to make the difference between "this deployment has no
 * Gmail configuration" and "this deployment was *meant* to have one and does not" a
 * refusal to start rather than a queue that quietly never drains.
 *
 * ## One switch, three values, and no default
 *
 * `FSS_DEPENDENCIES` is the switch and it has no fallback in production:
 *
 *   * `live` — build every real adapter from the deployed configuration. Any missing
 *     part is a `DeploymentConfigError` and the process exits.
 *   * `recorded` — the rehearsal selection: the recorded Gmail fake and a local
 *     envelope key, chosen **explicitly**. A rehearsal that reached the fakes by
 *     omission would be a rehearsal that proved nothing about the production path.
 *   * `none` — no Gmail, no classifier, no research; the three job kinds wait in the
 *     queue unclaimed. This is the shape this repository shipped before today and it
 *     stays available for a laptop — but `FSS_ENVIRONMENT=production` refuses it.
 *
 * That last refusal is the point of the whole file, and `test/release/scenario42` and
 * `apps/worker/test/deployment.test.ts` are the two places it is asserted: a
 * production process must never reach a no-op by accident, only by a value somebody
 * typed.
 *
 * ## The Google configuration is one operator-written secret
 *
 * The task definition injects Secrets Manager values under the logical names
 * `infra/modules/secrets` created (`google-gmail-oauth-client`, `llm-classifier-api-key`
 * and so on), so those are the environment variable names this file reads. Two
 * *public* identifiers the Gmail lane needs — the Pub/Sub topic `users.watch` names and
 * the Workspace domain a connectable mailbox must belong to — used to travel in that
 * same JSON, because nothing in the task environment carried them. G12b put them in
 * the environment (`FSS_GMAIL_PUSH_TOPIC`, `FSS_GOOGLE_HOSTED_DOMAIN`) through
 * `infra/modules/stack`'s environment map, and the JSON stays readable as a fallback
 * for one release. See
 * `docs/decisions/g12b-two-public-identifiers-move-out-of-the-secret.md` and
 * `docs/greenfield/release.md` 1.6.
 *
 * Nothing here logs a value. `describeDeployment` names the parts and their sources.
 */

export type DependencySelection = 'live' | 'recorded' | 'none';

export type DeploymentConfigErrorCode =
  | 'DEPENDENCIES_UNSET'
  | 'DEPENDENCIES_INVALID'
  | 'PRODUCTION_REQUIRES_LIVE'
  | 'MISSING'
  | 'INVALID';

export class DeploymentConfigError extends Error {
  constructor(
    readonly code: DeploymentConfigErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DeploymentConfigError';
  }
}

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Every environment variable a deployed process reads that is not its own role's.
 *
 * Exported as data because two processes read the same deployment and must not drift:
 * `test/release/scenario42.check.ts` compares this map with the API's and fails when
 * they disagree about a name.
 */
export const DEPLOYMENT_ENVIRONMENT_VARIABLES = Object.freeze({
  environmentName: 'FSS_ENVIRONMENT',
  dependencies: 'FSS_DEPENDENCIES',
  region: 'AWS_REGION',
  publicOrigin: 'FSS_PUBLIC_ORIGIN',
  envelopeKeyId: 'FSS_ENVELOPE_KEY_ID',
  journalBucket: 'FSS_JOURNAL_BUCKET',
  pushAudience: 'FSS_GMAIL_PUSH_AUDIENCE',
  pushServiceAccount: 'FSS_GMAIL_PUSH_SERVICE_ACCOUNT',
  /** Public identifiers `infra/modules/stack` puts in both task definitions (G12b). */
  pushTopic: 'FSS_GMAIL_PUSH_TOPIC',
  hostedDomain: 'FSS_GOOGLE_HOSTED_DOMAIN',
  sendingEnabled: 'FSS_SENDING_ENABLED',
  researchProviders: 'FSS_RESEARCH_PROVIDERS',
  /** The ECS `secrets` block names each entry by its logical Secrets Manager name. */
  gmailOAuthClient: 'google-gmail-oauth-client',
  oidcClient: 'google-oidc-client',
  classifierApiKey: 'llm-classifier-api-key',
  researchCredentials: 'research-provider-credentials',
} as const);

const VARIABLES = DEPLOYMENT_ENVIRONMENT_VARIABLES;

function required(environment: Environment, name: string): string {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0) {
    // The name, never the value: an environment variable is an operator's input.
    throw new DeploymentConfigError('MISSING', `${name} is not set`);
  }
  return value;
}

/**
 * The Google client bundle an operator pasted, as JSON.
 *
 * The client id and secret are refused rather than defaulted: each is a thing a
 * deployment either knows or must not pretend to know.
 *
 * `push_topic` and `hosted_domain` are **public identifiers** and are now carried by
 * the task environment (`FSS_GMAIL_PUSH_TOPIC`, `FSS_GOOGLE_HOSTED_DOMAIN`). They
 * remain readable here for one release so a deployment written against G12's shape
 * still starts; `resolvePublicIdentifier` prefers the environment and refuses when
 * neither source has one. See
 * `docs/decisions/g12b-two-public-identifiers-move-out-of-the-secret.md`.
 */
export interface GoogleClientBundle {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly pushTopic: string | null;
  readonly hostedDomain: string | null;
}

/** Which of the two places a public identifier was actually read from. */
export type PublicIdentifierSource = 'environment' | 'secret';

export function readGoogleClientBundle(raw: string, variableName: string): GoogleClientBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DeploymentConfigError('INVALID', `${variableName} does not hold a JSON object`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new DeploymentConfigError('INVALID', `${variableName} does not hold a JSON object`);
  }
  const bundle = parsed as Record<string, unknown>;
  const field = (name: string): string => {
    const value = bundle[name];
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new DeploymentConfigError('INVALID', `${variableName} does not carry ${name}`);
    }
    return value.trim();
  };
  const optional = (name: string): string | null => {
    const value = bundle[name];
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  };
  return {
    clientId: field('client_id'),
    clientSecret: field('client_secret'),
    pushTopic: optional('push_topic'),
    hostedDomain: optional('hosted_domain'),
  };
}

/**
 * A public identifier the task environment carries, with the secret as fallback.
 *
 * The environment wins when both are present, so an operator who has re-applied the
 * infrastructure does not also have to rewrite the secret. When neither has it the
 * refusal names *both* places it looked, because "hosted_domain is missing" sends an
 * operator to the wrong console.
 */
export function resolvePublicIdentifier(
  environment: Environment,
  variableName: string,
  fallback: string | null,
  secretName: string,
  secretField: string,
): { readonly value: string; readonly source: PublicIdentifierSource } {
  const fromEnvironment = environment[variableName]?.trim();
  if (fromEnvironment !== undefined && fromEnvironment.length > 0) {
    return { value: fromEnvironment, source: 'environment' };
  }
  if (fallback !== null) return { value: fallback, source: 'secret' };
  throw new DeploymentConfigError(
    'MISSING',
    `${variableName} is not set and ${secretName} carries no ${secretField}`,
  );
}

/** 12.3's "configured recent-history interval", in days. */
export const DEFAULT_BASELINE_DAYS = 30;

/**
 * The address the recorded Gmail fake answers for in a rehearsal.
 *
 * `.invalid` is reserved by RFC 2606 and can never be a real mailbox, so a rehearsal
 * that somehow reached a real Gmail with this would fail rather than touch anybody.
 */
export const REHEARSAL_MAILBOX_ADDRESS = 'rehearsal@rehearsal.invalid';

export interface GmailDeployment {
  readonly config: MailPublicConfig;
  readonly gmail: GmailClient;
  readonly oauth: GmailOAuthConfig;
  readonly cipher: EnvelopeCipher;
  readonly secrets: SecretProvider;
  /** `kms` in production, `local` in rehearsal. Never a key and never a ciphertext. */
  readonly envelopeSource: 'kms' | 'local';
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
  /** What the operator declared about research. `none` is a declaration, not a default. */
  readonly researchProviders: 'none' | 'recorded';
}

function dependencySelection(environment: Environment): DependencySelection {
  const raw = environment[VARIABLES.dependencies]?.trim().toLowerCase();
  const environmentName = environment[VARIABLES.environmentName]?.trim().toLowerCase() ?? 'unset';
  if (raw === undefined || raw.length === 0) {
    // A production process that read no switch would run with whatever the code's
    // fallback happened to be, which is how a build ends up sending nothing and
    // reporting nothing. Outside production the absence is allowed and means `none`.
    if (environmentName === 'production') {
      throw new DeploymentConfigError(
        'DEPENDENCIES_UNSET',
        `${VARIABLES.dependencies} must be set to live in a production deployment`,
      );
    }
    return 'none';
  }
  if (raw !== 'live' && raw !== 'recorded' && raw !== 'none') {
    throw new DeploymentConfigError('DEPENDENCIES_INVALID', `${VARIABLES.dependencies} must be live, recorded or none`);
  }
  if (environmentName === 'production' && raw !== 'live') {
    throw new DeploymentConfigError(
      'PRODUCTION_REQUIRES_LIVE',
      `${VARIABLES.environmentName} is production, so ${VARIABLES.dependencies} may only be live`,
    );
  }
  return raw;
}

function booleanFlag(environment: Environment, name: string): boolean {
  const raw = environment[name]?.trim().toLowerCase();
  if (raw === undefined || raw.length === 0) return false;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new DeploymentConfigError('INVALID', `${name} must be true or false`);
}

function researchSelection(environment: Environment, dependencies: DependencySelection): 'none' | 'recorded' {
  const raw = environment[VARIABLES.researchProviders]?.trim().toLowerCase();
  if (raw === undefined || raw.length === 0) {
    // 7.4's providers have no live adapter in this repository — the only
    // implementations are the recorded fixtures (docs/decisions/g10-provider-fixtures-only.md).
    // A `live` deployment must therefore *say* that research is absent rather than
    // discover it, which is what `researchHandlers({ providers: {} })` used to do
    // silently.
    if (dependencies === 'live') {
      throw new DeploymentConfigError(
        'MISSING',
        `${VARIABLES.researchProviders} must be set to none or recorded; there is no live research adapter in this build`,
      );
    }
    return 'none';
  }
  if (raw !== 'none' && raw !== 'recorded') {
    throw new DeploymentConfigError('INVALID', `${VARIABLES.researchProviders} must be none or recorded`);
  }
  if (raw === 'recorded' && dependencies === 'live') {
    throw new DeploymentConfigError(
      'INVALID',
      `${VARIABLES.researchProviders} may not be recorded when ${VARIABLES.dependencies} is live`,
    );
  }
  return raw;
}

interface ResolvedMailConfig {
  readonly config: MailPublicConfig;
  readonly pushTopicSource: PublicIdentifierSource;
  readonly hostedDomainSource: PublicIdentifierSource;
}

function mailConfigOf(bundle: GoogleClientBundle, environment: Environment): ResolvedMailConfig {
  const origin = required(environment, VARIABLES.publicOrigin).replace(/\/+$/u, '');
  const pushTopic = resolvePublicIdentifier(
    environment,
    VARIABLES.pushTopic,
    bundle.pushTopic,
    VARIABLES.gmailOAuthClient,
    'push_topic',
  );
  const hostedDomain = resolvePublicIdentifier(
    environment,
    VARIABLES.hostedDomain,
    bundle.hostedDomain,
    VARIABLES.gmailOAuthClient,
    'hosted_domain',
  );
  const config: MailPublicConfig = {
    clientId: bundle.clientId,
    // Exactly what is registered with Google. The registration in
    // `.context/FSS-GREENFIELD-ACCOUNT-IDENTIFIERS-20260920.md` is this path on the
    // API's own origin, so it is derived rather than configured twice.
    redirectUri: `${origin}/oauth/gmail/callback`,
    authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
    revocationEndpoint: 'https://oauth2.googleapis.com/revoke',
    apiBaseUrl: 'https://gmail.googleapis.com',
    pushTopicName: pushTopic.value,
    pushAudience: required(environment, VARIABLES.pushAudience),
    pushServiceAccountEmail: required(environment, VARIABLES.pushServiceAccount),
    hostedDomain: hostedDomain.value,
    baselineDays: DEFAULT_BASELINE_DAYS,
  };
  return { config, pushTopicSource: pushTopic.source, hostedDomainSource: hostedDomain.source };
}

/**
 * The Gmail configuration, built once at startup.
 *
 * `loadKms` is a parameter so a test can prove the live branch is taken without an
 * AWS credential: the production default is `loadKmsTransport`, which is the only line
 * in this file that can reach the network.
 */
export async function readGmailDeployment(
  environment: Environment,
  dependencies: DependencySelection,
  options: { readonly loadKms?: typeof loadKmsTransport } = {},
): Promise<GmailDeployment> {
  const bundle = readGoogleClientBundle(
    required(environment, VARIABLES.gmailOAuthClient),
    VARIABLES.gmailOAuthClient,
  );
  const { config, pushTopicSource, hostedDomainSource } = mailConfigOf(bundle, environment);
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
    return {
      config,
      gmail: recordedGmailClient({ emailAddress: REHEARSAL_MAILBOX_ADDRESS, historyId: '1', messages: [] }),
      oauth,
      cipher: envelopeCipher(localDataKeyWrapper('rehearsal-envelope')),
      secrets,
      envelopeSource: 'local',
      gmailSource: 'recorded',
      pushTopicSource,
      hostedDomainSource,
    };
  }

  const region = required(environment, VARIABLES.region);
  const keyId = required(environment, VARIABLES.envelopeKeyId);
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
  environment: Environment,
  options: { readonly loadKms?: typeof loadKmsTransport } = {},
): Promise<WorkerDeployment> {
  const environmentName = environment[VARIABLES.environmentName]?.trim() ?? 'unset';
  const dependencies = dependencySelection(environment);
  const journalBucket = environment[VARIABLES.journalBucket]?.trim() ?? '';
  const sendingEnabled = booleanFlag(environment, VARIABLES.sendingEnabled);

  if (dependencies === 'none') {
    return {
      environmentName,
      dependencies,
      gmail: undefined,
      sendingEnabled,
      journalBucket: journalBucket.length > 0 ? journalBucket : null,
      researchProviders: researchSelection(environment, dependencies),
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
    researchProviders: researchSelection(environment, dependencies),
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
    research_providers: deployment.researchProviders,
    sending_enabled: deployment.sendingEnabled,
  };
}

/**
 * The S3 suppression journal the worker appends to, or null when none is configured.
 *
 * The SDK is loaded lazily and only here, exactly as `loadKmsTransport` and
 * `loadCloudWatchTransport` do: a process that never journals never imports it, and
 * this lane adds no client to any module that domain code imports.
 *
 * A `412 PreconditionFailed` is success. `IfNoneMatch: '*'` means a replay of the same
 * deterministic event id does not overwrite the object that is already durable, and
 * "already durable" is the only thing the caller needed to know.
 */
export async function loadS3SuppressionJournal(options: {
  readonly bucket: string;
  readonly region: string;
}): Promise<SuppressionJournal> {
  const specifier = '@aws-sdk/client-s3';
  const sdk = (await import(specifier)) as {
    S3Client: new (configuration: { region: string }) => { send(command: unknown): Promise<unknown> };
    PutObjectCommand: new (input: Record<string, unknown>) => unknown;
  };
  const client = new sdk.S3Client({ region: options.region });
  return {
    append: async record => {
      try {
        await client.send(
          new sdk.PutObjectCommand({
            Bucket: options.bucket,
            Key: journalObjectKey(record),
            Body: journalRecordBody(record),
            ContentType: 'application/json',
            IfNoneMatch: '*',
          }),
        );
      } catch (error) {
        const name = error instanceof Error ? error.name : 'unknown';
        // The object is already there, which is what a replay of a deterministic id
        // looks like and is indistinguishable from success for the caller.
        if (name === 'PreconditionFailed' || name === 'ConditionalRequestConflict') return;
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

/**
 * The body of a journal object: identifiers and codes, never a name or a note.
 *
 * The same shape `apps/api/src/journal/index.ts` writes, and
 * `test/release/scenario11.check.ts` asserts the two agree field for field — a replay
 * that could not read what the other process wrote would be a replay that loses
 * suppressions, which Appendix E's step 2 exists to prevent.
 */
export function journalRecordBody(record: SuppressionJournalRecord): string {
  return JSON.stringify({
    schema: 'fss.suppression.v1',
    eventId: record.eventId,
    workspaceId: record.workspaceId,
    scope: record.scope,
    canonicalKey: record.canonicalKey,
    canonicalizerVersion: record.canonicalizerVersion,
    source: record.source,
    actorUserId: record.actorUserId,
    commandId: record.commandId,
    supersedesEventId: record.supersedesEventId,
    supersessionReason: record.supersessionReason,
    recordedAt: record.recordedAt,
  });
}

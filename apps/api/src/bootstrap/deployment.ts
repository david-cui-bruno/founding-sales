import { createPublicKey, type KeyObject } from 'node:crypto';
import {
  createGmailHttpClient,
  envelopeCipher,
  httpFetch,
  kmsDataKeyWrapper,
  loadKmsTransport,
  localDataKeyWrapper,
  publicKeyPushTokenVerifier,
  recordedGmailClient,
  staticSecretProvider,
  type HttpFetch,
  type MailPublicConfig,
  type PushTokenClaims,
  type PushTokenVerifier,
} from '@fss/domain/mail';
import { journalObjectKey, type SuppressionJournal, type SuppressionJournalRecord } from '@fss/domain/suppression';
import type { LogFields } from './log.ts';
import {
  journalBody,
  requireDurableJournal,
  resolveSuppressionJournal,
  type JournalPutObject,
} from '../journal/index.ts';
import type { MailRoutingDeps } from '../routes/types.ts';

/**
 * What a deployed API was actually given, and what it refuses to start without.
 *
 * The API's version of `apps/worker/src/bootstrap/deployment.ts`, and deliberately its
 * mirror image: the same switch, the same variable names, the same rule that a
 * production process may not reach a fallback by omission.
 * `test/release/scenario42.check.ts` compares the two variable maps and fails when
 * they drift.
 *
 * Three things a deployed API has that the worker does not.
 *
 * **The push-token verifier.** 4.1: "The webhook validates signature, issuer, exact
 * audience, service-account email, `email_verified`, expiration, and issued-at
 * bounds." Six of those seven are `decidePushToken`, which is pure. The seventh needs
 * Google's current key set, so `googleOidcPushTokenVerifier` fetches
 * `https://www.googleapis.com/oauth2/v3/certs`, caches it for the lifetime the
 * response asks for, and tries each key. A rehearsal selects a fixture verifier
 * explicitly instead.
 *
 * **The durable journal.** 10.2 and `docs/decisions/g4-journal-port.md`:
 * `ApiOptions.suppressionJournal` defaults to `localNoopSuppressionJournal()` so a
 * route test needs no fixture, and that default is exactly wrong in production — an
 * opt-out acknowledged with nothing to replay from after a restore. A live deployment
 * goes through `requireDurableJournal`, which throws rather than returning the no-op.
 *
 * **16.2's deployment flag.** The API reported `sendingEnabled: false` as a literal.
 * It is now read, so a release that has passed its gate can turn it on without a code
 * change, and `false` is still what an unset variable means.
 *
 * Google sign-in (`ApiOptions.auth`) is deliberately **not** wired here. It is G2's
 * configuration, this lane's brief does not name it, and an OIDC client half-built by
 * a release lane is worse than one that is honestly absent: the API serves `/healthz`,
 * `/readyz` and the client-version notice and refuses the rest, which is what a
 * deployment without its Google configuration should do.
 */

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

export type DependencySelection = 'live' | 'recorded' | 'none';

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * The deployment contract, as data.
 *
 * Kept equal to `apps/worker/src/bootstrap/deployment.ts`'s map for every name the two
 * processes share; the release suite compares them. The two entries only the API reads
 * are below the line.
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
  sendingEnabled: 'FSS_SENDING_ENABLED',
  researchProviders: 'FSS_RESEARCH_PROVIDERS',
  gmailOAuthClient: 'google-gmail-oauth-client',
  oidcClient: 'google-oidc-client',
  classifierApiKey: 'llm-classifier-api-key',
  researchCredentials: 'research-provider-credentials',
  // ---- the API's own ----
  sessionSigningKey: 'session-signing-key',
} as const);

const VARIABLES = DEPLOYMENT_ENVIRONMENT_VARIABLES;

/** Google's JWKS for service-account OIDC tokens. A public, documented endpoint. */
export const GOOGLE_OIDC_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

function required(environment: Environment, name: string): string {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new DeploymentConfigError('MISSING', `${name} is not set`);
  }
  return value;
}

export interface GoogleClientBundle {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly pushTopic: string;
  readonly hostedDomain: string;
}

/**
 * The same JSON the worker reads, parsed by the same rules.
 *
 * Duplicated rather than shared because `apps/api` and `apps/worker` are separate npm
 * workspaces with no dependency between them, and a shared home for it would have to
 * be `packages/domain`, which this lane does not own. The release suite asserts the
 * two agree on every field name.
 */
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
  return {
    clientId: field('client_id'),
    clientSecret: field('client_secret'),
    pushTopic: field('push_topic'),
    hostedDomain: field('hosted_domain'),
  };
}

/**
 * The signing key, as base64 DER or raw base64 bytes, never as PEM.
 *
 * `docs/decisions` records the lesson G13a learned: a PEM armour line in source is
 * flagged by the history scan in every commit it ever appeared in. Refusing the format
 * by name here means nothing in this repository ever has to contain one, not even as a
 * hint, and a paste that begins with the armour gets a message rather than a mystery.
 */
export function readSigningKey(raw: string, variableName: string): Buffer {
  const trimmed = raw.trim();
  if (trimmed.startsWith('---')) {
    throw new DeploymentConfigError('INVALID', `${variableName} is PEM; supply base64 bytes instead`);
  }
  if (!/^[A-Za-z0-9+/=_-]+$/u.test(trimmed)) {
    throw new DeploymentConfigError('INVALID', `${variableName} is not base64`);
  }
  const bytes = Buffer.from(trimmed, 'base64');
  if (bytes.length < 32) {
    throw new DeploymentConfigError('INVALID', `${variableName} is shorter than 32 bytes`);
  }
  return bytes;
}

/**
 * One entry of Google's JWKS, narrowed to what `createPublicKey` needs.
 *
 * Declared here rather than imported: `JsonWebKey` is a DOM global that this
 * workspace's `lib` does not include, and a structural type is enough for a value
 * that only ever goes straight into `createPublicKey`.
 */
interface JwksKey {
  readonly kid?: string;
  readonly kty?: string;
  readonly alg?: string;
  readonly use?: string;
  readonly n?: string;
  readonly e?: string;
}

/**
 * An RS256 verifier over Google's current key set.
 *
 * It tries every key rather than selecting by `kid`, which costs a few signature
 * checks and removes a whole class of bug: a token whose `kid` is absent, unknown or
 * chosen by the sender must not be able to steer key selection. `decidePushToken`
 * still makes every claim check afterwards, so a signature that verifies proves only
 * that Google issued the token — not that it was issued for this deployment.
 *
 * The key set is cached for `cacheSeconds` (Google rotates roughly daily and the
 * response's own `max-age` is hours). A fetch failure does not invalidate a cache that
 * is still in date; it returns null, the webhook refuses, and Pub/Sub retries.
 */
export function googleOidcPushTokenVerifier(options: {
  readonly fetch: HttpFetch;
  readonly certsUrl?: string;
  readonly cacheSeconds?: number;
  readonly now?: () => number;
}): PushTokenVerifier {
  const certsUrl = options.certsUrl ?? GOOGLE_OIDC_CERTS_URL;
  const cacheSeconds = options.cacheSeconds ?? 3600;
  const now = options.now ?? ((): number => Date.now());
  let keys: KeyObject[] = [];
  let refreshedAtMilliseconds = 0;

  const refresh = async (): Promise<void> => {
    if (keys.length > 0 && now() - refreshedAtMilliseconds < cacheSeconds * 1000) return;
    const response = await options.fetch(certsUrl, { method: 'GET' });
    if (response.status !== 200) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      return;
    }
    const set = (parsed as { keys?: readonly JwksKey[] } | null)?.keys;
    if (!Array.isArray(set)) return;
    const loaded: KeyObject[] = [];
    for (const key of set) {
      if (key.kty !== 'RSA') continue;
      try {
        loaded.push(createPublicKey({ key: { kty: 'RSA', n: key.n ?? '', e: key.e ?? '' }, format: 'jwk' }));
      } catch {
        // A key this Node cannot load is a key this process cannot verify with. The
        // others still work, and a key set with none usable is a refusal, not a crash.
      }
    }
    if (loaded.length === 0) return;
    keys = loaded;
    refreshedAtMilliseconds = now();
  };

  return {
    verify: async (token: string): Promise<PushTokenClaims | null> => {
      await refresh();
      for (const key of keys) {
        const claims = await publicKeyPushTokenVerifier(key).verify(token);
        if (claims !== null) return claims;
      }
      return null;
    },
  };
}

export interface ApiDeployment {
  readonly environmentName: string;
  readonly dependencies: DependencySelection;
  /** Absent when `dependencies` is `none`; the four mail paths then answer not_found. */
  readonly mail: MailRoutingDeps | undefined;
  readonly mailConfig: MailPublicConfig | undefined;
  readonly suppressionJournal: SuppressionJournal;
  readonly journalDescription: 's3' | 'local_noop';
  /** 16.2's deployment half. False unless the variable says true. */
  readonly sendingEnabled: boolean;
  readonly envelopeSource: 'kms' | 'local' | 'absent';
  readonly gmailSource: 'https' | 'recorded' | 'absent';
  readonly pushVerifierSource: 'google_jwks' | 'fixture' | 'absent';
}

function dependencySelection(environment: Environment): DependencySelection {
  const raw = environment[VARIABLES.dependencies]?.trim().toLowerCase();
  const environmentName = environment[VARIABLES.environmentName]?.trim().toLowerCase() ?? 'unset';
  if (raw === undefined || raw.length === 0) {
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

export interface ReadApiDeploymentOptions {
  readonly loadKms?: typeof loadKmsTransport;
  readonly fetch?: HttpFetch;
  /** Supplied by the process that has credentials; absent means no durable journal. */
  readonly putObject?: JournalPutObject | undefined;
  /** A rehearsal supplies its own; `live` never does. */
  readonly pushVerifier?: PushTokenVerifier | undefined;
}

export async function readApiDeployment(
  environment: Environment,
  options: ReadApiDeploymentOptions = {},
): Promise<ApiDeployment> {
  const environmentName = environment[VARIABLES.environmentName]?.trim() ?? 'unset';
  const dependencies = dependencySelection(environment);
  const sendingEnabled = booleanFlag(environment, VARIABLES.sendingEnabled);
  const bucket = environment[VARIABLES.journalBucket]?.trim() ?? '';

  const resolved = resolveSuppressionJournal({
    bucket: bucket.length > 0 ? bucket : null,
    putObject: options.putObject ?? null,
  });
  // 10.2 and g4-journal-port: a live deployment refuses rather than discarding an
  // audit trail. `requireDurableJournal` throws; the caller exits.
  const suppressionJournal = dependencies === 'live' ? requireDurableJournal(resolved) : resolved.journal;

  if (dependencies === 'none') {
    return {
      environmentName,
      dependencies,
      mail: undefined,
      mailConfig: undefined,
      suppressionJournal,
      journalDescription: resolved.description,
      sendingEnabled,
      envelopeSource: 'absent',
      gmailSource: 'absent',
      pushVerifierSource: 'absent',
    };
  }

  const bundle = readGoogleClientBundle(
    required(environment, VARIABLES.gmailOAuthClient),
    VARIABLES.gmailOAuthClient,
  );
  const origin = required(environment, VARIABLES.publicOrigin).replace(/\/+$/u, '');
  const config: MailPublicConfig = {
    clientId: bundle.clientId,
    redirectUri: `${origin}/oauth/gmail/callback`,
    authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
    revocationEndpoint: 'https://oauth2.googleapis.com/revoke',
    apiBaseUrl: 'https://gmail.googleapis.com',
    pushTopicName: bundle.pushTopic,
    pushAudience: required(environment, VARIABLES.pushAudience),
    pushServiceAccountEmail: required(environment, VARIABLES.pushServiceAccount),
    hostedDomain: bundle.hostedDomain,
    baselineDays: 30,
  };
  const stateSigningKey = readSigningKey(
    required(environment, VARIABLES.sessionSigningKey),
    VARIABLES.sessionSigningKey,
  );
  const secrets = staticSecretProvider({ gmail_oauth_client_secret: bundle.clientSecret });

  if (dependencies === 'recorded') {
    const pushVerifier = options.pushVerifier;
    if (pushVerifier === undefined) {
      // A rehearsal must *name* its fake. Falling back to Google's key set here would
      // make the rehearsal reach the internet; falling back to "accept everything"
      // would make the webhook scenario meaningless.
      throw new DeploymentConfigError('MISSING', 'a recorded deployment must supply its own push verifier');
    }
    return {
      environmentName,
      dependencies,
      mail: {
        gmail: recordedGmailClient({ emailAddress: 'rehearsal@rehearsal.invalid', historyId: '1', messages: [] }),
        config,
        secrets,
        cipher: envelopeCipher(localDataKeyWrapper('rehearsal-envelope')),
        stateSigningKey,
        pushVerifier,
      },
      mailConfig: config,
      suppressionJournal,
      journalDescription: resolved.description,
      sendingEnabled,
      envelopeSource: 'local',
      gmailSource: 'recorded',
      pushVerifierSource: 'fixture',
    };
  }

  const region = required(environment, VARIABLES.region);
  const keyId = required(environment, VARIABLES.envelopeKeyId);
  const transport = await (options.loadKms ?? loadKmsTransport)(region);
  return {
    environmentName,
    dependencies,
    mail: {
      gmail: createGmailHttpClient({ fetch: options.fetch ?? httpFetch, apiBaseUrl: config.apiBaseUrl }),
      config,
      secrets,
      cipher: envelopeCipher(kmsDataKeyWrapper({ keyId, transport })),
      stateSigningKey,
      pushVerifier: googleOidcPushTokenVerifier({ fetch: options.fetch ?? httpFetch }),
    },
    mailConfig: config,
    suppressionJournal,
    journalDescription: resolved.description,
    sendingEnabled,
    envelopeSource: 'kms',
    gmailSource: 'https',
    pushVerifierSource: 'google_jwks',
  };
}

/** The startup line and `--selftest`: which parts are configured, and no value. */
export function describeDeployment(deployment: ApiDeployment): LogFields {
  return {
    environment: deployment.environmentName,
    dependencies: deployment.dependencies,
    gmail_configured: deployment.mail !== undefined,
    gmail_client: deployment.gmailSource,
    envelope_key: deployment.envelopeSource,
    push_verifier: deployment.pushVerifierSource,
    push_audience_configured: (deployment.mailConfig?.pushAudience ?? '').length > 0,
    push_topic_configured: (deployment.mailConfig?.pushTopicName ?? '').length > 0,
    hosted_domain_configured: (deployment.mailConfig?.hostedDomain ?? '').length > 0,
    oauth_secret_configured: deployment.mail !== undefined,
    state_signing_key_configured: deployment.mail !== undefined,
    journal: deployment.journalDescription,
    sending_enabled: deployment.sendingEnabled,
  };
}

/**
 * The S3 put the journal is built over, loaded only by a process that has credentials.
 *
 * `apps/api/src/journal` deliberately imports no SDK; this is the "process with
 * credentials" that file's comment names. A `412` is success: `IfNoneMatch: '*'` means
 * a replayed deterministic id does not overwrite an object that is already durable.
 */
export async function loadJournalPutObject(region: string): Promise<JournalPutObject> {
  const specifier = '@aws-sdk/client-s3';
  const sdk = (await import(specifier)) as {
    S3Client: new (configuration: { region: string }) => { send(command: unknown): Promise<unknown> };
    PutObjectCommand: new (input: Record<string, unknown>) => unknown;
  };
  const client = new sdk.S3Client({ region });
  return async request => {
    try {
      await client.send(
        new sdk.PutObjectCommand({
          Bucket: request.bucket,
          Key: request.key,
          Body: request.body,
          ContentType: request.contentType,
          IfNoneMatch: request.ifNoneMatch,
        }),
      );
      return 'written';
    } catch (error) {
      const name = error instanceof Error ? error.name : 'unknown';
      if (name === 'PreconditionFailed' || name === 'ConditionalRequestConflict') return 'already_present';
      throw error;
    }
  };
}

/** Re-exported so the release suite can compare the two processes' bodies. */
export function apiJournalBody(record: SuppressionJournalRecord): string {
  return journalBody(record);
}

export { journalObjectKey };

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
import {
  createGoogleClient,
  httpFetch as authHttpFetch,
  type GoogleClient,
  type GoogleOidcConfig,
  type SessionPolicy,
} from '../auth/index.ts';
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
 * **Google sign-in.** G12 left `ApiOptions.auth` absent on purpose and said why: an
 * OIDC client half-built by a release lane is worse than one that is honestly missing.
 * G12b builds it whole. A live deployment reads the `google-oidc-client` secret, fixes
 * the redirect URI from `FSS_PUBLIC_ORIGIN`, restricts `hd` to the Workspace domain the
 * task environment carries, and takes the PKCE/state HMAC key from
 * `session-signing-key`. Any part missing is a refusal to start, because an API with no
 * identity answers `/healthz`, `/readyz` and the client-version notice and refuses
 * every command — a deployment nobody can sign in to, which is not a state to reach by
 * omission. A rehearsal names its own client, exactly as it names its own push verifier.
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
  /** Public identifiers `infra/modules/stack` puts in both task definitions (G12b). */
  pushTopic: 'FSS_GMAIL_PUSH_TOPIC',
  hostedDomain: 'FSS_GOOGLE_HOSTED_DOMAIN',
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

/**
 * Google's OpenID Connect issuer and discovery document.
 *
 * Constants rather than configuration: `createGoogleClient` refuses a discovery
 * document whose `issuer` differs and refuses any endpoint it names at another origin,
 * so making these settable would only widen what a deployment can be pointed at.
 */
export const GOOGLE_OIDC_ISSUER = 'https://accounts.google.com';
export const GOOGLE_OIDC_DISCOVERY_URL = 'https://accounts.google.com/.well-known/openid-configuration';

/** 5.1's "bounded clock skew". */
export const OIDC_CLOCK_SKEW_SECONDS = 60;

/**
 * Specification 5.3 as numbers: sessions of about an hour, a device-bound credential
 * that rotates on every use, full Google sign-in every 30 days, and a sign-in that may
 * sit in the browser for ten minutes before it is dead.
 */
export const DEPLOYED_SESSION_POLICY: SessionPolicy = Object.freeze({
  accessSessionSeconds: 3600,
  refreshCredentialSeconds: 30 * 24 * 3600,
  fullSignInSeconds: 30 * 24 * 3600,
  authorizationRequestSeconds: 600,
});

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
  /** Public identifiers, now carried by the environment; the secret is the fallback. */
  readonly pushTopic: string | null;
  readonly hostedDomain: string | null;
}

/** Which of the two places a public identifier was actually read from. */
export type PublicIdentifierSource = 'environment' | 'secret';

/**
 * The same JSON the worker reads, parsed by the same rules.
 *
 * Duplicated rather than shared because `apps/api` and `apps/worker` are separate npm
 * workspaces with no dependency between them, and a shared home for it would have to
 * be `packages/domain`, which this lane does not own. The release suite asserts the
 * two agree on every field name.
 *
 * Both secrets — `google-gmail-oauth-client` and `google-oidc-client` — have this
 * shape. Only the client id and secret are required: `push_topic` and `hosted_domain`
 * are public identifiers that the task environment carries since G12b, and they are
 * read here only as a one-release fallback.
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
 * infrastructure does not also have to rewrite the secret. When neither has it, the
 * refusal names *both* places it looked.
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

/**
 * Everything G2's `AuthDeps` needs that is not a database session.
 *
 * `bootstrap/main.ts` adds the session, the clock, the random source and the
 * container's client-version range; nothing here touches a row, so it can all be
 * decided before a socket or a connection is opened.
 */
export interface ApiSignIn {
  readonly oidc: GoogleOidcConfig;
  readonly sessions: SessionPolicy;
  /** 32 bytes or more. Also the HMAC the PKCE verifier is derived from (g2-pkce). */
  readonly stateSigningKey: Buffer;
  readonly google: GoogleClient;
}

export interface ApiDeployment {
  readonly environmentName: string;
  readonly dependencies: DependencySelection;
  /** Absent when `dependencies` is `none`; the four mail paths then answer not_found. */
  readonly mail: MailRoutingDeps | undefined;
  readonly mailConfig: MailPublicConfig | undefined;
  /** Absent only when `dependencies` is `none`, which production refuses. */
  readonly auth: ApiSignIn | undefined;
  readonly suppressionJournal: SuppressionJournal;
  readonly journalDescription: 's3' | 'local_noop';
  /** 16.2's deployment half. False unless the variable says true. */
  readonly sendingEnabled: boolean;
  readonly envelopeSource: 'kms' | 'local' | 'absent';
  readonly gmailSource: 'https' | 'recorded' | 'absent';
  readonly pushVerifierSource: 'google_jwks' | 'fixture' | 'absent';
  readonly signInSource: 'google' | 'fixture' | 'absent';
  readonly pushTopicSource: PublicIdentifierSource | 'absent';
  readonly hostedDomainSource: PublicIdentifierSource | 'absent';
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
  /** G2's OpenID Connect client. A rehearsal names its fake; `live` builds the real one. */
  readonly signInClient?: GoogleClient | undefined;
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
      auth: undefined,
      suppressionJournal,
      journalDescription: resolved.description,
      sendingEnabled,
      envelopeSource: 'absent',
      gmailSource: 'absent',
      pushVerifierSource: 'absent',
      signInSource: 'absent',
      pushTopicSource: 'absent',
      hostedDomainSource: 'absent',
    };
  }

  const bundle = readGoogleClientBundle(
    required(environment, VARIABLES.gmailOAuthClient),
    VARIABLES.gmailOAuthClient,
  );
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
    redirectUri: `${origin}/oauth/gmail/callback`,
    authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
    revocationEndpoint: 'https://oauth2.googleapis.com/revoke',
    apiBaseUrl: 'https://gmail.googleapis.com',
    pushTopicName: pushTopic.value,
    pushAudience: required(environment, VARIABLES.pushAudience),
    pushServiceAccountEmail: required(environment, VARIABLES.pushServiceAccount),
    hostedDomain: hostedDomain.value,
    baselineDays: 30,
  };
  const stateSigningKey = readSigningKey(
    required(environment, VARIABLES.sessionSigningKey),
    VARIABLES.sessionSigningKey,
  );
  const secrets = staticSecretProvider({ gmail_oauth_client_secret: bundle.clientSecret });

  // 5.1's sign-in client, which is *not* the Gmail one: a separate registration with
  // `openid email profile` only, and one redirect URI per environment fixed by the
  // API's own hostname (docs/decisions/g2-redirect-target.md).
  const signInBundle = readGoogleClientBundle(required(environment, VARIABLES.oidcClient), VARIABLES.oidcClient);
  const oidc: GoogleOidcConfig = {
    issuer: GOOGLE_OIDC_ISSUER,
    discoveryUrl: GOOGLE_OIDC_DISCOVERY_URL,
    clientId: signInBundle.clientId,
    clientSecret: signInBundle.clientSecret,
    redirectUri: `${origin}/auth/google/callback`,
    hostedDomain: hostedDomain.value,
    clockSkewSeconds: OIDC_CLOCK_SKEW_SECONDS,
  };

  if (dependencies === 'recorded') {
    const pushVerifier = options.pushVerifier;
    if (pushVerifier === undefined) {
      // A rehearsal must *name* its fake. Falling back to Google's key set here would
      // make the rehearsal reach the internet; falling back to "accept everything"
      // would make the webhook scenario meaningless.
      throw new DeploymentConfigError('MISSING', 'a recorded deployment must supply its own push verifier');
    }
    const signInClient = options.signInClient;
    if (signInClient === undefined) {
      // The same rule for the same reason: a rehearsal that reached
      // accounts.google.com for a discovery document and a key set would be testing
      // Google's availability, not the release.
      throw new DeploymentConfigError('MISSING', 'a recorded deployment must supply its own sign-in client');
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
      auth: { oidc, sessions: DEPLOYED_SESSION_POLICY, stateSigningKey, google: signInClient },
      suppressionJournal,
      journalDescription: resolved.description,
      sendingEnabled,
      envelopeSource: 'local',
      gmailSource: 'recorded',
      pushVerifierSource: 'fixture',
      signInSource: 'fixture',
      pushTopicSource: pushTopic.source,
      hostedDomainSource: hostedDomain.source,
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
    auth: {
      oidc,
      sessions: DEPLOYED_SESSION_POLICY,
      stateSigningKey,
      google: createGoogleClient({
        fetch: options.fetch ?? authHttpFetch,
        now: () => new Date(),
      }),
    },
    suppressionJournal,
    journalDescription: resolved.description,
    sendingEnabled,
    envelopeSource: 'kms',
    gmailSource: 'https',
    pushVerifierSource: 'google_jwks',
    signInSource: 'google',
    pushTopicSource: pushTopic.source,
    hostedDomainSource: hostedDomain.source,
  };
}

/**
 * The startup line and `--selftest`: which parts are configured, and no value.
 *
 * Every field is a boolean or one of a closed set. Not the sign-in client id, not the
 * redirect URI, not the hosted domain — those are public identifiers, but the rule
 * that this line carries no operator-supplied string is easier to keep than to
 * re-examine each time somebody adds a field, and `deployment.test.ts` asserts it by
 * feeding the reader a generated marker and searching the output for it.
 */
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
    push_topic_source: deployment.pushTopicSource,
    hosted_domain_configured: (deployment.mailConfig?.hostedDomain ?? '').length > 0,
    hosted_domain_source: deployment.hostedDomainSource,
    oauth_secret_configured: deployment.mail !== undefined,
    state_signing_key_configured: deployment.mail !== undefined,
    // 5.1's four parts, each named separately, so a deployment missing one is
    // readable in the startup line rather than only in the refusal that preceded it.
    sign_in: deployment.signInSource,
    sign_in_client_configured: (deployment.auth?.oidc.clientId ?? '').length > 0,
    sign_in_secret_configured: (deployment.auth?.oidc.clientSecret ?? '').length > 0,
    sign_in_redirect_configured: (deployment.auth?.oidc.redirectUri ?? '').length > 0,
    sign_in_hosted_domain_configured: (deployment.auth?.oidc.hostedDomain ?? '').length > 0,
    session_signing_key_configured: (deployment.auth?.stateSigningKey.length ?? 0) >= 32,
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

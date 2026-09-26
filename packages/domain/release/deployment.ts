import type { MailPublicConfig } from '../mail/config.ts';
import { DEFAULT_BASELINE_DAYS } from '../mail/types.ts';

/**
 * What a deployed process was given, read the same way by the API and the worker.
 *
 * `FSS_DEPENDENCIES` is the switch, and it has no fallback in production:
 *
 *   * `live` builds every real adapter from the deployed configuration; any missing part
 *     is a `DeploymentConfigError` and the process exits;
 *   * `recorded` is the rehearsal selection, chosen explicitly, never by omission;
 *   * `none` is a laptop's: no Gmail and no classifier. `FSS_ENVIRONMENT=production`
 *     refuses it, so a production process never reaches a no-op except by a value
 *     somebody typed.
 *
 * The Google configuration is one operator-written secret per client, injected under
 * its logical Secrets Manager name. The Pub/Sub topic and the Workspace domain are
 * public identifiers the task environment carries (`FSS_GMAIL_PUSH_TOPIC`,
 * `FSS_GOOGLE_HOSTED_DOMAIN`); the secret's copy is read only as a fallback
 * (`docs/decisions/g12b-two-public-identifiers-move-out-of-the-secret.md`).
 *
 * Nothing here logs a value; an error names the variable, never what it held. Each
 * process adds its own adapters and its own startup line in
 * `apps/<process>/src/bootstrap/deployment.ts`.
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

export type DeploymentEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * The environment variables both processes read. Each process's
 * `DEPLOYMENT_ENVIRONMENT_VARIABLES` is this map plus the names only it reads.
 */
export const SHARED_DEPLOYMENT_VARIABLES = Object.freeze({
  environmentName: 'FSS_ENVIRONMENT',
  dependencies: 'FSS_DEPENDENCIES',
  region: 'AWS_REGION',
  publicOrigin: 'FSS_PUBLIC_ORIGIN',
  envelopeKeyId: 'FSS_ENVELOPE_KEY_ID',
  journalBucket: 'FSS_JOURNAL_BUCKET',
  pushAudience: 'FSS_GMAIL_PUSH_AUDIENCE',
  pushServiceAccount: 'FSS_GMAIL_PUSH_SERVICE_ACCOUNT',
  /** Public identifiers `infra/modules/stack` puts in both task definitions. */
  pushTopic: 'FSS_GMAIL_PUSH_TOPIC',
  hostedDomain: 'FSS_GOOGLE_HOSTED_DOMAIN',
  sendingEnabled: 'FSS_SENDING_ENABLED',
  /** The ECS `secrets` block names each entry by its logical Secrets Manager name. */
  gmailOAuthClient: 'google-gmail-oauth-client',
  oidcClient: 'google-oidc-client',
} as const);

const VARIABLES = SHARED_DEPLOYMENT_VARIABLES;

export function requiredVariable(environment: DeploymentEnvironment, name: string): string {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0) {
    // The name, never the value: an environment variable is an operator's input.
    throw new DeploymentConfigError('MISSING', `${name} is not set`);
  }
  return value;
}

/**
 * A Google client bundle an operator pasted, as JSON. Both `google-gmail-oauth-client`
 * and `google-oidc-client` have this shape. The client id and secret are refused rather
 * than defaulted; `push_topic` and `hosted_domain` are the one-release fallback for the
 * public identifiers the environment now carries.
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
  environment: DeploymentEnvironment,
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
 * Whether `FSS_ENVIRONMENT` names production: trimmed and case-blind, the one comparison
 * the dependency switch, the upgrade URL and the release-record binding all make.
 */
export function isProductionEnvironmentName(environmentName: string | undefined): boolean {
  return environmentName?.trim().toLowerCase() === 'production';
}

export function readDependencySelection(environment: DeploymentEnvironment): DependencySelection {
  const raw = environment[VARIABLES.dependencies]?.trim().toLowerCase();
  const production = isProductionEnvironmentName(environment[VARIABLES.environmentName]);
  if (raw === undefined || raw.length === 0) {
    // A production process that read no switch would run with whatever the code's
    // fallback happened to be. Outside production the absence is allowed and means `none`.
    if (production) {
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
  if (production && raw !== 'live') {
    throw new DeploymentConfigError(
      'PRODUCTION_REQUIRES_LIVE',
      `${VARIABLES.environmentName} is production, so ${VARIABLES.dependencies} may only be live`,
    );
  }
  return raw;
}

/** A `true`/`false` variable; unset is `false`, anything else is a refusal. */
export function readBooleanFlag(environment: DeploymentEnvironment, name: string): boolean {
  const raw = environment[name]?.trim().toLowerCase();
  if (raw === undefined || raw.length === 0) return false;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new DeploymentConfigError('INVALID', `${name} must be true or false`);
}

export interface ResolvedMailConfig {
  readonly config: MailPublicConfig;
  readonly pushTopicSource: PublicIdentifierSource;
  readonly hostedDomainSource: PublicIdentifierSource;
}

/** The Gmail lane's public configuration, from the Gmail client bundle and the environment. */
export function readMailPublicConfig(bundle: GoogleClientBundle, environment: DeploymentEnvironment): ResolvedMailConfig {
  const origin = requiredVariable(environment, VARIABLES.publicOrigin).replace(/\/+$/u, '');
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
    // Exactly what is registered with Google: this path on the API's own origin, so it
    // is derived rather than configured twice.
    redirectUri: `${origin}/oauth/gmail/callback`,
    authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
    revocationEndpoint: 'https://oauth2.googleapis.com/revoke',
    apiBaseUrl: 'https://gmail.googleapis.com',
    pushTopicName: pushTopic.value,
    pushAudience: requiredVariable(environment, VARIABLES.pushAudience),
    pushServiceAccountEmail: requiredVariable(environment, VARIABLES.pushServiceAccount),
    hostedDomain: hostedDomain.value,
    baselineDays: DEFAULT_BASELINE_DAYS,
  };
  return { config, pushTopicSource: pushTopic.source, hostedDomainSource: hostedDomain.source };
}

/**
 * The address the recorded Gmail fake answers for in a rehearsal. `.invalid` is reserved
 * by RFC 2606 and can never be a real mailbox.
 */
export const REHEARSAL_MAILBOX_ADDRESS = 'rehearsal@rehearsal.invalid';

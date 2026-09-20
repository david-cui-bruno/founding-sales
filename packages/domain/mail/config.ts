import type { GmailOAuthConfig } from './gmailClient.ts';
import type { SecretProvider } from './secretProvider.ts';
import { DEFAULT_PUSH_TOKEN_POLICY, type PushTokenPolicy } from './pushToken.ts';

/**
 * What a deployment tells the mail lane (specification 4.1, 5.1, 12.1).
 *
 * Every value here is a public identifier — a client id, a redirect URI, a Pub/Sub
 * topic, a service-account address, an audience. The one secret, the Gmail OAuth
 * client secret, is not in this object at all: it is read from the injected
 * `SecretProvider` at the moment a token exchange needs it, and it exists for the
 * length of that call.
 *
 * The values Callie actually uses are in
 * `.context/FSS-GREENFIELD-ACCOUNT-IDENTIFIERS-20260920.md` and in the Terraform
 * variables; nothing in this repository hard-codes them, because rehearsal and
 * production must be able to differ on every one.
 */

export interface MailPublicConfig {
  /** The `fss-greenfield-gmail` web client id. A public identifier. */
  readonly clientId: string;
  /** `https://<api host>/oauth/gmail/callback`, exactly as registered with Google. */
  readonly redirectUri: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly revocationEndpoint: string;
  readonly apiBaseUrl: string;
  /** The fully qualified Pub/Sub topic `infra/modules/pubsub` outputs. */
  readonly pushTopicName: string;
  /** The exact audience the webhook requires, and the push identity it expects. */
  readonly pushAudience: string;
  readonly pushServiceAccountEmail: string;
  /** The Workspace domain a connectable mailbox must belong to. */
  readonly hostedDomain: string;
  /** 12.3's "configured recent-history interval", in days. */
  readonly baselineDays: number;
}

export const GOOGLE_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOCATION_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
export const GMAIL_API_BASE_URL = 'https://gmail.googleapis.com';

/**
 * The OAuth configuration for one call, with the secret fetched now and held by the
 * caller's stack frame and nothing else.
 */
export async function resolveGmailOAuthConfig(
  config: MailPublicConfig,
  secrets: SecretProvider,
): Promise<GmailOAuthConfig> {
  return {
    clientId: config.clientId,
    clientSecret: await secrets.read('gmail_oauth_client_secret'),
    redirectUri: config.redirectUri,
    authorizationEndpoint: config.authorizationEndpoint,
    tokenEndpoint: config.tokenEndpoint,
    revocationEndpoint: config.revocationEndpoint,
    apiBaseUrl: config.apiBaseUrl,
  };
}

export function pushTokenPolicyOf(config: MailPublicConfig): PushTokenPolicy {
  return {
    issuer: DEFAULT_PUSH_TOKEN_POLICY.issuer,
    audience: config.pushAudience,
    serviceAccountEmail: config.pushServiceAccountEmail,
    clockSkewSeconds: DEFAULT_PUSH_TOKEN_POLICY.clockSkewSeconds,
    maximumAgeSeconds: DEFAULT_PUSH_TOKEN_POLICY.maximumAgeSeconds,
  };
}

/** The startup line. Public identifiers only, and the secret named but never read. */
export function describeMailConfig(config: MailPublicConfig): Readonly<Record<string, unknown>> {
  return {
    gmail_client_id: config.clientId,
    gmail_redirect_uri: config.redirectUri,
    push_topic: config.pushTopicName,
    push_audience: config.pushAudience,
    push_service_account: config.pushServiceAccountEmail,
    hosted_domain: config.hostedDomain,
    baseline_days: config.baselineDays,
  };
}

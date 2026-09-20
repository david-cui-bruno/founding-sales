import type { ClientVersionRange } from '@fss/contracts';
import type { SessionQueryable } from '@fss/domain/db';
import type { GoogleClient } from './googleClient.ts';

/**
 * Everything identity needs that is not a row (specification 5.1, 5.3).
 *
 * The Google client secret and the state-signing key arrive as values, read once at
 * boot from Secrets Manager by reference. Neither is ever written to the database, to
 * a log line, or to a fixture: the tests generate both when they start.
 */

export interface GoogleOidcConfig {
  /** The `iss` every id token must carry, and the origin the discovery document must agree with. */
  readonly issuer: string;
  readonly discoveryUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** The API's own HTTPS callback. See docs/decisions/g2-redirect-target.md. */
  readonly redirectUri: string;
  /** The Google Workspace domain; an id token whose `hd` differs is refused. */
  readonly hostedDomain: string;
  /** How far either way a token's instants may be wrong before it is refused. */
  readonly clockSkewSeconds: number;
}

export interface SessionPolicy {
  /** "about one hour" (5.3). */
  readonly accessSessionSeconds: number;
  readonly refreshCredentialSeconds: number;
  /** "Full Google sign-in recurs every 30 days" (5.3). Never extended by a renewal. */
  readonly fullSignInSeconds: number;
  /** How long a started sign-in may wait in the browser before it is dead. */
  readonly authorizationRequestSeconds: number;
}

export interface AuthConfig {
  readonly oidc: GoogleOidcConfig;
  readonly sessions: SessionPolicy;
  readonly supportedClientVersions: ClientVersionRange;
  /**
   * The HMAC key the PKCE verifier is derived from. Deriving rather than storing is
   * what keeps the database free of anything presentable to Google; see
   * docs/decisions/g2-pkce-verifier-derivation.md.
   */
  readonly stateSigningKey: Buffer;
}

export interface AuthDeps {
  readonly db: SessionQueryable;
  readonly config: AuthConfig;
  readonly google: GoogleClient;
  /** Every instant in identity comes from here, never from `Date.now()`. */
  readonly now: () => Date;
  /** 32 random bytes, base64url. The only source of a secret in this package. */
  readonly randomSecret: () => string;
}

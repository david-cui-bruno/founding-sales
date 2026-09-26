import type { ClientVersionPolicy } from '@fss/contracts';
import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
import type { SuppressionJournal } from '@fss/domain/suppression/journal.ts';
import type { MailGrantDeps } from '@fss/domain/mail/oauth.ts';
import type { PushTokenVerifier } from '@fss/domain/mail/pushToken.ts';
import type { AuthDeps } from '../auth/config.ts';
import type { Logger } from '../bootstrap/log.ts';

/**
 * What a route is given and what it hands back.
 *
 * A route is a pure async function of this envelope, so every route in the API is
 * testable without binding a port — the same shape `docs/decisions/g0-api-http-server.md`
 * chose for `/health`, widened just enough to carry headers, a query string and a
 * parsed body.
 */

export interface ApiRequest {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  /** Lower-cased header names, as `node:http` gives them. */
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** Already parsed from JSON, or undefined for a bodyless request. */
  readonly body: unknown;
}

export interface RouteResult {
  readonly status: number;
  readonly body: unknown;
  /** Defaults to `application/json; charset=utf-8`. */
  readonly contentType?: string;
}

export interface RoutingOptions {
  readonly session: SessionQueryable;
  /** The policy (lane g78). A route that answers with versions publishes `publishedClientVersions` of it. */
  readonly supportedClientVersions: ClientVersionPolicy;
  readonly sendingEnabled: boolean;
  /** Absent in the health-only skeleton; present once identity is configured. */
  readonly auth?: AuthDeps;
  /**
   * What `/auth/client-version` publishes as `upgradeUrl`: in production the signed
   * update manifest the desktop reads (`FSS_DESKTOP_UPGRADE_URL`, lane g86), elsewhere
   * `DEFAULT_UPGRADE_URL`. Machine-facing; the Mac shows a sentence, never this.
   */
  readonly upgradeUrl: string;
  /**
   * The object-locked journal every suppression is written to before its row
   * (10.2). Always present: `routingOptions` supplies the local no-op when the
   * deployment has no bucket, so a route never has to decide what to do without one.
   */
  readonly suppressionJournal: SuppressionJournal;
  /**
   * Everything the Gmail grant, the webhook and the message view need (12.1 to 12.3).
   *
   * Absent in a deployment that has not been given its Google configuration, exactly
   * as `auth` is: the four mail paths then answer `not_found` rather than half
   * working. The one secret it implies — the OAuth client secret — is not in here; it
   * is behind `MailGrantDeps.secrets`, which is read at the moment an exchange needs
   * it and never held.
   */
  readonly mail?: MailRoutingDeps;
  /** The structured log; the safety metric filters read it. Absent in unit tests. */
  readonly log?: Logger | undefined;
  /**
   * The digest of the API image serving this request, as the bootstrap discovered it
   * (`discoverImageDigest`), or `unknown` (lane g71). An enable of production sending
   * names a release record whose API digest must be this one; absent is unknown, and
   * unknown refuses every enable (`release_record_identity_unknown`).
   */
  readonly imageDigest?: string | undefined;
}

export interface MailRoutingDeps extends MailGrantDeps {
  /** Verifies the Pub/Sub push token's signature. The claims are checked separately. */
  readonly pushVerifier: PushTokenVerifier;
}

/**
 * The placeholder a laptop, a route test and a rehearsal publish. A production API
 * refuses to start rather than publish it (`readUpgradeUrl` in `bootstrap/deployment.ts`).
 */
export const DEFAULT_UPGRADE_URL = 'https://callie.example/downloads/mac';

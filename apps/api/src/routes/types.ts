import type { ClientVersionRange } from '@fss/contracts';
import type { SessionQueryable } from '@fss/domain/db';
import type { SuppressionJournal } from '@fss/domain/suppression';
import type { MailGrantDeps, PushTokenVerifier } from '@fss/domain/mail';
import type { AuthDeps } from '../auth/index.ts';
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
  readonly supportedClientVersions: ClientVersionRange;
  readonly sendingEnabled: boolean;
  /** Absent in the health-only skeleton; present once identity is configured. */
  readonly auth?: AuthDeps;
  /** Where a person is told to get the current build. A public URL. */
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
  /** The structured log the CloudWatch metric filters read. Absent in unit tests. */
  readonly log?: Logger | undefined;
}

export interface MailRoutingDeps extends MailGrantDeps {
  /** Verifies the Pub/Sub push token's signature. The claims are checked separately. */
  readonly pushVerifier: PushTokenVerifier;
}

export const DEFAULT_UPGRADE_URL = 'https://callie.example/downloads/mac';

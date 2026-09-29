import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
import { API_SCHEMA_RANGE, checkSchemaRange } from '@fss/domain/db/schemaRange.ts';
import { buildCommit } from '@fss/domain/release/identity.ts';
import { publishedClientVersions, type ClientVersionPolicy, type ClientVersionRange } from '@fss/contracts';

/**
 * The health route (specification 4.2 and 5.3).
 *
 * It reports the schema range this binary accepts and the version the database is
 * actually at. It reports no secret, no connection string, no prospect data and no host
 * detail.
 *
 * `status` is `serving` only when the database answered and its schema version is
 * inside the declared range. Anything else is `degraded`: the API is running, and it
 * is saying so rather than pretending.
 *
 * `build.commit` is the commit the running image was built from. It is here because
 * this document is the only thing a reader can ask production without a credential,
 * and "which schema" was answerable while "which code" was not — so a gate that needed
 * the commit trusted a repository variable instead. A commit is a public identifier,
 * like the image digest already in the task definition; nothing else about the build
 * belongs in an unauthenticated document.
 */

export interface HealthReport {
  readonly status: 'serving' | 'degraded';
  readonly component: 'api';
  readonly schema: {
    readonly declaredRange: { readonly minimum: number; readonly maximum: number };
    readonly databaseVersion: number | null;
    readonly accepted: boolean;
    readonly reason: 'database_behind_binary' | 'database_ahead_of_binary' | 'database_unreachable' | null;
  };
  readonly build: {
    /**
     * The forty-character commit the image was built from, or `null` when this process
     * cannot prove one: a locally run API, and every image built before the build
     * argument existed. Never a guess — see `buildCommit`.
     */
    readonly commit: string | null;
  };
  readonly supportedClientVersions: ClientVersionRange;
  /** Whether production sending has been enabled by an authenticated admin (16.2). */
  readonly sendingEnabled: boolean;
}

export interface HealthInputs {
  readonly session: SessionQueryable;
  readonly supportedClientVersions: ClientVersionPolicy;
  readonly sendingEnabled: boolean;
  /**
   * Where `FSS_BUILD_COMMIT` is read from. Optional, and the process environment by
   * default, so the route's existing options object needs no new field and the
   * bootstrap needs no change; a test supplies its own rather than mutating the
   * process's.
   */
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined;
}

export async function buildHealthReport(inputs: HealthInputs): Promise<HealthReport> {
  const declaredRange = { minimum: API_SCHEMA_RANGE.minimum, maximum: API_SCHEMA_RANGE.maximum };
  const build = { commit: buildCommit(inputs.environment ?? process.env) };
  try {
    const check = await checkSchemaRange(inputs.session, API_SCHEMA_RANGE);
    return {
      status: check.accepted ? 'serving' : 'degraded',
      component: 'api',
      schema: {
        declaredRange,
        databaseVersion: check.version,
        accepted: check.accepted,
        reason: check.accepted ? null : check.reason,
      },
      build,
      supportedClientVersions: publishedClientVersions(inputs.supportedClientVersions),
      sendingEnabled: inputs.sendingEnabled,
    };
  } catch {
    // The reason is deliberately not carried out of the catch: it may name a host,
    // a role or a database. The operator reads the cause in the structured log.
    return {
      status: 'degraded',
      component: 'api',
      schema: { declaredRange, databaseVersion: null, accepted: false, reason: 'database_unreachable' },
      build,
      supportedClientVersions: publishedClientVersions(inputs.supportedClientVersions),
      sendingEnabled: inputs.sendingEnabled,
    };
  }
}

import type { SessionQueryable } from '@fss/domain/db';
import { API_SCHEMA_RANGE, checkSchemaRange, readSystemGeneration } from '@fss/domain/db';
import { publishedClientVersions, type ClientVersionPolicy, type ClientVersionRange } from '@fss/contracts';

/**
 * The health route (specification 4.2 and 5.3).
 *
 * It reports the schema range this binary accepts, the version the database is
 * actually at, and the system generation — which is what an operator compares with the
 * expected generation after a restore (Appendix E step 1). It reports no secret, no
 * connection string, no prospect data and no host detail.
 *
 * `status` is `serving` only when the database answered and its schema version is
 * inside the declared range. Anything else is `degraded`: the API is running, and it
 * is saying so rather than pretending.
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
  /** Null when the database did not answer. Never guessed. */
  readonly systemGeneration: number | null;
  readonly supportedClientVersions: ClientVersionRange;
  /** Whether production sending has been enabled by an authenticated admin (16.2). */
  readonly sendingEnabled: boolean;
}

export interface HealthInputs {
  readonly session: SessionQueryable;
  readonly supportedClientVersions: ClientVersionPolicy;
  readonly sendingEnabled: boolean;
}

export async function buildHealthReport(inputs: HealthInputs): Promise<HealthReport> {
  const declaredRange = { minimum: API_SCHEMA_RANGE.minimum, maximum: API_SCHEMA_RANGE.maximum };
  try {
    const check = await checkSchemaRange(inputs.session, API_SCHEMA_RANGE);
    const generation = await readSystemGeneration(inputs.session);
    return {
      status: check.accepted ? 'serving' : 'degraded',
      component: 'api',
      schema: {
        declaredRange,
        databaseVersion: check.version,
        accepted: check.accepted,
        reason: check.accepted ? null : check.reason,
      },
      systemGeneration: generation,
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
      systemGeneration: null,
      supportedClientVersions: publishedClientVersions(inputs.supportedClientVersions),
      sendingEnabled: inputs.sendingEnabled,
    };
  }
}

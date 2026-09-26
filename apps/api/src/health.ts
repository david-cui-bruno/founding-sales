import type { SessionQueryable } from '@fss/domain/db';
import { API_SCHEMA_RANGE, checkSchemaRange } from '@fss/domain/db';
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
    return {
      status: check.accepted ? 'serving' : 'degraded',
      component: 'api',
      schema: {
        declaredRange,
        databaseVersion: check.version,
        accepted: check.accepted,
        reason: check.accepted ? null : check.reason,
      },
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
      supportedClientVersions: publishedClientVersions(inputs.supportedClientVersions),
      sendingEnabled: inputs.sendingEnabled,
    };
  }
}

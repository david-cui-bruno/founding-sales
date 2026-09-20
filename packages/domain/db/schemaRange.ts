import type { SessionQueryable } from './queryable.ts';
import { readAppliedSchemaVersion } from './migrationRunner.ts';

/**
 * Declared schema ranges (specification 4.2: "API and worker declare accepted schema
 * ranges"; Appendix G 22: "old API with new worker and reverse across every
 * expand/contract phase obey schema ranges").
 *
 * Deployment order under expand, migrate, contract is: widen the range, ship that
 * release, then ship the migration. So PREVIOUS_RELEASE_SCHEMA_RANGE must already
 * cover the version the next migration produces, and the migration compatibility
 * test in test/db/migrations.test.ts fails the build when it does not.
 */

export interface SchemaRange {
  readonly minimum: number;
  readonly maximum: number;
}

/** The highest migration version this source tree contains. */
export const CURRENT_SCHEMA_VERSION = 1;

/** The range the release before this one declared. Widen this one release ahead of the migration. */
export const PREVIOUS_RELEASE_SCHEMA_RANGE: SchemaRange = { minimum: 1, maximum: 1 };

export const API_SCHEMA_RANGE: SchemaRange = { minimum: 1, maximum: 1 };
export const WORKER_SCHEMA_RANGE: SchemaRange = { minimum: 1, maximum: 1 };

export function acceptsSchemaVersion(range: SchemaRange, version: number): boolean {
  return Number.isInteger(version) && version >= range.minimum && version <= range.maximum;
}

export type SchemaRangeCheck =
  | { readonly accepted: true; readonly version: number; readonly range: SchemaRange }
  | {
      readonly accepted: false;
      readonly version: number;
      readonly range: SchemaRange;
      readonly reason: 'database_behind_binary' | 'database_ahead_of_binary';
    };

/**
 * Compare the database's applied schema version with a declared range. Fails closed:
 * an unmigrated database (version 0) is `database_behind_binary`, never "probably fine".
 */
export async function checkSchemaRange(session: SessionQueryable, range: SchemaRange): Promise<SchemaRangeCheck> {
  const version = await readAppliedSchemaVersion(session);
  if (acceptsSchemaVersion(range, version)) return { accepted: true, version, range };
  return {
    accepted: false,
    version,
    range,
    reason: version < range.minimum ? 'database_behind_binary' : 'database_ahead_of_binary',
  };
}

/** The current system generation (Appendix E). 0 when the table has never been written. */
export async function readSystemGeneration(session: SessionQueryable): Promise<number> {
  const { rows } = await session.query<{ generation: string | null }>(
    'SELECT max(generation)::text AS generation FROM system_generations',
  );
  const value = rows[0]?.generation;
  return value === null || value === undefined ? 0 : Number(value);
}

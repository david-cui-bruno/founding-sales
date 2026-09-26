import type { SessionQueryable } from './queryable.ts';
import { readAppliedSchemaVersion } from './migrationRunner.ts';

/**
 * The schema version this source tree produces and the one both services accept.
 *
 * Every range is a point, `{N, N}`: a release that changes the schema is deployed with
 * `infra/scripts/release-deploy.sh … --schema-change`, which stops both services, applies
 * the migrations and starts the new images (docs/greenfield/release.md). So the
 * previous release's images never meet the new schema, and the new images never meet
 * the old one; each refuses the other at startup (`checkSchemaRange`).
 *
 * A schema release moves the current version and both service ranges.
 * `test/db/migrations.test.ts` holds the contract against a real database: the images of
 * the release before, which declare `{N-1, N-1}` for both services, refuse the new
 * version, and the new images accept it.
 */

export interface SchemaRange {
  readonly minimum: number;
  readonly maximum: number;
}

/** The highest migration version this source tree contains. */
export const CURRENT_SCHEMA_VERSION = 19;

/**
 * The overlap input of Appendix G 22's rehearsal step (`infra/scripts/rehearsal-schema-ranges.sh`,
 * `test/ops/scenario22.check.ts`), widened to the current version as every schema release
 * before did. It is **not** what the previous images accept: those declare `{18, 18}` and
 * refuse schema 19, which `test/db/migrations.test.ts` asserts. The rehearsal's overlap
 * case launches a `-previous` family nothing registers, so it records
 * `skipped_no_previous` either way. (Making this `{18, 18}` needs the three overlap checks
 * in `scenario22.check.ts` changed with it.)
 */
export const PREVIOUS_RELEASE_SCHEMA_RANGE: SchemaRange = { minimum: 1, maximum: 19 };

/**
 * Migration 0019 drops what the previous images still name (research, the enrollment
 * migration tables, `direct_sent`, `record_merge_events`) and the new images need its
 * relaxed triggers and `postal_address` key, so neither range reaches back to 18.
 */
export const API_SCHEMA_RANGE: SchemaRange = { minimum: 19, maximum: 19 };
export const WORKER_SCHEMA_RANGE: SchemaRange = { minimum: 19, maximum: 19 };

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

/**
 * The current system generation (Appendix E).
 *
 * Null, not zero, when the table does not exist yet or has no row: a database the
 * foundation migration has not reached has no generation, and saying "0" would let a
 * caller compare it with an operator's expected generation as though it were one.
 */
export async function readSystemGeneration(session: SessionQueryable): Promise<number | null> {
  const present = await session.query<{ present: boolean }>(
    "SELECT to_regclass('public.system_generations') IS NOT NULL AS present",
  );
  if (present.rows[0]?.present !== true) return null;
  const { rows } = await session.query<{ generation: string | null }>(
    'SELECT max(generation)::text AS generation FROM system_generations',
  );
  const value = rows[0]?.generation;
  return value === null || value === undefined ? null : Number(value);
}

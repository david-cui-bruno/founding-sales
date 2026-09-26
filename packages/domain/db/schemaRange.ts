import type { SessionQueryable } from './queryable.ts';
import { readAppliedSchemaVersion } from './migrationRunner.ts';

/**
 * The schema this source tree produces and the only one either service accepts.
 *
 * A release that changes the schema stops both services, applies the migrations and
 * starts the new images (`infra/scripts/release-deploy.sh … --schema-change`,
 * docs/greenfield/release.md), so an image only ever meets its own schema and refuses
 * any other at startup (`checkSchemaRange`). A schema release changes this number and
 * nothing else here; `test/db/migrations.test.ts` holds it to the last migration.
 */
export const REQUIRED_SCHEMA = 19;

export interface SchemaRange {
  readonly minimum: number;
  readonly maximum: number;
}

/**
 * The names the release scripts and workflows read from this file with `node`
 * (`rehearsal-schema-ranges.sh`, `release-rollback.sh`, `productionSmoke.mjs`, the image
 * and deploy workflows). Keep the names; every value derives from `REQUIRED_SCHEMA`.
 */
export const CURRENT_SCHEMA_VERSION = REQUIRED_SCHEMA;
export const API_SCHEMA_RANGE: SchemaRange = { minimum: REQUIRED_SCHEMA, maximum: REQUIRED_SCHEMA };
export const WORKER_SCHEMA_RANGE: SchemaRange = { minimum: REQUIRED_SCHEMA, maximum: REQUIRED_SCHEMA };

/**
 * The overlap input of Appendix G 22's rehearsal step (`rehearsal-schema-ranges.sh`,
 * `test/ops/scenario22.check.ts`). It is not what the previous images accept: those
 * require the schema before this one and refuse `REQUIRED_SCHEMA`.
 */
export const PREVIOUS_RELEASE_SCHEMA_RANGE: SchemaRange = { minimum: 1, maximum: REQUIRED_SCHEMA };

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

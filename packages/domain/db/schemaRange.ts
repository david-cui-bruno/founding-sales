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
export const CURRENT_SCHEMA_VERSION = 5;

/**
 * The range the release before this one declared. Widen this one release ahead of the
 * migration.
 *
 * Lanes G5 and G2 shipped migrations 0002 and 0003 from the same main and each widened
 * this constant for its own; lane G3a widened it again for migration 0004, G3b for
 * 0005, and lane G10 for the research migration. A merge that finds two different
 * maxima takes the larger. That is honest only because nothing has been deployed —
 * G0's {1, 1} was never a promise made to a running production binary. From the first
 * real deployment onwards the widening must precede the migration by a release, and
 * the compatibility test will keep saying so.
 */
export const PREVIOUS_RELEASE_SCHEMA_RANGE: SchemaRange = { minimum: 1, maximum: 5 };

/**
 * Both services need migration 0002's shape: the API's dead-job list reads `dead_at`
 * and `requeued_count`, and the worker's claim writes `fencing_token`. A binary that
 * needs a column states so rather than starting and failing on the first statement, so
 * neither accepts a version-1 database; see docs/decisions/g5-schema-range.md.
 *
 * The API additionally needs migration 0003 — no session, device credential or
 * authorization request exists before it, so an API on a version-2 database could not
 * authenticate anybody — and migration 0004, because its CRM routes read `firms`,
 * `contacts`, `opportunities` and the default pipeline. Its minimum is therefore 4,
 * for the same reason the minimum was 2 and then 3.
 *
 * The worker read none of those tables before this lane, so its minimum was 2, which
 * is what let a rolling deployment run an old worker beside a new API (Appendix G 22).
 * Migration 0005 adds no column and no table — only the trigram indexes CRM search is
 * fast with and correct without — so it moved neither minimum.
 *
 * The research migration moves both. The API's research routes read
 * `research_settings`, `research_providers`, `research_route_policies` and
 * `research_suggestions`, and the worker's two research handlers write
 * `research_pages` and `research_firm_runs` — the tables whose unique constraints
 * *are* their declared idempotency protection. A worker on a database without them
 * would run those handlers with no uniqueness behind them, which is the one thing a
 * schema range exists to prevent, so it refuses to start instead. Both ranges are
 * therefore pinned to the research version rather than reaching back, and
 * `docs/decisions/g10-worker-schema-minimum.md` says what that gives up.
 *
 * NOTE (G10, pending): this lane's migration is renumbered to 0007 once G4's 0006 is
 * on main, and these four numbers move with it. Until then the tree holds two
 * version-5 migrations and `loadMigrations` says so.
 */
export const API_SCHEMA_RANGE: SchemaRange = { minimum: 5, maximum: 5 };
export const WORKER_SCHEMA_RANGE: SchemaRange = { minimum: 5, maximum: 5 };

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

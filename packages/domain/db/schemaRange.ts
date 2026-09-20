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
export const CURRENT_SCHEMA_VERSION = 8;

/**
 * The range the release before this one declared. Widen this one release ahead of the
 * migration.
 *
 * Lanes G5 and G2 shipped migrations 0002 and 0003 from the same main and each widened
 * this constant for its own; lane G3a widened it again for migration 0004, and G3b for
 * 0005, and G4 for 0006. G10 widens it for 0007 and G6 for 0008, so a merge that finds
 * two different maxima takes the larger. That is honest only because nothing has been
 * deployed — G0's {1, 1} was never a promise made to a running production binary.
 * From the first real deployment onwards the widening must precede the migration by a
 * release, and the compatibility test will keep saying so.
 */
export const PREVIOUS_RELEASE_SCHEMA_RANGE: SchemaRange = { minimum: 1, maximum: 8 };

/**
 * Both services need migration 0002's shape: the API's dead-job list reads `dead_at`
 * and `requeued_count`, and the worker's claim writes `fencing_token`. A binary that
 * needs a column states so rather than starting and failing on the first statement, so
 * neither accepts a version-1 database; see docs/decisions/g5-schema-range.md.
 *
 * The API additionally needs migration 0003 — no session, device credential or
 * authorization request exists before it, so an API on a version-2 database could not
 * authenticate anybody — and migration 0004, because its CRM routes read `firms`,
 * `contacts`, `opportunities` and the default pipeline. Migration 0006 raises it
 * again: the dial, suppression, pause and call routes read `state_postures`,
 * `dial_tickets`, `effective_suppressions`, `call_logs` and `callbacks`, and an API
 * without them could answer a dial authorization only by inventing one.
 *
 * Migration 0005 (G3b) adds no column and no table — only the trigram indexes CRM
 * search is fast with and correct without — so it moved neither minimum. Migration
 * 0006 does: the worker needs it because `suppression.finalize` writes
 * `suppression_finalizations`, so the worker's minimum moves from 2 to 6 for the first
 * time in this tree. The deploy order is migrate, then worker, then API, so the worker
 * never meets an older schema; a rolling step that runs two worker versions has both
 * understanding 0006, which is what the widened previous-release range above is for
 * (Appendix G 22). Both maxima move to 6: a binary that refused the database it has
 * just been deployed against would be a self-inflicted outage.
 *
 * Migration 0008 (lane G6) moves both minima again, and for the same reason both are
 * moved rather than only one. The rule is the one `docs/decisions/g5-schema-range.md`
 * and `docs/decisions/g10-worker-schema-minimum.md` state: a binary declares the
 * lowest version on which its *first statement* can succeed, not the lowest version it
 * would like. The API's `/today`, `/today/firm` and `/today/snooze` read and write
 * `today_snapshots`, `today_items` and `today_snoozes`; the worker's `today.build`
 * handler calls `today_upsert_item`, which does not exist before 0008. Neither could
 * do anything useful against a version-7 database except fail on its first query, and
 * 4.2 wants that to be a refusal at startup instead.
 *
 * The deploy order is migrate, then worker, then API, so neither binary ever meets an
 * older schema, and a rolling step that runs two worker versions has both understanding
 * 0008 — which is what the widened previous-release range above is for (Appendix G 22).
 */
export const API_SCHEMA_RANGE: SchemaRange = { minimum: 8, maximum: 8 };
export const WORKER_SCHEMA_RANGE: SchemaRange = { minimum: 8, maximum: 8 };

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

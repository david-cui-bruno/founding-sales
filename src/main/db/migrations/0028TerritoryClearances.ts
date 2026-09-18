import { sql, type Kysely } from 'kysely';
import type { FoundationDatabase } from '../schema';

/**
 * Schema 28: one compliance clearance per state (design D4, David's decision
 * of 17 Sep 2026). `territory_clearances` holds one revisioned row per US
 * postal state: the founder's confirmed statements (`clearance_json`), the
 * citation he confirmed against (`citation_json`), the IANA zone the calling
 * window uses, the confirmation time, the review date one year later, and a
 * revocation time when the state is revoked. Confirm and revoke both bump the
 * revision in place; a trigger keeps the revision strictly monotonic and the
 * state immutable, and nothing deletes a row. Additive only: no existing table,
 * index or trigger changes, and the legacy person-model jurisdiction tables from
 * 0014 are left untouched.
 */
const territoryClearanceStatements = [
  `CREATE TABLE territory_clearances (state TEXT PRIMARY KEY NOT NULL CHECK(length(state)=2 AND state=upper(state)),
        revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
        timezone TEXT NOT NULL CHECK(length(timezone) BETWEEN 1 AND 100),
        clearance_json TEXT NOT NULL CHECK(json_valid(clearance_json) AND json_type(clearance_json)='object' AND length(clearance_json)<=4000),
        citation_json TEXT NOT NULL CHECK(json_valid(citation_json) AND json_type(citation_json)='object' AND length(citation_json)<=4000),
        confirmed_at TEXT NOT NULL, review_at TEXT NOT NULL CHECK(review_at>confirmed_at), revoked_at TEXT NULL)`,
  `CREATE TRIGGER territory_clearances_no_delete BEFORE DELETE ON territory_clearances BEGIN SELECT RAISE(ABORT,'Territory clearance history is immutable'); END`,
  `CREATE TRIGGER territory_clearances_revision BEFORE UPDATE ON territory_clearances WHEN NEW.state IS NOT OLD.state OR NEW.revision<>OLD.revision+1
        BEGIN SELECT RAISE(ABORT,'Territory clearance revision is monotonic'); END`,
] as const;

export const migration0028TerritoryClearances = {
  async up(db: Kysely<FoundationDatabase>) {
    for (const statement of territoryClearanceStatements) await sql.raw(statement).execute(db);
    await sql`UPDATE app_meta SET schema_version=28,updated_at=${new Date().toISOString()} WHERE singleton=1`.execute(db);
  },
};

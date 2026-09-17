import { sql, type Kysely } from 'kysely';
import type { FoundationDatabase } from '../schema';

/**
 * Schema 27: a company route's `verification` may be `listed`, the value the
 * worker emits for a business phone taken from a Google Business Profile
 * listing. SQLite cannot alter a CHECK constraint, so `pm_account_routes` is
 * rebuilt with the 0005/0010 holding-table recipe: copy every row into a
 * holding table, drop, recreate under the same name with the widened CHECK,
 * reinsert in rowid order, then recreate the 0021 unique index and the 0020
 * immutability triggers that lived on the table. Every column, constraint and
 * object name is otherwise identical to 0020 and 0021, so the child tables whose
 * foreign keys name `pm_account_routes` (route evidence, outbound intents,
 * delegated approvals, route-policy receipts, campaign enrollments and step
 * receipts, manual LinkedIn drafts, manual handoffs, local company email
 * drafts) keep resolving by name. `PRAGMA defer_foreign_keys` keeps the
 * surrounding migration transaction satisfied until the rebuilt table holds its
 * rows again and `PRAGMA foreign_key_check` proves the graph is whole before
 * commit. Additive only: no row is reinterpreted and no other table changes.
 */
const ROUTE_COLUMNS = 'id, account_id, version, person_id, channel, value, purpose, verification, admitted_at';
const listedRouteVerificationStatements = [
  `CREATE TABLE pm_account_routes_migration_holding AS SELECT ${ROUTE_COLUMNS} FROM pm_account_routes ORDER BY rowid`,
  `DROP TABLE pm_account_routes`,
  // Byte-identical to 0020 except for the widened verification CHECK.
  `CREATE TABLE pm_account_routes (id TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES pm_accounts(id),
        version INTEGER NOT NULL CHECK(version>0), person_id TEXT REFERENCES persons(id), channel TEXT NOT NULL CHECK(channel IN ('phone','email','linkedin')),
        value TEXT NOT NULL CHECK(length(value) BETWEEN 1 AND 2048), purpose TEXT NOT NULL CHECK(purpose IN ('business','tenant_emergency','unknown')),
        verification TEXT NOT NULL CHECK(verification IN ('published','confirmed','unverified','listed')), admitted_at TEXT NOT NULL,
        PRIMARY KEY(id,version), UNIQUE(account_id,id,version))`,
  // 0021's parent index for the four-column route-policy foreign key must exist before rows return.
  `CREATE UNIQUE INDEX pm_account_route_policy_target ON pm_account_routes(account_id,id,version,value)`,
  `INSERT INTO pm_account_routes (${ROUTE_COLUMNS}) SELECT ${ROUTE_COLUMNS} FROM pm_account_routes_migration_holding ORDER BY rowid`,
  `DROP TABLE pm_account_routes_migration_holding`,
  // 0020's immutability triggers, recreated with the same text.
  ...['UPDATE', 'DELETE'].map(operation =>
    `CREATE TRIGGER pm_account_routes_no_${operation.toLowerCase()} BEFORE ${operation} ON pm_account_routes
         BEGIN SELECT RAISE(ABORT, 'PM account evidence is immutable'); END`),
] as const;

export const migration0027ListedRouteVerification = {
  async up(db: Kysely<FoundationDatabase>) {
    // The migration runner holds one BEGIN IMMEDIATE transaction around
    // every pending migration. Deferring foreign keys is scoped to that
    // transaction and resets itself at commit.
    await sql.raw('PRAGMA defer_foreign_keys = ON').execute(db);
    const before = await sql.raw<{ count: number }>('SELECT COUNT(*) AS count FROM pm_account_routes').execute(db);

    for (const statement of listedRouteVerificationStatements) {
      await sql.raw(statement).execute(db);
    }

    const after = await sql.raw<{ count: number }>('SELECT COUNT(*) AS count FROM pm_account_routes').execute(db);
    if (before.rows[0]?.count !== after.rows[0]?.count) {
      throw new Error('The listed-route-verification table rebuild changed the route row count.');
    }
    const violations = await sql.raw('PRAGMA foreign_key_check').execute(db);
    if (violations.rows.length > 0) {
      throw new Error('The listed-route-verification table rebuild left dangling foreign keys.');
    }

    await sql`UPDATE app_meta SET schema_version=27,updated_at=${new Date().toISOString()} WHERE singleton=1`.execute(db);
  },
};

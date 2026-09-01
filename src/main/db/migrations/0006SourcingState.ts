import { sql, type Kysely } from 'kysely';

import type { FoundationDatabase } from '../schema';

/**
 * Sourcing poller state (plan Task 3). `sourcing_cursor` is the single-row
 * lexicographic inbox cursor: the poller resumes strictly after `last_key`.
 * `cloud_entity_links` is the LOCAL-ONLY mapping from stable cloud entity IDs
 * (`ce_` ULIDs) to persons; per the contract this mapping never leaves the
 * Mac, and outcome labels flow upstream keyed by cloud_entity_id alone.
 */
const sourcingStateStatements = [
  `CREATE TABLE sourcing_cursor (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_key TEXT,
    polled_at TEXT NOT NULL
  )`,
  `CREATE TABLE cloud_entity_links (
    cloud_entity_id TEXT PRIMARY KEY,
    person_id TEXT NOT NULL REFERENCES persons(id),
    linked_at TEXT NOT NULL
  )`,
] as const;

export const migration0006SourcingState = {
  async up(db: Kysely<FoundationDatabase>) {
    for (const statement of sourcingStateStatements) {
      await sql.raw(statement).execute(db);
    }

    const timestamp = new Date().toISOString();
    await sql`
      UPDATE app_meta
      SET schema_version = 6, updated_at = ${timestamp}
      WHERE singleton = 1
    `.execute(db);
  },
};

import { sql, type Kysely } from 'kysely';

import type { FoundationDatabase } from '../schema';

export const migration0001Foundation = {
  async up(db: Kysely<FoundationDatabase>) {
    await sql`
      CREATE TABLE app_meta (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        schema_version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `.execute(db);

    await sql`
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued','running','succeeded','failed','cancelled')),
        progress_current INTEGER NOT NULL DEFAULT 0,
        progress_total INTEGER,
        retry_count INTEGER NOT NULL DEFAULT 0,
        payload_json TEXT NOT NULL,
        result_json TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        updated_at TEXT NOT NULL
      )
    `.execute(db);

    await sql`CREATE INDEX jobs_state_created_idx ON jobs(state, created_at)`.execute(db);
    await sql`CREATE VIRTUAL TABLE foundation_fts_probe USING fts5(content)`.execute(db);

    const timestamp = new Date().toISOString();
    await sql`
      INSERT INTO app_meta (singleton, schema_version, created_at, updated_at)
      VALUES (1, 1, ${timestamp}, ${timestamp})
    `.execute(db);
  },
};

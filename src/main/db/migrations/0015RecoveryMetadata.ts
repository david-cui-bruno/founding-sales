import { sql, type Kysely } from 'kysely';

import type { FoundationDatabase } from '../schema';

export const migration0015RecoveryMetadata = {
  async up(db: Kysely<FoundationDatabase>) {
    await sql.raw(`CREATE TABLE backup_receipts (
      id TEXT PRIMARY KEY,
      backup_basename TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK (kind IN ('daily','manual','pre_release')),
      schema_version INTEGER NOT NULL CHECK (schema_version > 0),
      sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
      size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
      created_at TEXT NOT NULL,
      verified_at TEXT NOT NULL
    )`).execute(db);
    await sql.raw(`CREATE TABLE recovery_readiness (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      recovery_setup_completed_at TEXT,
      last_restore_drill_at TEXT,
      last_restore_backup_sha256 TEXT,
      updated_at TEXT NOT NULL
    )`).execute(db);
    await sql.raw(`CREATE TABLE identity_repair_events (
      id TEXT PRIMARY KEY,
      manifest_sha256 TEXT NOT NULL,
      candidate_id TEXT NOT NULL,
      canonical_person_id TEXT NOT NULL,
      created_person_ids_json TEXT NOT NULL,
      reassigned_source_event_ids_json TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      UNIQUE (manifest_sha256, candidate_id)
    )`).execute(db);
    await sql.raw(`CREATE TRIGGER immutable_identity_repair_events
      BEFORE UPDATE ON identity_repair_events
      BEGIN
        SELECT RAISE(ABORT, 'identity_repair_events rows are immutable');
      END`).execute(db);
    await sql.raw(`CREATE TRIGGER immutable_identity_repair_events_delete
      BEFORE DELETE ON identity_repair_events
      BEGIN
        SELECT RAISE(ABORT, 'identity_repair_events rows are immutable');
      END`).execute(db);

    const timestamp = new Date().toISOString();
    await sql`INSERT INTO recovery_readiness (singleton, updated_at)
      VALUES (1, ${timestamp})`.execute(db);
    await sql`UPDATE app_meta SET schema_version = 15, updated_at = ${timestamp}
      WHERE singleton = 1`.execute(db);
  },
};

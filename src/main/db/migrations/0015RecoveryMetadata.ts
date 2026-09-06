import { sql, type Kysely } from 'kysely';

import type { FoundationDatabase } from '../schema';

export const migration0015RecoveryMetadata = {
  async up(db: Kysely<FoundationDatabase>) {
    await sql.raw(`CREATE TABLE backup_receipts (
      id TEXT PRIMARY KEY,
      backup_basename TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK (kind IN ('daily','manual','pre_release')),
      schema_version INTEGER NOT NULL CHECK (schema_version > 0),
      sha256 TEXT NOT NULL CHECK (
        length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'
      ),
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
    await sql.raw(`CREATE TABLE restore_drill_receipts (
      performed_at TEXT NOT NULL,
      backup_receipt_id TEXT NOT NULL,
      backup_sha256 TEXT NOT NULL CHECK (
        length(backup_sha256) = 64 AND backup_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      PRIMARY KEY (performed_at, backup_sha256),
      FOREIGN KEY (backup_receipt_id) REFERENCES backup_receipts(id)
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
    await sql.raw(`CREATE TRIGGER immutable_backup_receipts
      BEFORE UPDATE ON backup_receipts
      BEGIN
        SELECT RAISE(ABORT, 'backup_receipts rows are immutable');
      END`).execute(db);
    await sql.raw(`CREATE TRIGGER immutable_backup_receipts_delete
      BEFORE DELETE ON backup_receipts
      BEGIN
        SELECT RAISE(ABORT, 'backup_receipts rows are immutable');
      END`).execute(db);
    await sql.raw(`CREATE TRIGGER protect_restore_drill_backup_receipt
      BEFORE INSERT ON restore_drill_receipts
      WHEN NOT EXISTS (
        SELECT 1 FROM backup_receipts
        WHERE id = NEW.backup_receipt_id AND sha256 = NEW.backup_sha256
      )
      BEGIN
        SELECT RAISE(ABORT, 'restore drill requires matching verified backup receipt');
      END`).execute(db);
    await sql.raw(`CREATE TRIGGER immutable_restore_drill_receipts
      BEFORE UPDATE ON restore_drill_receipts
      BEGIN
        SELECT RAISE(ABORT, 'restore_drill_receipts rows are immutable');
      END`).execute(db);
    await sql.raw(`CREATE TRIGGER immutable_restore_drill_receipts_delete
      BEFORE DELETE ON restore_drill_receipts
      BEGIN
        SELECT RAISE(ABORT, 'restore_drill_receipts rows are immutable');
      END`).execute(db);

    const timestamp = new Date().toISOString();
    await sql`INSERT INTO recovery_readiness (singleton, updated_at)
      VALUES (1, ${timestamp})`.execute(db);
    await sql`UPDATE app_meta SET schema_version = 15, updated_at = ${timestamp}
      WHERE singleton = 1`.execute(db);
  },
};

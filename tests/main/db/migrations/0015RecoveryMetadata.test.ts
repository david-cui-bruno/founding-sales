import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../../../src/main/db/database';
import { createMigrationRunner } from '../../../../src/main/db/migrate';
import { migration0001Foundation } from '../../../../src/main/db/migrations/0001Foundation';
import { migration0002DomainFoundation } from '../../../../src/main/db/migrations/0002DomainFoundation';
import { migration0003Transcripts } from '../../../../src/main/db/migrations/0003Transcripts';
import { migration0004Learnings } from '../../../../src/main/db/migrations/0004Learnings';
import { migration0005SourcingChannels } from '../../../../src/main/db/migrations/0005SourcingChannels';
import { migration0006SourcingState } from '../../../../src/main/db/migrations/0006SourcingState';
import { migration0007SourcingOutbox } from '../../../../src/main/db/migrations/0007SourcingOutbox';
import { migration0008DedupeCloudPersons } from '../../../../src/main/db/migrations/0008DedupeCloudPersons';
import { migration0009SourcingFileLedger } from '../../../../src/main/db/migrations/0009SourcingFileLedger';
import { migration0010NoDueDates } from '../../../../src/main/db/migrations/0010NoDueDates';
import { migration0011ContactDncFlags } from '../../../../src/main/db/migrations/0011ContactDncFlags';
import { migration0012UpstreamRequestState } from '../../../../src/main/db/migrations/0012UpstreamRequestState';
import { migration0013ContactComplianceEvidence } from '../../../../src/main/db/migrations/0013ContactComplianceEvidence';
import { migration0014OutboundJurisdictionClearance } from '../../../../src/main/db/migrations/0014OutboundJurisdictionClearance';
import { migration0015RecoveryMetadata } from '../../../../src/main/db/migrations/0015RecoveryMetadata';
import { createTempDatabase, createTestWorkspaceKey, type TempDatabase } from '../../../fixtures/tempDatabase';

const migrationsThrough14 = [
  { id: '0001Foundation', schemaVersion: 1, migration: migration0001Foundation },
  { id: '0002DomainFoundation', schemaVersion: 2, migration: migration0002DomainFoundation },
  { id: '0003Transcripts', schemaVersion: 3, migration: migration0003Transcripts },
  { id: '0004Learnings', schemaVersion: 4, migration: migration0004Learnings },
  { id: '0005SourcingChannels', schemaVersion: 5, migration: migration0005SourcingChannels },
  { id: '0006SourcingState', schemaVersion: 6, migration: migration0006SourcingState },
  { id: '0007SourcingOutbox', schemaVersion: 7, migration: migration0007SourcingOutbox },
  { id: '0008DedupeCloudPersons', schemaVersion: 8, migration: migration0008DedupeCloudPersons },
  { id: '0009SourcingFileLedger', schemaVersion: 9, migration: migration0009SourcingFileLedger },
  { id: '0010NoDueDates', schemaVersion: 10, migration: migration0010NoDueDates },
  { id: '0011ContactDncFlags', schemaVersion: 11, migration: migration0011ContactDncFlags },
  { id: '0012UpstreamRequestState', schemaVersion: 12, migration: migration0012UpstreamRequestState },
  { id: '0013ContactComplianceEvidence', schemaVersion: 13, migration: migration0013ContactComplianceEvidence },
  { id: '0014OutboundJurisdictionClearance', schemaVersion: 14, migration: migration0014OutboundJurisdictionClearance },
] as const;
const migrateThrough14 = createMigrationRunner(migrationsThrough14);
const migrateThroughSchema15 = createMigrationRunner([
  ...migrationsThrough14,
  { id: '0015RecoveryMetadata', schemaVersion: 15, migration: migration0015RecoveryMetadata },
] as const);
const TS = '2026-09-05T12:00:00.000Z';
const SHA = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

const normalizeSql = (value: string): string => value.replace(/\s+/g, ' ').trim();

const expectedTableSql = {
  backup_receipts: `CREATE TABLE backup_receipts (
    id TEXT PRIMARY KEY,
    backup_basename TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('daily','manual','pre_release')),
    schema_version INTEGER NOT NULL CHECK (schema_version > 0),
    sha256 TEXT NOT NULL CHECK (
      typeof(sha256) = 'text' AND length(sha256) = 64
      AND length(CAST(sha256 AS BLOB)) = 64
      AND sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
    created_at TEXT NOT NULL,
    verified_at TEXT NOT NULL
  )`,
  recovery_readiness: `CREATE TABLE recovery_readiness (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    recovery_setup_completed_at TEXT,
    last_restore_drill_at TEXT,
    last_restore_backup_sha256 TEXT,
    updated_at TEXT NOT NULL
  )`,
  restore_drill_receipts: `CREATE TABLE restore_drill_receipts (
    performed_at TEXT NOT NULL,
    backup_receipt_id TEXT NOT NULL,
    backup_sha256 TEXT NOT NULL CHECK (
      typeof(backup_sha256) = 'text' AND length(backup_sha256) = 64
      AND length(CAST(backup_sha256 AS BLOB)) = 64
      AND backup_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    PRIMARY KEY (performed_at, backup_sha256),
    FOREIGN KEY (backup_receipt_id) REFERENCES backup_receipts(id)
  )`,
  identity_repair_events: `CREATE TABLE identity_repair_events (
    id TEXT PRIMARY KEY,
    manifest_sha256 TEXT NOT NULL,
    candidate_id TEXT NOT NULL,
    canonical_person_id TEXT NOT NULL,
    created_person_ids_json TEXT NOT NULL,
    reassigned_source_event_ids_json TEXT NOT NULL,
    applied_at TEXT NOT NULL,
    UNIQUE (manifest_sha256, candidate_id)
  )`,
} as const;

describe('0015 recovery metadata migration', () => {
  let database: AppDatabase;
  let temp: TempDatabase;
  let options: { backupDirectory: string; workspaceKey: ReturnType<typeof createTestWorkspaceKey> };

  beforeEach(async () => {
    temp = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: temp.path, key });
    options = { backupDirectory: `${temp.path}.backups`, workspaceKey: key };
    await migrateThrough14(database, options);
  });

  afterEach(() => {
    try {
      expect(database.raw.prepare(
        'SELECT schema_version FROM app_meta WHERE singleton = 1',
      ).get()).toEqual({ schema_version: 15 });
      expect(database.raw.prepare(
        'SELECT name FROM kysely_migration ORDER BY timestamp, name',
      ).all()).toEqual([
        ...migrationsThrough14.map(({ id }) => ({ name: id })),
        { name: '0015RecoveryMetadata' },
      ]);
    } finally {
      closeDatabase(database);
      temp.cleanup();
    }
  });

  it('migrates schema 14 to the exact schema-15 table contracts', async () => {
    await expect(migrateThroughSchema15(database, options)).resolves.toEqual({
      fromVersion: 14,
      toVersion: 15,
      appliedMigrationIds: ['0015RecoveryMetadata'],
    });
    expect(database.raw.prepare(
      'SELECT schema_version FROM app_meta WHERE singleton = 1',
    ).get()).toEqual({ schema_version: 15 });

    const rows = database.raw.prepare<[], { name: keyof typeof expectedTableSql; sql: string }>(`
      SELECT name, sql FROM sqlite_master
      WHERE type = 'table' AND name IN (
        'backup_receipts', 'recovery_readiness', 'restore_drill_receipts',
        'identity_repair_events'
      )
      ORDER BY name
    `).all();
    expect(rows.map(({ name, sql }) => ({ name, sql: normalizeSql(sql) }))).toEqual(
      Object.entries(expectedTableSql)
        .map(([name, sql]) => ({ name, sql: normalizeSql(sql) }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    );
  });

  it('initializes exactly one empty recovery-readiness singleton', async () => {
    await migrateThroughSchema15(database, options);

    expect(database.raw.prepare(`SELECT singleton, recovery_setup_completed_at,
      last_restore_drill_at, last_restore_backup_sha256, updated_at
      FROM recovery_readiness`).all()).toEqual([{
      singleton: 1,
      recovery_setup_completed_at: null,
      last_restore_drill_at: null,
      last_restore_backup_sha256: null,
      updated_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    }]);
    expect(() => database.raw.prepare(
      "INSERT INTO recovery_readiness (singleton, updated_at) VALUES (2, ?)",
    ).run(TS)).toThrow();
  });

  it('enforces backup receipt checks and basename uniqueness', async () => {
    await migrateThroughSchema15(database, options);
    const insert = database.raw.prepare(`INSERT INTO backup_receipts
      (id, backup_basename, kind, schema_version, sha256, size_bytes, created_at, verified_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    insert.run('backup-1', 'daily-1.sqlite3', 'daily', 15, SHA, 10, TS, TS);

    expect(() => insert.run(
      'backup-2', 'daily-1.sqlite3', 'manual', 15, 'b'.repeat(64), 20, TS, TS,
    )).toThrow();
    expect(() => insert.run(
      'backup-3', 'daily-3.sqlite3', 'other', 15, SHA, 10, TS, TS,
    )).toThrow();
    expect(() => insert.run(
      'backup-4', 'daily-4.sqlite3', 'manual', 0, SHA, 10, TS, TS,
    )).toThrow();
    expect(() => insert.run(
      'backup-5', 'daily-5.sqlite3', 'manual', 15, 'short', 10, TS, TS,
    )).toThrow();
    expect(() => insert.run(
      'backup-6', 'daily-6.sqlite3', 'pre_release', 15, SHA, 0, TS, TS,
    )).toThrow();
    expect(() => insert.run(
      'backup-7', 'daily-7.sqlite3', 'manual', 15, 'G'.repeat(64), 10, TS, TS,
    )).toThrow();
  });

  const noncanonicalHashes = [
    { label: '64-byte BLOB', value: Buffer.from(SHA, 'ascii') },
    { label: 'hex prefix with embedded NUL and suffix', value: `${SHA}\0G` },
  ];

  it.each(noncanonicalHashes)('rejects a $label in backup receipt hashes', async ({ value }) => {
    await migrateThroughSchema15(database, options);
    const insert = database.raw.prepare(`INSERT INTO backup_receipts
      (id, backup_basename, kind, schema_version, sha256, size_bytes, created_at, verified_at)
      VALUES (?, ?, 'manual', 15, ?, 10, ?, ?)`);

    expect(() => insert.run('bad', 'bad.sqlite3', value, TS, TS))
      .toThrow(/CHECK constraint failed/);
    expect(database.raw.prepare('SELECT id FROM backup_receipts').all()).toEqual([]);

    insert.run('valid', 'valid.sqlite3', SHA, TS, TS);
    expect(database.raw.prepare('SELECT sha256 FROM backup_receipts').get())
      .toEqual({ sha256: SHA });
  });

  it.each(noncanonicalHashes)('rejects a $label in restore-drill hashes', async ({ value }) => {
    await migrateThroughSchema15(database, options);
    const insertBackup = database.raw.prepare(`INSERT INTO backup_receipts
      (id, backup_basename, kind, schema_version, sha256, size_bytes, created_at, verified_at)
      VALUES (?, ?, 'manual', 15, ?, 10, ?, ?)`);

    // Seed corrupt historical evidence only in this disposable fixture. Restore the
    // checks before testing the drill's own constraint, not just its linkage trigger.
    database.raw.pragma('ignore_check_constraints = ON');
    try {
      insertBackup.run('legacy-bad', 'legacy-bad.sqlite3', value, TS, TS);
    } finally {
      database.raw.pragma('ignore_check_constraints = OFF');
    }
    expect(database.raw.pragma('ignore_check_constraints', { simple: true })).toBe(0);
    const insertDrill = database.raw.prepare(`INSERT INTO restore_drill_receipts
      (performed_at, backup_receipt_id, backup_sha256) VALUES (?, ?, ?)`);
    expect(() => insertDrill.run(TS, 'legacy-bad', value)).toThrow(/CHECK constraint failed/);
    expect(database.raw.prepare('SELECT * FROM restore_drill_receipts').all()).toEqual([]);

    insertBackup.run('valid', 'valid.sqlite3', SHA, TS, TS);
    insertDrill.run(TS, 'valid', SHA);
    expect(database.raw.prepare('SELECT backup_sha256 FROM restore_drill_receipts').get())
      .toEqual({ backup_sha256: SHA });
  });

  it('keeps backup and restore-drill receipts immutable and hash constrained', async () => {
    await migrateThroughSchema15(database, options);
    database.raw.prepare(`INSERT INTO backup_receipts
      (id, backup_basename, kind, schema_version, sha256, size_bytes, created_at, verified_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'backup-1', 'daily-1.sqlite3', 'daily', 15, SHA, 10, TS, TS,
    );
    database.raw.prepare(`INSERT INTO restore_drill_receipts
      (performed_at, backup_receipt_id, backup_sha256)
      VALUES (?, ?, ?)`).run(TS, 'backup-1', SHA);

    expect(() => database.raw.prepare(
      "UPDATE backup_receipts SET size_bytes = 11 WHERE id = 'backup-1'",
    ).run()).toThrow();
    expect(() => database.raw.prepare(
      "DELETE FROM backup_receipts WHERE id = 'backup-1'",
    ).run()).toThrow();
    expect(() => database.raw.prepare(
      "UPDATE restore_drill_receipts SET backup_sha256 = ? WHERE backup_receipt_id = 'backup-1'",
    ).run(SHA_B)).toThrow();
    expect(() => database.raw.prepare(
      "DELETE FROM restore_drill_receipts WHERE backup_receipt_id = 'backup-1'",
    ).run()).toThrow();
    expect(() => database.raw.prepare(`INSERT INTO restore_drill_receipts
      (performed_at, backup_receipt_id, backup_sha256)
      VALUES (?, ?, ?)`).run(TS, 'backup-1', 'Z'.repeat(64))).toThrow();
    const insertDrill = database.raw.prepare(`INSERT INTO restore_drill_receipts
      (performed_at, backup_receipt_id, backup_sha256) VALUES (?, ?, ?)`);
    expect(() => insertDrill.run(TS, 'backup-1', SHA_B))
      .toThrow(/matching verified backup receipt/);
    expect(() => insertDrill.run(TS, 'missing-backup', SHA))
      .toThrow(/matching verified backup receipt/);
    expect(database.raw.prepare('SELECT * FROM restore_drill_receipts').all()).toEqual([
      { performed_at: TS, backup_receipt_id: 'backup-1', backup_sha256: SHA },
    ]);
  });

  it('enforces immutable repair-event identity uniqueness and preserves receipts byte-for-byte', async () => {
    await migrateThroughSchema15(database, options);
    const insert = database.raw.prepare(`INSERT INTO identity_repair_events
      (id, manifest_sha256, candidate_id, canonical_person_id,
       created_person_ids_json, reassigned_source_event_ids_json, applied_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    insert.run('repair-1', SHA, 'candidate-1', 'person-1', '[]', '["event-1"]', TS);

    expect(() => insert.run(
      'repair-2', SHA, 'candidate-1', 'person-2', '["person-2"]', '[]', TS,
    )).toThrow();

    const selectReceipt = database.raw.prepare(
      'SELECT * FROM identity_repair_events WHERE id = ?',
    );
    const original = selectReceipt.get('repair-1');

    expect(() => database.raw.prepare(`UPDATE identity_repair_events
      SET canonical_person_id = 'person-rewritten' WHERE id = 'repair-1'`).run()).toThrow();
    expect(selectReceipt.get('repair-1')).toEqual(original);

    expect(() => database.raw.prepare(
      "DELETE FROM identity_repair_events WHERE id = 'repair-1'",
    ).run()).toThrow();
    expect(selectReceipt.get('repair-1')).toEqual(original);

    expect(database.raw.prepare(`SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND tbl_name = 'identity_repair_events'
      ORDER BY name`).all()).toEqual([
      { name: 'immutable_identity_repair_events' },
      { name: 'immutable_identity_repair_events_delete' },
    ]);
  });

  it('preserves schema-14 compliance and jurisdiction data', async () => {
    database.raw.prepare(`INSERT INTO persons
      (id, display_name, aliases_json, opted_out, never_record, provenance_json,
       version, created_at, updated_at)
      VALUES ('person-1', 'Person One', '[]', 0, 0, NULL, 1, ?, ?)` ).run(TS, TS);
    database.raw.prepare(`INSERT INTO person_contact_methods
      (id, person_id, kind, normalized_value, validation_state, reachability,
       is_primary, dnc_listed, tcpa_flag, federal_status, compliance_source,
       created_at, updated_at)
      VALUES ('contact-1', 'person-1', 'phone', '+14015550100', 'valid', 'direct',
       1, 0, 0, 'verified_clear', 'manual_import', ?, ?)` ).run(TS, TS);
    database.raw.prepare(`INSERT INTO contact_compliance_audit_events
      (id, contact_method_id, operation, old_evidence_json, new_evidence_json,
       source, evidence_timestamp, evidence_ref, policy_version,
       resulting_reason_code, resulting_call_reason_code,
       resulting_text_reason_code, created_at)
      VALUES ('audit-1', 'contact-1', 'authoritative_correction', '{}', '{}',
       'manual_import', ?, 'evidence-1', 'policy-v1', 'clear', 'clear', 'clear', ?)`)
      .run(TS, TS);
    database.raw.prepare(`INSERT INTO person_outbound_jurisdictions
      (person_id, region_code, timezone, source, evidence_ref, effective_at,
       review_at, updated_at)
      VALUES ('person-1', 'RI', 'America/New_York', 'manual_review',
       'review-1', ?, NULL, ?)` ).run(TS, TS);

    const before = {
      compliance: database.raw.prepare(
        "SELECT * FROM contact_compliance_audit_events WHERE id = 'audit-1'",
      ).get(),
      jurisdiction: database.raw.prepare(
        "SELECT * FROM person_outbound_jurisdictions WHERE person_id = 'person-1'",
      ).get(),
      clearances: database.raw.prepare(
        'SELECT * FROM outbound_jurisdiction_clearances ORDER BY region_code, channel',
      ).all(),
    };

    await migrateThroughSchema15(database, options);

    expect({
      compliance: database.raw.prepare(
        "SELECT * FROM contact_compliance_audit_events WHERE id = 'audit-1'",
      ).get(),
      jurisdiction: database.raw.prepare(
        "SELECT * FROM person_outbound_jurisdictions WHERE person_id = 'person-1'",
      ).get(),
      clearances: database.raw.prepare(
        'SELECT * FROM outbound_jurisdiction_clearances ORDER BY region_code, channel',
      ).all(),
    }).toEqual(before);
    expect(database.raw.prepare(
      'SELECT schema_version FROM app_meta WHERE singleton = 1',
    ).get()).toEqual({ schema_version: 15 });
  });
});

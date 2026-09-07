import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../../../src/main/db/database';
import { createMigrationRunner, productionMigrations } from '../../../../src/main/db/migrate';
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

const migrationsThrough15 = [
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
  { id: '0015RecoveryMetadata', schemaVersion: 15, migration: migration0015RecoveryMetadata },
] as const;
const migrateThrough16 = createMigrationRunner(productionMigrations.filter(x => x.schemaVersion <= 16));

const migrateThrough15 = createMigrationRunner(migrationsThrough15);
const TS = '2026-09-05T12:00:00.000Z';
const SHA = 'a'.repeat(64);
const normalizeSql = (value: string): string => value.replace(/\s+/g, ' ').trim();

const expectedContactSql = `CREATE TABLE person_contact_methods (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES persons(id),
  kind TEXT NOT NULL CHECK (kind IN ('phone', 'email')),
  normalized_value TEXT NOT NULL CHECK (length(normalized_value) > 0),
  raw_value TEXT,
  validation_state TEXT NOT NULL CHECK (
    validation_state IN ('unverified', 'valid', 'invalid')
  ),
  reachability TEXT NOT NULL CHECK (
    reachability IN ('direct', 'indirect', 'none')
  ),
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  in_contacts INTEGER CHECK (in_contacts IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  dnc_listed INTEGER NOT NULL DEFAULT 0 CHECK (dnc_listed IN (0, 1)),
  tcpa_flag INTEGER NOT NULL DEFAULT 0 CHECK (tcpa_flag IN (0, 1)),
  federal_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (federal_status IN ('unknown', 'verified_clear', 'listed')),
  compliance_tcpa_flag INTEGER NULL
    CHECK (compliance_tcpa_flag IS NULL OR compliance_tcpa_flag IN (0, 1)),
  covered_area_code TEXT NULL
    CHECK (covered_area_code IS NULL OR covered_area_code GLOB '[0-9][0-9][0-9]'),
  compliance_source TEXT NOT NULL DEFAULT 'legacy'
    CHECK (compliance_source IN ('ftc_download', 'enrichment_vendor', 'manual_import', 'legacy')),
  scrubbed_at TEXT NULL,
  compliance_expires_at TEXT NULL,
  source_label TEXT,
  vendor_rank INTEGER CHECK (vendor_rank IS NULL OR vendor_rank >= 1),
  phone_kind TEXT CHECK (
    phone_kind IS NULL OR phone_kind IN ('mobile','landline','voip','other')
  ),
  ownership_state TEXT NOT NULL DEFAULT 'unknown' CHECK (
    ownership_state IN ('verified_person','vendor_candidate','conflicting_identity','unknown')
  ),
  evidence_observed_at TEXT,
  UNIQUE (person_id, kind, normalized_value)
)`;

describe('0016 contact presentation evidence migration', () => {
  let database: AppDatabase;
  let temp: TempDatabase;
  let options: { backupDirectory: string; workspaceKey: ReturnType<typeof createTestWorkspaceKey> };

  beforeEach(async () => {
    temp = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: temp.path, key });
    options = { backupDirectory: `${temp.path}.backups`, workspaceKey: key };
    await migrateThrough15(database, options);

    database.raw.prepare(`INSERT INTO persons
      (id, display_name, aliases_json, opted_out, never_record, provenance_json,
       version, created_at, updated_at)
      VALUES ('person-1', 'Person One', '[]', 0, 0, NULL, 1, ?, ?)` ).run(TS, TS);
    const insertContact = database.raw.prepare(`INSERT INTO person_contact_methods
      (id, person_id, kind, normalized_value, validation_state, reachability,
       is_primary, dnc_listed, tcpa_flag, federal_status, compliance_tcpa_flag,
       covered_area_code, compliance_source, scrubbed_at, compliance_expires_at,
       created_at, updated_at)
      VALUES (?, 'person-1', ?, ?, 'valid', 'direct', ?, 0, 0, 'verified_clear', 0,
       '401', 'manual_import', ?, ?, ?, ?)`);
    insertContact.run('phone-1', 'phone', '+14015550100', 1, TS, TS, TS, TS);
    insertContact.run('email-1', 'email', 'person@example.com', 0, TS, TS, TS, TS);
    database.raw.prepare(`INSERT INTO contact_compliance_audit_events
      (id, contact_method_id, operation, old_evidence_json, new_evidence_json,
       source, evidence_timestamp, evidence_ref, policy_version,
       resulting_reason_code, resulting_call_reason_code,
       resulting_text_reason_code, created_at)
      VALUES ('audit-1', 'phone-1', 'authoritative_correction', '{}', '{}',
       'manual_import', ?, 'evidence-1', 'policy-v1', 'clear', 'clear', 'clear', ?)`)
      .run(TS, TS);
    database.raw.prepare(`INSERT INTO person_outbound_jurisdictions
      (person_id, region_code, timezone, source, evidence_ref, effective_at,
       review_at, updated_at)
      VALUES ('person-1', 'RI', 'America/New_York', 'manual_review',
       'review-1', ?, NULL, ?)` ).run(TS, TS);
    database.raw.prepare(`INSERT INTO backup_receipts
      (id, backup_basename, kind, schema_version, sha256, size_bytes, created_at, verified_at)
      VALUES ('backup-1', 'daily-1.sqlite3', 'daily', 15, ?, 10, ?, ?)`)
      .run(SHA, TS, TS);
    database.raw.prepare(`INSERT INTO restore_drill_receipts
      (performed_at, backup_receipt_id, backup_sha256)
      VALUES (?, 'backup-1', ?)`).run(TS, SHA);
    database.raw.prepare(`UPDATE recovery_readiness SET recovery_setup_completed_at = ?,
      last_restore_drill_at = ?, last_restore_backup_sha256 = ?, updated_at = ?
      WHERE singleton = 1`).run(TS, TS, SHA, TS);
    database.raw.prepare(`INSERT INTO identity_repair_events
      (id, manifest_sha256, candidate_id, canonical_person_id,
       created_person_ids_json, reassigned_source_event_ids_json, applied_at)
      VALUES ('repair-1', ?, 'candidate-1', 'person-1', '[]', '["event-1"]', ?)`)
      .run(SHA, TS);
  });

  afterEach(() => {
    closeDatabase(database);
    temp.cleanup();
  });

  it('migrates schema 15 to the exact additive schema-16 contract without rewriting recovery evidence', async () => {
    const recoveryNames = [
      'backup_receipts', 'identity_repair_events', 'recovery_readiness', 'restore_drill_receipts',
    ];
    const before = {
      tables: database.raw.prepare(`SELECT name, sql FROM sqlite_master
        WHERE type = 'table' AND name IN (${recoveryNames.map(() => '?').join(',')})
        ORDER BY name`).all(...recoveryNames),
      indexes: database.raw.prepare(`SELECT name, tbl_name, sql FROM sqlite_master
        WHERE type = 'index' AND tbl_name IN (${recoveryNames.map(() => '?').join(',')})
        ORDER BY name`).all(...recoveryNames),
      triggers: database.raw.prepare(`SELECT name, sql FROM sqlite_master
        WHERE type = 'trigger' AND tbl_name IN (${recoveryNames.map(() => '?').join(',')})
        ORDER BY name`).all(...recoveryNames),
      receipts: database.raw.prepare('SELECT * FROM backup_receipts ORDER BY id').all(),
      drills: database.raw.prepare('SELECT * FROM restore_drill_receipts ORDER BY performed_at, backup_sha256').all(),
      readiness: database.raw.prepare('SELECT * FROM recovery_readiness ORDER BY singleton').all(),
      repairs: database.raw.prepare('SELECT * FROM identity_repair_events ORDER BY id').all(),
      compliance: database.raw.prepare('SELECT * FROM contact_compliance_audit_events ORDER BY id').all(),
      jurisdiction: database.raw.prepare('SELECT * FROM person_outbound_jurisdictions ORDER BY person_id').all(),
    };

    await expect(migrateThrough16(database, options)).resolves.toEqual({
      fromVersion: 15,
      toVersion: 16,
      appliedMigrationIds: ['0016ContactPresentationEvidence'],
    });

    expect(database.raw.prepare('SELECT schema_version FROM app_meta WHERE singleton = 1').get())
      .toEqual({ schema_version: 16 });
    expect(normalizeSql((database.raw.prepare(`SELECT sql FROM sqlite_master
      WHERE type = 'table' AND name = 'person_contact_methods'`).get() as { sql: string }).sql))
      .toBe(normalizeSql(expectedContactSql));
    expect(database.raw.prepare('PRAGMA table_info(person_contact_methods)').all().slice(19)).toEqual([
      { cid: 19, name: 'source_label', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
      { cid: 20, name: 'vendor_rank', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 0 },
      { cid: 21, name: 'phone_kind', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
      { cid: 22, name: 'ownership_state', type: 'TEXT', notnull: 1, dflt_value: "'unknown'", pk: 0 },
      { cid: 23, name: 'evidence_observed_at', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
    ]);
    expect(database.raw.prepare(`SELECT source_label, vendor_rank, phone_kind,
      ownership_state, evidence_observed_at FROM person_contact_methods ORDER BY id`).all())
      .toEqual([
        { source_label: null, vendor_rank: null, phone_kind: null, ownership_state: 'unknown', evidence_observed_at: null },
        { source_label: null, vendor_rank: null, phone_kind: null, ownership_state: 'unknown', evidence_observed_at: null },
      ]);

    const update = database.raw.prepare(`UPDATE person_contact_methods SET vendor_rank = ?,
      phone_kind = ?, ownership_state = ? WHERE id = 'phone-1'`);
    expect(() => update.run(0, 'mobile', 'vendor_candidate')).toThrow();
    expect(() => update.run(1, 'fax', 'vendor_candidate')).toThrow();
    expect(() => update.run(1, 'mobile', 'claimed')).toThrow();
    expect(() => update.run(1, 'mobile', 'vendor_candidate')).not.toThrow();

    expect({
      tables: database.raw.prepare(`SELECT name, sql FROM sqlite_master
        WHERE type = 'table' AND name IN (${recoveryNames.map(() => '?').join(',')})
        ORDER BY name`).all(...recoveryNames),
      indexes: database.raw.prepare(`SELECT name, tbl_name, sql FROM sqlite_master
        WHERE type = 'index' AND tbl_name IN (${recoveryNames.map(() => '?').join(',')})
        ORDER BY name`).all(...recoveryNames),
      triggers: database.raw.prepare(`SELECT name, sql FROM sqlite_master
        WHERE type = 'trigger' AND tbl_name IN (${recoveryNames.map(() => '?').join(',')})
        ORDER BY name`).all(...recoveryNames),
      receipts: database.raw.prepare('SELECT * FROM backup_receipts ORDER BY id').all(),
      drills: database.raw.prepare('SELECT * FROM restore_drill_receipts ORDER BY performed_at, backup_sha256').all(),
      readiness: database.raw.prepare('SELECT * FROM recovery_readiness ORDER BY singleton').all(),
      repairs: database.raw.prepare('SELECT * FROM identity_repair_events ORDER BY id').all(),
      compliance: database.raw.prepare('SELECT * FROM contact_compliance_audit_events ORDER BY id').all(),
      jurisdiction: database.raw.prepare('SELECT * FROM person_outbound_jurisdictions ORDER BY person_id').all(),
    }).toEqual(before);

    await expect(migrateThrough16(database, options)).resolves.toEqual({
      fromVersion: 16,
      toVersion: 16,
      appliedMigrationIds: [],
    });
  });
});

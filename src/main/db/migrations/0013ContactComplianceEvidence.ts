import { sql, type Kysely } from 'kysely';

import type { FoundationDatabase } from '../schema';

const statements = [
  `ALTER TABLE person_contact_methods ADD COLUMN federal_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (federal_status IN ('unknown', 'verified_clear', 'listed'))`,
  `ALTER TABLE person_contact_methods ADD COLUMN compliance_tcpa_flag INTEGER NULL
    CHECK (compliance_tcpa_flag IS NULL OR compliance_tcpa_flag IN (0, 1))`,
  `ALTER TABLE person_contact_methods ADD COLUMN covered_area_code TEXT NULL
    CHECK (covered_area_code IS NULL OR covered_area_code GLOB '[0-9][0-9][0-9]')`,
  `ALTER TABLE person_contact_methods ADD COLUMN compliance_source TEXT NOT NULL DEFAULT 'legacy'
    CHECK (compliance_source IN ('ftc_download', 'enrichment_vendor', 'manual_import', 'legacy'))`,
  `ALTER TABLE person_contact_methods ADD COLUMN scrubbed_at TEXT NULL`,
  `ALTER TABLE person_contact_methods ADD COLUMN compliance_expires_at TEXT NULL`,
  `CREATE TABLE contact_compliance_audit_events (
    id TEXT PRIMARY KEY,
    contact_method_id TEXT NOT NULL REFERENCES person_contact_methods(id),
    operation TEXT NOT NULL CHECK (operation IN ('intake_merge', 'authoritative_correction', 'legacy_backfill')),
    old_evidence_json TEXT NOT NULL,
    new_evidence_json TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('ftc_download', 'enrichment_vendor', 'manual_import', 'legacy')),
    evidence_timestamp TEXT NULL,
    evidence_ref TEXT NULL,
    policy_version TEXT NOT NULL,
    resulting_reason_code TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX contact_compliance_audit_contact_idx
    ON contact_compliance_audit_events(contact_method_id, created_at, id)`,
] as const;

export const migration0013ContactComplianceEvidence = {
  async up(db: Kysely<FoundationDatabase>) {
    for (const statement of statements) await sql.raw(statement).execute(db);

    await sql`UPDATE person_contact_methods SET
      federal_status = CASE WHEN dnc_listed = 1 THEN 'listed' ELSE 'unknown' END,
      compliance_tcpa_flag = CASE WHEN tcpa_flag = 1 THEN 1 ELSE NULL END,
      covered_area_code = NULL,
      compliance_source = 'legacy',
      scrubbed_at = NULL,
      compliance_expires_at = NULL`.execute(db);

    await sql.raw(`INSERT INTO contact_compliance_audit_events (
      id, contact_method_id, operation, old_evidence_json, new_evidence_json,
      source, evidence_timestamp, evidence_ref, policy_version, resulting_reason_code, created_at
    ) SELECT
      'legacy-backfill-' || id,
      id,
      'legacy_backfill',
      json_object('dncListed', json(CASE WHEN dnc_listed = 1 THEN 'true' ELSE 'false' END),
                  'tcpaFlag', json(CASE WHEN tcpa_flag = 1 THEN 'true' ELSE 'false' END)),
      json_object('federalStatus', CASE WHEN dnc_listed = 1 THEN 'listed' ELSE 'unknown' END,
                  'tcpaFlag', CASE WHEN tcpa_flag = 1 THEN json('true') ELSE NULL END,
                  'coveredAreaCode', NULL, 'source', 'legacy', 'scrubbedAt', NULL, 'expiresAt', NULL),
      'legacy', NULL, NULL, 'contact-compliance-v1',
      CASE WHEN dnc_listed = 1 THEN 'federal_dnc_listed'
           WHEN tcpa_flag = 1 THEN 'tcpa_blocked'
           ELSE 'federal_status_unknown' END,
      updated_at
    FROM person_contact_methods`).execute(db);

    const timestamp = new Date().toISOString();
    await sql`UPDATE app_meta SET schema_version = 13, updated_at = ${timestamp} WHERE singleton = 1`.execute(db);
  },
};

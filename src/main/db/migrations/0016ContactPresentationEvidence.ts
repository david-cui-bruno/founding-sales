import { sql, type Kysely } from 'kysely';

import type { FoundationDatabase } from '../schema';

export const migration0016ContactPresentationEvidence = {
  async up(db: Kysely<FoundationDatabase>) {
    await sql.raw('ALTER TABLE person_contact_methods ADD COLUMN source_label TEXT').execute(db);
    await sql.raw(`ALTER TABLE person_contact_methods ADD COLUMN vendor_rank INTEGER
      CHECK (vendor_rank IS NULL OR vendor_rank >= 1)`).execute(db);
    await sql.raw(`ALTER TABLE person_contact_methods ADD COLUMN phone_kind TEXT CHECK (
      phone_kind IS NULL OR phone_kind IN ('mobile','landline','voip','other')
    )`).execute(db);
    await sql.raw(`ALTER TABLE person_contact_methods ADD COLUMN ownership_state TEXT NOT NULL
      DEFAULT 'unknown' CHECK (
        ownership_state IN ('verified_person','vendor_candidate','conflicting_identity','unknown')
      )`).execute(db);
    await sql.raw(
      'ALTER TABLE person_contact_methods ADD COLUMN evidence_observed_at TEXT',
    ).execute(db);

    const timestamp = new Date().toISOString();
    await sql`UPDATE app_meta SET schema_version = 16, updated_at = ${timestamp}
      WHERE singleton = 1`.execute(db);
  },
};

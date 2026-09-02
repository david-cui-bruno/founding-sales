import { sql, type Kysely } from 'kysely';

import type { FoundationDatabase } from '../schema';

/**
 * DNC/TCPA compliance flags on contact methods (schema 11).
 *
 * Cloud enrichment events (channel `parcel`, enrichmentPayloadSchema) carry
 * per-phone `dnc_listed` and `tcpa_flag` booleans from the vendor scrub.
 * Federal telemarketing compliance requires flagged numbers to be
 * non-dialable, so the flags persist on `person_contact_methods` and the
 * dial gate (beginOutbound) rejects flagged contacts. Additive column adds:
 * existing rows (manual intake, non-enrichment channels) default to 0.
 */
const dncComplianceStatements = [
  `ALTER TABLE person_contact_methods
    ADD COLUMN dnc_listed INTEGER NOT NULL DEFAULT 0 CHECK (dnc_listed IN (0, 1))`,
  `ALTER TABLE person_contact_methods
    ADD COLUMN tcpa_flag INTEGER NOT NULL DEFAULT 0 CHECK (tcpa_flag IN (0, 1))`,
] as const;

export const migration0011ContactDncFlags = {
  async up(db: Kysely<FoundationDatabase>) {
    for (const statement of dncComplianceStatements) {
      await sql.raw(statement).execute(db);
    }

    const timestamp = new Date().toISOString();
    await sql`
      UPDATE app_meta
      SET schema_version = 11, updated_at = ${timestamp}
      WHERE singleton = 1
    `.execute(db);
  },
};

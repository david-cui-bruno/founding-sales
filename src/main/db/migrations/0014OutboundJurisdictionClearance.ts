import { sql, type Kysely } from 'kysely';

import type { FoundationDatabase } from '../schema';

const EFFECTIVE_AT = '2026-09-04T00:00:00.000Z';

export const migration0014OutboundJurisdictionClearance = {
  async up(db: Kysely<FoundationDatabase>) {
    await sql.raw(`CREATE TABLE person_outbound_jurisdictions (
      person_id TEXT PRIMARY KEY REFERENCES persons(id),
      region_code TEXT NOT NULL CHECK (region_code GLOB '[A-Z][A-Z]'),
      timezone TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('property_address', 'residence_evidence', 'manual_review')),
      evidence_ref TEXT NULL,
      effective_at TEXT NOT NULL,
      review_at TEXT NULL,
      updated_at TEXT NOT NULL
    )`).execute(db);
    await sql.raw(`CREATE TABLE outbound_jurisdiction_clearances (
      region_code TEXT NOT NULL CHECK (region_code GLOB '[A-Z][A-Z]'),
      channel TEXT NOT NULL CHECK (channel IN ('call', 'text')),
      decision TEXT NOT NULL CHECK (decision IN ('unknown', 'allowed', 'blocked')),
      registration_confirmed INTEGER NULL CHECK (registration_confirmed IS NULL OR registration_confirmed IN (0, 1)),
      state_dnc_subscription_confirmed INTEGER NULL CHECK (state_dnc_subscription_confirmed IS NULL OR state_dnc_subscription_confirmed IN (0, 1)),
      consent_rule_confirmed INTEGER NULL CHECK (consent_rule_confirmed IS NULL OR consent_rule_confirmed IN (0, 1)),
      source TEXT NOT NULL,
      effective_at TEXT NOT NULL,
      expires_at TEXT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (region_code, channel)
    )`).execute(db);
    await sql.raw(`CREATE TABLE outbound_jurisdiction_audit_events (
      id TEXT PRIMARY KEY,
      subject_kind TEXT NOT NULL CHECK (subject_kind IN ('person_jurisdiction', 'state_clearance')),
      subject_key TEXT NOT NULL,
      old_value_json TEXT NULL,
      new_value_json TEXT NOT NULL,
      source TEXT NOT NULL,
      effective_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`).execute(db);
    await sql.raw(`ALTER TABLE contact_compliance_audit_events
      ADD COLUMN resulting_call_reason_code TEXT NULL`).execute(db);
    await sql.raw(`ALTER TABLE contact_compliance_audit_events
      ADD COLUMN resulting_text_reason_code TEXT NULL`).execute(db);

    await sql.raw(`INSERT INTO outbound_jurisdiction_clearances
      (region_code, channel, decision, registration_confirmed,
       state_dnc_subscription_confirmed, consent_rule_confirmed, source,
       effective_at, expires_at, updated_at)
      VALUES
      ('MA', 'call', 'blocked', NULL, NULL, NULL, 'approved_design_2026_09_04', '${EFFECTIVE_AT}', NULL, '${EFFECTIVE_AT}'),
      ('RI', 'call', 'unknown', NULL, NULL, NULL, 'approved_design_2026_09_04', '${EFFECTIVE_AT}', NULL, '${EFFECTIVE_AT}'),
      ('CT', 'call', 'unknown', NULL, NULL, NULL, 'approved_design_2026_09_04', '${EFFECTIVE_AT}', NULL, '${EFFECTIVE_AT}')`).execute(db);

    await sql.raw(`WITH normalized AS (
      SELECT pr.person_id, p.id AS property_id,
        CASE trim(p.region)
          WHEN 'Massachusetts' THEN 'MA'
          WHEN 'Rhode Island' THEN 'RI'
          WHEN 'Connecticut' THEN 'CT'
          ELSE upper(trim(p.region))
        END AS region_code
      FROM prospects pr
      JOIN prospect_properties pp ON pp.prospect_id = pr.id
      JOIN properties p ON p.id = pp.property_id
      WHERE trim(p.region) <> ''
    ), unambiguous AS (
      SELECT person_id, min(region_code) AS region_code
      FROM normalized
      WHERE region_code GLOB '[A-Z][A-Z]'
      GROUP BY person_id
      HAVING count(DISTINCT region_code) = 1
    )
    INSERT INTO person_outbound_jurisdictions
      (person_id, region_code, timezone, source, evidence_ref, effective_at, review_at, updated_at)
    SELECT person_id, region_code, 'America/New_York', 'property_address', NULL,
      '${EFFECTIVE_AT}', NULL, '${EFFECTIVE_AT}'
    FROM unambiguous`).execute(db);

    await sql.raw(`INSERT INTO outbound_jurisdiction_audit_events
      (id, subject_kind, subject_key, old_value_json, new_value_json, source, effective_at, created_at)
    SELECT '0014-property-backfill-' || person_id, 'person_jurisdiction', person_id, NULL,
      json_object('regionCode', region_code, 'timezone', timezone, 'source', source,
        'evidenceRef', evidence_ref, 'effectiveAt', effective_at, 'reviewAt', review_at),
      'property_address', effective_at, updated_at
    FROM person_outbound_jurisdictions`).execute(db);
    await sql.raw(`INSERT INTO outbound_jurisdiction_audit_events
      (id, subject_kind, subject_key, old_value_json, new_value_json, source, effective_at, created_at)
    SELECT '0014-clearance-seed-' || region_code || '-' || channel, 'state_clearance',
      region_code || ':' || channel, NULL,
      json_object('regionCode', region_code, 'channel', channel, 'decision', decision,
        'registrationConfirmed', registration_confirmed,
        'stateDncSubscriptionConfirmed', state_dnc_subscription_confirmed,
        'consentRuleConfirmed', consent_rule_confirmed, 'source', source,
        'effectiveAt', effective_at, 'expiresAt', expires_at),
      source, effective_at, updated_at
    FROM outbound_jurisdiction_clearances`).execute(db);

    const timestamp = new Date().toISOString();
    await sql`UPDATE app_meta SET schema_version = 14, updated_at = ${timestamp} WHERE singleton = 1`.execute(db);
  },
};

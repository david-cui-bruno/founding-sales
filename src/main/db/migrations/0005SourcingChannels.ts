import { sql, type Kysely } from 'kysely';

import type { FoundationDatabase } from '../schema';

/**
 * Sourcing channels for the lead-sourcing cloud. `source_events.channel`
 * gains the public-record channels (parcel/deed/permit/violation),
 * `prospects.segment` renames to plain temperature names
 * (hot_frbo -> hot, cold_registry -> cold), and
 * `protect_trigger_event_ownership` learns the new trigger-type -> channel
 * mappings. SQLite cannot alter CHECK constraints, so both tables are
 * rebuilt in place: copy into a holding table, drop, recreate with the new
 * DDL under the same name, and reinsert. Foreign keys from child tables
 * reference the tables by name, so recreating them under the original names
 * keeps every FK intact; `PRAGMA defer_foreign_keys` keeps the surrounding
 * migration transaction satisfied until the rebuilt tables exist and
 * `PRAGMA foreign_key_check` proves the graph is whole before commit.
 */
const sourcingChannelsStatements = [
  // ------------------------------------------------------ source_events
  `CREATE TABLE source_events_migration_holding AS
    SELECT id, person_id, prospect_id, sales_cycle_id, channel, observed_at,
      source_record_json, evidence_ref, referred_by_person_id,
      referrer_unknown_reason, created_at
    FROM source_events`,
  `DROP TABLE source_events`,
  `CREATE TABLE source_events (
    id TEXT PRIMARY KEY,
    person_id TEXT NOT NULL REFERENCES persons(id),
    prospect_id TEXT,
    sales_cycle_id TEXT,
    channel TEXT NOT NULL CHECK (channel IN (
      'frbo', 'registry', 'rireig', 'referral',
      'inbound_demo', 'community', 'custom',
      'parcel', 'deed', 'permit', 'violation'
    )),
    observed_at TEXT NOT NULL,
    source_record_json TEXT NOT NULL,
    evidence_ref TEXT,
    referred_by_person_id TEXT REFERENCES persons(id),
    referrer_unknown_reason TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (id, person_id),
    FOREIGN KEY (prospect_id, person_id) REFERENCES prospects(id, person_id),
    FOREIGN KEY (sales_cycle_id, person_id) REFERENCES sales_cycles(id, person_id),
    CHECK (referred_by_person_id IS NULL OR referred_by_person_id <> person_id),
    CHECK (
      (
        channel = 'referral'
        AND (
          (
            referred_by_person_id IS NOT NULL
            AND referrer_unknown_reason IS NULL
          )
          OR (
            referred_by_person_id IS NULL
            AND referrer_unknown_reason IS NOT NULL
            AND length(trim(referrer_unknown_reason)) > 0
          )
        )
      )
      OR (
        channel <> 'referral'
        AND referred_by_person_id IS NULL
        AND referrer_unknown_reason IS NULL
      )
    )
  )`,
  `INSERT INTO source_events (
    id, person_id, prospect_id, sales_cycle_id, channel, observed_at,
    source_record_json, evidence_ref, referred_by_person_id,
    referrer_unknown_reason, created_at
  )
  SELECT id, person_id, prospect_id, sales_cycle_id, channel, observed_at,
    source_record_json, evidence_ref, referred_by_person_id,
    referrer_unknown_reason, created_at
  FROM source_events_migration_holding`,
  `DROP TABLE source_events_migration_holding`,
  `CREATE INDEX source_events_person_observed_idx
    ON source_events(person_id, observed_at)`,
  `CREATE TRIGGER immutable_source_events
    BEFORE UPDATE ON source_events
    BEGIN
      SELECT RAISE(ABORT, 'source_events rows are immutable');
    END`,
  `CREATE TRIGGER immutable_source_events_delete
    BEFORE DELETE ON source_events
    BEGIN
      SELECT RAISE(ABORT, 'source_events rows are immutable');
    END`,
  // ---------------------------------------------------------- prospects
  `CREATE TABLE prospects_migration_holding AS
    SELECT id, person_id, original_source_event_id, segment,
      qualification_state, qualification_gate_reason, qualification_reason,
      last_contact_at, version, created_at, updated_at
    FROM prospects`,
  `DROP TABLE prospects`,
  `CREATE TABLE prospects (
    id TEXT PRIMARY KEY,
    person_id TEXT NOT NULL REFERENCES persons(id),
    original_source_event_id TEXT NOT NULL,
    segment TEXT NOT NULL CHECK (segment IN ('hot', 'cold', 'warm')),
    qualification_state TEXT NOT NULL CHECK (
      qualification_state IN ('unreviewed', 'eligible', 'disqualified', 'merge_review')
    ),
    qualification_gate_reason TEXT CHECK (
      qualification_gate_reason IN (
        'out_of_area', 'no_relevant_decision_relationship', 'institutional_outside_icp',
        'harmful_operator', 'non_paying_operator', 'unresolved_duplicate'
      )
    ),
    qualification_reason TEXT,
    last_contact_at TEXT,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (person_id),
    UNIQUE (id, person_id),
    CHECK (
      (qualification_state = 'disqualified' AND qualification_gate_reason IS NOT NULL)
      OR (qualification_state <> 'disqualified' AND qualification_gate_reason IS NULL)
    ),
    FOREIGN KEY (original_source_event_id, person_id)
      REFERENCES source_events(id, person_id)
  )`,
  `INSERT INTO prospects (
    id, person_id, original_source_event_id, segment,
    qualification_state, qualification_gate_reason, qualification_reason,
    last_contact_at, version, created_at, updated_at
  )
  SELECT id, person_id, original_source_event_id,
    CASE segment
      WHEN 'hot_frbo' THEN 'hot'
      WHEN 'cold_registry' THEN 'cold'
      ELSE segment
    END,
    qualification_state, qualification_gate_reason, qualification_reason,
    last_contact_at, version, created_at, updated_at
  FROM prospects_migration_holding`,
  `DROP TABLE prospects_migration_holding`,
  `CREATE TRIGGER protect_prospect_original_source
    BEFORE UPDATE OF original_source_event_id ON prospects
    WHEN NEW.original_source_event_id IS NOT OLD.original_source_event_id
    BEGIN
      SELECT RAISE(ABORT, 'original acquisition source is immutable');
    END`,
  // ------------------------------------------------- intake receipt data
  // Canonical intake commands persist the prospect segment; remap the
  // renamed values in place so stored receipts stay parseable. Canonical
  // JSON escapes every quote inside string values, so the bare key/value
  // byte pattern below can only match the real segment field.
  `DROP TRIGGER immutable_source_intake_receipts`,
  `UPDATE source_intake_receipts
    SET command_json = REPLACE(
      REPLACE(command_json, '"segment":"hot_frbo"', '"segment":"hot"'),
      '"segment":"cold_registry"', '"segment":"cold"'
    )
    WHERE command_json LIKE '%"segment":"hot_frbo"%'
      OR command_json LIKE '%"segment":"cold_registry"%'`,
  `CREATE TRIGGER immutable_source_intake_receipts
    BEFORE UPDATE ON source_intake_receipts
    BEGIN
      SELECT RAISE(ABORT, 'source_intake_receipts rows are immutable');
    END`,
  // ------------------------------------------------ trigger ownership
  `DROP TRIGGER protect_trigger_event_ownership`,
  `CREATE TRIGGER protect_trigger_event_ownership
    BEFORE INSERT ON trigger_events
    WHEN NEW.source_event_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM prospects AS prospect
        JOIN source_events AS source ON source.id = NEW.source_event_id
        WHERE prospect.id = NEW.prospect_id
          AND prospect.person_id = source.person_id
          AND NEW.effective_at = source.observed_at
          AND (
            (NEW.trigger_type = 'live_vacancy' AND source.channel = 'frbo')
            OR (NEW.trigger_type = 'inbound_demo' AND source.channel = 'inbound_demo')
            OR (NEW.trigger_type = 'direct_referral' AND source.channel = 'referral')
            OR (NEW.trigger_type = 'rireig_connection' AND source.channel = 'rireig')
            OR (NEW.trigger_type = 'permit_filed' AND source.channel = 'permit')
            OR (NEW.trigger_type = 'violation_opened' AND source.channel = 'violation')
            OR (NEW.trigger_type = 'deed_transfer' AND source.channel = 'deed')
            OR (NEW.trigger_type = 'community_post' AND source.channel = 'community')
            OR (NEW.trigger_type = 'review_pain' AND source.channel = 'parcel')
            OR (
              NEW.trigger_type NOT IN (
                'live_vacancy','inbound_demo','direct_referral','rireig_connection',
                'permit_filed','violation_opened','deed_transfer','community_post',
                'review_pain'
              )
              AND json_extract(source.source_record_json, '$.prioritizationTrigger.version') = 1
              AND json_extract(source.source_record_json, '$.prioritizationTrigger.signal')
                = NEW.trigger_type
            )
          )
      )
    BEGIN
      SELECT RAISE(ABORT, 'trigger evidence must belong to the prospect person');
    END`,
] as const;

export const migration0005SourcingChannels = {
  async up(db: Kysely<FoundationDatabase>) {
    // The migration runner holds one BEGIN IMMEDIATE transaction around
    // every pending migration. Deferring foreign keys is scoped to that
    // transaction and resets itself at commit.
    await sql.raw('PRAGMA defer_foreign_keys = ON').execute(db);

    for (const statement of sourcingChannelsStatements) {
      await sql.raw(statement).execute(db);
    }

    const violations = await sql.raw('PRAGMA foreign_key_check').execute(db);
    if (violations.rows.length > 0) {
      throw new Error(
        'The sourcing-channels table rebuild left dangling foreign keys.',
      );
    }

    const timestamp = new Date().toISOString();
    await sql`
      UPDATE app_meta
      SET schema_version = 5, updated_at = ${timestamp}
      WHERE singleton = 1
    `.execute(db);
  },
};

import { sql, type Kysely } from 'kysely';

import type { FoundationDatabase } from '../schema';

/**
 * Manual transcript recovery storage. Transcripts and their utterances are
 * append-only evidence, exactly like activities. 0002 made activities fully
 * immutable; attaching a transcript needs a one-way exception, so this
 * migration replaces the blanket `immutable_activities` UPDATE trigger with
 * a column-scoped version plus an append-only guard for the two transcript
 * evidence columns. The DELETE trigger from 0002 is left untouched.
 */
const transcriptStatements = [
  `CREATE TABLE transcripts (
    id TEXT PRIMARY KEY,
    activity_id TEXT NOT NULL,
    person_id TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('manual_paste')),
    format_version INTEGER NOT NULL CHECK (format_version = 1),
    raw_text TEXT NOT NULL CHECK (length(raw_text) > 0),
    created_at TEXT NOT NULL,
    UNIQUE (activity_id),
    FOREIGN KEY (activity_id, person_id) REFERENCES activities(id, person_id)
  )`,
  `CREATE TABLE transcript_utterances (
    id TEXT PRIMARY KEY,
    transcript_id TEXT NOT NULL REFERENCES transcripts(id),
    sequence INTEGER NOT NULL CHECK (sequence >= 0),
    speaker TEXT NOT NULL CHECK (speaker IN ('founder','lead','unknown')),
    text TEXT NOT NULL CHECK (length(trim(text)) > 0),
    UNIQUE (transcript_id, sequence)
  )`,
  ...immutableTriggers('transcripts'),
  ...immutableTriggers('transcript_utterances'),
  `DROP TRIGGER immutable_activities`,
  `CREATE TRIGGER immutable_activities
    BEFORE UPDATE ON activities
    WHEN NEW.id IS NOT OLD.id
      OR NEW.person_id IS NOT OLD.person_id
      OR NEW.prospect_id IS NOT OLD.prospect_id
      OR NEW.sales_cycle_id IS NOT OLD.sales_cycle_id
      OR NEW.cadence_enrollment_id IS NOT OLD.cadence_enrollment_id
      OR NEW.cadence_step_id IS NOT OLD.cadence_step_id
      OR NEW.cadence_component_id IS NOT OLD.cadence_component_id
      OR NEW.kind IS NOT OLD.kind
      OR NEW.direction IS NOT OLD.direction
      OR NEW.channel IS NOT OLD.channel
      OR NEW.occurred_at IS NOT OLD.occurred_at
      OR NEW.duration_seconds IS NOT OLD.duration_seconds
      OR NEW.observed_outcome IS NOT OLD.observed_outcome
      OR NEW.adapter IS NOT OLD.adapter
      OR NEW.provider_idempotency_key IS NOT OLD.provider_idempotency_key
      OR NEW.provider_reference IS NOT OLD.provider_reference
      OR NEW.recording_storage_ref IS NOT OLD.recording_storage_ref
      OR NEW.metadata_json IS NOT OLD.metadata_json
      OR NEW.created_at IS NOT OLD.created_at
    BEGIN
      SELECT RAISE(ABORT, 'activities rows are immutable');
    END`,
  `CREATE TRIGGER protect_activity_transcript_attach
    BEFORE UPDATE OF transcript_storage_ref, consent_policy_record_id
      ON activities
    WHEN (
      NEW.transcript_storage_ref IS NOT OLD.transcript_storage_ref
      OR NEW.consent_policy_record_id IS NOT OLD.consent_policy_record_id
    ) AND NOT (
      OLD.transcript_storage_ref IS NULL
      AND OLD.consent_policy_record_id IS NULL
      AND NEW.transcript_storage_ref IS NOT NULL
      AND NEW.consent_policy_record_id IS NOT NULL
    )
    BEGIN
      SELECT RAISE(ABORT, 'activity transcript evidence is append-only');
    END`,
] as const;

function immutableTriggers(table: string): readonly string[] {
  return [
    `CREATE TRIGGER immutable_${table}
      BEFORE UPDATE ON ${table}
      BEGIN
        SELECT RAISE(ABORT, '${table} rows are immutable');
      END`,
    `CREATE TRIGGER immutable_${table}_delete
      BEFORE DELETE ON ${table}
      BEGIN
        SELECT RAISE(ABORT, '${table} rows are immutable');
      END`,
  ];
}

export const migration0003Transcripts = {
  async up(db: Kysely<FoundationDatabase>) {
    for (const statement of transcriptStatements) {
      await sql.raw(statement).execute(db);
    }

    const timestamp = new Date().toISOString();
    await sql`
      UPDATE app_meta
      SET schema_version = 3, updated_at = ${timestamp}
      WHERE singleton = 1
    `.execute(db);
  },
};

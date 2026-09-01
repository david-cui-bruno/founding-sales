import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { createMigrationRunner } from '../../src/main/db/migrate';
import { migration0001Foundation } from '../../src/main/db/migrations/0001Foundation';
import { migration0002DomainFoundation } from '../../src/main/db/migrations/0002DomainFoundation';
import { migration0003Transcripts } from '../../src/main/db/migrations/0003Transcripts';
import { DOMAIN_TIMESTAMP, insertPerson } from '../fixtures/domainRows';
import {
  createTempDatabase,
  createTestWorkspaceKey,
  type TempDatabase,
} from '../fixtures/tempDatabase';

const migrateThroughTranscripts = createMigrationRunner([
  { id: '0001Foundation', schemaVersion: 1, migration: migration0001Foundation },
  { id: '0002DomainFoundation', schemaVersion: 2, migration: migration0002DomainFoundation },
  { id: '0003Transcripts', schemaVersion: 3, migration: migration0003Transcripts },
]);

describe('0003 transcripts migration', () => {
  let database: AppDatabase;
  let tempDatabase: TempDatabase;

  beforeEach(async () => {
    tempDatabase = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: tempDatabase.path, key });
    await migrateThroughTranscripts(database, {
      backupDirectory: `${tempDatabase.path}.backups`,
      workspaceKey: key,
    });
  });

  afterEach(() => {
    closeDatabase(database);
    tempDatabase.cleanup();
  });

  function insertActivity(activityId: string, personId: string): void {
    insertPerson(database.raw, personId);
    database.raw.prepare(`
      INSERT INTO activities (
        id, person_id, kind, direction, channel, occurred_at,
        metadata_json, created_at
      ) VALUES (?, ?, 'call', 'outbound', 'phone', ?, '{}', ?)
    `).run(activityId, personId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
  }

  function insertConsentRecord(input: {
    id: string;
    personId: string;
    activityId: string;
  }): void {
    database.raw.prepare(`
      INSERT INTO consent_policy_records (
        id, person_id, activity_id, policy_kind, policy_version,
        effective_at, decision, evidence_json, created_at
      ) VALUES (?, ?, ?, 'recording', 'manual-attach-v1', ?, 'granted', ?, ?)
    `).run(
      input.id,
      input.personId,
      input.activityId,
      DOMAIN_TIMESTAMP,
      JSON.stringify({ kind: 'founder_manual_attach' }),
      DOMAIN_TIMESTAMP,
    );
  }

  function insertTranscript(input: {
    id: string;
    activityId: string;
    personId: string;
  }): void {
    database.raw.prepare(`
      INSERT INTO transcripts (
        id, activity_id, person_id, source, format_version, raw_text, created_at
      ) VALUES (?, ?, ?, 'manual_paste', 1, 'me: hello', ?)
    `).run(input.id, input.activityId, input.personId, DOMAIN_TIMESTAMP);
  }

  function insertUtterance(input: {
    id: string;
    transcriptId: string;
    sequence?: number;
    speaker?: string;
    text?: string;
  }): void {
    database.raw.prepare(`
      INSERT INTO transcript_utterances (
        id, transcript_id, sequence, speaker, text
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.transcriptId,
      input.sequence ?? 0,
      input.speaker ?? 'founder',
      input.text ?? 'hello',
    );
  }

  it('creates the transcript tables, triggers, and schema version 3', () => {
    const names = database.raw.prepare<[], { name: string }>(`
      SELECT name FROM sqlite_master
      WHERE name IN (
        'transcripts', 'transcript_utterances',
        'immutable_transcripts', 'immutable_transcripts_delete',
        'immutable_transcript_utterances', 'immutable_transcript_utterances_delete',
        'immutable_activities', 'immutable_activities_delete',
        'protect_activity_transcript_attach'
      )
      ORDER BY name
    `).all().map(({ name }) => name);

    expect(names).toEqual([
      'immutable_activities',
      'immutable_activities_delete',
      'immutable_transcript_utterances',
      'immutable_transcript_utterances_delete',
      'immutable_transcripts',
      'immutable_transcripts_delete',
      'protect_activity_transcript_attach',
      'transcript_utterances',
      'transcripts',
    ]);
    expect(database.raw.prepare<[], { schema_version: number }>(
      'SELECT schema_version FROM app_meta WHERE singleton = 1',
    ).get()).toEqual({ schema_version: 3 });
  });

  it('keeps transcripts append-only', () => {
    insertActivity('activity-1', 'person-1');
    insertTranscript({ id: 'transcript-1', activityId: 'activity-1', personId: 'person-1' });

    expect(() => database.raw.prepare(
      "UPDATE transcripts SET raw_text = 'edited' WHERE id = 'transcript-1'",
    ).run()).toThrow(/immutable/);
    expect(() => database.raw.prepare(
      "DELETE FROM transcripts WHERE id = 'transcript-1'",
    ).run()).toThrow(/immutable/);
  });

  it('keeps transcript utterances append-only', () => {
    insertActivity('activity-1', 'person-1');
    insertTranscript({ id: 'transcript-1', activityId: 'activity-1', personId: 'person-1' });
    insertUtterance({ id: 'utterance-1', transcriptId: 'transcript-1' });

    expect(() => database.raw.prepare(
      "UPDATE transcript_utterances SET text = 'edited' WHERE id = 'utterance-1'",
    ).run()).toThrow(/immutable/);
    expect(() => database.raw.prepare(
      "DELETE FROM transcript_utterances WHERE id = 'utterance-1'",
    ).run()).toThrow(/immutable/);
  });

  it('requires an existing owning activity for a transcript', () => {
    expect(() => insertTranscript({
      id: 'transcript-orphan', activityId: 'missing-activity', personId: 'missing-person',
    })).toThrow(/FOREIGN KEY/i);
  });

  it('rejects a transcript whose person does not own the activity', () => {
    insertActivity('activity-1', 'person-1');
    insertPerson(database.raw, 'person-2');

    expect(() => insertTranscript({
      id: 'transcript-wrong-person', activityId: 'activity-1', personId: 'person-2',
    })).toThrow(/FOREIGN KEY/i);
  });

  it('allows exactly one transcript per activity', () => {
    insertActivity('activity-1', 'person-1');
    insertTranscript({ id: 'transcript-1', activityId: 'activity-1', personId: 'person-1' });

    expect(() => insertTranscript({
      id: 'transcript-2', activityId: 'activity-1', personId: 'person-1',
    })).toThrow(/UNIQUE/i);
  });

  it('requires an existing transcript for an utterance', () => {
    expect(() => insertUtterance({
      id: 'utterance-orphan', transcriptId: 'missing-transcript',
    })).toThrow(/FOREIGN KEY/i);
  });

  it('enforces utterance sequence uniqueness, speakers, and non-blank text', () => {
    insertActivity('activity-1', 'person-1');
    insertTranscript({ id: 'transcript-1', activityId: 'activity-1', personId: 'person-1' });
    insertUtterance({ id: 'utterance-1', transcriptId: 'transcript-1', sequence: 0 });

    expect(() => insertUtterance({
      id: 'utterance-2', transcriptId: 'transcript-1', sequence: 0,
    })).toThrow(/UNIQUE/i);
    expect(() => insertUtterance({
      id: 'utterance-3', transcriptId: 'transcript-1', sequence: 1, speaker: 'me',
    })).toThrow(/CHECK/i);
    expect(() => insertUtterance({
      id: 'utterance-4', transcriptId: 'transcript-1', sequence: 1, text: '   ',
    })).toThrow(/CHECK/i);
    expect(() => insertUtterance({
      id: 'utterance-5', transcriptId: 'transcript-1', sequence: -1,
    })).toThrow(/CHECK/i);
  });

  it('allows updating only the transcript evidence columns on activities', () => {
    insertActivity('activity-1', 'person-1');
    insertConsentRecord({ id: 'consent-1', personId: 'person-1', activityId: 'activity-1' });

    const result = database.raw.prepare(`
      UPDATE activities
      SET transcript_storage_ref = 'db:transcripts/transcript-1',
        consent_policy_record_id = 'consent-1'
      WHERE id = 'activity-1'
    `).run();

    expect(result.changes).toBe(1);
    expect(database.raw.prepare<[], {
      transcript_storage_ref: string; consent_policy_record_id: string;
    }>(`
      SELECT transcript_storage_ref, consent_policy_record_id
      FROM activities WHERE id = 'activity-1'
    `).get()).toEqual({
      transcript_storage_ref: 'db:transcripts/transcript-1',
      consent_policy_record_id: 'consent-1',
    });
  });

  it('still rejects updates to every other activity column', () => {
    insertActivity('activity-1', 'person-1');

    for (const statement of [
      "UPDATE activities SET occurred_at = '2026-08-31T00:00:00.000Z' WHERE id = 'activity-1'",
      "UPDATE activities SET metadata_json = '{\"edited\":true}' WHERE id = 'activity-1'",
      "UPDATE activities SET kind = 'voicemail' WHERE id = 'activity-1'",
      "UPDATE activities SET duration_seconds = 5 WHERE id = 'activity-1'",
      "UPDATE activities SET recording_storage_ref = 'ref' WHERE id = 'activity-1'",
    ]) {
      expect(() => database.raw.prepare(statement).run()).toThrow(/immutable/);
    }
  });

  it('still rejects deleting activities', () => {
    insertActivity('activity-1', 'person-1');

    expect(() => database.raw.prepare(
      "DELETE FROM activities WHERE id = 'activity-1'",
    ).run()).toThrow(/immutable/);
  });

  it('rejects clearing or replacing attached transcript evidence', () => {
    insertActivity('activity-1', 'person-1');
    insertConsentRecord({ id: 'consent-1', personId: 'person-1', activityId: 'activity-1' });
    database.raw.prepare(`
      UPDATE activities
      SET transcript_storage_ref = 'db:transcripts/transcript-1',
        consent_policy_record_id = 'consent-1'
      WHERE id = 'activity-1'
    `).run();

    expect(() => database.raw.prepare(`
      UPDATE activities
      SET transcript_storage_ref = NULL, consent_policy_record_id = NULL
      WHERE id = 'activity-1'
    `).run()).toThrow(/append-only/);
    expect(() => database.raw.prepare(`
      UPDATE activities
      SET transcript_storage_ref = 'db:transcripts/transcript-2'
      WHERE id = 'activity-1'
    `).run()).toThrow(/append-only/);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../../../src/main/db/database';
import { createMigrationRunner, migrateToLatest } from '../../../../src/main/db/migrate';
import { migration0001Foundation } from '../../../../src/main/db/migrations/0001Foundation';
import { migration0002DomainFoundation } from '../../../../src/main/db/migrations/0002DomainFoundation';
import { migration0003Transcripts } from '../../../../src/main/db/migrations/0003Transcripts';
import { migration0004Learnings } from '../../../../src/main/db/migrations/0004Learnings';
import { migration0005SourcingChannels } from '../../../../src/main/db/migrations/0005SourcingChannels';
import { migration0006SourcingState } from '../../../../src/main/db/migrations/0006SourcingState';
import { migration0007SourcingOutbox } from '../../../../src/main/db/migrations/0007SourcingOutbox';
import {
  serializeCanonicalIntakeResult,
  type StoredIntakeResult,
} from '../../../../src/main/domain/source/intakeReceiptRepository';
import {
  createTempDatabase,
  createTestWorkspaceKey,
  type TempDatabase,
} from '../../../fixtures/tempDatabase';

const migrateThroughSchema7 = createMigrationRunner([
  { id: '0001Foundation', schemaVersion: 1, migration: migration0001Foundation },
  { id: '0002DomainFoundation', schemaVersion: 2, migration: migration0002DomainFoundation },
  { id: '0003Transcripts', schemaVersion: 3, migration: migration0003Transcripts },
  { id: '0004Learnings', schemaVersion: 4, migration: migration0004Learnings },
  { id: '0005SourcingChannels', schemaVersion: 5, migration: migration0005SourcingChannels },
  { id: '0006SourcingState', schemaVersion: 6, migration: migration0006SourcingState },
  { id: '0007SourcingOutbox', schemaVersion: 7, migration: migration0007SourcingOutbox },
]);

const T_EARLIER = '2026-08-30T12:00:00.000Z';
const T_LATER = '2026-08-30T13:00:00.000Z';
const PARCEL_SOURCE_ID = `cloud:${'a'.repeat(64)}`;
const VIOLATION_SOURCE_ID = `cloud:${'b'.repeat(64)}`;

const REPAIRED_TRIGGERS = [
  'immutable_prioritization_evaluations_delete',
  'immutable_source_events',
  'immutable_source_intake_receipts',
  'immutable_stage_events_delete',
  'immutable_trigger_events',
  'protect_next_action_delete',
] as const;

type SeededDuplicatePair = {
  canonical: { personId: string; prospectId: string; cycleId: string };
  duplicate: { personId: string; prospectId: string; cycleId: string };
};

describe('0008 dedupe cloud persons migration', () => {
  let database: AppDatabase;
  let temp: TempDatabase;
  let options: { backupDirectory: string; workspaceKey: ReturnType<typeof createTestWorkspaceKey> };

  beforeEach(async () => {
    temp = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: temp.path, key });
    options = { backupDirectory: `${temp.path}.backups`, workspaceKey: key };
    await migrateThroughSchema7(database, options);
  });

  afterEach(() => {
    closeDatabase(database);
    temp.cleanup();
  });

  function insertPersonRow(input: {
    id: string; displayName: string; createdAt: string;
  }): void {
    database.raw.prepare(`
      INSERT INTO persons (
        id, display_name, aliases_json, opted_out, never_record, version,
        created_at, updated_at
      ) VALUES (?, ?, '[]', 0, 0, 1, ?, ?)
    `).run(input.id, input.displayName, input.createdAt, input.createdAt);
  }

  function insertCloudSourceEvent(input: {
    id: string; personId: string; channel: string;
  }): void {
    database.raw.prepare(`
      INSERT INTO source_events (
        id, person_id, channel, observed_at, source_record_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.id, input.personId, input.channel, T_EARLIER,
      JSON.stringify({
        formatVersion: 1,
        sourceRecord: { cloudSourceEvent: { fixture: true } },
        customSourceReason: null,
      }),
      T_EARLIER,
    );
  }

  function insertProspectRow(input: {
    id: string; personId: string; sourceEventId: string; createdAt: string;
    cloudScore?: { fit: number; timing: number; version: number };
  }): void {
    database.raw.prepare(`
      INSERT INTO prospects (
        id, person_id, original_source_event_id, segment, qualification_state,
        cloud_fit, cloud_timing, cloud_score_reasons_json, cloud_scores_version,
        cloud_scored_at, version, created_at, updated_at
      ) VALUES (?, ?, ?, 'cold', 'unreviewed', ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      input.id, input.personId, input.sourceEventId,
      input.cloudScore?.fit ?? null,
      input.cloudScore?.timing ?? null,
      input.cloudScore === undefined
        ? null
        : JSON.stringify([{ signal: 'violation_opened', contribution: 0.6 }]),
      input.cloudScore?.version ?? null,
      input.cloudScore === undefined ? null : input.createdAt,
      input.createdAt, input.createdAt,
    );
  }

  function insertUnreviewedCycle(input: {
    prefix: string; personId: string; prospectId: string; sourceEventId: string;
  }): { cycleId: string; actionId: string } {
    const cycleId = `${input.prefix}-cycle`;
    const actionId = `${input.prefix}-action`;
    database.raw.exec('BEGIN IMMEDIATE');
    try {
      database.raw.prepare(`
        INSERT INTO sales_cycles (
          id, person_id, prospect_id, entry_source_event_id, stage,
          workflow_status, current_next_action_id, stage_entered_at,
          version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'unreviewed', 'active', ?, ?, 1, ?, ?)
      `).run(
        cycleId, input.personId, input.prospectId, input.sourceEventId,
        actionId, T_EARLIER, T_EARLIER, T_EARLIER,
      );
      database.raw.prepare(`
        INSERT INTO next_actions (
          id, sales_cycle_id, action_type, channel, status, due_at,
          timezone, work_intent, created_at
        ) VALUES (?, ?, 'review_lead', NULL, 'pending', ?, 'America/New_York',
          'internal_review', ?)
      `).run(actionId, cycleId, T_EARLIER, T_EARLIER);
      database.raw.prepare(`
        INSERT INTO stage_events (
          id, sales_cycle_id, from_stage, to_stage, effective_at, confirmed_at,
          confirmation_kind, transition_sequence, created_at
        ) VALUES (?, ?, NULL, 'unreviewed', ?, ?, 'mechanical', 1, ?)
      `).run(`${input.prefix}-stage`, cycleId, T_EARLIER, T_EARLIER, T_EARLIER);
      database.raw.exec('COMMIT');
    } catch (error) {
      if (database.raw.inTransaction) database.raw.exec('ROLLBACK');
      throw error;
    }
    return { cycleId, actionId };
  }

  function insertReceipt(input: {
    sourceEventId: string; personId: string; prospectId: string;
  }): void {
    const result: StoredIntakeResult = {
      disposition: 'created',
      personId: input.personId,
      prospectId: input.prospectId,
      sourceEventId: input.sourceEventId,
      identityReviewReason: null,
      contextReviewReasons: [],
      organizationIds: [],
      propertyIds: [],
    };
    database.raw.prepare(`
      INSERT INTO source_intake_receipts (
        source_event_id, person_id, prospect_id, command_json, result_json,
        created_at
      ) VALUES (?, ?, ?, '{"formatVersion":1}', ?, ?)
    `).run(
      input.sourceEventId, input.personId, input.prospectId,
      serializeCanonicalIntakeResult(result), T_EARLIER,
    );
  }

  function insertLink(cloudEntityId: string, personId: string): void {
    database.raw.prepare(`
      INSERT INTO cloud_entity_links (cloud_entity_id, person_id, linked_at)
      VALUES (?, ?, ?)
    `).run(cloudEntityId, personId, T_EARLIER);
  }

  /** The exact live dupe shape: parcel person + violation person, same name. */
  function seedLiveDuplicateShape(): SeededDuplicatePair {
    insertPersonRow({ id: 'person-a', displayName: '212 LLC', createdAt: T_EARLIER });
    insertCloudSourceEvent({ id: PARCEL_SOURCE_ID, personId: 'person-a', channel: 'parcel' });
    insertProspectRow({
      id: 'prospect-a', personId: 'person-a',
      sourceEventId: PARCEL_SOURCE_ID, createdAt: T_EARLIER,
    });
    const canonicalCycle = insertUnreviewedCycle({
      prefix: 'a', personId: 'person-a', prospectId: 'prospect-a',
      sourceEventId: PARCEL_SOURCE_ID,
    });
    insertReceipt({
      sourceEventId: PARCEL_SOURCE_ID, personId: 'person-a', prospectId: 'prospect-a',
    });
    insertLink('ce_01JC00000000000000000000AA', 'person-a');

    insertPersonRow({ id: 'person-b', displayName: '212, LLC.', createdAt: T_LATER });
    insertCloudSourceEvent({
      id: VIOLATION_SOURCE_ID, personId: 'person-b', channel: 'violation',
    });
    insertProspectRow({
      id: 'prospect-b', personId: 'person-b',
      sourceEventId: VIOLATION_SOURCE_ID, createdAt: T_LATER,
      cloudScore: { fit: 82, timing: 64, version: 3 },
    });
    const duplicateCycle = insertUnreviewedCycle({
      prefix: 'b', personId: 'person-b', prospectId: 'prospect-b',
      sourceEventId: VIOLATION_SOURCE_ID,
    });
    insertReceipt({
      sourceEventId: VIOLATION_SOURCE_ID, personId: 'person-b', prospectId: 'prospect-b',
    });
    insertLink('ce_01JC00000000000000000000BB', 'person-b');

    return {
      canonical: {
        personId: 'person-a', prospectId: 'prospect-a', cycleId: canonicalCycle.cycleId,
      },
      duplicate: {
        personId: 'person-b', prospectId: 'prospect-b', cycleId: duplicateCycle.cycleId,
      },
    };
  }

  async function migrateToSchema8(): Promise<Awaited<ReturnType<typeof migrateToLatest>>> {
    return migrateToLatest(database, options);
  }

  function count(table: string): number {
    return (database.raw.prepare(
      `SELECT COUNT(*) AS count FROM ${table}`,
    ).get() as { count: number }).count;
  }

  it('migrates a fresh database to schema version 8', async () => {
    const result = await migrateToSchema8();
    expect(result.toVersion).toBe(8);
    expect(result.appliedMigrationIds).toContain('0008DedupeCloudPersons');
    expect(database.raw.prepare<[], { schema_version: number }>(
      'SELECT schema_version FROM app_meta WHERE singleton = 1',
    ).get()).toEqual({ schema_version: 8 });
  });

  it('merges the live dupe shape into the earliest person with links and receipts repointed', async () => {
    seedLiveDuplicateShape();

    await migrateToSchema8();

    // One person survives: the earliest created_at.
    expect(database.raw.prepare<[], { id: string; display_name: string }>(
      'SELECT id, display_name FROM persons',
    ).all()).toEqual([{ id: 'person-a', display_name: '212 LLC' }]);

    // Both cloud entity links point at the survivor.
    expect(database.raw.prepare<[], { cloud_entity_id: string; person_id: string }>(
      'SELECT cloud_entity_id, person_id FROM cloud_entity_links ORDER BY cloud_entity_id',
    ).all()).toEqual([
      { cloud_entity_id: 'ce_01JC00000000000000000000AA', person_id: 'person-a' },
      { cloud_entity_id: 'ce_01JC00000000000000000000BB', person_id: 'person-a' },
    ]);

    // Both immutable source events belong to the survivor.
    expect(database.raw.prepare<[], { id: string; person_id: string }>(
      'SELECT id, person_id FROM source_events ORDER BY id',
    ).all()).toEqual([
      { id: PARCEL_SOURCE_ID, person_id: 'person-a' },
      { id: VIOLATION_SOURCE_ID, person_id: 'person-a' },
    ]);

    // Receipts stay intact and repoint (row columns AND result_json payload),
    // so applyCloudScoreUpdate keeps resolving the violation receipt key.
    const receipts = database.raw.prepare<[], {
      source_event_id: string; person_id: string; prospect_id: string;
      result_json: string;
    }>(`
      SELECT source_event_id, person_id, prospect_id, result_json
      FROM source_intake_receipts ORDER BY source_event_id
    `).all();
    expect(receipts.map(({ source_event_id, person_id, prospect_id }) => ({
      source_event_id, person_id, prospect_id,
    }))).toEqual([
      {
        source_event_id: PARCEL_SOURCE_ID,
        person_id: 'person-a',
        prospect_id: 'prospect-a',
      },
      {
        source_event_id: VIOLATION_SOURCE_ID,
        person_id: 'person-a',
        prospect_id: 'prospect-a',
      },
    ]);
    for (const receipt of receipts) {
      const parsed = JSON.parse(receipt.result_json) as {
        result: { personId: string; prospectId: string };
      };
      expect(parsed.result.personId).toBe('person-a');
      expect(parsed.result.prospectId).toBe('prospect-a');
    }

    // Exactly one prospect (the earliest) and the duplicate's newer cloud
    // score preserved on it.
    expect(database.raw.prepare<[], {
      id: string; cloud_fit: number; cloud_timing: number;
      cloud_scores_version: number;
    }>(`
      SELECT id, cloud_fit, cloud_timing, cloud_scores_version FROM prospects
    `).all()).toEqual([{
      id: 'prospect-a', cloud_fit: 82, cloud_timing: 64, cloud_scores_version: 3,
    }]);

    // The duplicate's mechanical cycle machinery is gone; the survivor keeps
    // exactly one open cycle.
    expect(database.raw.prepare<[], { id: string; person_id: string }>(
      'SELECT id, person_id FROM sales_cycles',
    ).all()).toEqual([{ id: 'a-cycle', person_id: 'person-a' }]);
    expect(count('next_actions')).toBe(1);
    expect(count('stage_events')).toBe(1);

    // The graph is whole.
    expect(database.raw.pragma('foreign_key_check')).toEqual([]);
  });

  it('restores the immutability triggers after the repair', async () => {
    seedLiveDuplicateShape();

    await migrateToSchema8();

    const triggers = database.raw.prepare<string[], { name: string }>(`
      SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN (${
        REPAIRED_TRIGGERS.map(() => '?').join(', ')
      }) ORDER BY name
    `).all(...REPAIRED_TRIGGERS).map(({ name }) => name);
    expect(triggers).toEqual([...REPAIRED_TRIGGERS]);

    expect(() => database.raw.prepare(
      'UPDATE source_events SET person_id = ? WHERE id = ?',
    ).run('person-x', PARCEL_SOURCE_ID)).toThrow(/immutable/i);
    expect(() => database.raw.prepare(
      'DELETE FROM source_events WHERE id = ?',
    ).run(PARCEL_SOURCE_ID)).toThrow(/immutable/i);
    expect(() => database.raw.prepare(
      'UPDATE source_intake_receipts SET person_id = ? WHERE source_event_id = ?',
    ).run('person-x', PARCEL_SOURCE_ID)).toThrow(/immutable/i);
    expect(() => database.raw.prepare(
      'DELETE FROM stage_events WHERE id = ?',
    ).run('a-stage')).toThrow(/immutable/i);
    expect(() => database.raw.prepare(
      'DELETE FROM next_actions WHERE id = ?',
    ).run('a-action')).toThrow(/retained/i);
  });

  it('leaves duplicates with founder-generated data untouched', async () => {
    seedLiveDuplicateShape();
    // The founder logged a call against the duplicate: merging would delete
    // or orphan evidence, so the duplicate must survive whole.
    database.raw.prepare(`
      INSERT INTO activities (
        id, person_id, prospect_id, sales_cycle_id, kind, direction, channel,
        occurred_at, metadata_json, created_at
      ) VALUES ('activity-b', 'person-b', 'prospect-b', 'b-cycle', 'call',
        'outbound', 'phone', ?, '{}', ?)
    `).run(T_LATER, T_LATER);

    await migrateToSchema8();

    expect(count('persons')).toBe(2);
    expect(count('prospects')).toBe(2);
    expect(count('sales_cycles')).toBe(2);
    expect(database.raw.prepare<[string], { person_id: string }>(
      'SELECT person_id FROM source_intake_receipts WHERE source_event_id = ?',
    ).get(VIOLATION_SOURCE_ID)).toEqual({ person_id: 'person-b' });
    expect(database.raw.pragma('foreign_key_check')).toEqual([]);
  });

  it('never merges cloud persons into a same-named manually-created person', async () => {
    seedLiveDuplicateShape();
    // A manually-created person (no cloud entity link) sharing the name.
    insertPersonRow({
      id: 'person-manual', displayName: '212 LLC', createdAt: '2026-08-29T12:00:00.000Z',
    });

    await migrateToSchema8();

    // The manual person is untouched; the two cloud persons still merged.
    expect(database.raw.prepare<[], { id: string }>(
      'SELECT id FROM persons ORDER BY id',
    ).all()).toEqual([{ id: 'person-a' }, { id: 'person-manual' }]);
    expect(database.raw.prepare<[], { person_id: string }>(
      'SELECT DISTINCT person_id FROM cloud_entity_links',
    ).all()).toEqual([{ person_id: 'person-a' }]);
  });
});

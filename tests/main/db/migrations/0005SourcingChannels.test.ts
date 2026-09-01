import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../../../src/main/db/database';
import { createMigrationRunner } from '../../../../src/main/db/migrate';
import { migration0001Foundation } from '../../../../src/main/db/migrations/0001Foundation';
import { migration0002DomainFoundation } from '../../../../src/main/db/migrations/0002DomainFoundation';
import { migration0003Transcripts } from '../../../../src/main/db/migrations/0003Transcripts';
import { migration0004Learnings } from '../../../../src/main/db/migrations/0004Learnings';
import { migration0005SourcingChannels } from '../../../../src/main/db/migrations/0005SourcingChannels';
import {
  DOMAIN_TIMESTAMP,
  insertOpenCycleWithAction,
  insertPerson,
  insertSourceEvent,
  seedProspect,
  type SeededProspect,
} from '../../../fixtures/domainRows';
import {
  createTempDatabase,
  createTestWorkspaceKey,
  type TempDatabase,
} from '../../../fixtures/tempDatabase';

const migrateThroughDomainFoundation = createMigrationRunner([
  { id: '0001Foundation', schemaVersion: 1, migration: migration0001Foundation },
  { id: '0002DomainFoundation', schemaVersion: 2, migration: migration0002DomainFoundation },
]);

const migrateThroughSourcingChannels = createMigrationRunner([
  { id: '0001Foundation', schemaVersion: 1, migration: migration0001Foundation },
  { id: '0002DomainFoundation', schemaVersion: 2, migration: migration0002DomainFoundation },
  { id: '0003Transcripts', schemaVersion: 3, migration: migration0003Transcripts },
  { id: '0004Learnings', schemaVersion: 4, migration: migration0004Learnings },
  { id: '0005SourcingChannels', schemaVersion: 5, migration: migration0005SourcingChannels },
]);

const migrateThroughLearnings = createMigrationRunner([
  { id: '0001Foundation', schemaVersion: 1, migration: migration0001Foundation },
  { id: '0002DomainFoundation', schemaVersion: 2, migration: migration0002DomainFoundation },
  { id: '0003Transcripts', schemaVersion: 3, migration: migration0003Transcripts },
  { id: '0004Learnings', schemaVersion: 4, migration: migration0004Learnings },
]);

const NEW_CHANNELS = ['parcel', 'deed', 'permit', 'violation'] as const;

function insertRawProspect(database: AppDatabase, input: {
  id: string;
  personId: string;
  sourceEventId: string;
  segment: string;
}): void {
  database.raw.prepare(`
    INSERT INTO prospects (
      id, person_id, original_source_event_id, segment, qualification_state,
      version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'eligible', 1, ?, ?)
  `).run(
    input.id,
    input.personId,
    input.sourceEventId,
    input.segment,
    DOMAIN_TIMESTAMP,
    DOMAIN_TIMESTAMP,
  );
}

function insertTriggerEvent(database: AppDatabase, input: {
  id: string;
  prospectId: string;
  sourceEventId: string;
  triggerType: string;
}): void {
  database.raw.prepare(`
    INSERT INTO trigger_events (
      id, prospect_id, source_event_id, trigger_type, effective_at,
      strength_multiplier, verification_state, evidence_json, created_at
    ) VALUES (?, ?, ?, ?, ?, 1.0, 'verified', '{}', ?)
  `).run(
    input.id,
    input.prospectId,
    input.sourceEventId,
    input.triggerType,
    DOMAIN_TIMESTAMP,
    DOMAIN_TIMESTAMP,
  );
}

function insertIntakeReceipt(database: AppDatabase, input: {
  sourceEventId: string;
  personId: string;
  prospectId: string;
  commandJson: string;
}): void {
  database.raw.prepare(`
    INSERT INTO source_intake_receipts (
      source_event_id, person_id, prospect_id, command_json, result_json, created_at
    ) VALUES (?, ?, ?, ?, '{}', ?)
  `).run(
    input.sourceEventId,
    input.personId,
    input.prospectId,
    input.commandJson,
    DOMAIN_TIMESTAMP,
  );
}

describe('0005 sourcing channels migration', () => {
  describe('fresh database at schema 5', () => {
    let database: AppDatabase;
    let temp: TempDatabase;
    let migrationResult: Awaited<ReturnType<typeof migrateThroughSourcingChannels>>;

    beforeEach(async () => {
      temp = createTempDatabase();
      const key = createTestWorkspaceKey();
      database = openDatabase({ path: temp.path, key });
      migrationResult = await migrateThroughSourcingChannels(database, {
        backupDirectory: `${temp.path}.backups`, workspaceKey: key,
      });
    });

    afterEach(() => {
      closeDatabase(database);
      temp.cleanup();
    });

    it('migrates a fresh database to schema version 5', () => {
      expect(migrationResult.toVersion).toBe(5);
      expect(migrationResult.appliedMigrationIds).toContain('0005SourcingChannels');
      expect(database.raw.prepare<[], { schema_version: number }>(
        'SELECT schema_version FROM app_meta WHERE singleton = 1',
      ).get()).toEqual({ schema_version: 5 });
    });

    it.each(NEW_CHANNELS)('accepts the new %s source channel', (channel) => {
      insertPerson(database.raw, `person-${channel}`);
      insertSourceEvent({
        database: database.raw,
        id: `source-${channel}`,
        personId: `person-${channel}`,
        channel,
      });

      expect(database.raw.prepare<[string], { channel: string }>(
        'SELECT channel FROM source_events WHERE id = ?',
      ).get(`source-${channel}`)).toEqual({ channel });
    });

    it('rejects a source channel outside the allowed list', () => {
      insertPerson(database.raw, 'person-unknown');

      expect(() => insertSourceEvent({
        database: database.raw,
        id: 'source-unknown',
        personId: 'person-unknown',
        channel: 'zillow',
      })).toThrow(/CHECK/i);
    });

    it('accepts the renamed hot/cold/warm segments and rejects the old names', () => {
      for (const segment of ['hot', 'cold', 'warm'] as const) {
        insertPerson(database.raw, `person-${segment}`);
        insertSourceEvent({
          database: database.raw,
          id: `source-${segment}`,
          personId: `person-${segment}`,
        });
        insertRawProspect(database, {
          id: `prospect-${segment}`,
          personId: `person-${segment}`,
          sourceEventId: `source-${segment}`,
          segment,
        });
      }

      insertPerson(database.raw, 'person-legacy');
      insertSourceEvent({
        database: database.raw, id: 'source-legacy', personId: 'person-legacy',
      });
      for (const legacy of ['hot_frbo', 'cold_registry']) {
        expect(() => insertRawProspect(database, {
          id: 'prospect-legacy',
          personId: 'person-legacy',
          sourceEventId: 'source-legacy',
          segment: legacy,
        })).toThrow(/CHECK/i);
      }
    });

    it.each([
      ['permit_filed', 'permit'],
      ['violation_opened', 'violation'],
      ['deed_transfer', 'deed'],
      ['community_post', 'community'],
      ['review_pain', 'parcel'],
      ['live_vacancy', 'frbo'],
    ] as const)('accepts trigger type %s for channel %s', (triggerType, channel) => {
      const prospect = seedProspect(database.raw, `trigger-${triggerType}`);
      insertSourceEvent({
        database: database.raw,
        id: `trigger-${triggerType}-evidence`,
        personId: prospect.personId,
        channel,
      });

      insertTriggerEvent(database, {
        id: `trigger-${triggerType}`,
        prospectId: prospect.prospectId,
        sourceEventId: `trigger-${triggerType}-evidence`,
        triggerType,
      });

      expect(database.raw.prepare<[string], { trigger_type: string }>(
        'SELECT trigger_type FROM trigger_events WHERE id = ?',
      ).get(`trigger-${triggerType}`)).toEqual({ trigger_type: triggerType });
    });

    it.each([
      ['permit_filed', 'violation'],
      ['violation_opened', 'permit'],
      ['deed_transfer', 'parcel'],
      ['community_post', 'frbo'],
      ['review_pain', 'deed'],
      ['live_vacancy', 'permit'],
    ] as const)('rejects trigger type %s against a %s source', (triggerType, channel) => {
      const prospect = seedProspect(database.raw, `mismatch-${triggerType}`);
      insertSourceEvent({
        database: database.raw,
        id: `mismatch-${triggerType}-evidence`,
        personId: prospect.personId,
        channel,
      });

      expect(() => insertTriggerEvent(database, {
        id: `mismatch-${triggerType}`,
        prospectId: prospect.prospectId,
        sourceEventId: `mismatch-${triggerType}-evidence`,
        triggerType,
      })).toThrow(/trigger evidence must belong to the prospect person/);
    });

    it('keeps the prioritizationTrigger fallback for unmapped trigger types', () => {
      const prospect = seedProspect(database.raw, 'fallback');
      database.raw.prepare(`
        INSERT INTO source_events (
          id, person_id, channel, observed_at, source_record_json, created_at
        ) VALUES ('fallback-evidence', ?, 'parcel', ?, ?, ?)
      `).run(
        prospect.personId,
        DOMAIN_TIMESTAMP,
        JSON.stringify({
          prioritizationTrigger: { version: 1, signal: 'tax_lien_recorded' },
        }),
        DOMAIN_TIMESTAMP,
      );

      insertTriggerEvent(database, {
        id: 'fallback-trigger',
        prospectId: prospect.prospectId,
        sourceEventId: 'fallback-evidence',
        triggerType: 'tax_lien_recorded',
      });
      expect(() => insertTriggerEvent(database, {
        id: 'fallback-trigger-wrong',
        prospectId: prospect.prospectId,
        sourceEventId: 'fallback-evidence',
        triggerType: 'some_other_signal',
      })).toThrow(/trigger evidence must belong to the prospect person/);
    });

    it('keeps source events immutable after the table rebuild', () => {
      const prospect = seedProspect(database.raw, 'immutable');

      expect(() => database.raw.prepare(
        "UPDATE source_events SET channel = 'parcel' WHERE id = ?",
      ).run(prospect.sourceEventId)).toThrow(/immutable/);
      expect(() => database.raw.prepare(
        'DELETE FROM source_events WHERE id = ?',
      ).run(prospect.sourceEventId)).toThrow(/immutable/);
    });

    it('keeps the prospect original source immutable after the table rebuild', () => {
      const prospect = seedProspect(database.raw, 'origin');
      insertSourceEvent({
        database: database.raw, id: 'origin-other', personId: prospect.personId,
      });

      expect(() => database.raw.prepare(
        "UPDATE prospects SET original_source_event_id = 'origin-other' WHERE id = ?",
      ).run(prospect.prospectId)).toThrow(/immutable/);
    });

    it('recreates the source events observation index', () => {
      expect(database.raw.prepare<[], { name: string }>(`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND name = 'source_events_person_observed_idx'
      `).get()).toEqual({ name: 'source_events_person_observed_idx' });
    });
  });

  describe('upgrade from schema 4 with data', () => {
    let database: AppDatabase;
    let temp: TempDatabase;
    let key: ReturnType<typeof createTestWorkspaceKey>;

    beforeEach(async () => {
      temp = createTempDatabase();
      key = createTestWorkspaceKey();
      database = openDatabase({ path: temp.path, key });
      await migrateThroughLearnings(database, {
        backupDirectory: `${temp.path}.backups`, workspaceKey: key,
      });
    });

    afterEach(() => {
      closeDatabase(database);
      temp.cleanup();
    });

    function seedLegacySegments(): void {
      for (const [prefix, segment] of [
        ['hot', 'hot_frbo'],
        ['cold', 'cold_registry'],
        ['warm', 'warm'],
      ] as const) {
        insertPerson(database.raw, `${prefix}-person`);
        insertSourceEvent({
          database: database.raw, id: `${prefix}-source`, personId: `${prefix}-person`,
        });
        insertRawProspect(database, {
          id: `${prefix}-prospect`,
          personId: `${prefix}-person`,
          sourceEventId: `${prefix}-source`,
          segment,
        });
      }
    }

    it('remaps stored segments to hot/cold/warm', async () => {
      seedLegacySegments();

      const result = await migrateThroughSourcingChannels(database, {
        backupDirectory: `${temp.path}.backups`, workspaceKey: key,
      });

      expect(result).toMatchObject({
        fromVersion: 4,
        toVersion: 5,
        appliedMigrationIds: ['0005SourcingChannels'],
      });
      expect(database.raw.prepare<[], { id: string; segment: string }[]>(
        'SELECT id, segment FROM prospects ORDER BY id',
      ).all()).toEqual([
        { id: 'cold-prospect', segment: 'cold' },
        { id: 'hot-prospect', segment: 'hot' },
        { id: 'warm-prospect', segment: 'warm' },
      ]);
      expect(database.raw.pragma('foreign_key_check')).toEqual([]);
    });

    it('remaps segment values stored in intake receipt commands', async () => {
      seedLegacySegments();
      insertIntakeReceipt(database, {
        sourceEventId: 'hot-source',
        personId: 'hot-person',
        prospectId: 'hot-prospect',
        commandJson: '{"segment":"hot_frbo"}',
      });
      insertIntakeReceipt(database, {
        sourceEventId: 'warm-source',
        personId: 'warm-person',
        prospectId: 'warm-prospect',
        commandJson: '{"segment":"warm"}',
      });

      await migrateThroughSourcingChannels(database, {
        backupDirectory: `${temp.path}.backups`, workspaceKey: key,
      });

      expect(database.raw.prepare<[], { source_event_id: string; command_json: string }[]>(
        'SELECT source_event_id, command_json FROM source_intake_receipts ORDER BY source_event_id',
      ).all()).toEqual([
        { source_event_id: 'hot-source', command_json: '{"segment":"hot"}' },
        { source_event_id: 'warm-source', command_json: '{"segment":"warm"}' },
      ]);
      expect(() => database.raw.prepare(
        "UPDATE source_intake_receipts SET command_json = '{}' WHERE source_event_id = 'hot-source'",
      ).run()).toThrow(/immutable/);
    });
  });

  describe('upgrade from a v2-era database with data', () => {
    let database: AppDatabase;
    let temp: TempDatabase;
    let key: ReturnType<typeof createTestWorkspaceKey>;

    beforeEach(async () => {
      temp = createTempDatabase();
      key = createTestWorkspaceKey();
      database = openDatabase({ path: temp.path, key });
      await migrateThroughDomainFoundation(database, {
        backupDirectory: `${temp.path}.backups`, workspaceKey: key,
      });
    });

    afterEach(() => {
      closeDatabase(database);
      temp.cleanup();
    });

    it('migrates 2 -> 5 cleanly with prospects, cycles, triggers, and receipts', async () => {
      insertPerson(database.raw, 'legacy-person');
      insertSourceEvent({
        database: database.raw,
        id: 'legacy-source',
        personId: 'legacy-person',
        channel: 'frbo',
      });
      insertRawProspect(database, {
        id: 'legacy-prospect',
        personId: 'legacy-person',
        sourceEventId: 'legacy-source',
        segment: 'hot_frbo',
      });
      const prospect: SeededProspect = {
        personId: 'legacy-person',
        prospectId: 'legacy-prospect',
        sourceEventId: 'legacy-source',
      };
      insertOpenCycleWithAction({ database: database.raw, prefix: 'legacy', prospect });
      insertTriggerEvent(database, {
        id: 'legacy-trigger',
        prospectId: 'legacy-prospect',
        sourceEventId: 'legacy-source',
        triggerType: 'live_vacancy',
      });
      insertIntakeReceipt(database, {
        sourceEventId: 'legacy-source',
        personId: 'legacy-person',
        prospectId: 'legacy-prospect',
        commandJson: '{"segment":"hot_frbo"}',
      });

      const result = await migrateThroughSourcingChannels(database, {
        backupDirectory: `${temp.path}.backups`, workspaceKey: key,
      });

      expect(result).toMatchObject({
        fromVersion: 2,
        toVersion: 5,
        appliedMigrationIds: ['0003Transcripts', '0004Learnings', '0005SourcingChannels'],
      });
      expect(database.raw.prepare<[], { segment: string }>(
        "SELECT segment FROM prospects WHERE id = 'legacy-prospect'",
      ).get()).toEqual({ segment: 'hot' });
      expect(database.raw.prepare<[], { channel: string }>(
        "SELECT channel FROM source_events WHERE id = 'legacy-source'",
      ).get()).toEqual({ channel: 'frbo' });
      expect(database.raw.prepare<[], { count: number }>(
        'SELECT COUNT(*) AS count FROM trigger_events',
      ).get()).toEqual({ count: 1 });
      expect(database.raw.prepare<[], { count: number }>(
        'SELECT COUNT(*) AS count FROM sales_cycles',
      ).get()).toEqual({ count: 1 });
      expect(database.raw.prepare<[], { command_json: string }>(
        "SELECT command_json FROM source_intake_receipts WHERE source_event_id = 'legacy-source'",
      ).get()).toEqual({ command_json: '{"segment":"hot"}' });
      expect(database.raw.pragma('foreign_key_check')).toEqual([]);
      expect(database.raw.prepare<[], { schema_version: number }>(
        'SELECT schema_version FROM app_meta WHERE singleton = 1',
      ).get()).toEqual({ schema_version: 5 });

      insertPerson(database.raw, 'post-person');
      insertSourceEvent({
        database: database.raw,
        id: 'post-source',
        personId: 'post-person',
        channel: 'deed',
      });
      insertSourceEvent({
        database: database.raw,
        id: 'post-legacy-deed',
        personId: 'legacy-person',
        channel: 'deed',
      });
      insertTriggerEvent(database, {
        id: 'post-trigger',
        prospectId: 'legacy-prospect',
        sourceEventId: 'post-legacy-deed',
        triggerType: 'deed_transfer',
      });
    });
  });
});

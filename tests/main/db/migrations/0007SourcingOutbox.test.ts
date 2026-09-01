import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../../../src/main/db/database';
import { migrateToLatest } from '../../../../src/main/db/migrate';
import { DOMAIN_TIMESTAMP, insertPerson } from '../../../fixtures/domainRows';
import {
  createTempDatabase,
  createTestWorkspaceKey,
  type TempDatabase,
} from '../../../fixtures/tempDatabase';

const CE_ID = 'ce_01JC0000000000000000000000';

describe('0007 sourcing outbox migration', () => {
  let database: AppDatabase;
  let temp: TempDatabase;
  let migrationResult: Awaited<ReturnType<typeof migrateToLatest>>;

  beforeEach(async () => {
    temp = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: temp.path, key });
    migrationResult = await migrateToLatest(database, {
      backupDirectory: `${temp.path}.backups`, workspaceKey: key,
    });
  });

  afterEach(() => {
    closeDatabase(database);
    temp.cleanup();
  });

  function insertOutcome(input: {
    id: string;
    label: string;
    lossReasonCode?: string | null;
    overrideDirection?: string | null;
  }): void {
    database.raw.prepare(`
      INSERT INTO sourcing_outcome_outbox (
        id, cloud_entity_id, label, loss_reason_code, override_direction,
        observed_at, flushed_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL)
    `).run(
      input.id,
      CE_ID,
      input.label,
      input.lossReasonCode ?? null,
      input.overrideDirection ?? null,
      DOMAIN_TIMESTAMP,
    );
  }

  it('migrates a fresh database to schema version 7', () => {
    expect(migrationResult.toVersion).toBe(7);
    expect(migrationResult.appliedMigrationIds).toContain('0007SourcingOutbox');
    expect(database.raw.prepare<[], { schema_version: number }>(
      'SELECT schema_version FROM app_meta WHERE singleton = 1',
    ).get()).toEqual({ schema_version: 7 });
  });

  it('creates the outcome outbox accepting exactly the contract labels', () => {
    for (const label of ['interviewed', 'offered', 'won', 'lost'] as const) {
      insertOutcome({ id: `outcome-${label}`, label });
    }
    insertOutcome({ id: 'outcome-override', label: 'override', overrideDirection: 'up' });

    expect(() => insertOutcome({ id: 'outcome-bad', label: 'ghosted' }))
      .toThrow(/CHECK/i);
    expect(database.raw.prepare<[], { count: number }>(
      'SELECT COUNT(*) AS count FROM sourcing_outcome_outbox',
    ).get()).toEqual({ count: 5 });
  });

  it('requires override_direction exactly when label is override', () => {
    expect(() => insertOutcome({ id: 'no-direction', label: 'override' }))
      .toThrow(/CHECK/i);
    expect(() => insertOutcome({
      id: 'stray-direction', label: 'won', overrideDirection: 'down',
    })).toThrow(/CHECK/i);
    expect(() => insertOutcome({
      id: 'bad-direction', label: 'override', overrideDirection: 'sideways',
    })).toThrow(/CHECK/i);
  });

  it('marks rows flushed and lists only unflushed rows', () => {
    insertOutcome({ id: 'outcome-1', label: 'won' });
    insertOutcome({ id: 'outcome-2', label: 'lost', lossReasonCode: 'price' });

    database.raw.prepare(
      'UPDATE sourcing_outcome_outbox SET flushed_at = ? WHERE id = ?',
    ).run('2026-09-01T13:00:00.000Z', 'outcome-1');

    expect(database.raw.prepare<[], { id: string }>(
      'SELECT id FROM sourcing_outcome_outbox WHERE flushed_at IS NULL',
    ).all()).toEqual([{ id: 'outcome-2' }]);
  });

  it('adds the nullable cloud score columns to prospects', () => {
    const columns = (database.raw.prepare(
      "SELECT name FROM pragma_table_info('prospects')",
    ).all() as { name: string }[]).map(({ name }) => name);

    for (const column of [
      'cloud_fit', 'cloud_timing', 'cloud_score_reasons_json',
      'cloud_scores_version', 'cloud_scored_at',
    ]) {
      expect(columns).toContain(column);
    }

    insertPerson(database.raw, 'person-1');
    database.raw.prepare(`
      INSERT INTO source_events (
        id, person_id, channel, observed_at, source_record_json, created_at
      ) VALUES ('source-1', 'person-1', 'custom', ?, '{"formatVersion":1}', ?)
    `).run(DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
    database.raw.prepare(`
      INSERT INTO prospects (
        id, person_id, original_source_event_id, segment, qualification_state,
        version, created_at, updated_at
      ) VALUES ('prospect-1', 'person-1', 'source-1', 'warm', 'eligible', 1, ?, ?)
    `).run(DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);

    const row = database.raw.prepare<[], {
      cloud_fit: number | null;
      cloud_timing: number | null;
      cloud_score_reasons_json: string | null;
      cloud_scores_version: number | null;
      cloud_scored_at: string | null;
    }>(`
      SELECT cloud_fit, cloud_timing, cloud_score_reasons_json,
        cloud_scores_version, cloud_scored_at
      FROM prospects WHERE id = 'prospect-1'
    `).get();
    expect(row).toEqual({
      cloud_fit: null,
      cloud_timing: null,
      cloud_score_reasons_json: null,
      cloud_scores_version: null,
      cloud_scored_at: null,
    });
  });
});

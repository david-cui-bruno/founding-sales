import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../../../src/main/db/database';
import { createMigrationRunner } from '../../../../src/main/db/migrate';
import { migration0001Foundation } from '../../../../src/main/db/migrations/0001Foundation';
import { migration0002DomainFoundation } from '../../../../src/main/db/migrations/0002DomainFoundation';
import { migration0003Transcripts } from '../../../../src/main/db/migrations/0003Transcripts';
import { migration0004Learnings } from '../../../../src/main/db/migrations/0004Learnings';
import { migration0005SourcingChannels } from '../../../../src/main/db/migrations/0005SourcingChannels';
import { migration0006SourcingState } from '../../../../src/main/db/migrations/0006SourcingState';
import { DOMAIN_TIMESTAMP, insertPerson } from '../../../fixtures/domainRows';
import {
  createTempDatabase,
  createTestWorkspaceKey,
  type TempDatabase,
} from '../../../fixtures/tempDatabase';

const migrateThroughSourcingState = createMigrationRunner([
  { id: '0001Foundation', schemaVersion: 1, migration: migration0001Foundation },
  { id: '0002DomainFoundation', schemaVersion: 2, migration: migration0002DomainFoundation },
  { id: '0003Transcripts', schemaVersion: 3, migration: migration0003Transcripts },
  { id: '0004Learnings', schemaVersion: 4, migration: migration0004Learnings },
  { id: '0005SourcingChannels', schemaVersion: 5, migration: migration0005SourcingChannels },
  { id: '0006SourcingState', schemaVersion: 6, migration: migration0006SourcingState },
]);

describe('0006 sourcing state migration', () => {
  let database: AppDatabase;
  let temp: TempDatabase;
  let migrationResult: Awaited<ReturnType<typeof migrateThroughSourcingState>>;

  beforeEach(async () => {
    temp = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: temp.path, key });
    migrationResult = await migrateThroughSourcingState(database, {
      backupDirectory: `${temp.path}.backups`, workspaceKey: key,
    });
  });

  afterEach(() => {
    closeDatabase(database);
    temp.cleanup();
  });

  it('migrates a fresh database to schema version 6', () => {
    expect(migrationResult.toVersion).toBe(6);
    expect(migrationResult.appliedMigrationIds).toContain('0006SourcingState');
    expect(database.raw.prepare<[], { schema_version: number }>(
      'SELECT schema_version FROM app_meta WHERE singleton = 1',
    ).get()).toEqual({ schema_version: 6 });
  });

  it('creates the sourcing cursor and cloud entity link tables', () => {
    const tables = database.raw.prepare<[], { name: string }>(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('sourcing_cursor', 'cloud_entity_links')
      ORDER BY name
    `).all().map(({ name }) => name);

    expect(tables).toEqual(['cloud_entity_links', 'sourcing_cursor']);
  });

  it('keeps the sourcing cursor a singleton row', () => {
    database.raw.prepare(
      'INSERT INTO sourcing_cursor (id, last_key, polled_at) VALUES (1, NULL, ?)',
    ).run(DOMAIN_TIMESTAMP);

    expect(() => database.raw.prepare(
      'INSERT INTO sourcing_cursor (id, last_key, polled_at) VALUES (2, NULL, ?)',
    ).run(DOMAIN_TIMESTAMP)).toThrow(/CHECK/i);
    expect(() => database.raw.prepare(
      'INSERT INTO sourcing_cursor (id, last_key, polled_at) VALUES (1, NULL, ?)',
    ).run(DOMAIN_TIMESTAMP)).toThrow(/UNIQUE|PRIMARY/i);

    database.raw.prepare(
      "UPDATE sourcing_cursor SET last_key = 'events/2026-09-01/a.ndjson', polled_at = ? WHERE id = 1",
    ).run('2026-09-01T13:00:00.000Z');
    expect(database.raw.prepare<[], { last_key: string; polled_at: string }>(
      'SELECT last_key, polled_at FROM sourcing_cursor WHERE id = 1',
    ).get()).toEqual({
      last_key: 'events/2026-09-01/a.ndjson',
      polled_at: '2026-09-01T13:00:00.000Z',
    });
  });

  it('requires polled_at on the cursor row', () => {
    expect(() => database.raw.prepare(
      'INSERT INTO sourcing_cursor (id, last_key, polled_at) VALUES (1, NULL, NULL)',
    ).run()).toThrow(/NOT NULL/i);
  });

  it('links cloud entities to existing persons only', () => {
    insertPerson(database.raw, 'person-1');

    database.raw.prepare(
      'INSERT INTO cloud_entity_links (cloud_entity_id, person_id, linked_at) VALUES (?, ?, ?)',
    ).run('ce_01JC0000000000000000000000', 'person-1', DOMAIN_TIMESTAMP);

    expect(() => database.raw.prepare(
      'INSERT INTO cloud_entity_links (cloud_entity_id, person_id, linked_at) VALUES (?, ?, ?)',
    ).run('ce_01JC0000000000000000000001', 'missing-person', DOMAIN_TIMESTAMP))
      .toThrow(/FOREIGN KEY/i);
    expect(() => database.raw.prepare(
      'INSERT INTO cloud_entity_links (cloud_entity_id, person_id, linked_at) VALUES (?, ?, ?)',
    ).run('ce_01JC0000000000000000000000', 'person-1', DOMAIN_TIMESTAMP))
      .toThrow(/UNIQUE|PRIMARY/i);
  });
});

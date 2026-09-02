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
import { migration0008DedupeCloudPersons } from '../../../../src/main/db/migrations/0008DedupeCloudPersons';
import {
  createTempDatabase,
  createTestWorkspaceKey,
  type TempDatabase,
} from '../../../fixtures/tempDatabase';

const migrateThroughSchema8 = createMigrationRunner([
  { id: '0001Foundation', schemaVersion: 1, migration: migration0001Foundation },
  { id: '0002DomainFoundation', schemaVersion: 2, migration: migration0002DomainFoundation },
  { id: '0003Transcripts', schemaVersion: 3, migration: migration0003Transcripts },
  { id: '0004Learnings', schemaVersion: 4, migration: migration0004Learnings },
  { id: '0005SourcingChannels', schemaVersion: 5, migration: migration0005SourcingChannels },
  { id: '0006SourcingState', schemaVersion: 6, migration: migration0006SourcingState },
  { id: '0007SourcingOutbox', schemaVersion: 7, migration: migration0007SourcingOutbox },
  { id: '0008DedupeCloudPersons', schemaVersion: 8, migration: migration0008DedupeCloudPersons },
]);

// The live poisoned cursor shape: a repair copy consumed out of order left the
// cursor pointing past same-day keys that sort before it.
const POISONED_CURSOR = 'events/2026-09-01/zz-repair-c-scorer.ndjson';

describe('0009 sourcing file ledger migration', () => {
  let database: AppDatabase;
  let temp: TempDatabase;
  let options: {
    backupDirectory: string;
    workspaceKey: ReturnType<typeof createTestWorkspaceKey>;
  };

  beforeEach(async () => {
    temp = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: temp.path, key });
    options = { backupDirectory: `${temp.path}.backups`, workspaceKey: key };
    await migrateThroughSchema8(database, options);
  });

  afterEach(() => {
    closeDatabase(database);
    temp.cleanup();
  });

  it('migrates a fresh database to schema version 9', async () => {
    const result = await migrateToLatest(database, options);
    expect(result.toVersion).toBe(11);
    expect(result.appliedMigrationIds).toContain('0009SourcingFileLedger');
    expect(database.raw.prepare<[], { schema_version: number }>(
      'SELECT schema_version FROM app_meta WHERE singleton = 1',
    ).get()).toEqual({ schema_version: 11 });
  });

  it('creates an empty processed-file ledger with key primary key and required processed_at', async () => {
    await migrateToLatest(database, options);

    expect(database.raw.prepare<[], { count: number }>(
      'SELECT COUNT(*) AS count FROM sourcing_processed_files',
    ).get()).toEqual({ count: 0 });

    database.raw.prepare(
      'INSERT INTO sourcing_processed_files (key, processed_at) VALUES (?, ?)',
    ).run(POISONED_CURSOR, '2026-09-01T12:00:00.000Z');
    expect(() => database.raw.prepare(
      'INSERT INTO sourcing_processed_files (key, processed_at) VALUES (?, ?)',
    ).run(POISONED_CURSOR, '2026-09-01T13:00:00.000Z')).toThrow(/UNIQUE|PRIMARY/i);
    expect(() => database.raw.prepare(
      'INSERT INTO sourcing_processed_files (key, processed_at) VALUES (?, NULL)',
    ).run('events/2026-09-01/other.ndjson')).toThrow(/NOT NULL/i);
  });

  it('resets a poisoned v8 cursor to NULL with an empty ledger and a clean foreign-key graph', async () => {
    database.raw.prepare(
      'INSERT INTO sourcing_cursor (id, last_key, polled_at) VALUES (1, ?, ?)',
    ).run(POISONED_CURSOR, '2026-09-01T11:00:00.000Z');

    const result = await migrateToLatest(database, options);

    expect(result.fromVersion).toBe(8);
    expect(result.toVersion).toBe(11);
    expect(database.raw.prepare<[], { last_key: string | null; polled_at: string }>(
      'SELECT last_key, polled_at FROM sourcing_cursor WHERE id = 1',
    ).get()).toEqual({
      last_key: null,
      polled_at: '2026-09-01T11:00:00.000Z',
    });
    expect(database.raw.prepare<[], { count: number }>(
      'SELECT COUNT(*) AS count FROM sourcing_processed_files',
    ).get()).toEqual({ count: 0 });
    expect(database.raw.pragma('foreign_key_check')).toEqual([]);
  });
});

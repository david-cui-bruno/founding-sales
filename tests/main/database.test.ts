import { statSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  checkFts5,
  closeDatabase,
  openDatabase,
  type AppDatabase,
} from '../../src/main/db/database';
import { createTempDatabase, createTestWorkspaceKey, type TempDatabase } from '../fixtures/tempDatabase';

describe('database manager', () => {
  let database: AppDatabase | undefined;
  let tempDatabase: TempDatabase | undefined;

  afterEach(() => {
    if (database !== undefined) {
      closeDatabase(database);
    }
    tempDatabase?.cleanup();
  });

  it('opens SQLite with secure connection settings and FTS5 support', () => {
    tempDatabase = createTempDatabase();
    database = openDatabase({ path: tempDatabase.path, key: createTestWorkspaceKey() });

    expect(database.path).toBe(tempDatabase.path);
    expect(database.raw.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(database.raw.pragma('recursive_triggers', { simple: true })).toBe(1);
    expect(database.raw.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(database.raw.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(checkFts5(database)).toBe(true);
    expect(statSync(dirname(tempDatabase.path)).mode & 0o777).toBe(0o700);
  });
});

import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { Kysely, SqliteDialect } from 'kysely';

import type { WorkspaceKey } from '../security/workspaceKeyTypes';
import type { FoundationDatabase } from './schema';
import {
  applyWorkspaceKey,
  createRawDatabase,
  type RawDatabase,
} from './sqliteDriver';

export type DatabaseOpenOptions = {
  path: string;
  key: WorkspaceKey;
};

export type AppDatabase = {
  raw: RawDatabase;
  kysely: import('kysely').Kysely<FoundationDatabase>;
  path: string;
};

export function openDatabase(options: DatabaseOpenOptions): AppDatabase {
  const { path, key } = options;
  const parentDirectory = dirname(path);
  mkdirSync(parentDirectory, { recursive: true, mode: 0o700 });
  chmodSync(parentDirectory, 0o700);

  const raw = createRawDatabase(path);
  try {
    applyWorkspaceKey(raw, key.bytes);
    raw.pragma('foreign_keys = ON');
    raw.pragma('journal_mode = WAL');
    raw.pragma('busy_timeout = 5000');
  } catch (error) {
    raw.close();
    throw error;
  }

  const kysely = new Kysely<FoundationDatabase>({
    dialect: new SqliteDialect({ database: raw }),
  });

  return { raw, kysely, path };
}

export function checkFts5(db: AppDatabase): boolean {
  const result = db.raw
    .prepare<[], { enabled: number }>(
      "SELECT sqlite_compileoption_used('ENABLE_FTS5') AS enabled",
    )
    .get();

  return result?.enabled === 1;
}

export function closeDatabase(db: AppDatabase): void {
  if (db.raw.open) {
    db.raw.close();
  }
}

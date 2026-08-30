// The project intentionally uses TypeScript's legacy Node resolver, which cannot
// type-resolve Kysely's package-exported migration entrypoint.
// @ts-expect-error -- The runtime subpath is exported by Kysely and covered by migration tests.
import { Migrator } from 'kysely/migration'; // eslint-disable-line import/no-unresolved -- Kysely exports this runtime subpath.

import type { AppDatabase } from './database';
import { migration0001Foundation } from './migrations/0001Foundation';

export type MigrationResult = {
  fromVersion: number;
  toVersion: number;
  appliedMigrationIds: string[];
};

type KyselyMigrationResultSet = {
  error?: unknown;
  results?: Array<{
    migrationName: string;
    direction: 'Up' | 'Down';
    status: 'Success' | 'Error' | 'NotExecuted';
  }>;
};

const migrationProvider = {
  async getMigrations() {
    return {
      '0001Foundation': migration0001Foundation,
    };
  },
};

function readSchemaVersion(db: AppDatabase): number {
  const table = db.raw
    .prepare<[], { found: number }>(
      "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'app_meta'",
    )
    .get();

  if (table === undefined) {
    return 0;
  }

  const metadata = db.raw
    .prepare<[], { schema_version: number }>(
      'SELECT schema_version FROM app_meta WHERE singleton = 1',
    )
    .get();

  if (metadata === undefined) {
    throw new Error('The app_meta singleton row is missing.');
  }

  return metadata.schema_version;
}

export async function migrateToLatest(db: AppDatabase): Promise<MigrationResult> {
  const fromVersion = readSchemaVersion(db);
  const migrator = new Migrator({
    db: db.kysely,
    provider: migrationProvider,
  });
  const resultSet = (await migrator.migrateToLatest()) as KyselyMigrationResultSet;

  if (resultSet.error !== undefined) {
    throw resultSet.error;
  }

  return {
    fromVersion,
    toVersion: readSchemaVersion(db),
    appliedMigrationIds: (resultSet.results ?? [])
      .filter((result) => result.direction === 'Up' && result.status === 'Success')
      .map((result) => result.migrationName),
  };
}

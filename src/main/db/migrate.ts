// The project intentionally uses TypeScript's legacy Node resolver, which cannot
// type-resolve Kysely's package-exported migration entrypoint.
// @ts-expect-error -- The runtime subpath is exported by Kysely and covered by migration tests.
import { Migrator } from 'kysely/migration'; // eslint-disable-line import/no-unresolved -- Kysely exports this runtime subpath.

import type { AppDatabase } from './database';
import { createVerifiedMigrationBackup } from './migrationBackup';
import { migration0001Foundation } from './migrations/0001Foundation';
import type { WorkspaceKey } from '../security/workspaceKeyTypes';

export type MigrationResult = {
  fromVersion: number;
  toVersion: number;
  appliedMigrationIds: string[];
};

export type MigrationOptions = {
  backupDirectory: string;
  workspaceKey: WorkspaceKey;
};

type KyselyMigrationResultSet = {
  error?: unknown;
  results?: Array<{
    migrationName: string;
    direction: 'Up' | 'Down';
    status: 'Success' | 'Error' | 'NotExecuted';
  }>;
};

export type RegisteredMigration = Readonly<{
  id: string;
  schemaVersion: number;
  migration: {
    up(database: AppDatabase['kysely']): Promise<void>;
  };
}>;

const productionMigrations = [
  {
    id: '0001Foundation',
    schemaVersion: 1,
    migration: migration0001Foundation,
  },
] as const;
const productionMigrationRunner = createMigrationRunner(productionMigrations);

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

export async function migrateToLatest(
  db: AppDatabase,
  options: MigrationOptions,
): Promise<MigrationResult> {
  return productionMigrationRunner(db, options);
}

export function createMigrationRunner(
  migrations: readonly RegisteredMigration[],
): (
  db: AppDatabase,
  options: MigrationOptions,
) => Promise<MigrationResult> {
  const registeredMigrations = validateRegisteredMigrations(migrations);
  return (db, options) => migrateWithRegisteredMigrations(
    db,
    options,
    registeredMigrations,
  );
}

async function migrateWithRegisteredMigrations(
  db: AppDatabase,
  options: MigrationOptions,
  registeredMigrations: readonly RegisteredMigration[],
): Promise<MigrationResult> {
  const fromVersion = readSchemaVersion(db);
  const latestVersion = registeredMigrations.at(-1)?.schemaVersion ?? 0;
  if (fromVersion < latestVersion) {
    createVerifiedMigrationBackup({
      database: db,
      backupDirectory: options.backupDirectory,
      key: options.workspaceKey,
      sourceSchemaVersion: fromVersion,
    });
  }
  const migrator = new Migrator({
    db: db.kysely,
    provider: {
      async getMigrations() {
        return Object.fromEntries(
          registeredMigrations.map(({ id, migration }) => [id, migration]),
        );
      },
    },
  });
  let resultSet: KyselyMigrationResultSet;

  db.raw.exec('BEGIN IMMEDIATE');

  try {
    resultSet = (await migrator.migrateToLatest()) as KyselyMigrationResultSet;

    if (resultSet.error !== undefined) {
      throw resultSet.error;
    }

    db.raw.exec('COMMIT');
  } catch (error) {
    if (db.raw.inTransaction) {
      db.raw.exec('ROLLBACK');
    }

    throw error;
  }

  return {
    fromVersion,
    toVersion: readSchemaVersion(db),
    appliedMigrationIds: (resultSet.results ?? [])
      .filter((result) => result.direction === 'Up' && result.status === 'Success')
      .map((result) => result.migrationName),
  };
}

function validateRegisteredMigrations(
  migrations: readonly RegisteredMigration[],
): readonly RegisteredMigration[] {
  const registeredMigrations = migrations.map((migration) => ({ ...migration }));
  for (const [index, migration] of registeredMigrations.entries()) {
    const previous = registeredMigrations[index - 1];
    if (
      migration.id.length === 0
      || !Number.isSafeInteger(migration.schemaVersion)
      || migration.schemaVersion < 1
      || (previous !== undefined && migration.id.localeCompare(previous.id) <= 0)
      || (
        previous !== undefined
        && migration.schemaVersion <= previous.schemaVersion
      )
    ) {
      throw new Error('Registered migrations are invalid.');
    }
  }
  return registeredMigrations;
}

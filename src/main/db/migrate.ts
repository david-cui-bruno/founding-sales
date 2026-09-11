// The project intentionally uses TypeScript's legacy Node resolver, which cannot
// type-resolve Kysely's package-exported migration entrypoint.
// @ts-expect-error -- The runtime subpath is exported by Kysely and covered by migration tests.
import { Migrator } from 'kysely/migration'; // eslint-disable-line import/no-unresolved -- Kysely exports this runtime subpath.

import type { AppDatabase } from './database';
import { createVerifiedMigrationBackup } from './migrationBackup';
import { migration0001Foundation } from './migrations/0001Foundation';
import { migration0002DomainFoundation } from './migrations/0002DomainFoundation';
import { migration0003Transcripts } from './migrations/0003Transcripts';
import { migration0004Learnings } from './migrations/0004Learnings';
import { migration0005SourcingChannels } from './migrations/0005SourcingChannels';
import { migration0006SourcingState } from './migrations/0006SourcingState';
import { migration0007SourcingOutbox } from './migrations/0007SourcingOutbox';
import { migration0008DedupeCloudPersons } from './migrations/0008DedupeCloudPersons';
import { migration0009SourcingFileLedger } from './migrations/0009SourcingFileLedger';
import { migration0010NoDueDates } from './migrations/0010NoDueDates';
import { migration0011ContactDncFlags } from './migrations/0011ContactDncFlags';
import { migration0012UpstreamRequestState } from './migrations/0012UpstreamRequestState';
import { migration0013ContactComplianceEvidence } from './migrations/0013ContactComplianceEvidence';
import { migration0014OutboundJurisdictionClearance } from './migrations/0014OutboundJurisdictionClearance';
import { migration0015RecoveryMetadata } from './migrations/0015RecoveryMetadata';
import { migration0016ContactPresentationEvidence } from './migrations/0016ContactPresentationEvidence';
import { migration0017DiscoveryAssessments } from './migrations/0017DiscoveryAssessments';
import { migration0018PlaybookDueActions } from './migrations/0018PlaybookDueActions';
import { migration0019EmailDrafts } from './migrations/0019EmailDrafts';
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

export const productionMigrations = [
  {
    id: '0001Foundation',
    schemaVersion: 1,
    migration: migration0001Foundation,
  },
  {
    id: '0002DomainFoundation',
    schemaVersion: 2,
    migration: migration0002DomainFoundation,
  },
  {
    id: '0003Transcripts',
    schemaVersion: 3,
    migration: migration0003Transcripts,
  },
  {
    id: '0004Learnings',
    schemaVersion: 4,
    migration: migration0004Learnings,
  },
  {
    id: '0005SourcingChannels',
    schemaVersion: 5,
    migration: migration0005SourcingChannels,
  },
  {
    id: '0006SourcingState',
    schemaVersion: 6,
    migration: migration0006SourcingState,
  },
  {
    id: '0007SourcingOutbox',
    schemaVersion: 7,
    migration: migration0007SourcingOutbox,
  },
  {
    id: '0008DedupeCloudPersons',
    schemaVersion: 8,
    migration: migration0008DedupeCloudPersons,
  },
  {
    id: '0009SourcingFileLedger',
    schemaVersion: 9,
    migration: migration0009SourcingFileLedger,
  },
  {
    id: '0010NoDueDates',
    schemaVersion: 10,
    migration: migration0010NoDueDates,
  },
  {
    id: '0011ContactDncFlags',
    schemaVersion: 11,
    migration: migration0011ContactDncFlags,
  },
  {
    id: '0012UpstreamRequestState',
    schemaVersion: 12,
    migration: migration0012UpstreamRequestState,
  },
  {
    id: '0013ContactComplianceEvidence',
    schemaVersion: 13,
    migration: migration0013ContactComplianceEvidence,
  },
  {
    id: '0014OutboundJurisdictionClearance',
    schemaVersion: 14,
    migration: migration0014OutboundJurisdictionClearance,
  },
  {
    id: '0015RecoveryMetadata',
    schemaVersion: 15,
    migration: migration0015RecoveryMetadata,
  },
  {
    id: '0016ContactPresentationEvidence',
    schemaVersion: 16,
    migration: migration0016ContactPresentationEvidence,
  },
  {
    id: '0017DiscoveryAssessments',
    schemaVersion: 17,
    migration: migration0017DiscoveryAssessments,
  },
  { id: '0018PlaybookDueActions', schemaVersion: 18, migration: migration0018PlaybookDueActions },
  { id: '0019EmailDrafts', schemaVersion: 19, migration: migration0019EmailDrafts },
] as const;
const productionMigrationRunner = createMigrationRunner(productionMigrations);

function readSchemaVersion(db: AppDatabase): unknown {
  const table = db.raw
    .prepare<[], { found: number }>(
      "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'app_meta'",
    )
    .get();

  if (table === undefined) {
    return 0;
  }

  const metadata = db.raw
    .prepare<[], { schema_version: unknown }>(
      'SELECT schema_version FROM app_meta WHERE singleton = 1',
    )
    .get();

  if (metadata === undefined) {
    throw new Error('The app_meta singleton row is missing.');
  }

  return metadata.schema_version;
}

function validateMigrationState(
  db: AppDatabase,
  registeredMigrations: readonly RegisteredMigration[],
): number {
  const schemaVersion = readSchemaVersion(db);
  const latestVersion = registeredMigrations.length;
  if (
    !Number.isSafeInteger(schemaVersion)
    || (schemaVersion as number) < 0
    || (schemaVersion as number) > latestVersion
  ) {
    throw new Error('The app_meta schema version is not a registered migration version.');
  }

  const version = schemaVersion as number;
  const ledgerTable = db.raw.prepare<[], { found: number }>(
    "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'kysely_migration'",
  ).get();
  if (version === 0 && ledgerTable === undefined) {
    return version;
  }
  if (ledgerTable === undefined) {
    throw new Error('The migration ledger does not match the app_meta schema version.');
  }

  const actualIds = db.raw.prepare<[], { name: string }>(
    'SELECT name FROM kysely_migration ORDER BY timestamp, name',
  ).all().map(({ name }) => name);
  const expectedIds = registeredMigrations.slice(0, version).map(({ id }) => id);
  if (
    actualIds.length !== expectedIds.length
    || actualIds.some((id, index) => id !== expectedIds[index])
  ) {
    throw new Error('The migration ledger does not match the app_meta schema version.');
  }

  return version;
}

export function isRegisteredSchemaVersion(version: number): boolean {
  return productionMigrations.some((entry) => entry.schemaVersion === version);
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
  const fromVersion = validateMigrationState(db, registeredMigrations);
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
    toVersion: readSchemaVersion(db) as number,
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
      || migration.schemaVersion !== index + 1
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

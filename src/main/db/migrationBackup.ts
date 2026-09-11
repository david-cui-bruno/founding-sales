import {
  createVerifiedEncryptedCopy,
  type VerifiedCopyOperations,
} from '../backup/verifiedBackup';
import { SystemClock } from '../domain/support/clock';
import type { WorkspaceKey } from '../security/workspaceKeyTypes';
import type { AppDatabase } from './database';

export type MigrationBackup = {
  path: string;
  sourceSchemaVersion: number;
  sha256: string;
  verifiedAt: string;
};
export type MigrationBackupInput = {
  database: AppDatabase;
  backupDirectory: string;
  key: WorkspaceKey;
  sourceSchemaVersion: number;
};
export type MigrationBackupCreationOperations = VerifiedCopyOperations;

export function createVerifiedMigrationBackup(input: MigrationBackupInput): MigrationBackup {
  return createMigrationBackup(input);
}

export function createMigrationBackupService(
  creationOperations: MigrationBackupCreationOperations,
): (input: MigrationBackupInput) => MigrationBackup {
  return (input) => createMigrationBackup(input, creationOperations);
}

function createMigrationBackup(
  input: MigrationBackupInput,
  creationOperations?: MigrationBackupCreationOperations,
): MigrationBackup {
  const clock = new SystemClock();
  try {
    const result = createVerifiedEncryptedCopy({
      database: input.database,
      backupDirectory: input.backupDirectory,
      key: input.key,
      schemaVersion: input.sourceSchemaVersion,
      basename: `pre-migration-schema-${input.sourceSchemaVersion}-${clock.now().replace(/[-:.]/g, '')}.sqlite3`,
      clock,
    }, creationOperations);
    return {
      path: result.path,
      sourceSchemaVersion: input.sourceSchemaVersion,
      sha256: result.sha256,
      verifiedAt: result.verifiedAt,
    };
  } catch (error) {
    // Preserve the established sanitized migration error contract.
    if (error instanceof Error && error.message === 'Encrypted backup verification failed.') {
      throw new Error('Migration backup verification failed.');
    }
    throw error;
  }
}

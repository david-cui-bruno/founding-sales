import { dirname, join } from 'node:path';
import { BackupService } from '../../src/main/backup/backupService';
import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { createMigrationRunner, migrateToLatest, productionMigrations } from '../../src/main/db/migrate';
import { OperationalSafetyRepository } from '../../src/main/domain/operations/operationalSafetyRepository';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import { createRecoveryKeyMaterial } from '../../src/main/security/recoveryKey';
import { createTempDatabase, createTestWorkspaceKey } from './tempDatabase';

export async function recoveryFixture(options: { schemaVersion?: 17 | 18 | 19 | 20 } = {}) {
  const temp = createTempDatabase();
  const root = dirname(dirname(temp.path));
  const key = createTestWorkspaceKey();
  const material = createRecoveryKeyMaterial(key);
  const database = openDatabase({ path: temp.path, key });
  const migrate = options.schemaVersion === undefined ? migrateToLatest
    : createMigrationRunner(productionMigrations.filter(entry => entry.schemaVersion <= options.schemaVersion!));
  const migration = await migrate(database, { backupDirectory: join(root, 'migrations'), workspaceKey: key });
  key.bytes.fill(0);
  let time = '2026-09-06T12:00:00.000Z';
  let id = 0;
  const clock = { now: () => time };
  const ids = { next: () => `recovery-fixture-${++id}` };
  const gate = { withDatabase: async <T>(operation: (db: AppDatabase) => T | Promise<T>) => operation(database) };
  const backups = new BackupService({ databaseGate: gate, backupDirectory: join(root, 'backups'), loadWorkspaceKey: async () => createTestWorkspaceKey(), clock, ids });
  const unitOfWork = new DomainUnitOfWork(database);
  const repository = new OperationalSafetyRepository({ database, unitOfWork });
  return { root, database, material, clock, ids, gate, backups, unitOfWork, repository, schemaVersion: migration.toVersion,
    setTime: (value: string) => { time = value; },
    cleanup: async () => { await backups.shutdown(); closeDatabase(database); temp.cleanup(); },
  };
}

import { afterEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { HealthService } from '../../src/main/health/healthService';
import { JobRepository } from '../../src/main/jobs/jobRepository';
import { createTempDatabase, createTestWorkspaceKey, type TempDatabase } from '../fixtures/tempDatabase';

describe('HealthService', () => {
  let database: AppDatabase | undefined;
  let tempDatabase: TempDatabase | undefined;

  afterEach(() => {
    if (database !== undefined) {
      closeDatabase(database);
    }
    tempDatabase?.cleanup();
  });

  it('reports migrated SQLite, FTS5, active jobs, and retained recovery values', async () => {
    tempDatabase = createTempDatabase();
    database = openDatabase({ path: tempDatabase.path, key: createTestWorkspaceKey() });
    await migrateToLatest(database);
    const jobs = new JobRepository(database);
    jobs.enqueue({ id: 'queued', type: 'sync', payload: {} });
    jobs.start(jobs.enqueue({ id: 'running', type: 'sync', payload: {} }).id);
    jobs.cancel(jobs.enqueue({ id: 'cancelled', type: 'sync', payload: {} }).id);

    const service = new HealthService({
      appVersion: '2.3.4',
      database,
      databasePath: tempDatabase.path,
      jobs,
      interruptedJobsRecovered: 3,
    });

    expect(service.getHealth()).toEqual({
      appVersion: '2.3.4',
      schemaVersion: 1,
      databasePath: tempDatabase.path,
      databaseEncrypted: true,
      cipherVersion: 'SQLite3 Multiple Ciphers 2.3.5',
      fts5Available: true,
      pendingJobs: 2,
      interruptedJobsRecovered: 3,
    });
  });
});

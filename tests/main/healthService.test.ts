import { afterEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { HealthService } from '../../src/main/health/healthService';
import { JobRepository } from '../../src/main/jobs/jobRepository';
import { fakeStartupReport } from '../fixtures/fakeDomainRuntime';
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

  it('observes live jobs while retaining the immutable startup audit', async () => {
    tempDatabase = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: tempDatabase.path, key });
    await migrateToLatest(database, { backupDirectory: `${tempDatabase.path}.backups`, workspaceKey: key });
    const jobs = new JobRepository(database);
    const report = fakeStartupReport({ interruptedJobsRecovered: 3 });
    const service = new HealthService({ appVersion: '1', database, databasePath: tempDatabase.path, jobs, domainStartupReport: report });
    expect(service.getHealth()).toMatchObject({ pendingJobs: 0, interruptedJobsRecovered: 3 });
    jobs.enqueue({ id: 'new-live-job', type: 'sync', payload: {} });
    const refreshed = service.getHealth();
    expect(refreshed).toMatchObject({ pendingJobs: 1, interruptedJobsRecovered: 3,
      domainStartupEvaluatedAt: '2026-08-30T12:00:00.000Z' });
    expect(refreshed.domainStartupEvaluatedAt).toBe(report.evaluatedAt);
  });

  it('reports migrated SQLite, FTS5, active jobs, and retained recovery values', async () => {
    tempDatabase = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: tempDatabase.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${tempDatabase.path}.backups`,
      workspaceKey: key,
    });
    const jobs = new JobRepository(database);
    jobs.enqueue({ id: 'queued', type: 'sync', payload: {} });
    jobs.start(jobs.enqueue({ id: 'running', type: 'sync', payload: {} }).id);
    jobs.cancel(jobs.enqueue({ id: 'cancelled', type: 'sync', payload: {} }).id);

    const service = new HealthService({
      appVersion: '2.3.4',
      database,
      databasePath: tempDatabase.path,
      jobs,
      domainStartupReport: fakeStartupReport({ interruptedJobsRecovered: 3 }),
    });

    expect(service.getHealth()).toEqual({
      appVersion: '2.3.4',
      schemaVersion: 27,
      databasePath: tempDatabase.path,
      databaseEncrypted: true,
      cipherVersion: 'SQLite3 Multiple Ciphers 2.3.5',
      fts5Available: true,
      pendingJobs: 2,
      interruptedJobsRecovered: 3,
      domainStatus: 'ready',
      domainReady: true,
      domainBlockingViolationCount: 0,
      domainRepairableIssueCount: 0,
      domainProjectionRefreshCandidateCount: 0,
      pendingProjectionRebuilds: 0,
      domainStartupEvaluatedAt: '2026-08-30T12:00:00.000Z',
    });
  });
});

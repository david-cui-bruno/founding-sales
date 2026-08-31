import { mkdirSync, rmSync, statSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DomainRuntime } from '../../src/main/domain/domainRuntime';

import {
  closeDatabase,
  openDatabase,
} from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { prepareEncryptedDatabase } from '../../src/main/db/plaintextDatabaseUpgrade';
import { FoundationRuntime } from '../../src/main/foundation/foundationRuntime';
import { HealthService } from '../../src/main/health/healthService';
import {
  createTempDatabase,
  createTestWorkspaceKey,
  type TempDatabase,
} from '../fixtures/tempDatabase';

describe('foundation initialization recovery', () => {
  let tempDatabase: TempDatabase | undefined;
  let runtime: FoundationRuntime | undefined;

  afterEach(async () => {
    await runtime?.shutdown();
    tempDatabase?.cleanup();
  });

  it('recovers from an isolated filesystem collision without replacing the path', async () => {
    tempDatabase = createTempDatabase();
    mkdirSync(tempDatabase.path, { recursive: true, mode: 0o700 });
    runtime = new FoundationRuntime(
      {
        appVersion: '1.0.0',
        backupDirectory: `${tempDatabase.path}.backups`,
        databasePath: tempDatabase.path,
        databaseExists: true,
        keyEnvelopePath: `${tempDatabase.path}.key-envelope.json`,
      },
      {
        loadWorkspaceKey: async () => createTestWorkspaceKey(),
        prepareEncryptedDatabase,
        openDatabase,
        migrateToLatest,
        createDomainRuntime: (database) => new DomainRuntime({
          database,
          clock: { now: () => new Date().toISOString() },
          ids: { next: () => randomUUID() },
        }),
        createHealthService: (options) => new HealthService(options),
        closeDatabase,
      },
    );

    await expect(runtime.getHealth()).rejects.toThrow();
    expect(statSync(tempDatabase.path).isDirectory()).toBe(true);

    rmSync(tempDatabase.path, { recursive: true });
    const recoveredHealth = await runtime.getHealth();

    expect(recoveredHealth).toEqual({
      appVersion: '1.0.0',
      schemaVersion: 2,
      databasePath: tempDatabase.path,
      databaseEncrypted: true,
      cipherVersion: 'SQLite3 Multiple Ciphers 2.3.5',
      fts5Available: true,
      pendingJobs: 0,
      interruptedJobsRecovered: 0,
      domainStatus: 'ready',
      domainReady: true,
      domainBlockingViolationCount: 0,
      domainRepairableIssueCount: 0,
      domainProjectionRefreshCandidateCount: 0,
      pendingProjectionRebuilds: 0,
      domainStartupEvaluatedAt: expect.stringMatching(/Z$/),
    });
    expect(statSync(tempDatabase.path).isFile()).toBe(true);
  });
});

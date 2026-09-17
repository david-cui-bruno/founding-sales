import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DomainRuntime } from '../../src/main/domain/domainRuntime';

import {
  closeDatabase,
  openDatabase,
} from '../../src/main/db/database';
import { createMigrationRunner, migrateToLatest, productionMigrations } from '../../src/main/db/migrate';
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

  it.each([16, 17, 18])(
    'rejects a real schema-15 database marked as version %i before migration or composition',
    async (schemaVersion) => {
      tempDatabase = createTempDatabase();
      const backupDirectory = `${tempDatabase.path}.backups`;
      const setupKey = createTestWorkspaceKey();
      const setupDatabase = openDatabase({ path: tempDatabase.path, key: setupKey });
      await createMigrationRunner(productionMigrations.slice(0, 15))(setupDatabase, {
        backupDirectory,
        workspaceKey: setupKey,
      });
      setupDatabase.raw.prepare(
        'UPDATE app_meta SET schema_version = ? WHERE singleton = 1',
      ).run(schemaVersion);
      const beforeCatalog = setupDatabase.raw.prepare(`
        SELECT type, name, tbl_name, sql
        FROM sqlite_master
        WHERE name NOT LIKE 'sqlite_%'
        ORDER BY type, name
      `).all();
      const beforeLedger = setupDatabase.raw.prepare(`
        SELECT name, timestamp FROM kysely_migration ORDER BY timestamp, name
      `).all();
      closeDatabase(setupDatabase);
      rmSync(backupDirectory, { recursive: true, force: true });
      const beforeBytes = readFileSync(tempDatabase.path);
      const createDomainRuntime = vi.fn();
      const createHealthService = vi.fn();

      runtime = new FoundationRuntime(
        {
          appVersion: '1.0.0',
          backupDirectory,
          databasePath: tempDatabase.path,
          databaseExists: true,
          keyEnvelopePath: `${tempDatabase.path}.key-envelope.json`,
        },
        {
          loadWorkspaceKey: async () => createTestWorkspaceKey(),
          prepareEncryptedDatabase: async () => undefined,
          openDatabase,
          migrateToLatest,
          createDomainRuntime,
          createHealthService,
          closeDatabase,
        },
      );

      await expect(runtime.initialize()).rejects.toThrow(/schema version|migration ledger/i);

      expect(createDomainRuntime).not.toHaveBeenCalled();
      expect(createHealthService).not.toHaveBeenCalled();
      expect(existsSync(backupDirectory)).toBe(false);
      expect(readFileSync(tempDatabase.path)).toEqual(beforeBytes);

      const verifyDatabase = openDatabase({
        path: tempDatabase.path,
        key: createTestWorkspaceKey(),
      });
      expect(verifyDatabase.raw.prepare(`
        SELECT type, name, tbl_name, sql
        FROM sqlite_master
        WHERE name NOT LIKE 'sqlite_%'
        ORDER BY type, name
      `).all()).toEqual(beforeCatalog);
      expect(verifyDatabase.raw.prepare(`
        SELECT name, timestamp FROM kysely_migration ORDER BY timestamp, name
      `).all()).toEqual(beforeLedger);
      expect(verifyDatabase.raw.prepare(
        'SELECT schema_version FROM app_meta WHERE singleton = 1',
      ).get()).toEqual({ schema_version: schemaVersion });
      closeDatabase(verifyDatabase);
    },
  );

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
    runtime.setSourcingHealthProvider(() => ({
      status: 'healthy',
      reasons: [],
      state: {
        state: 'idle',
        pollId: null,
        startedAt: null,
        lastCompletedAt: null,
        consecutiveFailures: 0,
        lastFailureAt: null,
        lastFailureCode: null,
        backlogCount: 0,
      },
      lastSuccessAgeMs: 0,
    }));

    await expect(runtime.getHealth()).rejects.toThrow();
    expect(statSync(tempDatabase.path).isDirectory()).toBe(true);

    rmSync(tempDatabase.path, { recursive: true });
    const recoveredHealth = await runtime.getHealth();

    expect(recoveredHealth).toEqual({
      appVersion: '1.0.0',
      schemaVersion: 27,
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
      operationalStatus: 'ready',
      sourcing: {
        status: 'healthy',
        reasons: [],
        state: {
          state: 'idle',
          pollId: null,
          startedAt: null,
          lastCompletedAt: null,
          consecutiveFailures: 0,
          lastFailureAt: null,
          lastFailureCode: null,
          backlogCount: 0,
        },
        lastSuccessAgeMs: 0,
      },
    });
    expect(statSync(tempDatabase.path).isFile()).toBe(true);
  });
});

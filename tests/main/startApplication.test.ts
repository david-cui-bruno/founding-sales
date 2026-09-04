import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { fakeDomainRuntime } from '../fixtures/fakeDomainRuntime';

import type { AppDatabase } from '../../src/main/db/database';
import type { MigrationOptions } from '../../src/main/db/migrate';
import type { HealthProvider } from '../../src/main/health/registerHealthIpc';
import {
  startApplication,
  type ApplicationStartupDependencies,
  type ApplicationStartupOptions,
} from '../../src/main/startApplication';
import type { AppHealth } from '../../src/shared/healthContract';

const health: AppHealth = {
  appVersion: '1.0.0',
  schemaVersion: 2,
  databasePath: '/tmp/callie.sqlite3',
  databaseEncrypted: true,
  cipherVersion: 'SQLite3 Multiple Ciphers 2.3.5',
  fts5Available: true,
  pendingJobs: 0,
  interruptedJobsRecovered: 4,
  domainStatus: 'ready',
  domainReady: true,
  domainBlockingViolationCount: 0,
  domainRepairableIssueCount: 0,
  domainProjectionRefreshCandidateCount: 0,
  pendingProjectionRebuilds: 0,
  domainStartupEvaluatedAt: '2026-08-30T12:00:00.000Z',
  operationalStatus: 'ready',
  sourcing: {
    status: 'healthy', reasons: [], lastSuccessAgeMs: null,
    state: {
      state: 'idle', pollId: null, startedAt: null, lastCompletedAt: null,
      consecutiveFailures: 0, lastFailureAt: null, lastFailureCode: null,
      backlogCount: null,
    },
  },
};

const keyDependencies = () => ({
  loadWorkspaceKey: async () => ({ bytes: Buffer.alloc(32, 0x2a), version: 1 as const }),
  prepareEncryptedDatabase: async (): Promise<void> => undefined,
});

describe('startApplication', () => {
  function createDependencies(
    events: string[],
    captureHealth?: (provider: HealthProvider) => void,
    captureMigration?: (options: MigrationOptions) => void,
  ): ApplicationStartupDependencies {
    const database = { path: '/ignored-until-open' } as AppDatabase;

    return {
      ...keyDependencies(),
      openDatabase: ({ path }) => {
        events.push(`open:${path}`);
        return database;
      },
      migrateToLatest: async (_database, options) => {
        events.push('migrate');
        captureMigration?.(options);
        return {
          fromVersion: 0,
          toVersion: 2,
          appliedMigrationIds: ['0001Foundation', '0002DomainFoundation'],
        };
      },
      createDomainRuntime: () => fakeDomainRuntime({
        onInitialize: () => events.push('recover'),
        interruptedJobsRecovered: 4,
      }),
      createHealthService: (options) => {
        events.push(`health:${options.domainStartupReport.interruptedJobsRecovered}`);
        return { getHealth: () => health };
      },
      registerApplicationIpc: (provider: HealthProvider) => {
        events.push('ipc');
        captureHealth?.(provider);
        return () => events.push('unregister');
      },
      createAppleBridgeSupervisor: () => {
        throw new Error('Apple bridge must not be created without startup options.');
      },
      closeDatabase: () => events.push('close'),
    };
  }

  it('requests the existing-workspace key and never replaces it when the envelope is unavailable', async () => {
    const events: string[] = [];
    const userDataPath = mkdtempSync(join(tmpdir(), 'callie-existing-key-'));
    const databasePath = join(userDataPath, 'callie.sqlite3');
    const original = Buffer.from('synthetic existing encrypted file');
    writeFileSync(databasePath, original);
    const dependencies = createDependencies(events);
    const loadWorkspaceKey = vi.fn(async () => {
      throw new Error('Workspace key is unavailable for an existing database');
    });
    dependencies.loadWorkspaceKey = loadWorkspaceKey;
    try {
      await expect(startApplication({
        appVersion: '1.0.0',
        userDataPath,
        createWindow: () => undefined,
      }, dependencies)).rejects.toThrow('Workspace key is unavailable');

      expect(loadWorkspaceKey).toHaveBeenCalledWith({
        envelopePath: join(userDataPath, 'callie.key-envelope.json'),
        databaseExists: true,
      });
      expect(readFileSync(databasePath)).toEqual(original);
      expect(events).toEqual([]);
    } finally {
      rmSync(userDataPath, { recursive: true, force: true });
    }
  });

  it('initializes the app-owned database before registering diagnostics and opening the window', async () => {
    const events: string[] = [];
    let provider: HealthProvider | undefined;
    const userDataPath = '/Users/founder/Library/Application Support/Callie';

    const running = await startApplication(
      {
        appVersion: '1.0.0',
        userDataPath,
        createWindow: () => {
          events.push('window');
        },
      },
      createDependencies(events, (registered) => {
        provider = registered;
      }),
    );

    expect(events).toEqual([
      `open:${join(userDataPath, 'callie.sqlite3')}`,
      'migrate',
      'recover',
      'health:4',
      'ipc',
      'window',
    ]);
    await expect(provider?.getHealth()).resolves.toEqual(health);
    expect(events).toEqual([
      `open:${join(userDataPath, 'callie.sqlite3')}`,
      'migrate',
      'recover',
      'health:4',
      'ipc',
      'window',
    ]);
    expect(running.databasePath).toBe(join(userDataPath, 'callie.sqlite3'));
  });

  it('passes the app-owned backup directory and live workspace key into migration', async () => {
    const events: string[] = [];
    const userDataPath = '/tmp/callie-migration-wiring';
    let backupDirectory: string | undefined;
    let keyWasLive = false;

    const running = await startApplication(
      {
        appVersion: '1.0.0',
        userDataPath,
        createWindow: () => undefined,
      },
      createDependencies(events, undefined, (options) => {
        backupDirectory = options.backupDirectory;
        keyWasLive = options.workspaceKey.bytes.equals(Buffer.alloc(32, 0x2a));
      }),
    );

    expect(backupDirectory).toBe(join(userDataPath, 'backups'));
    expect(keyWasLive).toBe(true);
    await running.shutdown();
  });

  it('unregisters IPC and closes initialized SQLite exactly once on repeated shutdown requests', async () => {
    const events: string[] = [];
    let provider: HealthProvider | undefined;
    const running = await startApplication(
      {
        appVersion: '1.0.0',
        userDataPath: '/tmp/callie-user-data',
        createWindow: () => {
          events.push('window');
        },
      },
      createDependencies(events, (registered) => {
        provider = registered;
      }),
    );
    await provider?.getHealth();

    await Promise.all([running.shutdown(), running.shutdown()]);

    expect(events.filter((event) => event === 'unregister')).toHaveLength(1);
    expect(events.filter((event) => event === 'close')).toHaveLength(1);
  });

  it('unregisters IPC and closes ready SQLite when bootstrap window creation fails', async () => {
    const events: string[] = [];

    await expect(
      startApplication(
        {
          appVersion: '1.0.0',
          userDataPath: '/tmp/callie-user-data',
          createWindow: () => {
            events.push('window');
            throw new Error('window failed');
          },
        },
        createDependencies(events),
      ),
    ).rejects.toThrow('window failed');

    expect(events).toEqual([
      'open:/tmp/callie-user-data/callie.sqlite3',
      'migrate',
      'recover',
      'health:4',
      'ipc',
      'window',
      'unregister',
      'close',
    ]);
  });

  it('fails before IPC and window creation when explicit foundation initialization fails', async () => {
    const events: string[] = [];
    let provider: HealthProvider | undefined;
    let migrationAttempts = 0;
    const dependencies = createDependencies(events, (registered) => {
      provider = registered;
    });
    dependencies.migrateToLatest = vi.fn(async () => {
      migrationAttempts += 1;
      events.push(`migrate:${migrationAttempts}`);
      if (migrationAttempts === 1) {
        throw new Error('migration failed');
      }
      return {
        fromVersion: 0,
        toVersion: 2,
        appliedMigrationIds: ['0001Foundation', '0002DomainFoundation'],
      };
    });

    await expect(startApplication(
      {
        appVersion: '1.0.0',
        userDataPath: '/tmp/callie-user-data',
        createWindow: () => {
          events.push('window');
        },
      },
      dependencies,
    )).rejects.toThrow('migration failed');

    expect(provider).toBeUndefined();
    expect(events).toEqual([
      'open:/tmp/callie-user-data/callie.sqlite3',
      'migrate:1',
      'close',
    ]);
  });

  it('cancels startup after Foundation initialization without registering IPC or opening a window', async () => {
    const events: string[] = [];
    const controller = new AbortController();
    const options: ApplicationStartupOptions & { signal: AbortSignal } = {
      appVersion: '1.0.0',
      userDataPath: '/tmp/callie-user-data',
      createWindow: () => {
        events.push('window');
      },
      signal: controller.signal,
    };

    const startup = startApplication(options, createDependencies(events));
    controller.abort();

    await expect(startup).rejects.toThrow('cancelled');
    expect(events).toEqual([
      'open:/tmp/callie-user-data/callie.sqlite3',
      'migrate',
      'recover',
      'health:4',
      'close',
    ]);
  });

  it('awaits window loading and cleans up when it rejects', async () => {
    const events: string[] = [];

    await expect(
      startApplication(
        {
          appVersion: '1.0.0',
          userDataPath: '/tmp/callie-user-data',
          createWindow: async () => {
            events.push('window');
            throw new Error('renderer load failed');
          },
        },
        createDependencies(events),
      ),
    ).rejects.toThrow('renderer load failed');

    expect(events).toEqual([
      'open:/tmp/callie-user-data/callie.sqlite3',
      'migrate',
      'recover',
      'health:4',
      'ipc',
      'window',
      'unregister',
      'close',
    ]);
  });
});

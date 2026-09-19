import { describe, expect, it, vi } from 'vitest';
import { fakeDomainRuntime } from '../fixtures/fakeDomainRuntime';

import { openDatabase, closeDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { DomainRuntime } from '../../src/main/domain/domainRuntime';
import { UuidGenerator } from '../../src/main/domain/support/idGenerator';
import { createTempDatabase, createTestWorkspaceKey } from '../fixtures/tempDatabase';
import { insertPerson } from '../fixtures/domainRows';
import { HealthService } from '../../src/main/health/healthService';
import {
  FoundationRuntime,
  type FoundationRuntimeDependencies,
} from '../../src/main/foundation/foundationRuntime';
import type { AppHealth } from '../../src/shared/healthContract';

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
};

const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const migrationResult = {
  fromVersion: 0,
  toVersion: 2,
  appliedMigrationIds: ['0001Foundation', '0002DomainFoundation'],
};

const health: AppHealth = {
  appVersion: '1.0.0',
  schemaVersion: 2,
  databasePath: '/tmp/callie-user-data/callie.sqlite3',
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
};

const runtimeOptions = {
  appVersion: '1.0.0',
  backupDirectory: '/tmp/callie-user-data/backups',
  databasePath: health.databasePath,
  databaseExists: false,
  keyEnvelopePath: '/tmp/callie-user-data/callie.key-envelope.json',
};

const keyDependencies = () => ({
  loadWorkspaceKey: async () => ({ bytes: Buffer.alloc(32, 0x2a), version: 1 as const }),
  prepareEncryptedDatabase: async (): Promise<void> => undefined,
});

const ipc = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, input: unknown) => Promise<unknown>>() }));
vi.mock('electron', () => ({ safeStorage: {}, dialog: {}, ipcMain: {
  handle: (channel: string, handler: (event: unknown, input: unknown) => Promise<unknown>) => {
    if (ipc.handlers.has(channel)) throw new Error('duplicate fixture channel');
    ipc.handlers.set(channel, handler);
  },
  removeHandler: (channel: string) => { ipc.handlers.delete(channel); },
} }));

describe('FoundationRuntime', () => {
  it.each([false, true])('real HealthService serves the retained startup report without repeating initialization, blocked=%s', async blocked => {
    const temp = createTempDatabase();
    const counts = { key: 0, prepare: 0, open: 0, migrate: 0, domain: 0, initialize: 0, health: 0, close: 0 };
    const release = deferred<void>();
    const entered = deferred<void>();
    const runtime = new FoundationRuntime({ ...runtimeOptions, databasePath: temp.path, backupDirectory: `${temp.path}.backups` }, {
      loadWorkspaceKey: async () => { counts.key++; return createTestWorkspaceKey(); },
      prepareEncryptedDatabase: async () => { counts.prepare++; },
      openDatabase: options => { counts.open++; return openDatabase(options); },
      migrateToLatest: async (database, options) => {
        counts.migrate++;
        const result = await migrateToLatest(database, options);
        if (blocked) insertPerson(database.raw, 'orphan-without-canonical-prospect');
        return result;
      },
      createDomainRuntime: database => {
        counts.domain++;
        const domain = new DomainRuntime({ database, clock: { now: () => '2026-09-10T15:00:00.000Z' }, ids: new UuidGenerator() });
        const initialize = domain.initialize.bind(domain);
        vi.spyOn(domain, 'initialize').mockImplementation(() => { counts.initialize++; return initialize(); });
        return domain;
      },
      createHealthService: options => { counts.health++; return new HealthService(options); },
      closeDatabase: database => { counts.close++; closeDatabase(database); },
    });
    try {
      await runtime.initialize();
      const expected = { domainStatus: blocked ? 'blocked' : 'ready', domainReady: !blocked, domainBlockingViolationCount: blocked ? 1 : 0,
        databaseEncrypted: true, domainStartupEvaluatedAt: '2026-09-10T15:00:00.000Z' };
      await expect(runtime.getHealth()).resolves.toMatchObject(expected);
      // A second read serves the same retained report without re-running the audit.
      await expect(runtime.getHealth()).resolves.toMatchObject(expected);
      const operation = vi.fn(() => 'admitted');
      if (blocked) { await expect(runtime.withDomain(operation)).rejects.toThrow('blocked'); expect(operation).not.toHaveBeenCalled(); }
      else await expect(runtime.withDomain(operation)).resolves.toBe('admitted');
      expect(counts).toEqual({ key: 1, prepare: 1, open: 1, migrate: 1, domain: 1, initialize: 1, health: 1, close: 0 });
      const leased = runtime.withDatabase(async () => { entered.resolve(); await release.promise; });
      await entered.promise;
      const stopping = runtime.shutdown();
      await expect(runtime.getHealth()).rejects.toThrow('cancelled');
      await expect(runtime.withDomain(operation)).rejects.toThrow('cancelled');
      expect(counts.close).toBe(0);
      release.resolve(); await leased; await stopping;
      await expect(runtime.getHealth()).rejects.toThrow('shut down');
      expect(counts).toEqual({ key: 1, prepare: 1, open: 1, migrate: 1, domain: 1, initialize: 1, health: 1, close: 1 });
    } finally {
      release.resolve();
      try { await runtime.shutdown(); } finally { temp.cleanup(); }
    }
  });

  it.each([false, true])('keeps a main-only database lease alive through shutdown, releasing on rejection=%s', async (reject) => {
    const database = { path: health.databasePath } as AppDatabase;
    const events: string[] = [];
    const runtime = new FoundationRuntime(runtimeOptions, {
      ...keyDependencies(),
      openDatabase: () => database,
      migrateToLatest: async () => migrationResult,
      createDomainRuntime: () => fakeDomainRuntime(),
      createHealthService: () => ({ getHealth: () => health }),
      closeDatabase: () => { events.push('close'); },
    });
    const entered = deferred<void>();
    const release = deferred<void>();
    const operation = runtime.withDatabase(async (leased) => {
      expect(leased).toBe(database);
      entered.resolve();
      await release.promise;
      events.push('released');
      if (reject) throw new Error('operation failed');
      return 'done';
    });
    const observed = operation.catch((error: Error) => error.message);
    await entered.promise;
    const stopping = runtime.shutdown();
    await expect(runtime.withDatabase(() => 'late')).rejects.toThrow('cancelled');
    expect(events).toEqual([]);
    release.resolve();
    await expect(observed).resolves.toBe(reject ? 'operation failed' : 'done');
    await stopping;
    expect(events).toEqual(['released', 'close']);
    await expect(runtime.withDatabase(() => 'late')).rejects.toThrow('shut down');
  });

  it('resolves, converts, opens, and migrates in order before zeroing the key', async () => {
    const keyBytes = Buffer.alloc(32, 0x5a);
    const database = { path: health.databasePath } as AppDatabase;
    const events: string[] = [];
    const runtime = new FoundationRuntime(runtimeOptions, {
      loadWorkspaceKey: async (input) => {
        events.push(`key:${input.envelopePath}:${input.databaseExists}`);
        return { bytes: keyBytes, version: 1 };
      },
      prepareEncryptedDatabase: async (_path, key) => {
        expect(key.bytes.equals(Buffer.alloc(32, 0x5a))).toBe(true);
        events.push('prepare');
      },
      openDatabase: ({ key }) => {
        expect(key.bytes.equals(Buffer.alloc(32, 0x5a))).toBe(true);
        events.push('open');
        return database;
      },
      migrateToLatest: async (migratedDatabase, options) => {
        expect(migratedDatabase).toBe(database);
        expect(options.backupDirectory).toBe(runtimeOptions.backupDirectory);
        expect(options.workspaceKey.bytes.equals(Buffer.alloc(32, 0x5a))).toBe(true);
        expect(keyBytes.equals(Buffer.alloc(32, 0x5a))).toBe(true);
        events.push('migrate');
        return migrationResult;
      },
      createDomainRuntime: () => fakeDomainRuntime(),
      createHealthService: () => ({ getHealth: () => health }),
      closeDatabase: () => undefined,
    });

    await runtime.initialize();

    expect(events).toEqual([
      `key:${runtimeOptions.keyEnvelopePath}:false`,
      'prepare',
      'open',
      'migrate',
    ]);
    expect(keyBytes.equals(Buffer.alloc(32))).toBe(true);
    await runtime.shutdown();
  });

  it('zeroes the key when conversion fails before a database is opened', async () => {
    const keyBytes = Buffer.alloc(32, 0x5a);
    const runtime = new FoundationRuntime(runtimeOptions, {
      loadWorkspaceKey: async () => ({ bytes: keyBytes, version: 1 }),
      prepareEncryptedDatabase: async () => {
        throw new Error('conversion failed');
      },
      openDatabase: () => {
        throw new Error('must not open');
      },
      migrateToLatest: async () => migrationResult,
      createDomainRuntime: () => fakeDomainRuntime(),
      createHealthService: () => ({ getHealth: () => health }),
      closeDatabase: () => undefined,
    });

    await expect(runtime.initialize()).rejects.toThrow('conversion failed');
    expect(keyBytes.equals(Buffer.alloc(32))).toBe(true);
    await runtime.shutdown();
  });

  it('zeroes a resolved key when shutdown cancels initialization', async () => {
    const keyResolution = deferred<{ bytes: Buffer; version: 1 }>();
    const keyBytes = Buffer.alloc(32, 0x5a);
    const runtime = new FoundationRuntime(runtimeOptions, {
      loadWorkspaceKey: () => keyResolution.promise,
      prepareEncryptedDatabase: async () => undefined,
      openDatabase: () => {
        throw new Error('must not open');
      },
      migrateToLatest: async () => migrationResult,
      createDomainRuntime: () => fakeDomainRuntime(),
      createHealthService: () => ({ getHealth: () => health }),
      closeDatabase: () => undefined,
    });

    const initialization = runtime.initialize();
    const shutdown = runtime.shutdown();
    keyResolution.resolve({ bytes: keyBytes, version: 1 });

    await expect(initialization).rejects.toThrow('cancelled');
    await shutdown;
    expect(keyBytes.equals(Buffer.alloc(32))).toBe(true);
  });

  it('explicitly initializes the durable foundation once before serving health', async () => {
    const database = { path: health.databasePath } as AppDatabase;
    const events: string[] = [];
    const runtime = new FoundationRuntime(
      runtimeOptions,
      {
        ...keyDependencies(),
        openDatabase: () => {
          events.push('open');
          return database;
        },
        migrateToLatest: async () => {
          events.push('migrate');
          return migrationResult;
        },
        createDomainRuntime: () => fakeDomainRuntime({
          onInitialize: () => events.push('recover'),
          interruptedJobsRecovered: 4,
        }),
        createHealthService: () => {
          events.push('health:create');
          return {
            getHealth: () => {
              events.push('health:read');
              return health;
            },
          };
        },
        closeDatabase: () => events.push('close'),
      },
    );

    await Promise.all([runtime.initialize(), runtime.initialize()]);
    expect(events).toEqual(['open', 'migrate', 'recover', 'health:create']);

    await expect(runtime.getHealth()).resolves.toEqual(health);
    expect(events).toEqual([
      'open',
      'migrate',
      'recover',
      'health:create',
      'health:read',
    ]);
    await runtime.shutdown();
    expect(events.at(-1)).toBe('close');
  });

  it('retries a failed migration non-destructively against the same database path', async () => {
    const databasePath = health.databasePath;
    const firstDatabase = { path: databasePath } as AppDatabase;
    const secondDatabase = { path: databasePath } as AppDatabase;
    const events: string[] = [];
    let openCount = 0;
    const dependencies: FoundationRuntimeDependencies = {
      ...keyDependencies(),
      openDatabase: ({ path }) => {
        openCount += 1;
        events.push(`open:${path}:${openCount}`);
        return openCount === 1 ? firstDatabase : secondDatabase;
      },
      migrateToLatest: async (database) => {
        events.push(`migrate:${database === firstDatabase ? 'first' : 'second'}`);
        if (database === firstDatabase) {
          throw new Error('transient migration failure');
        }
        return migrationResult;
      },
      createDomainRuntime: () => fakeDomainRuntime({
        onInitialize: () => events.push('recover'),
        interruptedJobsRecovered: 4,
      }),
      createHealthService: (options) => {
        events.push(`health:${options.domainStartupReport.interruptedJobsRecovered}`);
        return { getHealth: () => health };
      },
      closeDatabase: (database) => {
        events.push(`close:${database === firstDatabase ? 'first' : 'second'}`);
      },
    };
    const runtime = new FoundationRuntime(
      { ...runtimeOptions, databasePath },
      dependencies,
    );

    await expect(runtime.getHealth()).rejects.toThrow(
      'transient migration failure',
    );
    await expect(runtime.getHealth()).resolves.toEqual(health);
    await expect(runtime.getHealth()).resolves.toEqual(health);

    expect(events).toEqual([
      `open:${databasePath}:1`,
      'migrate:first',
      'close:first',
      `open:${databasePath}:2`,
      'migrate:second',
      'recover',
      'health:4',
    ]);

    await runtime.shutdown();
    expect(events.at(-1)).toBe('close:second');
  });

  it('deduplicates concurrent initialization requests', async () => {
    const migration = deferred<typeof migrationResult>();
    const database = { path: health.databasePath } as AppDatabase;
    let opens = 0;
    let recoveries = 0;
    const runtime = new FoundationRuntime(
      runtimeOptions,
      {
        ...keyDependencies(),
        openDatabase: () => {
          opens += 1;
          return database;
        },
        migrateToLatest: () => migration.promise,
        createDomainRuntime: () => fakeDomainRuntime({
          onInitialize: () => {
            recoveries += 1;
          },
          interruptedJobsRecovered: 4,
        }),
        createHealthService: () => ({ getHealth: () => health }),
        closeDatabase: () => undefined,
      },
    );

    const first = runtime.getHealth();
    const second = runtime.getHealth();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(opens).toBe(1);

    migration.resolve(migrationResult);
    await expect(Promise.all([first, second])).resolves.toEqual([
      health,
      health,
    ]);
    expect(opens).toBe(1);
    expect(recoveries).toBe(1);
    await runtime.shutdown();
  });

  it('awaits and closes an in-flight partial database during shutdown', async () => {
    const migration = deferred<typeof migrationResult>();
    const database = { path: health.databasePath } as AppDatabase;
    const events: string[] = [];
    const runtime = new FoundationRuntime(
      runtimeOptions,
      {
        ...keyDependencies(),
        openDatabase: () => {
          events.push('open');
          return database;
        },
        migrateToLatest: () => {
          events.push('migrate');
          return migration.promise;
        },
        createDomainRuntime: () => {
          events.push('jobs');
          return fakeDomainRuntime();
        },
        createHealthService: () => {
          events.push('health');
          return { getHealth: () => health };
        },
        closeDatabase: () => events.push('close'),
      },
    );

    const initialization = runtime.getHealth();
    await new Promise((resolve) => setTimeout(resolve, 0));
    let shutdownComplete = false;
    const shutdown = runtime.shutdown().then(() => {
      shutdownComplete = true;
    });

    await Promise.resolve();
    expect(shutdownComplete).toBe(false);
    migration.resolve(migrationResult);

    await expect(initialization).rejects.toThrow('cancelled');
    await shutdown;
    expect(events).toEqual(['open', 'migrate', 'close']);
    await expect(runtime.getHealth()).rejects.toThrow('shut down');
    expect(events).toEqual(['open', 'migrate', 'close']);
  });
});

describe('FoundationRuntime.lastFailedStage', () => {
  const stageFailure = async (stage: 'key' | 'prepare' | 'open' | 'migrate' | 'domain' | 'health'): Promise<FoundationRuntime> => {
    const failure = new Error(`private ${stage} detail`);
    const database = { path: '/fixture/callie.sqlite3' } as AppDatabase;
    const dependencies: FoundationRuntimeDependencies = {
      loadWorkspaceKey: async () => { if (stage === 'key') throw failure; return { bytes: Buffer.alloc(32, 1), version: 1 }; },
      prepareEncryptedDatabase: async () => { if (stage === 'prepare') throw failure; },
      openDatabase: () => { if (stage === 'open') throw failure; return database; },
      migrateToLatest: async () => { if (stage === 'migrate') throw failure; return migrationResult; },
      createDomainRuntime: () => fakeDomainRuntime({ onInitialize: () => { if (stage === 'domain') throw failure; } }),
      createHealthService: () => { if (stage === 'health') throw failure; return { getHealth: () => health }; },
      closeDatabase: () => undefined,
    };
    const runtime = new FoundationRuntime(runtimeOptions, dependencies);
    await expect(runtime.initialize()).rejects.toBe(failure);
    return runtime;
  };

  it.each(['key', 'prepare', 'open', 'migrate', 'domain', 'health'] as const)('names %s as the stage where initialization stopped', async stage => {
    const runtime = await stageFailure(stage);
    expect(runtime.lastFailedStage).toBe(stage);
  });

  it('is undefined before any attempt and after a successful start', async () => {
    const database = { path: '/fixture/callie.sqlite3' } as AppDatabase;
    const runtime = new FoundationRuntime(runtimeOptions, {
      loadWorkspaceKey: async () => ({ bytes: Buffer.alloc(32, 1), version: 1 }),
      prepareEncryptedDatabase: async () => undefined,
      openDatabase: () => database,
      migrateToLatest: async () => migrationResult,
      createDomainRuntime: () => fakeDomainRuntime(),
      createHealthService: () => ({ getHealth: () => health }),
      closeDatabase: () => undefined,
    });
    expect(runtime.lastFailedStage).toBeUndefined();
    await runtime.initialize();
    expect(runtime.lastFailedStage).toBeUndefined();
    await runtime.shutdown();
  });
});

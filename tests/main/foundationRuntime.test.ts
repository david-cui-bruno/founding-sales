import { describe, expect, it } from 'vitest';

import type { AppDatabase } from '../../src/main/db/database';
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

describe('FoundationRuntime', () => {
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
      createJobRepository: () => ({
        listActive: () => [],
        recoverInterruptedJobs: () => 0,
      }),
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
      createJobRepository: () => ({
        listActive: () => [], recoverInterruptedJobs: () => 0,
      }),
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
      createJobRepository: () => ({
        listActive: () => [], recoverInterruptedJobs: () => 0,
      }),
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
        createJobRepository: () => ({
          listActive: () => [],
          recoverInterruptedJobs: () => {
            events.push('recover');
            return 4;
          },
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
      createJobRepository: () => ({
        listActive: () => [],
        recoverInterruptedJobs: () => {
          events.push('recover');
          return 4;
        },
      }),
      createHealthService: (options) => {
        events.push(`health:${options.interruptedJobsRecovered}`);
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
        createJobRepository: () => ({
          listActive: () => [],
          recoverInterruptedJobs: () => {
            recoveries += 1;
            return 4;
          },
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
        createJobRepository: () => {
          events.push('jobs');
          return { listActive: () => [], recoverInterruptedJobs: () => 0 };
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

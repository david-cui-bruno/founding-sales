import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { AppDatabase } from '../../src/main/db/database';
import type { HealthProvider } from '../../src/main/health/registerHealthIpc';
import {
  startApplication,
  type ApplicationStartupDependencies,
  type ApplicationStartupOptions,
} from '../../src/main/startApplication';
import type { AppHealth } from '../../src/shared/healthContract';

const health: AppHealth = {
  appVersion: '1.0.0',
  schemaVersion: 1,
  databasePath: '/tmp/callie.sqlite3',
  fts5Available: true,
  pendingJobs: 0,
  interruptedJobsRecovered: 4,
};

describe('startApplication', () => {
  function createDependencies(
    events: string[],
    captureHealth?: (provider: HealthProvider) => void,
  ): ApplicationStartupDependencies {
    const database = { path: '/ignored-until-open' } as AppDatabase;
    const jobs = {
      recoverInterruptedJobs: () => {
        events.push('recover');
        return 4;
      },
      listActive: (): [] => [],
    };

    return {
      openDatabase: (databasePath) => {
        events.push(`open:${databasePath}`);
        return database;
      },
      migrateToLatest: async () => {
        events.push('migrate');
        return {
          fromVersion: 0,
          toVersion: 1,
          appliedMigrationIds: ['0001Foundation'],
        };
      },
      createJobRepository: () => jobs,
      createHealthService: (options) => {
        events.push(`health:${options.interruptedJobsRecovered}`);
        return { getHealth: () => health };
      },
      registerHealthIpc: (provider) => {
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

  it('loads bootstrap diagnostics before lazily opening the app-owned database', async () => {
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

    expect(events).toEqual(['ipc', 'window']);
    await expect(provider?.getHealth()).resolves.toEqual(health);
    expect(events).toEqual([
      'ipc',
      'window',
      `open:${join(userDataPath, 'callie.sqlite3')}`,
      'migrate',
      'recover',
      'health:4',
    ]);
    expect(running.databasePath).toBe(join(userDataPath, 'callie.sqlite3'));
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

  it('unregisters IPC without opening SQLite when bootstrap window creation fails', async () => {
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

    expect(events).toEqual(['ipc', 'window', 'unregister']);
  });

  it('keeps diagnostics reachable when initialization fails and allows retry', async () => {
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
        toVersion: 1,
        appliedMigrationIds: ['0001Foundation'],
      };
    });

    const running = await startApplication(
      {
        appVersion: '1.0.0',
        userDataPath: '/tmp/callie-user-data',
        createWindow: () => {
          events.push('window');
        },
      },
      dependencies,
    );

    expect(events).toEqual(['ipc', 'window']);
    await expect(provider?.getHealth()).rejects.toThrow('migration failed');
    await expect(provider?.getHealth()).resolves.toEqual(health);
    expect(events.filter((event) => event === 'close')).toHaveLength(1);
    expect(events.filter((event) => event.startsWith('open:'))).toHaveLength(2);
    await running.shutdown();
    expect(events.filter((event) => event === 'close')).toHaveLength(2);
  });

  it('cancels startup during bootstrap loading without opening SQLite', async () => {
    const events: string[] = [];
    const controller = new AbortController();
    let settleWindow: (() => void) | undefined;
    const options: ApplicationStartupOptions & { signal: AbortSignal } = {
      appVersion: '1.0.0',
      userDataPath: '/tmp/callie-user-data',
      createWindow: () => {
        events.push('window');
        return new Promise<void>((resolve) => {
          settleWindow = resolve;
        });
      },
      signal: controller.signal,
    };

    const startup = startApplication(options, createDependencies(events));
    controller.abort();
    settleWindow?.();

    await expect(startup).rejects.toThrow('cancelled');
    expect(events).toEqual(['ipc', 'window', 'unregister']);
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

    expect(events).toEqual(['ipc', 'window', 'unregister']);
  });
});

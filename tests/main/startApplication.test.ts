import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { AppDatabase } from '../../src/main/db/database';
import type { AppHealth } from '../../src/shared/healthContract';
import {
  startApplication,
  type ApplicationStartupDependencies,
  type ApplicationStartupOptions,
} from '../../src/main/startApplication';

const health: AppHealth = {
  appVersion: '1.0.0',
  schemaVersion: 1,
  databasePath: '/tmp/callie.sqlite3',
  fts5Available: true,
  pendingJobs: 0,
  interruptedJobsRecovered: 4,
};

describe('startApplication', () => {
  function createDependencies(events: string[]): ApplicationStartupDependencies {
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
        return { fromVersion: 0, toVersion: 1, appliedMigrationIds: ['0001Foundation'] };
      },
      createJobRepository: () => jobs,
      createHealthService: (options) => {
        events.push(`health:${options.interruptedJobsRecovered}`);
        return { getHealth: () => health };
      },
      registerHealthIpc: () => {
        events.push('ipc');
        return () => events.push('unregister');
      },
      closeDatabase: () => events.push('close'),
    };
  }

  it('opens the per-app database and composes dependencies in startup order', async () => {
    const events: string[] = [];
    const dependencies = createDependencies(events);
    const userDataPath = '/Users/founder/Library/Application Support/Callie';

    const running = await startApplication(
      {
        appVersion: '1.0.0',
        userDataPath,
        createWindow: () => {
          events.push('window');
        },
      },
      dependencies,
    );

    expect(events).toEqual([
      `open:${join(userDataPath, 'callie.sqlite3')}`,
      'migrate',
      'recover',
      'health:4',
      'ipc',
      'window',
    ]);
    expect(running.databasePath).toBe(join(userDataPath, 'callie.sqlite3'));
    expect(running.interruptedJobsRecovered).toBe(4);
  });

  it('unregisters IPC and closes SQLite exactly once on repeated shutdown requests', async () => {
    const events: string[] = [];
    const running = await startApplication(
      {
        appVersion: '1.0.0',
        userDataPath: '/tmp/callie-user-data',
        createWindow: () => {
          events.push('window');
        },
      },
      createDependencies(events),
    );

    running.shutdown();
    running.shutdown();

    expect(events.filter((event) => event === 'unregister')).toHaveLength(1);
    expect(events.filter((event) => event === 'close')).toHaveLength(1);
  });

  it('cleans up registered IPC and SQLite when window creation fails', async () => {
    const events: string[] = [];
    const dependencies = createDependencies(events);

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
        dependencies,
      ),
    ).rejects.toThrow('window failed');

    expect(events.slice(-2)).toEqual(['unregister', 'close']);
    expect(events.filter((event) => event === 'close')).toHaveLength(1);
  });

  it('closes SQLite when migration fails before later services are created', async () => {
    const events: string[] = [];
    const dependencies = createDependencies(events);
    dependencies.migrateToLatest = vi.fn(async () => {
      events.push('migrate');
      throw new Error('migration failed');
    });

    await expect(
      startApplication(
        {
          appVersion: '1.0.0',
          userDataPath: '/tmp/callie-user-data',
          createWindow: () => {
            events.push('window');
          },
        },
        dependencies,
      ),
    ).rejects.toThrow('migration failed');

    expect(events).toEqual([
      'open:/tmp/callie-user-data/callie.sqlite3',
      'migrate',
      'close',
    ]);
  });

  it('stops after an in-flight migration when startup is cancelled', async () => {
    const events: string[] = [];
    const dependencies = createDependencies(events);
    const controller = new AbortController();
    let settleMigration: (() => void) | undefined;
    dependencies.migrateToLatest = () => {
      events.push('migrate');
      return new Promise((resolve) => {
        settleMigration = () =>
          resolve({
            fromVersion: 0,
            toVersion: 1,
            appliedMigrationIds: ['0001Foundation'],
          });
      });
    };
    const options: ApplicationStartupOptions & { signal: AbortSignal } = {
      appVersion: '1.0.0',
      userDataPath: '/tmp/callie-user-data',
      createWindow: () => {
        events.push('window');
      },
      signal: controller.signal,
    };

    const startup = startApplication(options, dependencies);
    controller.abort();
    settleMigration?.();

    await expect(startup).rejects.toThrow('cancelled');
    expect(events).toEqual([
      'open:/tmp/callie-user-data/callie.sqlite3',
      'migrate',
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

    expect(events.slice(-3)).toEqual(['window', 'unregister', 'close']);
  });
});

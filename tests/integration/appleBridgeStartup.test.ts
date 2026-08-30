import { describe, expect, it } from 'vitest';

import type { AppDatabase } from '../../src/main/db/database';
import type { AppleBridgeSupervisorApi } from '../../src/main/appleBridge/appleBridgeSupervisor';
import {
  startApplication,
  type ApplicationStartupDependencies,
  type ApplicationStartupOptions,
} from '../../src/main/startApplication';

const APPLE_OPTIONS: NonNullable<ApplicationStartupOptions['appleBridge']> = {
  platform: 'darwin',
  isPackaged: true,
  resourcesPath: '/Applications/Callie.app/Contents/Resources',
  environment: {},
  stagingRoot: '/Users/founder/Library/Application Support/Callie/apple-bridge-staging',
  expectedIdentifier: 'com.callie.foundersales.applebridge',
  expectedTeamIdentifier: 'TEAM123456',
};

function dependencies(
  events: string[],
  supervisor: AppleBridgeSupervisorApi,
): ApplicationStartupDependencies {
  const database = { path: '/tmp/callie.sqlite3' } as AppDatabase;
  return {
    openDatabase: () => {
      events.push('database:open');
      return database;
    },
    migrateToLatest: async () => ({
      fromVersion: 0,
      toVersion: 1,
      appliedMigrationIds: ['0001Foundation'],
    }),
    createJobRepository: () => ({
      listActive: () => [],
      recoverInterruptedJobs: () => 0,
    }),
    createHealthService: () => ({
      getHealth: async () => ({ state: 'ok' }),
    }),
    registerHealthIpc: (health) => {
      events.push('health-ipc:register');
      void Promise.resolve(health.getHealth()).catch((): undefined => undefined);
      return () => events.push('health-ipc:unregister');
    },
    createAppleBridgeSupervisor: () => {
      events.push('helper:create');
      return supervisor;
    },
    registerAppleBridgeIpc: () => {
      events.push('apple-ipc:register');
      return () => events.push('apple-ipc:unregister');
    },
    closeDatabase: () => events.push('database:close'),
  };
}

function fakeSupervisor(
  events: string[],
  start: () => Promise<void> = async () => undefined,
): AppleBridgeSupervisorApi {
  return {
    start: async () => {
      events.push('helper:start');
      await start();
    },
    getStatus: () => ({
      state: 'degraded',
      code: 'helper_launch_failed',
      message: 'Apple integration helper could not be launched.',
    }),
    request: async () => {
      throw new Error('Apple integration helper is unavailable.');
    },
    subscribe: () => () => undefined,
    stop: async () => {
      events.push('helper:stop');
    },
  };
}

describe('Apple bridge application lifecycle', () => {
  it('starts the helper after FoundationRuntime construction and before renderer loading', async () => {
    const events: string[] = [];
    const supervisor = fakeSupervisor(events);
    const app = await startApplication(
      {
        appVersion: '1.0.0',
        userDataPath: '/Users/founder/Library/Application Support/Callie',
        appleBridge: APPLE_OPTIONS,
        createWindow: () => {
          events.push('window');
        },
      },
      dependencies(events, supervisor),
    );

    expect(events.slice(0, 6)).toEqual([
      'health-ipc:register',
      'database:open',
      'helper:create',
      'helper:start',
      'apple-ipc:register',
      'window',
    ]);
    await app.shutdown();
  });

  it('opens the core window when helper startup rejects with private diagnostics', async () => {
    const events: string[] = [];
    const supervisor = fakeSupervisor(events, async () => {
      throw new Error('/Users/founder/private raw stderr');
    });

    const app = await startApplication(
      {
        appVersion: '1.0.0',
        userDataPath: '/Users/founder/Library/Application Support/Callie',
        appleBridge: APPLE_OPTIONS,
        createWindow: () => {
          events.push('window');
        },
      },
      dependencies(events, supervisor),
    );

    expect(events).toContain('window');
    await app.shutdown();
  });

  it('unregisters bridge IPC, stops the helper, then closes FoundationRuntime SQLite', async () => {
    const events: string[] = [];
    const supervisor = fakeSupervisor(events);
    const app = await startApplication(
      {
        appVersion: '1.0.0',
        userDataPath: '/Users/founder/Library/Application Support/Callie',
        appleBridge: APPLE_OPTIONS,
        createWindow: () => {
          events.push('window');
        },
      },
      dependencies(events, supervisor),
    );

    await Promise.all([app.shutdown(), app.shutdown()]);

    expect(events.slice(-4)).toEqual([
      'health-ipc:unregister',
      'apple-ipc:unregister',
      'helper:stop',
      'database:close',
    ]);
  });
});

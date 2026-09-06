import { describe, expect, it, vi } from 'vitest';
import { createOutboundCommandService } from '../../src/main/communications/outboundCommandService';
import type { OutboundCommandServiceApi } from '../../src/main/communications/outboundPorts';

vi.mock('electron', () => ({ safeStorage: {}, dialog: {} }));

import { fakeDomainRuntime } from '../fixtures/fakeDomainRuntime';

import type { AppDatabase } from '../../src/main/db/database';
import type { AppleBridgeSupervisorApi } from '../../src/main/appleBridge/appleBridgeSupervisor';
import type { SourcingPoller } from '../../src/main/sourcing/sourcingPoller';
import type { SourcingPollHealth } from '../../src/shared/contracts/sourcingContract';
import {
  startApplication,
  type ApplicationStartupDependencies,
  type ApplicationStartupOptions,
} from '../../src/main/startApplication';

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const APPLE_OPTIONS: NonNullable<ApplicationStartupOptions['appleBridge']> = {
  platform: 'darwin',
  isPackaged: true,
  resourcesPath: '/Applications/Callie.app/Contents/Resources',
  environment: {},
  stagingRoot: '/Users/founder/Library/Application Support/Callie/apple-bridge-staging',
  expectedIdentifier: 'com.callie.foundersales.applebridge',
  parentExecutablePath: '/Applications/Callie.app/Contents/MacOS/Callie',
};

function explicitIdleSourcingPoller(): SourcingPoller {
  return {
    getHealth: (): SourcingPollHealth => ({
      status: 'healthy', reasons: [], lastSuccessAgeMs: null,
      state: {
        state: 'idle', pollId: null, startedAt: null, lastCompletedAt: null,
        consecutiveFailures: 0, lastFailureAt: null, lastFailureCode: null, backlogCount: null,
      },
    }),
    stop: (): void => undefined,
    idle: async (): Promise<void> => undefined,
  } as unknown as SourcingPoller;
}

function dependencies(
  events: string[],
  supervisor: AppleBridgeSupervisorApi,
): ApplicationStartupDependencies {
  const database = { path: '/tmp/callie.sqlite3' } as AppDatabase;
  return {
    createBackupService: () => ({ start: async () => undefined, shutdown: async () => undefined,
      listAvailableBackups: async () => [], createBackup: async () => { throw new Error('unexpected backup'); } }),
    createRecoveryService: () => ({ status: vi.fn(), beginSetup: vi.fn(), saveSetupMaterial: vi.fn(),
      completeSetup: vi.fn(), selectAndRunRestoreDrill: vi.fn(), shutdown: async () => undefined }),
    createOutboundCommandService: (input) => {
      const service = createOutboundCommandService(input);
      return { ...service, dispose: () => { events.push('outbound:dispose'); service.dispose(); } };
    },
    loadWorkspaceKey: async () => ({ bytes: Buffer.alloc(32, 0x2a), version: 1 }),
    prepareEncryptedDatabase: async () => undefined,
    openDatabase: () => {
      events.push('database:open');
      return database;
    },
    migrateToLatest: async () => {
      events.push('database:migrate');
      return {
        fromVersion: 0,
        toVersion: 2,
        appliedMigrationIds: ['0001Foundation', '0002DomainFoundation'],
      };
    },
    createDomainRuntime: () => fakeDomainRuntime({
      onInitialize: () => events.push('database:recover'),
    }),
    createHealthService: () => {
      events.push('database:health');
      return {
        getHealth: async () => ({ state: 'ok' }),
      };
    },
    createSourcingPoller: explicitIdleSourcingPoller,
    registerApplicationIpc: () => {
      events.push('health-ipc:register');
      return () => events.push('health-ipc:unregister');
    },
    createAppleBridgeSupervisor: () => {
      events.push('helper:create');
      return supervisor;
    },
    registerAppleSpikeIpc: (service) => {
      events.push(`apple-ipc:register:${service.getStatus().enabled}`);
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
  it('makes Foundation ready before starting the helper and loading the renderer', async () => {
    const events: string[] = [];
    const supervisor = fakeSupervisor(events);
    const app = await startApplication(
      {
        appVersion: '1.0.0',
        userDataPath: '/Users/founder/Library/Application Support/Callie',
        appleBridge: APPLE_OPTIONS,
        appleSpikeEnabled: false,
        createWindow: () => {
          events.push('window');
        },
      },
      dependencies(events, supervisor),
    );

    expect(events.slice(0, 9)).toEqual([
      'database:open',
      'database:migrate',
      'database:recover',
      'database:health',
      'health-ipc:register',
      'helper:create',
      'helper:start',
      'apple-ipc:register:false',
      'window',
    ]);
    await app.shutdown();
  });

  it('opens the core window without awaiting a pending optional helper', async () => {
    const events: string[] = [];
    const helperStart = deferred<void>();
    const helperStarted = deferred<void>();
    const supervisor = fakeSupervisor(events, () => {
      helperStarted.resolve();
      return helperStart.promise;
    });

    const startup = startApplication(
      {
        appVersion: '1.0.0',
        userDataPath: '/Users/founder/Library/Application Support/Callie',
        appleBridge: APPLE_OPTIONS,
        appleSpikeEnabled: false,
        createWindow: () => {
          events.push('window');
        },
      },
      dependencies(events, supervisor),
    );

    await helperStarted.promise;
    expect(events).toContain('helper:start');
    expect(events).toContain('window');
    const app = await startup;
    await app.shutdown();
    helperStart.resolve();
  });

  it('consumes a late helper-start rejection without closing the core window', async () => {
    const events: string[] = [];
    const helperStart = deferred<void>();
    const supervisor = fakeSupervisor(events, () => helperStart.promise);
    const app = await startApplication(
      {
        appVersion: '1.0.0',
        userDataPath: '/Users/founder/Library/Application Support/Callie',
        appleBridge: APPLE_OPTIONS,
        appleSpikeEnabled: false,
        createWindow: () => {
          events.push('window');
        },
      },
      dependencies(events, supervisor),
    );

    helperStart.reject(
      new Error('/Users/founder/private +15555550100 raw stderr'),
    );
    await Promise.resolve();
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
        appleSpikeEnabled: false,
        createWindow: () => {
          events.push('window');
        },
      },
      dependencies(events, supervisor),
    );

    await Promise.all([app.shutdown(), app.shutdown()]);

    expect(events.slice(-5)).toEqual([
      'outbound:dispose',
      'health-ipc:unregister',
      'apple-ipc:unregister',
      'helper:stop',
      'database:close',
    ]);
  });

  it('aggregates every cleanup failure while preserving unregister, helper, database order', async () => {
    const events: string[] = [];
    const healthUnregisterError = new Error('health unregister failed');
    const appleUnregisterError = new Error('apple unregister failed');
    const helperStopError = new Error('helper stop failed');
    const databaseCloseError = new Error('database close failed');
    const supervisor = fakeSupervisor(events);
    supervisor.stop = async () => {
      events.push('helper:stop');
      throw helperStopError;
    };
    const startupDependencies = dependencies(events, supervisor);
    startupDependencies.registerApplicationIpc = () => () => {
      events.push('health-ipc:unregister');
      throw healthUnregisterError;
    };
    startupDependencies.registerAppleSpikeIpc = () => () => {
      events.push('apple-ipc:unregister');
      throw appleUnregisterError;
    };
    startupDependencies.closeDatabase = () => {
      events.push('database:close');
      throw databaseCloseError;
    };
    const app = await startApplication(
      {
        appVersion: '1.0.0',
        userDataPath: '/Users/founder/Library/Application Support/Callie',
        appleBridge: APPLE_OPTIONS,
        appleSpikeEnabled: false,
        createWindow: () => {
          events.push('window');
        },
      },
      startupDependencies,
    );

    const cleanupError = await app.shutdown().catch((error: unknown) => error);

    expect(cleanupError).toBeInstanceOf(AggregateError);
    expect((cleanupError as AggregateError).errors).toEqual([
      healthUnregisterError,
      appleUnregisterError,
      helperStopError,
      databaseCloseError,
    ]);
    expect(events.slice(-5)).toEqual([
      'outbound:dispose',
      'health-ipc:unregister',
      'apple-ipc:unregister',
      'helper:stop',
      'database:close',
    ]);
  });

  it('optional helper failure never enables Phone and spike-registration failure uses the common outbound close', async () => {
    const events: string[] = []; const helperStart = deferred<void>();
    const startupDependencies = dependencies(events, fakeSupervisor(events, () => helperStart.promise));
    let service!: OutboundCommandServiceApi;
    startupDependencies.createOutboundCommandService = (input) => { service = createOutboundCommandService(input); return service; };
    const app = await startApplication({ appVersion: '1', userDataPath: '/fixture/helper-failure', appleBridge: APPLE_OPTIONS,
      createWindow: () => { events.push('window'); } }, startupDependencies);
    helperStart.reject(new Error('optional helper failed')); await Promise.resolve();
    expect((await service.getCapabilities()).phoneHandoff.reasonCode).toBe('inbound_safety_unwired');
    await app.shutdown();
    expect((await service.getCapabilities()).phoneHandoff.reasonCode).toBe('workspace_inactive');
    const failure = new Error('spike registration');
    const second = dependencies(events, fakeSupervisor(events));
    second.registerAppleSpikeIpc = () => { throw failure; };
    await expect(startApplication({ appVersion: '1', userDataPath: '/fixture/spike-failure', appleBridge: APPLE_OPTIONS,
      createWindow: () => { throw new Error('window must not open'); } }, second)).rejects.toBe(failure);
    expect(events.slice(-4)).toEqual(['outbound:dispose', 'health-ipc:unregister', 'helper:stop', 'database:close']);
  });
});

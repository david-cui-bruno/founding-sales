import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { prepareEncryptedDatabase } from '../../src/main/db/plaintextDatabaseUpgrade';
import { DomainRuntime } from '../../src/main/domain/domainRuntime';
import type { FounderSalesDomain } from '../../src/main/domain/founderSalesDomain';
import { SystemClock } from '../../src/main/domain/support/clock';
import { UuidGenerator } from '../../src/main/domain/support/idGenerator';
import { FoundationRuntime } from '../../src/main/foundation/foundationRuntime';
import { registerFridayIpc } from '../../src/main/friday/registerFridayIpc';
import { HealthService } from '../../src/main/health/healthService';
import { registerHealthIpc } from '../../src/main/health/registerHealthIpc';
import { createFridayProvider } from '../../src/main/ipc/registerApplicationIpc';
import { SourcingPoller } from '../../src/main/sourcing/sourcingPoller';
import { createLocalWorkspaceProvider } from '../../src/main/workspace/localWorkspaceProvider';
import { registerLocalWorkspaceIpc } from '../../src/main/workspace/registerLocalWorkspaceIpc';
import { createCallieApi } from '../../src/preload/createCallieApi';
import type { RegisteredIpcHandler } from './registeredIpcHandler';
import { createTempDatabase, createTestWorkspaceKey } from './tempDatabase';

export const CONTINUITY_NOW = '2026-09-10T15:00:00.000Z';
export const CONTINUITY_URL = 'callie://app/index.html';
export const CONTINUITY_READ_CHANNELS = [
  'health:get', 'local-workspace:get', 'local-workspace:get-commitments', 'friday:get',
] as const;
export const CONTINUITY_REGISTERED_CHANNELS = [
  'health:get',
  'local-workspace:get', 'local-workspace:get-commitments', 'local-workspace:transition',
  'local-workspace:review-company', 'local-workspace:create-company', 'local-workspace:company-create-status',
  'friday:get', 'friday:drilldown', 'friday:create-job', 'friday:fill-job', 'friday:cancel-job',
] as const;

type Invocation = Readonly<{
  channel: string; args: readonly unknown[]; senderUrl: string;
  handlerStarted: boolean; outcome: 'pending' | 'resolved' | 'rejected';
}>;
export type ContinuityCleanup = Readonly<{
  databaseClosed: boolean; keysZeroed: boolean; directoryRemoved: boolean;
  registrationsRemaining: number; pendingInvocations: number;
  cleanupRuns: number; runtimeShutdowns: number; domainShutdowns: number; databaseCloses: number;
  pollerStops: number; pollerIdleWaits: number;
}>;

/** Stage0 only: one genuine runtime, four readonly public channels, no seeds,
 * UI, writes, holds, polling, schedules or external providers. The caller's
 * Electron registration map is the only replacement for the IPC transport.
 */
export async function createContinuityDomainFixture(handlers: Map<string, RegisteredIpcHandler>) {
  assert.equal(handlers.size, 0, 'Continuity fixture requires an empty owned transport map');
  const temp = createTempDatabase();
  const directory = dirname(dirname(temp.path));
  const keys: ReturnType<typeof createTestWorkspaceKey>[] = [];
  const counts = {
    keyLoads: 0, preparations: 0, databaseOpens: 0, migrations: 0,
    domainConstructions: 0, domainBootstraps: 0, healthConstructions: 0,
    healthReads: 0, domainEntries: 0, databaseEntries: 0, evidenceReads: 0,
    databaseCloses: 0, domainShutdowns: 0, runtimeShutdowns: 0,
    credentialLoads: 0, inboxCreations: 0, pollSchedules: 0,
    pollerStops: 0, pollerIdleWaits: 0, cleanupRuns: 0,
  };
  let database: AppDatabase | undefined;
  let disposed = false;
  let disposal: Promise<ContinuityCleanup> | undefined;
  const unregisters: (() => void)[] = [];
  const flights = new Set<Promise<unknown>>();
  const trace: Invocation[] = [];
  const runtime = new FoundationRuntime({
    appVersion: 'continuity-stage0', databasePath: temp.path, databaseExists: false,
    backupDirectory: `${temp.path}.backups`, keyEnvelopePath: `${temp.path}.envelope`,
  }, {
    loadWorkspaceKey: async () => {
      counts.keyLoads++;
      const key = createTestWorkspaceKey();
      keys.push(key);
      return key;
    },
    prepareEncryptedDatabase: async (path, key) => {
      counts.preparations++;
      await prepareEncryptedDatabase(path, key);
    },
    openDatabase: (options) => {
      counts.databaseOpens++;
      database = openDatabase(options);
      return database;
    },
    migrateToLatest: async (db, options) => {
      counts.migrations++;
      return migrateToLatest(db, options);
    },
    createDomainRuntime: (db) => {
      counts.domainConstructions++;
      const domain = new DomainRuntime({ database: db, clock: new SystemClock(), ids: new UuidGenerator() });
      const initialize = domain.initialize.bind(domain);
      domain.initialize = () => { counts.domainBootstraps++; return initialize(); };
      const shutdown = domain.shutdown.bind(domain);
      domain.shutdown = () => { counts.domainShutdowns++; shutdown(); };
      return domain;
    },
    createHealthService: (options) => {
      counts.healthConstructions++;
      return new HealthService(options);
    },
    closeDatabase: (db) => { counts.databaseCloses++; closeDatabase(db); },
  });
  // Instrument only callbacks actually admitted by the real runtime. This is
  // not productionDomainGate and never invokes a facade outside the real gate.
  const observed = {
    withDomain: <T>(operation: (domain: FounderSalesDomain) => T | Promise<T>): Promise<T> =>
      runtime.withDomain(domain => { counts.domainEntries++; return operation(domain); }),
    withDatabase: <T>(operation: (db: AppDatabase) => T | Promise<T>): Promise<T> =>
      runtime.withDatabase(db => { counts.databaseEntries++; return operation(db); }),
    getHealth: () => { counts.healthReads++; return runtime.getHealth(); },
  };
  const poller = new SourcingPoller({
    domainGate: observed,
    clock: new SystemClock(),
    loadCredentials: async () => {
      counts.credentialLoads++;
      return { credentials: null, source: 'none' };
    },
    createInboxClient: async () => {
      counts.inboxCreations++;
      throw new Error('Stage0 does not create an inbox client');
    },
    watchdogTimer: { schedule: () => {
      counts.pollSchedules++;
      throw new Error('Stage0 does not schedule a poller');
    } },
  });
  // Constructor/getHealth are observational. Never call start/pollNow/retry.
  runtime.setSourcingHealthProvider(() => poller.getHealth());

  const dispose = (): Promise<ContinuityCleanup> => {
    if (disposal) return disposal;
    disposed = true;
    counts.cleanupRuns++;
    disposal = (async () => {
      const errors: unknown[] = [];
      try { counts.pollerStops++; poller.stop(); } catch (error) { errors.push(error); }
      try { counts.pollerIdleWaits++; await poller.idle(); } catch (error) { errors.push(error); }
      await Promise.allSettled([...flights]);
      for (const unregister of unregisters.splice(0).reverse()) {
        try { unregister(); } catch (error) { errors.push(error); }
      }
      if (handlers.size !== 0) {
        errors.push(new Error('Continuity registrar cleanup left handlers'));
        handlers.clear(); // Exclusively owned map; report the defect, do not hide it.
      }
      try { counts.runtimeShutdowns++; await runtime.shutdown(); } catch (error) { errors.push(error); }
      const keysZeroed = keys.length > 0 && keys.every(key => key.bytes.every(byte => byte === 0));
      // Observe runtime wiping first. Defensive wipe is not counted as its success.
      for (const key of keys) key.bytes.fill(0);
      try { temp.cleanup(); } catch (error) { errors.push(error); }
      const evidence = Object.freeze({
        databaseClosed: database === undefined || !database.raw.open,
        keysZeroed, directoryRemoved: !existsSync(directory),
        registrationsRemaining: handlers.size, pendingInvocations: flights.size,
        cleanupRuns: counts.cleanupRuns, runtimeShutdowns: counts.runtimeShutdowns,
        domainShutdowns: counts.domainShutdowns, databaseCloses: counts.databaseCloses,
        pollerStops: counts.pollerStops, pollerIdleWaits: counts.pollerIdleWaits,
      });
      if (errors.length) throw new AggregateError(errors, 'Continuity fixture cleanup failed');
      return evidence;
    })();
    return disposal;
  };

  try {
    await runtime.initialize();
    const trusted = (url: string) => url === CONTINUITY_URL;
    unregisters.push(registerHealthIpc(observed, trusted));
    unregisters.push(registerLocalWorkspaceIpc(createLocalWorkspaceProvider(observed), trusted));
    unregisters.push(registerFridayIpc(createFridayProvider(observed), trusted));
    assert.deepEqual([...handlers.keys()].sort(), [...CONTINUITY_REGISTERED_CHANNELS].sort());

    const invokeFrom = (senderUrl: string, channel: string, ...args: unknown[]): Promise<unknown> => {
      const index = trace.length;
      const entry: Invocation = Object.freeze({ channel, senderUrl, args: structuredClone(args), handlerStarted: false, outcome: 'pending' });
      trace.push(entry);
      const flight = (async () => {
        try {
          if (disposed) throw new Error('Continuity fixture is disposed');
          if (!(CONTINUITY_READ_CHANNELS as readonly string[]).includes(channel)) {
            throw new Error('Stage0 only admits its four readonly channels');
          }
          const handler = handlers.get(channel);
          if (!handler) throw new Error(`Missing continuity handler: ${channel}`);
          trace[index] = Object.freeze({ ...entry, handlerStarted: true });
          const result = await handler({ senderFrame: { url: senderUrl } }, ...args);
          trace[index] = Object.freeze({ ...trace[index]!, outcome: 'resolved' });
          return result;
        } catch (error) {
          trace[index] = Object.freeze({ ...trace[index]!, outcome: 'rejected' });
          throw error;
        }
      })();
      flights.add(flight);
      void flight.finally(() => flights.delete(flight)).catch((): undefined => undefined);
      return flight;
    };
    const api = createCallieApi({ invoke: (channel, ...args) => invokeFrom(CONTINUITY_URL, channel, ...args) });
    const evidence = async () => {
      if (disposed) throw new Error('Continuity fixture is disposed');
      counts.evidenceReads++;
      return runtime.withDatabase(db => {
        const changes = db.raw.prepare<[], { count: number }>('SELECT total_changes() AS count').get();
        assert.ok(changes);
        // Fixed empty identities only. No arbitrary SQL or native handle escapes.
        return Object.freeze({
          changes: changes.count,
          accounts: db.raw.prepare('SELECT id FROM pm_accounts ORDER BY id').all(),
          accountCommands: db.raw.prepare('SELECT command_id FROM pm_account_commands ORDER BY command_id').all(),
          jobs: db.raw.prepare('SELECT id FROM jobs ORDER BY id').all(),
          workflowStates: db.raw.prepare('SELECT mode FROM workspace_workflow_state').all(),
          keysZeroed: keys.length === 1 && keys[0]!.bytes.every(byte => byte === 0),
        });
      });
    };
    return Object.freeze({ api, invokeFrom, evidence, counts: () => Object.freeze({ ...counts }),
      trace: () => [...trace], dispose });
  } catch (error) {
    try { await dispose(); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Continuity construction and cleanup failed');
    }
    throw error;
  }
}

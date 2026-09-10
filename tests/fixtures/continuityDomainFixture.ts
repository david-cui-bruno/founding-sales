import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as realTimeout, clearTimeout as clearRealTimeout } from 'node:timers';
import { registerDailyIpc } from '../../src/main/today/registerDailyIpc';
import { registerLeadsIpc } from '../../src/main/leads/registerLeadsIpc';
import { registerLeadDetailIpc } from '../../src/main/leads/registerLeadDetailIpc';
import { registerReviewIpc } from '../../src/main/review/registerReviewIpc';
import { createDailyProvider, createLeadsProvider, createLeadDetailProvider, createReviewProvider } from '../../src/main/ipc/registerApplicationIpc';
import { localDelegationStatusSchema } from '../../src/shared/contracts/ownerCommandContract';
import { localCompanyCreateRequestSchema, localCompanyCreateResultSchema, type LocalCompanyCreateRequest } from '../../src/shared/contracts/localCompanyIntakeContract';

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

// Capture real watchdog functions before any case installs renderer fake timers.
const deliveryTimeout = realTimeout;
const clearDeliveryTimeout = clearRealTimeout;

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

export const CONTINUITY_UI_CHANNELS = [...CONTINUITY_READ_CHANNELS, 'daily:get', 'leads:list', 'review:list',
  'local-workspace:review-company', 'local-workspace:create-company', 'local-workspace:company-create-status',
  'outreach:delegation-status', 'lead-detail:outbound-capabilities'] as const;
export const CONTINUITY_UI_REGISTERED_CHANNELS = [...CONTINUITY_REGISTERED_CHANNELS, 'daily:get',
  'leads:list', 'leads:update-field', 'leads:bulk-update', 'review:list', 'review:resolve',
  'lead-detail:get', 'lead-detail:begin-outbound', 'lead-detail:outbound-capabilities',
  'lead-detail:confirm-transition', 'lead-detail:dismiss', 'lead-detail:cloud-score-override',
  'lead-detail:find-contact-info'] as const;

type Invocation = Readonly<{
  channel: string; args: readonly unknown[]; senderUrl: string;
  result?: unknown; synthetic?: boolean; handlerStarted: boolean; outcome: 'pending' | 'resolved' | 'rejected';
}>;
export type ContinuityCleanup = Readonly<{
  databaseClosed: boolean; keysZeroed: boolean; directoryRemoved: boolean;
  registrationsRemaining: number; pendingInvocations: number;
  cleanupRuns: number; runtimeShutdowns: number; domainShutdowns: number; databaseCloses: number;
  pollerStops: number; pollerIdleWaits: number;
}>;

/** Default Stage0: four readonly channels. Explicit company-ui mode adds only
 * local company commands, real incidental reads and a finite delivery hold. The caller's
 * Electron registration map is the only replacement for the IPC transport.
 */
export async function createContinuityDomainFixture(handlers: Map<string, RegisteredIpcHandler>, mode: 'construction' | 'company-ui' = 'construction') {
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
  const readFlights = new Set<Promise<unknown>>();
  type Arrival = { request: LocalCompanyCreateRequest; result: ReturnType<typeof localCompanyCreateResultSchema.parse> };
  let delivery: ReturnType<typeof armCompanyDelivery> | undefined;
  let armedOnce = false;
  function armCompanyDelivery() {
    assert.equal(mode, 'company-ui');
    assert.equal(armedOnce, false, 'Only one company delivery hold per fixture');
    armedOnce = true;
    let arrive!: (value: Arrival | null) => void;
    const arrived = new Promise<Arrival | null>(resolve => { arrive = resolve; });
    let finish!: (error: Error | null) => void;
    const decision = new Promise<Error | null>(resolve => { finish = resolve; });
    let settled = false;
    let claimed = false;
    const settle = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearDeliveryTimeout(timer);
      arrive(null); // Settles even an armed-but-never-invoked waiter.
      finish(error);
    };
    const timer = deliveryTimeout(() => settle(new Error('Company delivery hold deadline')), 5_000);
    const control = {
      arrived,
      release: () => settle(null),
      reject: () => settle(new Error('Committed company delivery rejected')),
      cancel: () => settle(new Error('Company delivery disposed')),
      claim: () => { if (claimed || settled) return false; claimed = true; return true; },
      hold: async (request: unknown, raw: unknown) => {
        const record = { request: localCompanyCreateRequestSchema.parse(request), result: localCompanyCreateResultSchema.parse(raw) };
        arrive(structuredClone(record));
        const error = await decision;
        if (error) throw error;
        return raw;
      },
    };
    delivery = control;
    return control;
  }
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
      delivery?.cancel(); // Cancel/release delivery BEFORE draining invokes.
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
    if (mode === 'company-ui') {
      unregisters.push(registerDailyIpc(createDailyProvider(observed), trusted));
      unregisters.push(registerLeadsIpc(createLeadsProvider(observed), trusted));
      unregisters.push(registerLeadDetailIpc(createLeadDetailProvider(observed), trusted));
      unregisters.push(registerReviewIpc(createReviewProvider(observed), trusted));
    }
    assert.deepEqual([...handlers.keys()].sort(), [...(mode === 'company-ui' ? CONTINUITY_UI_REGISTERED_CHANNELS : CONTINUITY_REGISTERED_CHANNELS)].sort());

    const invokeFrom = (senderUrl: string, channel: string, ...args: unknown[]): Promise<unknown> => {
      const index = trace.length;
      const entry: Invocation = Object.freeze({ channel, senderUrl, args: structuredClone(args), handlerStarted: false, outcome: 'pending' });
      trace.push(entry);
      const flight = (async () => {
        try {
          if (disposed) throw new Error('Continuity fixture is disposed');
          if (!((mode === 'company-ui' ? CONTINUITY_UI_CHANNELS : CONTINUITY_READ_CHANNELS) as readonly string[]).includes(channel)) {
            throw new Error('Stage0 only admits its four readonly channels');
          }
          // Explicit synthetic UNCONFIGURED worker transport only. No registrar,
          // credential access, worker authority, grant, pairing or readiness claim.
          if (mode === 'company-ui' && channel === 'outreach:delegation-status') {
            assert.equal(senderUrl, CONTINUITY_URL); assert.equal(args.length, 0);
            const result = localDelegationStatusSchema.parse({ state: 'unconfigured', workspaceId: null, endpoint: null, configuration: null });
            trace[index] = Object.freeze({ ...entry, synthetic: true, result, outcome: 'resolved' });
            return result;
          }
          const handler = handlers.get(channel);
          if (!handler) throw new Error(`Missing continuity handler: ${channel}`);
          trace[index] = Object.freeze({ ...entry, handlerStarted: true });
          const hold = channel === 'local-workspace:create-company' && delivery?.claim() ? delivery : undefined;
          const result = await handler({ senderFrame: { url: senderUrl } }, ...args);
          trace[index] = Object.freeze({ ...trace[index]!, result: structuredClone(result) });
          const delivered = hold ? await hold.hold(args[0], result) : result;
          trace[index] = Object.freeze({ ...trace[index]!, outcome: 'resolved' });
          return delivered;
        } catch (error) {
          trace[index] = Object.freeze({ ...trace[index]!, outcome: 'rejected' });
          throw error;
        }
      })();
      flights.add(flight);
      if (channel !== 'local-workspace:create-company') {
        readFlights.add(flight);
        void flight.finally(() => readFlights.delete(flight)).catch((): undefined => undefined);
      }
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
    const companyEvidence = (commandId: string) => {
      assert.equal(mode, 'company-ui');
      if (disposed) throw new Error('Continuity fixture is disposed');
      return runtime.withDatabase(db => ({
        // Exact independent receipt/account join, never an exposed SQL executor.
        joined: db.raw.prepare<[string], { command_id: string; account_id: string; fingerprint: string; result_json: string; account_version: number; name: string; domain: string | null; version: number }>(
          `SELECT c.command_id,c.account_id,c.fingerprint,c.result_json,c.account_version,a.name,a.domain,a.version
           FROM pm_account_commands c JOIN pm_accounts a ON a.id=c.account_id WHERE c.command_id=?`).get(commandId),
        accounts: db.raw.prepare('SELECT id,name,domain,version FROM pm_accounts ORDER BY id').all(),
        commands: db.raw.prepare('SELECT command_id,account_id FROM pm_account_commands ORDER BY command_id').all(),
        jobs: db.raw.prepare('SELECT id FROM jobs ORDER BY id').all(),
      }));
    };
    return Object.freeze({ api, invokeFrom, evidence, companyEvidence, armCompanyDelivery,
      cancelDelivery: () => delivery?.cancel(),
      drainInvocations: () => Promise.allSettled([...flights]),
      drainReads: () => Promise.allSettled([...readFlights]), counts: () => Object.freeze({ ...counts }),
      trace: () => [...trace], dispose });
  } catch (error) {
    try { await dispose(); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Continuity construction and cleanup failed');
    }
    throw error;
  }
}

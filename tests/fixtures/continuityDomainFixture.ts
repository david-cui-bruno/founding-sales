import { insertPerson } from './domainRows';
import type { SafeLogFields } from '../../src/main/logging/safeLogger';
import assert from 'node:assert/strict';
import { createDelegationRuntime } from '../../src/main/delegation/delegationRuntime';
import { registerOutreachIpc } from '../../src/main/ipc/registerOutreachIpc';
import { registerDiscoveryIpc } from '../../src/main/discovery/registerDiscoveryIpc';
import { createDiscoveryProvider } from '../../src/main/discovery/discoveryProvider';
import { dailySnapshotSchema, type DailySnapshot } from '../../src/shared/contracts/dailyContract';
import { localCommitmentsSnapshotSchema } from '../../src/shared/contracts/localWorkspaceContract';
import { randomUUID } from 'node:crypto';
import { auditDomainInvariants } from '../../src/main/domain/lifecycle/invariantAudit';
import type { DomainServices } from '../../src/main/domain/createDomainServices';
import type { SalesCycle } from '../../src/main/domain/lifecycle/lifecycleTypes';
import { BUILTIN_CADENCES } from '../../src/main/domain/cadence/builtinCadences';
import { DISCOVERY_NOW, seedDiscoveryOwner } from './discoveryDatabase';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as realTimeout, clearTimeout as clearRealTimeout } from 'node:timers';
import { registerDailyIpc } from '../../src/main/today/registerDailyIpc';
import { registerLeadsIpc } from '../../src/main/leads/registerLeadsIpc';
import { registerLeadDetailIpc } from '../../src/main/leads/registerLeadDetailIpc';
import { registerReviewIpc } from '../../src/main/review/registerReviewIpc';
import { createDailyProvider, createLeadsProvider, createLeadDetailProvider, createReviewProvider, createFridayProvider } from '../../src/main/ipc/registerApplicationIpc';
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
import { SourcingPoller } from '../../src/main/sourcing/sourcingPoller';
import { createLocalWorkspaceProvider } from '../../src/main/workspace/localWorkspaceProvider';
import { registerLocalWorkspaceIpc } from '../../src/main/workspace/registerLocalWorkspaceIpc';
import { createCallieApi } from '../../src/preload/createCallieApi';
import type { RegisteredIpcHandler } from './registeredIpcHandler';
import { createTempDatabase, createTestWorkspaceKey } from './tempDatabase';

// Capture real watchdog functions before any case installs renderer fake timers.
const deliveryTimeout = realTimeout;
const clearDeliveryTimeout = clearRealTimeout;

export const RETAINED_T = '2026-08-30T12:00:00.000Z';
export const RETAINED_O = '2026-09-06T13:00:00.000Z';
export const RETAINED_DISCOVERY = DISCOVERY_NOW;
type RetainedKind = 'callback' | 'post_stage' | 'onboarding' | 'inbound_response' | 'warm_relationship' | 'founder_resurface';
type RetainedOwner = Readonly<{ kind: RetainedKind; personId: string; prospectId: string; cycleId: string; actionId: string; sourceEventId: string; evidenceIds: readonly string[] }>;

export const FRIDAY_REQUESTED_AT = '2026-09-10T14:30:00.000Z';
export const FRIDAY_OWNER_AT = '2026-09-10T13:00:00.000Z';
export const HEALTH_ORPHAN_ID = 'continuity-health-orphan';
export const HEALTH_POLL_AT = '2026-09-10T15:01:00.000Z';
export const CONTINUITY_NOW = '2026-09-10T15:00:00.000Z';
export const CONTINUITY_URL = 'callie://app/index.html';
export const CONTINUITY_READ_CHANNELS = [
  'health:get', 'local-workspace:get', 'local-workspace:get-commitments', 'friday:get',
] as const;
export const CONTINUITY_REGISTERED_CHANNELS = [
  'local-workspace:admit-company-draft-email', 'local-workspace:admit-company-phone-route', 'local-workspace:open-company-draft', 'local-workspace:get-company-draft', 'local-workspace:save-company-draft', 'local-workspace:prepare-company-draft',
  'health:get',
  'local-workspace:get-company-research-settings', 'local-workspace:update-company-research-settings',
  'local-workspace:get', 'local-workspace:get-company', 'local-workspace:get-commitments', 'local-workspace:transition',
  'local-workspace:review-company', 'local-workspace:create-company', 'local-workspace:company-create-status',
  'local-workspace:research-company', 'local-workspace:company-research-status', 'local-workspace:link-company-person', 'local-workspace:get-call-settings', 'local-workspace:update-call-settings',
  'friday:get', 'friday:drilldown', 'friday:create-job', 'friday:fill-job', 'friday:cancel-job',
] as const;

export const CONTINUITY_UI_CHANNELS = [...CONTINUITY_READ_CHANNELS, 'daily:get', 'leads:list', 'review:list', 'local-workspace:get-company',
  'local-workspace:get-company-research-settings',
  'local-workspace:review-company', 'local-workspace:create-company', 'local-workspace:company-create-status',
  'outreach:delegation-status', 'lead-detail:outbound-capabilities'] as const;
export const CONTINUITY_UI_REGISTERED_CHANNELS = [...CONTINUITY_REGISTERED_CHANNELS, 'daily:get',
  'leads:list', 'leads:update-field', 'leads:bulk-update', 'review:list', 'review:resolve',
  'lead-detail:get', 'lead-detail:begin-outbound', 'lead-detail:outbound-capabilities',
  'lead-detail:confirm-transition', 'lead-detail:dismiss', 'lead-detail:cloud-score-override',
  'lead-detail:find-contact-info'] as const;

export const RETAINED_UI_REGISTERED_CHANNELS = [...CONTINUITY_UI_REGISTERED_CHANNELS,
  'discovery:get', 'discovery:get-brief', 'discovery:begin', 'discovery:override',
  ...['status', 'configure', 'connect-gmail', 'disconnect-gmail', 'open-draft', 'save-draft', 'generate-draft', 'send-draft', 'inspect-local-authority',
    'reply-reconcile', 'reply-edit', 'requested-followup-prepare', 'requested-followup-get', 'requested-followup-edit', 'requested-followup-approve',
    'delegation-begin-phone', 'delegation-get-phone-handoff-state', 'delegation-bootstrap', 'delegation-policy', 'delegation-research', 'delegation-status',
    'google-connection-status', 'google-connection-disclosure', 'google-connection-begin', 'google-connection-revoke',
    'research-setup-status', 'research-setup-approve', 'research-setup-set-state', 'research-setup-retry', 'research-setup-cancel-pending',
    'delegation-configure', 'delegation-submit', 'delegation-sync', 'delegation-get-account-preparation', 'delegation-configure-intake',
    'delegation-refresh-selected-account', 'delegation-selected-account-freshness'].map(name => `outreach:${name}`),
] as const;
const RETAINED_UI_CHANNELS = [...CONTINUITY_READ_CHANNELS, 'daily:get', 'review:list', 'outreach:delegation-status',
  'lead-detail:outbound-capabilities', 'lead-detail:get', 'discovery:get-brief', 'local-workspace:transition'];
export const SYNTHETIC_WORKER_IDS = ['synthetic-worker-alpha', 'synthetic-worker-beta'] as const;

type Invocation = Readonly<{
  channel: string; args: readonly unknown[]; senderUrl: string;
  result?: unknown; actualResult?: unknown; synthetic?: boolean; presentationVariant?: 'retained-complete' | 'retained-partial'; handlerStarted: boolean; outcome: 'pending' | 'resolved' | 'rejected';
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
export async function createContinuityDomainFixture(handlers: Map<string, RegisteredIpcHandler>, mode: 'construction' | 'company-ui' | 'retained-setup' | 'retained-ui' | 'retained-synthetic' | 'health-poll' | 'health-ui' | 'health-blocked' | 'friday-ui' = 'construction') {
  const isFridayUi = mode === 'friday-ui';
  const isCompanyUi = mode === 'company-ui' || mode === 'health-ui';
  const isBlockedUi = mode === 'health-blocked';
  const pollDiagnostics: { level: string; eventCode: string; fields?: SafeLogFields }[] = [];
  let pollAttempted = false;
  let latestHealth: Promise<unknown> | undefined;
  const isRetainedUi = mode === 'retained-ui' || mode === 'retained-synthetic';
  const uiCounters = { network: 0, forbidden: 0, delegationDisposals: 0 };
  let retainedMetadata: 'genuine' | 'complete' | 'partial' = 'genuine';
  let workerPartial = false, rejectDaily = false, dailyRejectionUsed = false;
  type RetainedReadHold = Readonly<{
    arrival: Promise<unknown | null>;
    release: () => void;
    reject: () => void;
    cancel: () => void;
    claim: () => boolean;
    deliver: (value: unknown) => Promise<unknown>;
  }>;
  const readHolds: RetainedReadHold[] = [];
  function holdRetainedRead(): RetainedReadHold {
    assert.equal(mode, 'retained-synthetic'); assert.ok(readHolds.length < 2);
    let arrived!: (value: unknown | null) => void, decide!: (error: Error | null) => void;
    const arrival = new Promise<unknown | null>(resolve => { arrived = resolve; });
    const decision = new Promise<Error | null>(resolve => { decide = resolve; });
    let settled = false, claimed = false;
    const finish = (error: Error | null) => { if (settled) return; settled = true; clearDeliveryTimeout(timer); arrived(null); decide(error); };
    const timer = deliveryTimeout(() => finish(new Error('Retained read hold deadline')), 5_000);
    const control = { arrival, release: () => finish(null), reject: () => finish(new Error('Retained read delivery rejected')),
      cancel: () => finish(new Error('Retained read disposed')), claim: () => { if (claimed || settled) return false; claimed = true; return true; },
      deliver: async (value: unknown) => { arrived(structuredClone(value)); const error = await decision; if (error) throw error; return value; } };
    readHolds.push(control); return control;
  }
  const healthHolds: RetainedReadHold[] = [];
  function holdHealthRead(): RetainedReadHold {
    assert.equal(mode, 'health-ui'); assert.ok(!disposed); assert.ok(healthHolds.length < 2);
    let arrived!: (value: unknown | null) => void, decide!: (error: Error | null) => void;
    const arrival = new Promise<unknown | null>(resolve => { arrived = resolve; });
    const decision = new Promise<Error | null>(resolve => { decide = resolve; });
    let settled = false, claimed = false;
    const finish = (error: Error | null) => { if (settled) return; settled = true; clearDeliveryTimeout(timer); arrived(null); decide(error); };
    const timer = deliveryTimeout(() => finish(new Error('Health delivery watchdog expired')), 5_000);
    const control: RetainedReadHold = { arrival, release: () => finish(null), reject: () => finish(new Error('Health delivery rejected')),
      cancel: () => finish(new Error('Health delivery disposed')), claim: () => { if (claimed || settled) return false; claimed = true; return true; },
      deliver: async value => { arrived(structuredClone(value)); const error = await decision; if (error) throw error; return value; } };
    healthHolds.push(control); return control;
  }
  const fridayMutationHolds: (RetainedReadHold & { channel: string })[] = [];
  let activeFridayMutation: RetainedReadHold | undefined;
  let fridayReportHold: RetainedReadHold | undefined;
  function holdNextFridayMutation(): RetainedReadHold {
    assert.ok(isFridayUi); assert.ok(!disposed); assert.equal(activeFridayMutation, undefined);
    const channel = ['friday:create-job', 'friday:fill-job', 'friday:cancel-job'][fridayMutationHolds.length]; assert.ok(channel);
    let arrived!: (value: unknown | null) => void, decide!: (error: Error | null) => void;
    const arrival = new Promise<unknown | null>(resolve => { arrived = resolve; });
    const decision = new Promise<Error | null>(resolve => { decide = resolve; });
    let settled = false, claimed = false;
    const finish = (error: Error | null) => { if (settled) return; settled = true; clearDeliveryTimeout(timer); activeFridayMutation = undefined; arrived(null); decide(error); };
    const timer = deliveryTimeout(() => finish(new Error('Friday mutation delivery watchdog')), 5_000);
    const control = { channel, arrival, release: () => finish(null), reject: () => finish(new Error('Friday committed delivery rejected')),
      cancel: () => finish(new Error('Friday mutation disposed')), claim: () => { if (claimed || settled) return false; claimed = true; return true; },
      deliver: async (value: unknown) => { arrived(structuredClone(value)); const error = await decision; if (error) throw error; return value; } };
    fridayMutationHolds.push(control); activeFridayMutation = control; return control;
  }
  function holdFridayReport(): RetainedReadHold {
    assert.ok(isFridayUi); assert.ok(!disposed); assert.equal(fridayReportHold, undefined);
    let arrived!: (value: unknown | null) => void, decide!: (error: Error | null) => void;
    const arrival = new Promise<unknown | null>(resolve => { arrived = resolve; });
    const decision = new Promise<Error | null>(resolve => { decide = resolve; });
    let settled = false, claimed = false;
    const finish = (error: Error | null) => { if (settled) return; settled = true; clearDeliveryTimeout(timer); arrived(null); decide(error); };
    const timer = deliveryTimeout(() => finish(new Error('Friday report delivery watchdog')), 5_000);
    const control = { arrival, release: () => finish(null), reject: () => finish(new Error('Friday report delivery rejected')),
      cancel: () => finish(new Error('Friday report disposed')), claim: () => { if (claimed || settled) return false; claimed = true; return true; },
      deliver: async (value: unknown) => { arrived(structuredClone(value)); const error = await decision; if (error) throw error; return value; } };
    fridayReportHold = control; return control;
  }
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
  let capturedRuntime: DomainRuntime | undefined;
  let startupReport: ReturnType<DomainRuntime['initialize']> | undefined;
  let retainedServices: DomainServices | undefined;
  const retainedOwners: RetainedOwner[] = [];
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
      if (isBlockedUi) insertPerson(db.raw, HEALTH_ORPHAN_ID);
      const domain = new DomainRuntime({ database: db, clock: new SystemClock(), ids: new UuidGenerator() });
      capturedRuntime = domain;
      const initialize = domain.initialize.bind(domain);
      domain.initialize = () => { counts.domainBootstraps++; startupReport = initialize(); return startupReport; };
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
  const delegation = isRetainedUi ? createDelegationRuntime({ databaseGate: runtime, pairing: null, clock: new SystemClock(),
    fetch: async () => { uiCounters.network++; throw new Error('Retained UI forbids network'); },
  }) : undefined;
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
      return mode === 'health-poll'
        ? { credentials: { accessKeyId: 'synthetic-access', secretAccessKey: 'synthetic-secret' }, source: 'file' as const }
        : { credentials: null, source: 'none' as const };
    },
    createInboxClient: async () => {
      counts.inboxCreations++;
      throw new Error('Stage0 does not create an inbox client');
    },
    ...(mode === 'health-poll' ? { pollIds: { next: () => 'c140fbf0-5b83-4a50-baa2-8fc06f1028fe' },
      logger: { log: (level: 'debug' | 'info' | 'warn' | 'error', eventCode: string, fields?: SafeLogFields) => { pollDiagnostics.push({ level, eventCode, fields }); } } } : {}),
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
      for (const hold of readHolds) hold.cancel();
      for (const hold of healthHolds) hold.cancel();
      for (const hold of fridayMutationHolds) hold.cancel();
      fridayReportHold?.cancel();
      await Promise.allSettled([...flights]);
      for (const unregister of unregisters.splice(0).reverse()) {
        try { unregister(); } catch (error) { errors.push(error); }
      }
      if (handlers.size !== 0) {
        errors.push(new Error('Continuity registrar cleanup left handlers'));
        handlers.clear(); // Exclusively owned map; report the defect, do not hide it.
      }
      if (delegation) { try { uiCounters.delegationDisposals++; await delegation.dispose(); } catch (error) { errors.push(error); } }
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
    if (isCompanyUi || isRetainedUi || isFridayUi) {
      unregisters.push(registerDailyIpc(createDailyProvider(observed), trusted));
      unregisters.push(registerLeadsIpc(createLeadsProvider(observed), trusted));
      unregisters.push(registerLeadDetailIpc(createLeadDetailProvider(observed), trusted));
      unregisters.push(registerReviewIpc(createReviewProvider(observed), trusted));
    }
    if (delegation) {
      const denied = async (): Promise<never> => { uiCounters.forbidden++; throw new Error('Unrelated outreach forbidden'); };
      unregisters.push(registerOutreachIpc({ delegation, isTrustedRendererUrl: trusted, provider: {
        status: denied, configure: denied, connectGmail: denied, disconnectGmail: denied,
        openDraft: denied, saveDraft: denied, generateDraft: denied, sendDraft: denied, inspectLocalAuthority: denied,
      } }));
      unregisters.push(registerDiscoveryIpc({ isTrustedRendererUrl: trusted, provider: {
        get: () => runtime.withDomain(domain => createDiscoveryProvider(domain).get()),
        getBrief: input => runtime.withDomain(domain => createDiscoveryProvider(domain).getBrief(input)),
        begin: denied, override: denied,
      } }));
    }
    assert.deepEqual([...handlers.keys()].sort(), [...(isRetainedUi ? RETAINED_UI_REGISTERED_CHANNELS : isCompanyUi || isFridayUi ? CONTINUITY_UI_REGISTERED_CHANNELS : CONTINUITY_REGISTERED_CHANNELS)].sort());

    const invokeFrom = (senderUrl: string, channel: string, ...args: unknown[]): Promise<unknown> => {
      const index = trace.length;
      const entry: Invocation = Object.freeze({ channel, senderUrl, args: structuredClone(args), handlerStarted: false, outcome: 'pending' });
      trace.push(entry);
      const flight = (async () => {
        try {
          if (disposed) throw new Error('Continuity fixture is disposed');
          if (!((isRetainedUi ? RETAINED_UI_CHANNELS : isFridayUi ? ['health:get', 'lead-detail:outbound-capabilities', 'review:list', 'friday:get', 'friday:create-job', 'friday:fill-job', 'friday:cancel-job'] : isCompanyUi ? CONTINUITY_UI_CHANNELS : isBlockedUi ? [...CONTINUITY_READ_CHANNELS, 'local-workspace:create-company'] : mode === 'retained-setup' ? [...CONTINUITY_READ_CHANNELS, 'local-workspace:transition'] : CONTINUITY_READ_CHANNELS) as readonly string[]).includes(channel)) {
            if (isRetainedUi || isFridayUi) uiCounters.forbidden++;
            throw new Error('Stage0 only admits its four readonly channels');
          }
          // Explicit synthetic UNCONFIGURED worker transport only. No registrar,
          // credential access, worker authority, grant, pairing or readiness claim.
          if (isCompanyUi && channel === 'outreach:delegation-status') {
            assert.equal(senderUrl, CONTINUITY_URL); assert.equal(args.length, 0);
            const result = localDelegationStatusSchema.parse({ state: 'unconfigured', workspaceId: null, endpoint: null, configuration: null });
            trace[index] = Object.freeze({ ...entry, synthetic: true, result, outcome: 'resolved' });
            return result;
          }
          const handler = handlers.get(channel);
          if (!handler) throw new Error(`Missing continuity handler: ${channel}`);
          trace[index] = Object.freeze({ ...entry, handlerStarted: true });
          const hold = channel === 'local-workspace:create-company' && delivery?.claim() ? delivery : undefined;
          const retainedHold = channel === 'local-workspace:get-commitments' ? readHolds.find(item => item.claim()) : undefined;
          const healthHold = channel === 'health:get' ? healthHolds.find(item => item.claim()) : undefined;
          const fridayHold = channel === 'friday:get'
            ? fridayReportHold?.claim() ? fridayReportHold : undefined
            : fridayMutationHolds.find(item => item.channel === channel && item.claim());
          const actual = await handler({ senderFrame: { url: senderUrl } }, ...args);
          let result = actual;
          if (mode === 'retained-synthetic' && channel === 'daily:get') {
            const real = dailySnapshotSchema.parse(actual);
            result = dailySnapshotSchema.parse({ ...real, workspaceId: 'synthetic-worker-workspace',
              revision: (workerPartial ? 'b' : 'a').repeat(64),
              freshness: { ...real.freshness, kind: workerPartial ? 'incomplete' : 'local_snapshot' },
              accounts: SYNTHETIC_WORKER_IDS.map((id): DailySnapshot['accounts'][number] => ({ account: { id, name: id, domain: null, version: 1 },
                claims: [], routes: [], portfolio: [], unknowns: [], conflicts: [], fingerprint: 'c'.repeat(64) })),
              calls: { accountIds: [...SYNTHETIC_WORKER_IDS], workloadConflict: false },
              answers: [], meetings: [], campaigns: [], ownerStatus: [], transport: [],
              issues: workerPartial ? [{ code: 'transport_incomplete', count: 1 }] : [],
            });
            trace[index] = Object.freeze({ ...trace[index]!, synthetic: true, actualResult: structuredClone(actual) });
            if (rejectDaily) { rejectDaily = false; throw new Error('Synthetic Daily delivery rejected'); }
          }
          if (mode === 'retained-synthetic' && retainedMetadata !== 'genuine' && channel === 'local-workspace:get-commitments') {
            const real = localCommitmentsSnapshotSchema.parse(actual);
            result = localCommitmentsSnapshotSchema.parse({ ...real, reviewErrorCount: retainedMetadata === 'complete' ? 0 : 1 });
            trace[index] = Object.freeze({ ...trace[index]!, synthetic: true, presentationVariant: retainedMetadata === 'complete' ? 'retained-complete' : 'retained-partial', actualResult: structuredClone(actual) });
          }
          trace[index] = Object.freeze({ ...trace[index]!, result: structuredClone(result) });
          const delivered = hold ? await hold.hold(args[0], result) : retainedHold ? await retainedHold.deliver(result) : healthHold ? await healthHold.deliver(result) : fridayHold ? await fridayHold.deliver(result) : result;
          trace[index] = Object.freeze({ ...trace[index]!, outcome: 'resolved' });
          return delivered;
        } catch (error) {
          trace[index] = Object.freeze({ ...trace[index]!, outcome: 'rejected' });
          throw error;
        }
      })();
      if (channel === 'health:get') latestHealth = flight;
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
    let fridayOwner: RetainedOwner | undefined;
    const seedFridayOwner = async () => {
      assert.ok(isFridayUi); assert.equal(fridayOwner, undefined); assert.equal(new Date().toISOString(), CONTINUITY_NOW);
      return runtime.withDomain(() => {
        assert.ok(capturedRuntime);
        const services = capturedRuntime.getServices();
        const at = FRIDAY_OWNER_AT;
        const source = services.sources.createPersonProspect({ person: { displayName: 'Friday fictional Won owner' }, contacts: [],
          source: { id: randomUUID(), channel: 'referral', observedAt: at, sourceRecord: { fixture: 'friday-owner' },
            referral: { kind: 'unknown' as const, reason: 'not_provided' as const } } });
        const unreviewed = services.lifecycle.createUnreviewedCycle({ personId: source.personId, prospectId: source.prospectId,
          entrySourceEventId: source.sourceEventId, effectiveAt: at });
        const ready = services.lifecycle.reviewToReady({ cycleId: unreviewed.id, expectedCycleVersion: 1, expectedProspectVersion: 1, effectiveAt: at });
        const replyId = randomUUID(), interviewId = randomUUID(), offerId = randomUUID();
        services.unitOfWork.immediate(() => services.events.appendActivity({ id: replyId, personId: ready.personId,
          prospectId: ready.prospectId, salesCycleId: ready.id, kind: 'text', direction: 'inbound', channel: 'text', occurredAt: at, observedOutcome: 'replied', metadata: {} }));
        services.lifecycle.recordQualifyingContact({ cycleId: ready.id, expectedCycleVersion: 2, expectedCurrentActionId: ready.currentNextActionId!, activityId: replyId, effectiveAt: at });
        services.unitOfWork.immediate(() => services.events.appendActivity({ id: interviewId, personId: ready.personId,
          prospectId: ready.prospectId, salesCycleId: ready.id, kind: 'interview', direction: 'outbound', channel: 'phone', occurredAt: at,
          durationSeconds: 240, observedOutcome: 'substantive', metadata: {} }));
        const interviewed = services.lifecycle.confirmInterviewed({ cycleId: ready.id, expectedCycleVersion: 3,
          expectedCurrentActionId: ready.currentNextActionId!, suggestionActivityId: interviewId, effectiveAt: at, confirmedAt: at });
        assert.equal(interviewed.version, 4);
        services.lifecycle.setDesignPartnerFitness({ cycleId: ready.id, expectedCycleVersion: 4, fitness: 5, updatedAt: at });
        const dimension = { value: 'moderate' as const, evidenceActivityIds: [interviewId] };
        services.lifecycle.setCloseReadiness({ cycleId: ready.id, expectedReadinessVersion: 0, assessedAt: at,
          readiness: { version: 1, demonstratedPain: dimension, activeTimeline: dimension, decisionAuthority: dimension,
            willingnessToTryOrPay: dimension, concreteNextStep: dimension } });
        services.unitOfWork.immediate(() => services.events.appendActivity({ id: offerId, personId: ready.personId,
          prospectId: ready.prospectId, salesCycleId: ready.id, kind: 'offer', direction: 'outbound', channel: 'phone', occurredAt: at, observedOutcome: 'price_said', metadata: {} }));
        const offered = services.lifecycle.confirmOffered({ cycleId: ready.id, expectedCycleVersion: 5,
          expectedCurrentActionId: interviewed.currentNextActionId!, suggestionActivityId: offerId, effectiveAt: at, confirmedAt: at });
        const won = services.lifecycle.confirmWon({ cycleId: ready.id, expectedCycleVersion: 6, expectedCurrentActionId: offered.currentNextActionId!,
          effectiveAt: at, confirmedAt: at, terms: { billingModel: 'per_door_monthly', doorsCommitted: 12, unitRateCents: 2500, foundingCustomer: true, effectiveAt: at } });
        assert.equal(won.stage, 'won'); assert.equal(won.version, 7); assert.ok(won.currentNextActionId);
        fridayOwner = Object.freeze({ kind: 'onboarding' as const, personId: source.personId, prospectId: source.prospectId, cycleId: won.id,
          actionId: won.currentNextActionId, sourceEventId: source.sourceEventId, evidenceIds: Object.freeze([replyId, interviewId, offerId]) });
        return fridayOwner;
      });
    };
    const fridayEvidence = () => {
      assert.ok(isFridayUi); const owner = fridayOwner; assert.ok(owner);
      return runtime.withDatabase(db => ({
        changes: db.raw.prepare<[], { count: number }>('SELECT total_changes() AS count').get()!.count,
        audit: auditDomainInvariants({ database: db, asOf: new Date().toISOString() }),
        owner: {
          identity: owner,
          person: db.raw.prepare('SELECT id,display_name FROM persons WHERE id=?').get(owner.personId),
          source: db.raw.prepare('SELECT id,person_id,prospect_id,channel,(SELECT id FROM prospects WHERE original_source_event_id=source_events.id) AS original_prospect_id FROM source_events WHERE id=?').get(owner.sourceEventId),
          prospect: db.raw.prepare('SELECT id,person_id,original_source_event_id,segment FROM prospects WHERE id=?').get(owner.prospectId),
          cycle: db.raw.prepare('SELECT id,person_id,prospect_id,entry_source_event_id,stage,workflow_status,current_next_action_id,version FROM sales_cycles WHERE id=?').get(owner.cycleId),
          activities: db.raw.prepare< [string], { id: string; person_id: string; prospect_id: string; sales_cycle_id: string; kind: string; occurred_at: string } >('SELECT id,person_id,prospect_id,sales_cycle_id,kind,occurred_at FROM activities WHERE sales_cycle_id=? ORDER BY id').all(owner.cycleId),
          stages: db.raw.prepare('SELECT to_stage FROM stage_events WHERE sales_cycle_id=? ORDER BY transition_sequence').all(owner.cycleId),
          terms: db.raw.prepare('SELECT doors_committed,billing_model,unit_rate_cents,projected_mrr_cents FROM won_terms WHERE sales_cycle_id=?').get(owner.cycleId),
        },
        jobs: db.raw.prepare<[], { id: string; type: string; idempotency_key: string; state: string; payload_json: string; result_json: string | null }>(
          "SELECT id,type,idempotency_key,state,payload_json,result_json FROM jobs WHERE type='founder_job_request_v1' ORDER BY id").all(),
      }));
    };
    // Finite, two-phase internal construction only. Never expose services/raw DB.
    const seedRetained = async (phase: 'warm-owners' | 'callback') => {
      assert.ok(mode === 'retained-setup' || isRetainedUi);
      return runtime.withDomain(async domain => {
        assert.ok(capturedRuntime); assert.ok(database);
        const now = new Date().toISOString();
        if (phase === 'warm-owners') {
          assert.equal(now, RETAINED_T); assert.equal(retainedOwners.length, 0);
          assert.equal(retainedServices, undefined);
          retainedServices = capturedRuntime.getServices(); // Exactly the initialized graph.
        } else { assert.equal(now, DISCOVERY_NOW); assert.equal(retainedOwners.length, 5); }
        const services = retainedServices; assert.ok(services);
        const remember = (kind: RetainedKind, cycle: SalesCycle, evidenceIds: string[] = []) => {
          assert.ok(cycle.currentNextActionId);
          const owner = Object.freeze({ kind, personId: cycle.personId, prospectId: cycle.prospectId,
            cycleId: cycle.id, actionId: cycle.currentNextActionId, sourceEventId: cycle.entrySourceEventId,
            evidenceIds: Object.freeze(evidenceIds) });
          retainedOwners.push(owner);
          return owner;
        };
        const warm = (kind: RetainedKind) => {
          const source = services.sources.createPersonProspect({
            person: { displayName: `Retained ${kind} fictional owner` }, contacts: [],
            source: { id: randomUUID(), channel: 'referral', observedAt: RETAINED_T,
              sourceRecord: { fixture: kind }, referral: { kind: 'unknown' as const, reason: 'not_provided' as const } },
          });
          return services.lifecycle.createUnreviewedCycle({ personId: source.personId, prospectId: source.prospectId,
            entrySourceEventId: source.sourceEventId, effectiveAt: RETAINED_T });
        };
        const ready = (cycle: SalesCycle) => services.lifecycle.reviewToReady({ cycleId: cycle.id,
          expectedCycleVersion: 1, expectedProspectVersion: 1, effectiveAt: RETAINED_T });
        const interview = (cycle: SalesCycle) => {
          const replyId = randomUUID(), interviewId = randomUUID();
          services.unitOfWork.immediate(() => services.events.appendActivity({ id: replyId,
            personId: cycle.personId, prospectId: cycle.prospectId, salesCycleId: cycle.id,
            kind: 'text', direction: 'inbound', channel: 'text', occurredAt: RETAINED_T, observedOutcome: 'replied', metadata: {} }));
          services.lifecycle.recordQualifyingContact({ cycleId: cycle.id, expectedCycleVersion: 2,
            expectedCurrentActionId: cycle.currentNextActionId!, activityId: replyId, effectiveAt: RETAINED_T });
          services.unitOfWork.immediate(() => services.events.appendActivity({ id: interviewId,
            personId: cycle.personId, prospectId: cycle.prospectId, salesCycleId: cycle.id,
            kind: 'interview', direction: 'outbound', channel: 'phone', occurredAt: RETAINED_T,
            durationSeconds: 240, observedOutcome: 'substantive', metadata: {} }));
          const result = services.lifecycle.confirmInterviewed({ cycleId: cycle.id, expectedCycleVersion: 3,
            expectedCurrentActionId: cycle.currentNextActionId!, suggestionActivityId: interviewId,
            effectiveAt: RETAINED_T, confirmedAt: RETAINED_T });
          assert.equal(result.version, 4);
          return { cycle: result, replyId, interviewId };
        };
        if (phase === 'warm-owners') {
          // Warm introduction remains genuine unreviewed Contact work. No W->C.
          const introduction = warm('warm_relationship');
          assert.equal(introduction.version, 1); assert.equal(introduction.stage, 'unreviewed');
          assert.equal(introduction.currentNextActionId, `${introduction.id}:review`);
          remember('warm_relationship', introduction);
          const post = interview(ready(warm('post_stage')));
          remember('post_stage', post.cycle, [post.replyId, post.interviewId]);
          const onboarding = interview(ready(warm('onboarding')));
          const cycle = onboarding.cycle;
          services.lifecycle.setDesignPartnerFitness({ cycleId: cycle.id, expectedCycleVersion: 4, fitness: 5, updatedAt: RETAINED_T });
          const dimension = { value: 'moderate' as const, evidenceActivityIds: [onboarding.interviewId] };
          services.lifecycle.setCloseReadiness({ cycleId: cycle.id, expectedReadinessVersion: 0, assessedAt: RETAINED_T,
            readiness: { version: 1, demonstratedPain: dimension, activeTimeline: dimension, decisionAuthority: dimension,
              willingnessToTryOrPay: dimension, concreteNextStep: dimension } });
          const offerId = randomUUID();
          services.unitOfWork.immediate(() => services.events.appendActivity({ id: offerId, personId: cycle.personId,
            prospectId: cycle.prospectId, salesCycleId: cycle.id, kind: 'offer', direction: 'outbound', channel: 'phone',
            occurredAt: RETAINED_T, observedOutcome: 'price_said', metadata: {} }));
          const offered = services.lifecycle.confirmOffered({ cycleId: cycle.id, expectedCycleVersion: 5,
            expectedCurrentActionId: cycle.currentNextActionId!, suggestionActivityId: offerId, effectiveAt: RETAINED_T, confirmedAt: RETAINED_T });
          const won = services.lifecycle.confirmWon({ cycleId: cycle.id, expectedCycleVersion: 6,
            expectedCurrentActionId: offered.currentNextActionId!, effectiveAt: RETAINED_T, confirmedAt: RETAINED_T,
            terms: { billingModel: 'per_door_monthly', doorsCommitted: 12, unitRateCents: 2500, foundingCustomer: true, effectiveAt: RETAINED_T } });
          assert.equal(won.version, 7); remember('onboarding', won, [onboarding.replyId, onboarding.interviewId, offerId]);
          const inbound = ready(warm('inbound_response'));
          services.lifecycle.closeLostNurture({ cycleId: inbound.id, expectedCycleVersion: 2,
            expectedCurrentActionId: inbound.currentNextActionId!, reason: 'bad_timing', qualificationGateReason: null, notes: null,
            effectiveAt: RETAINED_T, manualReactivationDueAt: '2026-10-01T13:00:00.000Z', expectedProspectVersion: null });
          const inboundId = randomUUID();
          services.unitOfWork.immediate(() => services.sourceRepository.append({ id: inboundId, personId: inbound.personId,
            prospectId: inbound.prospectId, channel: 'inbound_demo', observedAt: RETAINED_T, sourceRecord: { message: 'DEMO' } }));
          const builtin = BUILTIN_CADENCES.find(row => row.family === 'cadence_c'); assert.ok(builtin);
          const installed = services.cadences.getById(builtin.id); assert.ok(installed); assert.equal(installed.contentHash, builtin.contentHash);
          const activated = services.lifecycle.reactivateFromInboundResponse({ evidence: { kind: 'source_event', sourceEventId: inboundId, channel: 'inbound_demo' },
            personId: inbound.personId, prospectId: inbound.prospectId, sourceCycleId: inbound.id, newCycleId: randomUUID(), activatedAt: RETAINED_T,
            cadence: { definitionId: installed.id, family: 'cadence_c', version: installed.version, contentHash: installed.contentHash } });
          assert.equal(activated.kind, 'reactivated');
          if (activated.kind !== 'reactivated') throw new Error('Inbound construction did not reactivate');
          remember('inbound_response', activated.cycle, [inboundId]);
          const founder = ready(warm('founder_resurface'));
          domain.snoozePrimaryAction({ salesCycleId: founder.id, resurfaceAt: RETAINED_O });
          remember('founder_resurface', founder);
        } else {
          const callback = seedDiscoveryOwner({ services }, { prefix: 'Continuity retained callback', units: 12 });
          const cycle = services.lifecycle.reviewToReady({ cycleId: callback.salesCycleId, expectedCycleVersion: 1,
            expectedProspectVersion: 1, effectiveAt: DISCOVERY_NOW });
          domain.logCallOutcome({ personId: callback.personId, salesCycleId: callback.salesCycleId,
            outcome: 'spoke', occurredAt: DISCOVERY_NOW, callbackAt: RETAINED_O });
          const activities = database.raw.prepare<[string], { id: string }>('SELECT id FROM activities WHERE sales_cycle_id=? AND callback_at IS NOT NULL').all(cycle.id);
          assert.equal(activities.length, 1);
          remember('callback', cycle, [activities[0]!.id]);
        }
        return Object.freeze([...retainedOwners]);
      });
    };
    const retainedEvidence = () => {
      assert.ok(mode === 'retained-setup' || isRetainedUi); assert.equal(retainedOwners.length, 6);
      return runtime.withDatabase(db => ({
        audit: auditDomainInvariants({ database: db, asOf: new Date().toISOString() }),
        owners: retainedOwners.map(owner => ({ owner,
          action: db.raw.prepare<[string], { id: string; sales_cycle_id: string; action_type: string; channel: string | null; due_at: string; due_source: string; work_intent: string; inbound_sla_kind: string | null; inbound_sla_due_at: string | null; inbound_sla_source_event_id: string | null; status: string }>(
            'SELECT id,sales_cycle_id,action_type,channel,due_at,due_source,work_intent,inbound_sla_kind,inbound_sla_due_at,inbound_sla_source_event_id,inbound_sla_provenance_json,cadence_enrollment_id,(SELECT cadence_definition_id FROM cadence_enrollments WHERE id=next_actions.cadence_enrollment_id) AS cadence_definition_id,cadence_step_id,cadence_component_id,version,timezone,status FROM next_actions WHERE id=?').get(owner.actionId),
          cycle: db.raw.prepare('SELECT id,person_id,prospect_id,entry_source_event_id,current_next_action_id,stage,workflow_status,resurface_at,resurface_reason,version FROM sales_cycles WHERE id=?').get(owner.cycleId),
          prospect: db.raw.prepare('SELECT id,person_id,segment FROM prospects WHERE id=?').get(owner.prospectId),
          source: db.raw.prepare('SELECT id,person_id,prospect_id,channel,(SELECT id FROM prospects WHERE original_source_event_id=source_events.id) AS original_prospect_id FROM source_events WHERE id=?').get(owner.sourceEventId),
          activities: db.raw.prepare('SELECT id,person_id,prospect_id,sales_cycle_id,kind,direction,channel,occurred_at,callback_at FROM activities WHERE sales_cycle_id=? ORDER BY id').all(owner.cycleId),
          stages: db.raw.prepare('SELECT to_stage FROM stage_events WHERE sales_cycle_id=? ORDER BY transition_sequence').all(owner.cycleId),
          terms: db.raw.prepare('SELECT doors_committed,billing_model,unit_rate_cents,projected_mrr_cents FROM won_terms WHERE sales_cycle_id=?').get(owner.cycleId),
          enrollment: db.raw.prepare('SELECT d.family FROM cadence_enrollments e JOIN cadence_definitions d ON d.id=e.cadence_definition_id JOIN next_actions a ON a.cadence_enrollment_id=e.id WHERE a.id=?').get(owner.actionId),
        })),
        pendingIds: db.raw.prepare<[], { id: string }>("SELECT id FROM next_actions WHERE status='pending' ORDER BY id").all().map(row => row.id),
      }));
    };
    return Object.freeze({ api, isRetainedUi, isBlockedUi, isFridayUi, seedFridayOwner, fridayEvidence, holdNextFridayMutation, holdFridayReport, holdRetainedRead, holdHealthRead,
      drainLatestHealth: async () => { assert.equal(mode, 'health-ui'); assert.ok(latestHealth); await latestHealth; },
      failSourcingOnce: async () => { assert.equal(mode, 'health-poll'); assert.equal(pollAttempted, false); assert.equal(new Date().toISOString(), HEALTH_POLL_AT); pollAttempted = true; await poller.pollNow(); },
      pollDiagnostics: () => structuredClone(pollDiagnostics),
      healthEvidence: async () => { assert.ok(mode.startsWith('health-')); assert.ok(startupReport); return runtime.withDatabase(db => ({
        report: structuredClone(startupReport!), reportFrozen: Object.isFrozen(startupReport),
        audit: auditDomainInvariants({ database: db, asOf: new Date().toISOString() }),
      })); },
      uiCounters: () => Object.freeze({ ...uiCounters }),
      partialWorker: () => { assert.equal(mode, 'retained-synthetic'); assert.equal(workerPartial, false); workerPartial = true; },
      completeRetained: () => { assert.equal(mode, 'retained-synthetic'); assert.equal(retainedMetadata, 'genuine'); retainedMetadata = 'complete'; },
      partialRetained: () => { assert.equal(mode, 'retained-synthetic'); assert.equal(retainedMetadata, 'complete'); retainedMetadata = 'partial'; },
      rejectNextDaily: () => { assert.equal(mode, 'retained-synthetic'); assert.equal(dailyRejectionUsed, false); dailyRejectionUsed = true; rejectDaily = true; },
      seedRetained, retainedEvidence, invokeFrom, evidence, companyEvidence, armCompanyDelivery,
      cancelDelivery: () => { delivery?.cancel(); for (const hold of readHolds) hold.cancel();
      for (const hold of healthHolds) hold.cancel();
      for (const hold of fridayMutationHolds) hold.cancel();
      fridayReportHold?.cancel(); },
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

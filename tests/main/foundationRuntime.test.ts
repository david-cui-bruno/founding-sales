import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fakeDomainRuntime } from '../fixtures/fakeDomainRuntime';

import { openDatabase, closeDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { DomainRuntime } from '../../src/main/domain/domainRuntime';
import { createDomainServices } from '../../src/main/domain/createDomainServices';
import { UuidGenerator } from '../../src/main/domain/support/idGenerator';
import { startApplication, type ApplicationStartupDependencies, type ApplicationStartupOptions } from '../../src/main/startApplication';
import { createOutboundCommandService } from '../../src/main/communications/outboundCommandService';
import type { OutboundCommandServiceApi, OutboundReadinessPort, PhoneHandoffPort } from '../../src/main/communications/outboundPorts';
import type { Capability, HandoffResult, OutboundReceipt, OutboundRequest } from '../../src/shared/contracts/outboundContract';
import { registerApplicationIpc, type FeatureRegistrars } from '../../src/main/ipc/registerApplicationIpc';
import { registerLeadDetailIpc } from '../../src/main/leads/registerLeadDetailIpc';
import { createTempDatabase, createTestWorkspaceKey, type TempDatabase } from '../fixtures/tempDatabase';
import { seedProspect } from '../fixtures/domainRows';
import type { SourcingPoller } from '../../src/main/sourcing/sourcingPoller';
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

describe('encrypted application outbound lifetime (source fixtures, no live Phone or restore)', () => {
  const NOW = '2026-08-31T15:00:00.000Z';
  const held = <T,>() => {
    let resolve!: (value: T) => void; let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  };
  const available: Capability = { state: 'available', reasonCode: null };
  const accepted: HandoffResult = { status: 'handoff_accepted', reasonCode: null };
  const cleanups: (() => Promise<void>)[] = [];
  const temps: TempDatabase[] = [];
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(NOW);
  });
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    expect(ipc.handlers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    vi.restoreAllMocks(); vi.useRealTimers();
    for (const temp of temps.splice(0)) temp.cleanup();
  });

  async function fixture(input: {
    temp?: TempDatabase;
    readiness?: OutboundReadinessPort;
    phone?: PhoneHandoffPort;
    pendingWindow?: boolean;
    productionPorts?: boolean;
  } = {}) {
    const temp = input.temp ?? createTempDatabase();
    if (!input.temp) temps.push(temp);
    const controller = new AbortController();
    const window = held<void>(); const windowEntered = held<void>();
    let runtime!: FoundationRuntime; let service!: OutboundCommandServiceApi;
    let callbacks!: Parameters<NonNullable<ApplicationStartupOptions['registerOutboundLifecycle']>>[0];
    let closed = false; let sqlCalls = 0; let postCloseSql = 0; let closes = 0;
    const listeners = new Set<() => void>();
    const features = new Set<string>();
    const factory = vi.fn<typeof createOutboundCommandService>((options) => {
      service = createOutboundCommandService({ ...options,
        ...(input.productionPorts ? {} : {
          phone: input.phone ?? { inspectCapability: async () => available, dispatch: async () => accepted },
          readiness: input.readiness ?? { getCapability: () => available, check: async () => ({ kind: 'ready' }) },
        }),
      });
      return service;
    });
    const dependencies: ApplicationStartupDependencies = {
      loadWorkspaceKey: async () => createTestWorkspaceKey(),
      prepareEncryptedDatabase: async () => undefined,
      openDatabase: (options) => {
        const database = openDatabase(options);
        const prepare = database.raw.prepare.bind(database.raw);
        vi.spyOn(database.raw, 'prepare').mockImplementation((...args) => {
          sqlCalls += 1; if (closed) postCloseSql += 1;
          return prepare(...args);
        });
        return database;
      },
      migrateToLatest,
      createDomainRuntime: (database) => new DomainRuntime({ database, clock: { now: () => NOW }, ids: new UuidGenerator() }),
      createHealthService: ({ domainStartupReport }) => {
        expect(domainStartupReport.violations).toEqual([]);
        return { getHealth: () => health };
      },
      createOutboundCommandService: factory,
      createBackupService: () => ({ start: async () => undefined, shutdown: async () => undefined,
        listAvailableBackups: async () => [], createBackup: async () => { throw new Error('unexpected backup'); } }),
      createRecoveryService: () => ({ status: vi.fn(), beginSetup: vi.fn(), saveSetupMaterial: vi.fn(),
        completeSetup: vi.fn(), selectAndRunRestoreDrill: vi.fn(), shutdown: async () => undefined }),
      createSourcingPoller: () => ({ getHealth: () => health.sourcing, stop: (): void => undefined,
        idle: async (): Promise<void> => undefined }) as unknown as SourcingPoller,
      createAppleBridgeSupervisor: () => { throw new Error('no helper permitted'); },
      registerApplicationIpc: (bound, trust, _registrars, sourcing, recovery, shell, enrichment, logs, outbound) => {
        runtime = bound;
        expect(outbound).toBe(service);
        expect(factory).toHaveBeenCalledTimes(1);
        expect(listeners.size).toBe(3);
        const names = ['registerHealthIpc', 'registerLeadsIpc', 'registerTodayIpc', 'registerPipelineIpc',
          'registerReviewIpc', 'registerFridayIpc', 'registerImportIpc', 'registerConversationsIpc',
          'registerLearningsIpc', 'registerSourcingIpc', 'registerShellIpc', 'registerRecoveryIpc'];
        const registrars = Object.fromEntries(names.map((name) => [name, () => {
          features.add(name); return () => { features.delete(name); };
        }])) as unknown as Omit<FeatureRegistrars, 'registerLeadDetailIpc'>;
        return registerApplicationIpc(bound, trust, { ...registrars, registerLeadDetailIpc }, sourcing,
          recovery, shell, enrichment, logs, outbound);
      },
      closeDatabase: (database) => { closes += 1; closeDatabase(database); closed = true; },
    };
    const starting = startApplication({ appVersion: '1', userDataPath: dirname(temp.path), signal: controller.signal,
      isTrustedRendererUrl: (url) => url === 'callie://app/index.html',
      registerOutboundLifecycle: (owned) => {
        callbacks = owned; Object.values(owned).forEach((callback) => listeners.add(callback));
        return () => { listeners.clear(); };
      },
      createWindow: () => { windowEntered.resolve(); return input.pendingWindow ? window.promise : undefined; },
    }, dependencies);
    // Observe startup failures immediately, including while awaiting entry.
    const startupResult = starting.catch((error: Error) => error);
    cleanups.push(async () => {
      controller.abort(); window.resolve();
      const result = await startupResult;
      if (!(result instanceof Error)) await result.shutdown();
      service?.dispose();
    });
    await Promise.race([windowEntered.promise, starting.then((): undefined => undefined)]);
    const ports = await runtime.withDomain((domain) => ({
      inspect: vi.spyOn(domain, 'inspectOutboundCommand'),
      prepare: vi.spyOn(domain, 'prepareOutboundDispatch'),
      result: vi.spyOn(domain, 'recordOutboundResult'),
      refusal: vi.spyOn(domain, 'recordOutboundRefusal'),
    }));
    const invoke = ipc.handlers.get('lead-detail:begin-outbound')!;
    const capabilities = ipc.handlers.get('lead-detail:outbound-capabilities')!;
    return { temp, runtime, service, callbacks, controller, window, starting, ports, listeners, features,
      counts: () => ({ sqlCalls, postCloseSql, closes }),
      portCounts: () => Object.values(ports).map((spy) => spy.mock.calls.length),
      invoke: (request: OutboundRequest) => invoke({ senderFrame: { url: 'callie://app/index.html' } }, request) as Promise<OutboundReceipt>,
      capabilities: () => capabilities({ senderFrame: { url: 'callie://app/index.html' } }, {}),
    };
  }

  async function seed(runtime: FoundationRuntime): Promise<OutboundRequest> {
    const identity = await runtime.withDatabase((database) => {
      const prospect = seedProspect(database.raw, 'lifetime');
      database.raw.prepare("UPDATE prospects SET qualification_state = 'unreviewed' WHERE id = ?").run(prospect.prospectId);
      const services = createDomainServices({ database, clock: { now: () => NOW }, ids: new UuidGenerator() });
      const cycleId = services.lifecycle.createUnreviewedCycle({ personId: prospect.personId,
        prospectId: prospect.prospectId, entrySourceEventId: prospect.sourceEventId, effectiveAt: NOW }).id;
      database.raw.prepare(`INSERT INTO person_contact_methods
        (id, person_id, kind, normalized_value, validation_state, reachability, created_at, updated_at,
         federal_status, compliance_tcpa_flag, covered_area_code, compliance_source, scrubbed_at, compliance_expires_at)
        VALUES ('lifetime-phone', ?, 'phone', '+14015550100', 'valid', 'direct', ?, ?,
         'verified_clear', 0, '401', 'ftc_download', '2026-08-15T00:00:00.000Z', '2026-09-15T00:00:00.000Z')`)
        .run(prospect.personId, NOW, NOW);
      database.raw.prepare(`INSERT INTO person_outbound_jurisdictions
        (person_id, region_code, timezone, source, effective_at, updated_at)
        VALUES (?, 'RI', 'America/New_York', 'manual_review', ?, ?)`).run(prospect.personId, NOW, NOW);
      database.raw.prepare(`INSERT OR REPLACE INTO outbound_jurisdiction_clearances
        (region_code, channel, decision, registration_confirmed, state_dnc_subscription_confirmed,
         consent_rule_confirmed, source, effective_at, expires_at, updated_at)
        VALUES ('RI', 'call', 'allowed', 1, 1, 1, 'test', '2026-08-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', ?)`).run(NOW);
      return { personId: prospect.personId, salesCycleId: cycleId };
    });
    return runtime.withDomain((domain) => {
      domain.confirmTransition({ transition: 'review_to_ready', salesCycleId: identity.salesCycleId, expectedRevision: 0 });
      return { ...identity, commandId: randomUUID(), channel: 'call', contactMethodId: 'lifetime-phone',
        expectedContactSnapshot: domain.getLeadDetail({ personId: identity.personId }).phones[0].contactSnapshot };
    });
  }
  const facts = (runtime: FoundationRuntime) => runtime.withDatabase((database) => database.raw.prepare(
    "SELECT provider_idempotency_key FROM activities WHERE adapter = 'callie_outbound_v1' ORDER BY rowid",
  ).all());
  const workflow = (runtime: FoundationRuntime) => runtime.withDatabase((database) => Object.fromEntries(
    ['sales_cycles', 'stage_events', 'next_actions', 'cadence_enrollments', 'cadence_action_components'].map((table) =>
      [table, database.raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
  ));

  it('production unavailable capabilities never enter SQL and a valid direct call records only route-unverified refusal', async () => {
    const f = await fixture({ productionPorts: true });
    const request = await seed(f.runtime);
    const before = f.counts();
    await expect(f.capabilities()).resolves.toMatchObject({ phoneHandoff: { state: 'unavailable', reasonCode: 'inbound_safety_unwired' }, localDrafts: true });
    expect(f.counts()).toEqual(before); expect(f.portCounts()).toEqual([0, 0, 0, 0]);
    await expect(f.invoke(request)).resolves.toMatchObject({ status: 'unavailable', reasonCode: 'phone_route_unverified' });
    expect(await facts(f.runtime)).toHaveLength(2);
    await (await f.starting).shutdown();
    const closed = f.counts();
    f.callbacks.onUnlock(); f.callbacks.onWake();
    await expect(f.capabilities()).resolves.toMatchObject({ phoneHandoff: { reasonCode: 'workspace_inactive' }, localDrafts: true });
    await expect(f.invoke({ ...request, commandId: randomUUID() })).rejects.toThrow('inactive');
    expect(f.counts()).toEqual(closed);
  });

  it.each(['wake', 'unlock', 'shutdown'] as const)('fences queued domain callback entry after %s, not merely gate invocation', async (event) => {
    const f = await fixture(); const request = await seed(f.runtime);
    const entered = held<void>(); const release = held<void>();
    let callbacksEntered = 0;
    const original: FoundationRuntime['withDomain'] = f.runtime.withDomain.bind(f.runtime);
    const gate = vi.spyOn(f.runtime, 'withDomain').mockImplementation(async (operation) => {
      entered.resolve(); await release.promise;
      return original((domain) => { callbacksEntered += 1; return operation(domain); });
    });
    const pending = f.invoke(request).catch((error: Error) => error);
    await entered.promise;
    expect(gate).toHaveBeenCalledTimes(1); expect(callbacksEntered).toBe(0);
    expect(f.portCounts()).toEqual([0, 0, 0, 0]);
    if (event === 'shutdown') await (await f.starting).shutdown();
    else if (event === 'wake') f.callbacks.onWake(); else f.callbacks.onUnlock();
    expect(await pending).toBeInstanceOf(Error);
    const atFence = f.counts();
    release.resolve(); await gate.mock.results[0].value.catch((): undefined => undefined);
    expect(callbacksEntered).toBe(event === 'shutdown' ? 0 : 1);
    expect(f.portCounts()).toEqual([0, 0, 0, 0]);
    expect(f.counts()).toEqual(atFence);
    gate.mockRestore(); await (await f.starting).shutdown();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes outbound before Foundation waits for a real database lease, without awaiting external readiness', async () => {
    const entered = held<AbortSignal>(); const ready = held<{ kind: 'ready' }>();
    const f = await fixture({ readiness: { getCapability: () => available,
      check: (_person, signal) => { entered.resolve(signal); return ready.promise; } } });
    const request = await seed(f.runtime); const pending = f.invoke(request).catch((error: Error) => error);
    const signal = await entered.promise;
    const leased = held<void>(); const releaseLease = held<void>();
    const lease = f.runtime.withDatabase(async (database) => {
      leased.resolve(); await releaseLease.promise; expect(database.raw.open).toBe(true);
    });
    await leased.promise;
    const app = await f.starting; const stopping = app.shutdown();
    expect(app.shutdown()).toBe(stopping); expect(signal.aborted).toBe(true);
    expect(await pending).toBeInstanceOf(Error);
    expect(f.counts().closes).toBe(0); expect(f.listeners.size).toBe(0);
    releaseLease.resolve(); await lease; await stopping;
    expect(f.counts().closes).toBe(1); expect(f.portCounts()).toEqual([1, 0, 0, 0]);
    ready.reject(new Error('late readiness')); await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('lock→wake stays suspended, unlock always aborts the old epoch, and old finally cannot release a newer flight', async () => {
    const checks = Array.from({ length: 4 }, () => ({ entered: held<AbortSignal>(), reply: held<{ kind: 'ready' }>() }));
    let index = 0;
    const dispatch = vi.fn(async () => accepted);
    const f = await fixture({ phone: { inspectCapability: async () => available, dispatch },
      readiness: { getCapability: () => available, check: (_person, signal) => {
        const check = checks[index++]; check.entered.resolve(signal); return check.reply.promise;
      } },
    });
    const request = await seed(f.runtime);
    const first = f.invoke(request).catch((error: Error) => error);
    const firstSignal = await checks[0].entered.promise;
    f.callbacks.onLock(); f.callbacks.onWake();
    expect(firstSignal.aborted).toBe(true);
    const beforeSuspended = f.counts();
    await expect(f.invoke({ ...request, commandId: randomUUID() })).rejects.toThrow('inactive');
    expect(f.counts()).toEqual(beforeSuspended); expect(index).toBe(1);
    f.callbacks.onUnlock(); // The paired unlock does not resubmit the canceled request.
    expect(index).toBe(1);
    const second = f.invoke({ ...request, commandId: randomUUID() }).catch((error: Error) => error);
    const secondSignal = await checks[1].entered.promise;
    f.callbacks.onUnlock(); // Duplicate/unpaired unlock must also invalidate.
    expect(secondSignal.aborted).toBe(true);
    const third = f.invoke({ ...request, commandId: randomUUID() }).catch((error: Error) => error);
    const thirdSignal = await checks[2].entered.promise;
    f.callbacks.onUnlock();
    expect(thirdSignal.aborted).toBe(true);
    const fourth = f.invoke({ ...request, commandId: randomUUID() });
    const fourthSignal = await checks[3].entered.promise;
    checks[0].reply.resolve({ kind: 'ready' }); checks[1].reply.reject(new Error('late prior epoch')); checks[2].reply.resolve({ kind: 'ready' });
    for (const old of [first, second, third]) expect(await old).toBeInstanceOf(Error);
    expect(fourthSignal.aborted).toBe(false);
    await expect(f.invoke({ ...request, commandId: randomUUID() })).resolves.toMatchObject({ reasonCode: 'outbound_busy' });
    expect(index).toBe(4); expect(dispatch).not.toHaveBeenCalled(); expect(f.ports.prepare).not.toHaveBeenCalled();
    checks[3].reply.resolve({ kind: 'ready' });
    await expect(fourth).resolves.toMatchObject({ status: 'handoff_accepted' });
    expect(dispatch).toHaveBeenCalledTimes(1);
    await (await f.starting).shutdown(); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['contact', 'tombstone'] as const)('retains real final authority for a current %s edit during readiness and fresh wake/unlock intent', async (edit) => {
    const ready = held<{ kind: 'ready' }>(); const entered = held<void>();
    const dispatch = vi.fn(async () => accepted); let first = true;
    const f = await fixture({ phone: { inspectCapability: async () => available, dispatch },
      readiness: { getCapability: () => available, check: () => {
        if (!first) return Promise.resolve({ kind: 'ready' });
        first = false; entered.resolve(); return ready.promise;
      } },
    });
    const request = await seed(f.runtime); const pending = f.invoke(request);
    await entered.promise;
    if (edit === 'contact') await f.runtime.withDatabase((database) => {
      database.raw.prepare("UPDATE person_contact_methods SET normalized_value = '+14015550101' WHERE id = ?").run(request.contactMethodId);
    });
    else await f.runtime.withDomain((domain) => domain.logCallOutcome({ personId: request.personId, salesCycleId: request.salesCycleId,
      outcome: 'opted_out', occurredAt: NOW, callbackAt: null }));
    ready.resolve({ kind: 'ready' });
    const reasonCode = edit === 'contact' ? 'stale_contact' : 'cycle_not_executable';
    await expect(pending).resolves.toMatchObject({ status: 'refused', reasonCode });
    f.callbacks.onWake(); f.callbacks.onLock(); f.callbacks.onUnlock();
    await expect(f.invoke({ ...request, commandId: randomUUID() })).resolves.toMatchObject({ status: 'refused', reasonCode });
    expect(dispatch).not.toHaveBeenCalled(); expect(f.ports.prepare).toHaveBeenCalledTimes(2);
    if (edit === 'tombstone') expect(await f.runtime.withDatabase((database) => database.raw.prepare('SELECT COUNT(*) AS n FROM opt_out_tombstones').get())).toEqual({ n: 1 });
    await (await f.starting).shutdown(); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['readiness', 'dispatch', 'result_gate'] as const)('synthetic A→B replacement fences old %s work from both encrypted runtimes (not live restore)', async (stage) => {
    const ready = held<{ kind: 'ready' }>(); const reply = held<HandoffResult>();
    const entered = held<void>(); const releaseGate = held<void>();
    const a = await fixture({
      readiness: { getCapability: () => available, check: () => {
        if (stage === 'readiness') { entered.resolve(); return ready.promise; }
        return Promise.resolve({ kind: 'ready' });
      } },
      phone: { inspectCapability: async () => available, dispatch: () => {
        if (stage === 'dispatch') { entered.resolve(); return reply.promise; }
        return Promise.resolve(accepted);
      } },
    });
    const request = await seed(a.runtime);
    const original: FoundationRuntime['withDomain'] = a.runtime.withDomain.bind(a.runtime); let entries = 0;
    const gate = vi.spyOn(a.runtime, 'withDomain').mockImplementation(async (operation) => {
      if (++entries === 3 && stage === 'result_gate') { entered.resolve(); await releaseGate.promise; }
      return original(operation);
    });
    const pending = a.invoke(request).catch((error: Error) => error);
    await entered.promise;
    // Explicit fixture-only lifetime replacement. RecoveryService has no live restore API.
    a.service.invalidate('restore');
    await (await a.starting).shutdown();
    const outcome = await pending;
    if (stage === 'readiness') expect(outcome).toBeInstanceOf(Error);
    else expect(outcome).toMatchObject({ status: 'unknown', reasonCode: 'result_not_persisted' });
    const aCounts = a.counts(); const aPorts = a.portCounts();
    const b = await fixture(); const bRequest = await seed(b.runtime);
    expect(b.service).not.toBe(a.service); expect(b.runtime).not.toBe(a.runtime);
    const bCounts = b.counts();
    if (stage === 'readiness') ready.resolve({ kind: 'ready' });
    if (stage === 'dispatch') reply.reject(new Error('late A reply'));
    releaseGate.resolve();
    await Promise.all(gate.mock.results.map((result) => result.value.catch((): undefined => undefined)));
    a.callbacks.onWake(); a.callbacks.onUnlock();
    await expect(a.service.beginOutbound(request)).rejects.toThrow('inactive');
    expect(a.counts()).toEqual(aCounts); expect(a.portCounts()).toEqual(aPorts);
    expect(b.counts()).toEqual(bCounts); expect(b.portCounts()).toEqual([0, 0, 0, 0]);
    await expect(b.invoke(bRequest)).resolves.toMatchObject({ status: 'handoff_accepted' });
    await (await b.starting).shutdown(); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['shutdown', 'abort'] as const)('preflight %s closes immediately, with no late SQL on resolve or reject', async (boundary) => {
    for (const late of ['resolve', 'reject'] as const) {
      const ready = held<{ kind: 'ready' }>(); const entered = held<AbortSignal>();
      const dispatch = vi.fn(async () => accepted);
      const f = await fixture({ pendingWindow: boundary === 'abort',
        readiness: { getCapability: () => available, check: (_person, signal) => { entered.resolve(signal); return ready.promise; } },
        phone: { inspectCapability: async () => available, dispatch },
      });
      const request = await seed(f.runtime);
      const pending = f.invoke(request).catch((error: Error) => error);
      const signal = await entered.promise;
      expect(f.portCounts()).toEqual([1, 0, 0, 0]);
      let stopping: Promise<unknown>;
      if (boundary === 'abort') { f.controller.abort(); stopping = f.starting.catch((error: Error) => error); }
      else { stopping = (await f.starting).shutdown(); }
      expect(signal.aborted).toBe(true);
      expect(f.listeners.size).toBe(0);
      if (boundary === 'abort') f.window.resolve();
      await stopping;
      expect(await pending).toBeInstanceOf(Error);
      expect(f.features.size).toBe(0); expect(ipc.handlers.size).toBe(0);
      const atClose = f.counts();
      if (late === 'resolve') ready.resolve({ kind: 'ready' }); else ready.reject(new Error('late readiness'));
      await Promise.resolve(); await Promise.resolve();
      expect(f.counts()).toEqual(atClose);
      expect(atClose.postCloseSql).toBe(0); expect(atClose.closes).toBe(1);
      expect(f.portCounts()).toEqual([1, 0, 0, 0]); expect(dispatch).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      expect(readFileSync(f.temp.path).subarray(0, 16).toString()).not.toBe('SQLite format 3\0');
      const reopened = await fixture({ temp: f.temp });
      expect(await facts(reopened.runtime)).toEqual([]);
      await (await reopened.starting).shutdown();
    }
  });

  it.each(['shutdown', 'abort'] as const)('committed dispatch %s settles unknown before external completion and reopens without redispatch', async (boundary) => {
    for (const late of ['resolve', 'reject'] as const) {
      const reply = held<HandoffResult>(); const entered = held<void>();
      const dispatch = vi.fn(() => { entered.resolve(); return reply.promise; });
      const f = await fixture({ pendingWindow: boundary === 'abort', phone: { inspectCapability: async () => available, dispatch } });
      const request = await seed(f.runtime); const before = await workflow(f.runtime);
      const beforeDials = await f.runtime.withDomain((domain) => domain.getToday().scheduledDials);
      const pending = f.invoke(request);
      await entered.promise;
      expect(await facts(f.runtime)).toEqual([{ provider_idempotency_key: `${request.commandId}:requested` }, { provider_idempotency_key: `${request.commandId}:dispatching` }]);
      const saved = f.ports.prepare.mock.results[0].value;
      let stopping: Promise<unknown>;
      if (boundary === 'abort') { f.controller.abort(); stopping = f.starting.catch((error: Error) => error); }
      else { stopping = (await f.starting).shutdown(); }
      expect(f.listeners.size).toBe(0);
      if (boundary === 'abort') f.window.resolve();
      await stopping;
      expect(f.features.size).toBe(0); expect(ipc.handlers.size).toBe(0);
      await expect(pending).resolves.toMatchObject({ status: 'unknown', reasonCode: 'result_not_persisted', mutation: saved.mutation });
      const atClose = f.counts();
      if (late === 'resolve') reply.resolve(accepted); else reply.reject(new Error('late Phone reply'));
      await Promise.resolve(); await Promise.resolve();
      expect(f.counts()).toEqual(atClose); expect(atClose.postCloseSql).toBe(0);
      // Preparation repeats the durable lookup inside its own write scope.
      expect(f.portCounts()).toEqual([2, 1, 0, 0]);
      expect(dispatch).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
      const replayDispatch = vi.fn(async () => accepted);
      const reopened = await fixture({ temp: f.temp, phone: { inspectCapability: async () => available, dispatch: replayDispatch } });
      await expect(reopened.invoke(request)).resolves.toMatchObject({ status: 'unknown', reasonCode: 'handoff_uncertain' });
      expect(replayDispatch).not.toHaveBeenCalled(); expect(await facts(reopened.runtime)).toHaveLength(2);
      expect(await workflow(reopened.runtime)).toEqual(before);
      expect(await reopened.runtime.withDomain((domain) => domain.getToday().scheduledDials)).toBe(beforeDials);
      expect(await reopened.runtime.withDatabase((database) => database.raw.prepare("SELECT COUNT(*) AS n FROM activities WHERE kind IN ('call','text','email')").get())).toEqual({ n: 0 });
      await (await reopened.starting).shutdown();
    }
  });
});

describe('FoundationRuntime', () => {
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

  it('requires and serves the explicitly composed sourcing health provider', async () => {
    const database = { path: health.databasePath } as AppDatabase;
    const runtime = new FoundationRuntime(runtimeOptions, {
      ...keyDependencies(),
      openDatabase: () => database,
      migrateToLatest: async () => migrationResult,
      createDomainRuntime: () => fakeDomainRuntime(),
      createHealthService: (options) => ({
        getHealth: () => ({
          ...health,
          operationalStatus: options.sourcingHealth().status === 'degraded' ? 'degraded' : 'ready',
          sourcing: options.sourcingHealth(),
        }),
      }),
      closeDatabase: () => undefined,
    });
    await runtime.initialize();

    await expect(runtime.getHealth()).rejects.toThrow(
      'Sourcing health provider has not been composed.',
    );
    runtime.setSourcingHealthProvider(() => ({
      status: 'degraded', reasons: ['POLL_EXCEEDED_TOTAL_DEADLINE'], lastSuccessAgeMs: null,
      state: {
        state: 'running', pollId: 'poll-real', startedAt: '2026-09-01T11:45:00.000Z',
        lastCompletedAt: null, consecutiveFailures: 0, lastFailureAt: null,
        lastFailureCode: null, backlogCount: null,
      },
    }));
    await expect(runtime.getHealth()).resolves.toMatchObject({
      operationalStatus: 'degraded',
      sourcing: { status: 'degraded', state: { pollId: 'poll-real' } },
    });
    await runtime.shutdown();
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

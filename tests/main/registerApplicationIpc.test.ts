import { describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  showItemInFolder: vi.fn(),
  handle: vi.fn(), removeHandler: vi.fn(),
}));

vi.mock('electron', () => ({
  shell: { showItemInFolder: electron.showItemInFolder },
  safeStorage: {}, dialog: {}, ipcMain: { handle: electron.handle, removeHandler: electron.removeHandler },
}));

import type { FounderSalesDomain } from '../../src/main/domain/founderSalesDomain';
import type { AppHealth } from '../../src/shared/healthContract';
import type { LeadDetail } from '../../src/shared/contracts/leadDetailContract';
import { startApplication, type ApplicationStartupDependencies } from '../../src/main/startApplication';
import { fakeDomainRuntime } from '../fixtures/fakeDomainRuntime';
import type { AppDatabase } from '../../src/main/db/database';
import { createOutboundCommandService } from '../../src/main/communications/outboundCommandService';
import type { OutboundCommandServiceApi } from '../../src/main/communications/outboundPorts';
import { registeredIpcHandler } from '../fixtures/registeredIpcHandler';
import { createCallieApi } from '../../src/preload/createCallieApi';
import { registerLeadDetailIpc } from '../../src/main/leads/registerLeadDetailIpc';
import {
  createDailyProvider,
  createLeadDetailProvider,
  createLeadsProvider,
  createShellProvider,
  registerApplicationIpc,
  type FeatureRegistrars,
} from '../../src/main/ipc/registerApplicationIpc';

const recoveryProvider = { status: vi.fn(), beginSetup: vi.fn(), saveSetupMaterial: vi.fn(), completeSetup: vi.fn(), selectAndRunRestoreDrill: vi.fn() };

type Gate = Parameters<typeof registerApplicationIpc>[0];

const fakeGate = (domain: Partial<FounderSalesDomain> = {}): Gate => ({
  withDatabase: vi.fn(),
  withDomain: vi.fn(async (operation: (domain: FounderSalesDomain) => unknown) =>
    operation(domain as FounderSalesDomain)) as Gate['withDomain'],
  getHealth: vi.fn(async () => ({})),
});

/** The seven surviving slices in registration order. */
const SLICES = ['health', 'leads', 'leadDetail', 'shell', 'recovery', 'daily', 'localWorkspace'] as const;
/** Every channel the default registrars own: 1 + 1 + 1 + 2 + 5 + 1 + 23. */
const REGISTERED_CHANNEL_COUNT = 34;
/** Channel prefixes as the disposer removes them, in reverse registration order. */
const REVERSE_CHANNEL_SLICES = ['local-workspace', 'daily', 'recovery', 'shell', 'lead-detail', 'leads', 'health'];

/** Schema-shaped read-only detail. Fictional person, no real contact data. */
const detail: LeadDetail = {
  personId: 'p', salesCycleId: 's', personName: 'Fixture Owner', phones: [], emails: [], organizationLabel: null,
  propertySummaries: [], stage: 'ready', workflowStatus: 'active', sourceLabel: 'frbo', segment: 'hot', cloudScores: null,
  cloudLinked: false, findContactEligibility: { eligible: false, refusalReason: 'qualification_required' }, priorityContext: null,
  priorityReasons: [], nextAction: null, optedOut: false, cadence: null, outboundAttempts: [], activities: [], conversations: [],
  properties: [], history: [], revision: 0,
};

describe('registerApplicationIpc', () => {
  const runtimeHealth: AppHealth = {
    appVersion: '1.0.0', schemaVersion: 14, databasePath: '/fixture.sqlite3',
    databaseEncrypted: true, cipherVersion: 'cipher', fts5Available: true,
    pendingJobs: 0, interruptedJobsRecovered: 0, domainStatus: 'ready', domainReady: true,
    domainBlockingViolationCount: 0, domainRepairableIssueCount: 0,
    domainProjectionRefreshCandidateCount: 0, pendingProjectionRebuilds: 0,
    domainStartupEvaluatedAt: '2026-09-01T12:00:00.000Z',
  };

  function fakeRegistrars(unregisters: ReturnType<typeof vi.fn>[]): {
    registrars: FeatureRegistrars;
    calls: string[];
  } {
    const calls: string[] = [];
    const track = (name: string, unregister: ReturnType<typeof vi.fn>) =>
      vi.fn(() => {
        calls.push(name);
        return unregister;
      });
    const registrars = {
      registerHealthIpc: track('health', unregisters[0]!),
      registerLeadsIpc: track('leads', unregisters[1]!),
      registerLeadDetailIpc: track('leadDetail', unregisters[2]!),
      registerShellIpc: track('shell', unregisters[3]!),
      registerRecoveryIpc: track('recovery', unregisters[4]!),
      registerDailyIpc: track('daily', unregisters[5]!),
      registerLocalWorkspaceIpc: track('localWorkspace', unregisters[6]!),
    } as unknown as FeatureRegistrars;
    return { registrars, calls };
  }

  it.each(['outer', 'nested'] as const)('startup consumes accepted %s IPC rollback and closes outbound despite cleanup errors', async (failureAt) => {
    const handlers = new Set<string>(); const features = new Set<string>(); const listeners = new Set<() => void>();
    const registrationError = new Error('registration'); const cleanupError = new Error('cleanup');
    const { registrars } = fakeRegistrars([]);
    for (const name of Object.keys(registrars) as (keyof FeatureRegistrars)[]) {
      registrars[name] = vi.fn(() => {
        if (failureAt === 'outer' && name === 'registerDailyIpc') throw registrationError;
        features.add(name);
        return () => { features.delete(name); if (name === 'registerHealthIpc') throw cleanupError; };
      });
    }
    registrars.registerLeadDetailIpc = registerLeadDetailIpc;
    electron.handle.mockReset().mockImplementation((channel: string) => {
      if (failureAt === 'nested' && channel === 'lead-detail:get') throw registrationError;
      handlers.add(channel);
    });
    electron.removeHandler.mockReset().mockImplementation((channel: string) => { handlers.delete(channel); });
    let service!: OutboundCommandServiceApi;
    const dispose = vi.fn(); const close = vi.fn(); const window = vi.fn();
    const dependencies: ApplicationStartupDependencies = {
      loadWorkspaceKey: async () => ({ bytes: Buffer.alloc(32, 0x2a), version: 1 }),
      prepareEncryptedDatabase: async () => undefined,
      openDatabase: () => ({ path: '/fixture/rollback' }) as AppDatabase,
      migrateToLatest: async () => ({ fromVersion: 0, toVersion: 2, appliedMigrationIds: [] }),
      createDomainRuntime: () => fakeDomainRuntime(), createHealthService: () => ({ getHealth: () => runtimeHealth }),
      createBackupService: () => ({ start: async () => undefined, shutdown: async () => undefined,
        listAvailableBackups: async () => [], createBackup: async () => { throw new Error('unexpected backup'); } }),
      createRecoveryService: () => ({ ...recoveryProvider, shutdown: async () => undefined }),
      createOutboundCommandService: (input) => { service = createOutboundCommandService(input); dispose.mockImplementation(() => service.dispose()); return { ...service, dispose }; },
      registerApplicationIpc: (runtime, trust, _unused, recovery, shell, logs, options) =>
        registerApplicationIpc(runtime, trust, registrars, recovery, shell, logs, options),
      createAppleBridgeSupervisor: () => { throw new Error('unexpected helper'); }, closeDatabase: close,
    };
    // This startup fixture has no operational domain graph. Only the settings read is expected.
    const getCompanyResearchSettings = vi.fn(() => ({ revision: 0, configuration: null }));
    const settingsRead = vi.spyOn(FoundationRuntime.prototype, 'withDomain').mockImplementationOnce(async operation =>
      operation({ getCompanyResearchSettings } as unknown as FounderSalesDomain));
    const error = await startApplication({ appVersion: '1', userDataPath: '/fixture/rollback', createWindow: window,
      registerOutboundLifecycle: (owned) => { Object.values(owned).forEach((callback) => listeners.add(callback)); return () => listeners.clear(); },
    }, dependencies).catch((caught: unknown) => caught) as AggregateError;
    settingsRead.mockRestore();
    expect(getCompanyResearchSettings).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.cause).toBe(registrationError);
    expect(error.errors).toEqual([registrationError, cleanupError]);
    expect(handlers.size).toBe(0); expect(features.size).toBe(0); expect(listeners.size).toBe(0);
    expect(dispose).toHaveBeenCalledTimes(1); expect(close).toHaveBeenCalledTimes(1); expect(window).not.toHaveBeenCalled();
    expect((await service.getCapabilities()).phoneHandoff.reasonCode).toBe('workspace_inactive');
  });

  it('Task 1 startup rolls selected-company registration back without repeating startup', async () => {
    const handlers = new Set<string>(); const features = new Set<string>(); const listeners = new Set<() => void>();
    const registrationError = new Error('registration'); const cleanupError = new Error('cleanup');
    const { registrars } = fakeRegistrars([]);
    for (const name of Object.keys(registrars) as (keyof FeatureRegistrars)[]) {
      registrars[name] = vi.fn(() => {
        features.add(name);
        return () => { features.delete(name); if (name === 'registerHealthIpc') throw cleanupError; };
      });
    }
    registrars.registerLocalWorkspaceIpc = registerLocalWorkspaceIpc;
    electron.handle.mockReset().mockImplementation((channel: string) => {
      if (channel === 'local-workspace:get-company') throw registrationError;
      handlers.add(channel);
    });
    electron.removeHandler.mockReset().mockImplementation((channel: string) => { handlers.delete(channel); });
    let service!: OutboundCommandServiceApi;
    const dispose = vi.fn(); const close = vi.fn(); const window = vi.fn();
    const opened = vi.fn(() => ({ path: '/fixture/rollback' }) as AppDatabase);
    const domainCreated = vi.fn(() => fakeDomainRuntime());
    const registration = vi.fn<typeof registerApplicationIpc>((runtime, trust, _unused, recovery, shell, logs, options) =>
      registerApplicationIpc(runtime, trust, registrars, recovery, shell, logs, options));
    const dependencies: ApplicationStartupDependencies = {
      loadWorkspaceKey: async () => ({ bytes: Buffer.alloc(32, 0x2a), version: 1 }),
      prepareEncryptedDatabase: async () => undefined,
      openDatabase: opened,
      migrateToLatest: async () => ({ fromVersion: 0, toVersion: 2, appliedMigrationIds: [] }),
      createDomainRuntime: domainCreated, createHealthService: () => ({ getHealth: () => runtimeHealth }),
      createBackupService: () => ({ start: async () => undefined, shutdown: async () => undefined,
        listAvailableBackups: async () => [], createBackup: async () => { throw new Error('unexpected backup'); } }),
      createRecoveryService: () => ({ ...recoveryProvider, shutdown: async () => undefined }),
      createOutboundCommandService: (input) => { service = createOutboundCommandService(input); dispose.mockImplementation(() => service.dispose()); return { ...service, dispose }; },
      registerApplicationIpc: registration,
      createAppleBridgeSupervisor: () => { throw new Error('unexpected helper'); }, closeDatabase: close,
    };
    // This startup fixture has no operational domain graph. Only the settings read is expected.
    const getCompanyResearchSettings = vi.fn(() => ({ revision: 0, configuration: null }));
    const settingsRead = vi.spyOn(FoundationRuntime.prototype, 'withDomain').mockImplementationOnce(async operation =>
      operation({ getCompanyResearchSettings } as unknown as FounderSalesDomain));
    const error = await startApplication({ appVersion: '1', userDataPath: '/fixture/rollback', createWindow: window,
      registerOutboundLifecycle: (owned) => { Object.values(owned).forEach((callback) => listeners.add(callback)); return () => listeners.clear(); },
    }, dependencies).catch((caught: unknown) => caught) as AggregateError;
    settingsRead.mockRestore();
    expect(getCompanyResearchSettings).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.cause).toBe(registrationError);
    expect(error.errors).toEqual([registrationError, cleanupError]);
    expect(handlers.size).toBe(0); expect(features.size).toBe(0); expect(listeners.size).toBe(0);
    expect(dispose).toHaveBeenCalledTimes(1); expect(close).toHaveBeenCalledTimes(1); expect(window).not.toHaveBeenCalled();
    expect((await service.getCapabilities()).phoneHandoff.reasonCode).toBe('workspace_inactive');
    expect(opened).toHaveBeenCalledTimes(1); expect(domainCreated).toHaveBeenCalledTimes(1);
    expect(registration).toHaveBeenCalledTimes(1);
    expect(electron.handle.mock.calls.filter(call => call[0] === 'local-workspace:get-company')).toHaveLength(1);
  });

  it.each([2, 3, 5, 6, 7])('rolls back all successful outer registrations when registrar %s fails', (nth) => {
    const registry = new Set<string>();
    const order: string[] = [];
    const registrationError = new Error('register');
    const cleanupError = new Error('cleanup');
    const { registrars } = fakeRegistrars([]);
    let index = 0;
    for (const name of Object.keys(registrars) as (keyof FeatureRegistrars)[]) {
      const position = ++index;
      registrars[name] = vi.fn(() => {
        if (position === nth) throw registrationError;
        registry.add(name);
        return () => {
          registry.delete(name);
          order.push(name);
          if (position === 1) throw cleanupError;
        };
      });
    }
    let caught: unknown;
    try { registerApplicationIpc(fakeGate(), undefined, registrars, recoveryProvider); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toEqual([registrationError, cleanupError]);
    expect(registry.size).toBe(0);
    expect(order).toEqual(Object.keys(registrars).slice(0, nth - 1).reverse());
  });

  it('cleans every owned outer handler in reverse and is idempotent after errors', () => {
    const registry = new Set<string>();
    const order: string[] = [];
    const { registrars } = fakeRegistrars([]);
    for (const name of Object.keys(registrars) as (keyof FeatureRegistrars)[]) {
      registrars[name] = vi.fn(() => {
        registry.add(name);
        return () => { registry.delete(name); order.push(name); if (name === 'registerRecoveryIpc') throw new Error('cleanup'); };
      });
    }
    const dispose = registerApplicationIpc(fakeGate(), undefined, registrars, recoveryProvider);
    expect(dispose).toThrow();
    expect(registry.size).toBe(0);
    expect(order).toEqual(Object.keys(registrars).reverse());
    expect(dispose).not.toThrow();
    expect(order).toHaveLength(SLICES.length);
  });

  it('leases the current domain separately for every actual lead read invocation', async () => {
    electron.handle.mockReset(); electron.removeHandler.mockReset();
    const page: Awaited<ReturnType<FounderSalesDomain['listLeadRows']>> = { rows: [], nextCursor: null, total: 0, revision: 0 };
    const request: Parameters<FounderSalesDomain['listLeadRows']>[0] = { query: '', stages: [], priorities: [], sort: 'priority', cursor: null, limit: 50 };
    let current: Partial<FounderSalesDomain> = { listLeadRows: input => { expect(input).toEqual(request); return page; } };
    const gate: Gate = { withDatabase: vi.fn(), getHealth: vi.fn(), withDomain: vi.fn(async operation => operation(current as FounderSalesDomain)) };
    const dispose = registerApplicationIpc(gate, undefined, undefined, recoveryProvider);
    expect(gate.withDomain).not.toHaveBeenCalled();
    const api = createCallieApi({ invoke: (channel, ...args) => Promise.resolve(
      registeredIpcHandler(electron.handle, channel)({ senderFrame: { url: 'callie://app/index.html' } }, ...args)) });
    await expect(api.leads.list(request)).resolves.toEqual(page);
    current = { getLeadDetail: input => { expect(input).toEqual({ personId: 'p' }); return detail; } };
    await expect(api.leadDetail.get({ personId: 'p' })).resolves.toEqual(detail);
    expect(gate.withDomain).toHaveBeenCalledTimes(2);
    // The removed person commands have no channel left to lease.
    for (const channel of ['leads:update-field', 'leads:bulk-update', 'lead-detail:begin-outbound', 'lead-detail:outbound-capabilities',
      'lead-detail:confirm-transition', 'lead-detail:dismiss', 'lead-detail:cloud-score-override', 'lead-detail:find-contact-info',
      'today:get', 'pipeline:get', 'review:list', 'friday:get', 'imports:preview', 'conversations:list', 'learnings:list', 'sourcing:status', 'discovery:get']) {
      expect(electron.handle.mock.calls.some(call => call[0] === channel), channel).toBe(false);
    }
    dispose();
  });

  it('rolls back prior application handlers if a later slice registration partially fails', () => {
    const handlers = new Set(['unrelated']); const failure = new Error('daily registration');
    electron.handle.mockReset().mockImplementation((channel: string) => {
      if (channel === 'daily:get') throw failure;
      handlers.add(channel);
    });
    electron.removeHandler.mockReset().mockImplementation((channel: string) => { handlers.delete(channel); });
    expect(() => registerApplicationIpc(fakeGate(), undefined, undefined, recoveryProvider)).toThrow(failure);
    expect([...handlers]).toEqual(['unrelated']);
    electron.handle.mockReset(); electron.removeHandler.mockReset();
  });

  it('passes the injected shell provider, log directory and options through their fixed positions', () => {
    const shell = { revealDatabase: vi.fn(), revealLogDirectory: vi.fn() };
    const { registrars } = fakeRegistrars(Array.from({ length: SLICES.length }, () => vi.fn()));
    const gate = fakeGate(); const current = vi.fn(() => null);
    registerApplicationIpc(gate, undefined, registrars, recoveryProvider, shell, '/fixture/logs', { selectedCompanyResearch: { current } });
    expect(registrars.registerShellIpc).toHaveBeenCalledWith(shell, undefined);
    expect(registrars.registerRecoveryIpc).toHaveBeenCalledWith(recoveryProvider, undefined);
    expect(current).not.toHaveBeenCalled();
    expect(gate.withDomain).not.toHaveBeenCalled(); expect(gate.withDatabase).not.toHaveBeenCalled();
  });

  it('derives the default shell provider from the log directory when none is injected', async () => {
    electron.showItemInFolder.mockReset();
    const { registrars } = fakeRegistrars(Array.from({ length: SLICES.length }, () => vi.fn()));
    const registerShell = vi.fn<FeatureRegistrars['registerShellIpc']>(() => vi.fn());
    registrars.registerShellIpc = registerShell;
    registerApplicationIpc(fakeGate(), undefined, registrars, recoveryProvider, undefined, '/fixture/logs');
    const provider = registerShell.mock.calls[0]![0];
    await expect(provider.revealLogDirectory()).resolves.toEqual({ revealed: true });
    expect(electron.showItemInFolder).toHaveBeenCalledWith('/fixture/logs');
  });

  it('registers all seven feature slices and unregisters each exactly once', () => {
    const unregisters = Array.from({ length: SLICES.length }, () => vi.fn());
    const { registrars, calls } = fakeRegistrars(unregisters);

    const unregister = registerApplicationIpc(fakeGate(), undefined, registrars, recoveryProvider);
    expect(calls).toEqual([...SLICES]);

    unregister();
    unregister();
    expect(unregisters.every((fn) => fn.mock.calls.length === 1)).toBe(true);
  });

  it('unregisters slices in reverse registration order', () => {
    const order: string[] = [];
    const unregisters = SLICES.map((name) => vi.fn(() => order.push(name)));
    const { registrars } = fakeRegistrars(unregisters);

    registerApplicationIpc(fakeGate(), undefined, registrars, recoveryProvider)();
    expect(order).toEqual([...SLICES].reverse());
  });

  it('passes the trusted-URL predicate to every slice registrar', () => {
    const unregisters = Array.from({ length: SLICES.length }, () => vi.fn());
    const { registrars } = fakeRegistrars(unregisters);
    const trust = (url: string) => url.startsWith('app://');

    registerApplicationIpc(fakeGate(), trust, registrars, recoveryProvider);
    for (const registrar of Object.values(registrars)) {
      const args = vi.mocked(registrar).mock.calls[0]!;
      expect(args.length === 1 ? (args[0] as { isTrustedRendererUrl?: unknown }).isTrustedRendererUrl : args[1]).toBe(trust);
    }
  });

  it('registers the primary runtime health unchanged', async () => {
    const unregisters = Array.from({ length: SLICES.length }, () => vi.fn());
    const { registrars } = fakeRegistrars(unregisters);
    let registeredHealth: { getHealth(): Promise<unknown> } | undefined;
    registrars.registerHealthIpc = vi.fn((provider) => {
      registeredHealth = provider;
      return unregisters[0]!;
    });
    const runtime = fakeGate();
    vi.mocked(runtime.getHealth).mockResolvedValue(runtimeHealth);

    registerApplicationIpc(runtime, undefined, registrars, recoveryProvider);

    await expect(registeredHealth?.getHealth()).resolves.toEqual(runtimeHealth);
    expect(registeredHealth?.getHealth).toBe(runtime.getHealth);
  });

  it('rejects a missing recovery provider instead of registering a fallback', () => {
    const unregisters = Array.from({ length: SLICES.length }, () => vi.fn());
    const { registrars, calls } = fakeRegistrars(unregisters);

    expect(() => registerApplicationIpc(
      fakeGate(), undefined, registrars, undefined as never,
    )).toThrow('Recovery provider is required.');
    expect(calls).toEqual([]);
  });

  it('retains the gated provider smoke cases for the surviving read slices', async () => {
    const domain = {
      listLeadRows: vi.fn(() => 'lead-rows'),
      getLeadDetail: vi.fn(() => 'detail'),
      getDaily: vi.fn(() => 'daily'),
    } as unknown as FounderSalesDomain;
    const gate = fakeGate(domain);

    await expect(createLeadsProvider(gate).list({} as never)).resolves.toBe('lead-rows');
    await expect(createLeadDetailProvider(gate).get({} as never)).resolves.toBe('detail');
    await expect(createDailyProvider(gate).get()).resolves.toBe('daily');

    expect(gate.withDomain).toHaveBeenCalledTimes(3);
  });

  it('ships no person command surface on the surviving lead providers', () => {
    const gate = fakeGate();
    expect(Object.keys(createLeadsProvider(gate))).toEqual(['list']);
    expect(Object.keys(createLeadDetailProvider(gate))).toEqual(['get']);
    expect(gate.withDomain).not.toHaveBeenCalled();
  });

  it('reveals only the health-reported database path through the shell provider', async () => {
    electron.showItemInFolder.mockReset();
    const gate = fakeGate();
    vi.mocked(gate.getHealth).mockResolvedValue({
      appVersion: '1.0.0',
      schemaVersion: 9,
      databasePath: '/tmp/callie.sqlite3',
      databaseEncrypted: true,
      cipherVersion: 'SQLite3 Multiple Ciphers 2.3.5',
      fts5Available: true,
      pendingJobs: 0,
      interruptedJobsRecovered: 0,
      domainStatus: 'ready',
      domainReady: true,
      domainBlockingViolationCount: 0,
      domainRepairableIssueCount: 0,
      domainProjectionRefreshCandidateCount: 0,
      pendingProjectionRebuilds: 0,
      domainStartupEvaluatedAt: '2026-08-30T12:00:00.000Z',
    });

    const shellProvider = createShellProvider(gate);
    await expect(shellProvider.revealDatabase()).resolves.toEqual({
      revealed: true,
    });
    expect(electron.showItemInFolder).toHaveBeenCalledWith('/tmp/callie.sqlite3');
  });

  it('reveals the main-owned retained log directory without renderer input', async () => {
    electron.showItemInFolder.mockReset();
    const shellProvider = createShellProvider(fakeGate(), '/private/callie/logs');

    await expect(shellProvider.revealLogDirectory()).resolves.toEqual({ revealed: true });
    expect(electron.showItemInFolder).toHaveBeenCalledWith('/private/callie/logs');
  });

  it('refuses to reveal when health does not validate', async () => {
    electron.showItemInFolder.mockReset();
    const gate = fakeGate();
    vi.mocked(gate.getHealth).mockResolvedValue({ databasePath: 42 });

    await expect(createShellProvider(gate).revealDatabase()).rejects.toThrow();
    expect(electron.showItemInFolder).not.toHaveBeenCalled();
  });
});

// Sentinel mapping values below prove forwarding only, never public API/readiness success.
describe('shipped provider mappings', () => {
  const person = { personId: 'mapping-person' };
  type Mapping = { name: string; facade: keyof FounderSalesDomain; factory: (gate: Gate) => object; method: string; args: unknown[] };
  const cases: Mapping[] = [
    { name: 'leads.list', facade: 'listLeadRows', factory: createLeadsProvider, method: 'list', args: [{ query: 'map', stages: [], priorities: [], sort: 'person_name', cursor: null, limit: 7 }] },
    { name: 'detail.get', facade: 'getLeadDetail', factory: createLeadDetailProvider, method: 'get', args: [person] },
    { name: 'daily.get', facade: 'getDaily', factory: createDailyProvider, method: 'get', args: [] },
  ];
  const invoke = (entry: Mapping, gate: Gate): Promise<unknown> => {
    const provider = entry.factory(gate);
    return Reflect.apply(Reflect.get(provider, entry.method), provider, entry.args) as Promise<unknown>;
  };
  it.each(cases)('$name forwards exact arguments and preserves returned value and both rejection sources', async entry => {
    const value = Object.freeze({ mapping: entry.name });
    const method = vi.fn((...args: unknown[]) => { void args; return value; });
    const gate = fakeGate({ [entry.facade]: method });
    await expect(invoke(entry, gate)).resolves.toBe(value);
    expect(method.mock.calls).toEqual([entry.args]);
    expect(gate.withDomain).toHaveBeenCalledTimes(1);
    expect(gate.getHealth).not.toHaveBeenCalled();
    if (entry.args.length) expect(method.mock.calls[0]?.[0]).toBe(entry.args[0]);
    const domainError = new Error(`facade:${entry.name}`);
    method.mockImplementationOnce(() => { throw domainError; });
    await expect(invoke(entry, gate)).rejects.toBe(domainError);
    const gateError = new Error(`gate:${entry.name}`);
    vi.mocked(gate.withDomain).mockRejectedValueOnce(gateError);
    await expect(invoke(entry, gate)).rejects.toBe(gateError);
    expect(method).toHaveBeenCalledTimes(2);
  });
});

import { createPmFixture, PM_NOW } from '../fixtures/pmAccounts';
import { SystemClock } from '../../src/main/domain/support/clock';

function applicationCompanyState(database: AppDatabase) {
  const tables = database.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  return { changes: database.raw.prepare('SELECT total_changes() AS changes').get(),
    tables: tables.map(({ name }) => ({ name, rows: database.raw.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all() })) };
}

describe('Task 1 selected-company application composition', () => {
  it('public getCompany uses current storage for every invocation without startup or domain work', async () => {
    const first = await createPmFixture();
    const second = await createPmFixture();
    let dispose: (() => void) | undefined;
    electron.handle.mockReset(); electron.removeHandler.mockReset();
    try {
      const a = first.repo.create({ commandId: crypto.randomUUID(), name: 'Workspace A', domain: null });
      const b = second.repo.create({ commandId: crypto.randomUUID(), name: 'Workspace B', domain: null });
      let current: AppDatabase | undefined = first.db;
      const gate: Gate = {
        withDatabase: async operation => { if (!current) throw new Error('storage inactive'); return operation(current); },
        withDomain: async () => { throw new Error('unexpected domain operation'); },
        getHealth: async () => { throw new Error('unexpected health operation'); },
      };
      const databaseLease = vi.spyOn(gate, 'withDatabase');
      const domainLease = vi.spyOn(gate, 'withDomain');
      const health = vi.spyOn(gate, 'getHealth');
      vi.spyOn(SystemClock.prototype, 'now').mockReturnValue(PM_NOW);
      const firstBefore = applicationCompanyState(first.db);
      const secondBefore = applicationCompanyState(second.db);
      dispose = registerApplicationIpc(gate, undefined, undefined, recoveryProvider);
      expect(databaseLease).not.toHaveBeenCalled();
      expect(domainLease).not.toHaveBeenCalled();
      const registeredCount = electron.handle.mock.calls.length;
      expect(registeredCount).toBe(REGISTERED_CHANNEL_COUNT);
      expect(electron.handle.mock.calls.filter(call => call[0] === 'local-workspace:get-company')).toHaveLength(1);
      const api = createCallieApi({ invoke: async (channel, ...args) => registeredIpcHandler(electron.handle, channel)({ senderFrame: { url: 'callie://app/index.html' } }, ...args) });
      expect(await api.localWorkspace.getCompany({ accountId: a.id })).toEqual({ scope: 'local_database', generatedAt: PM_NOW, snapshot: first.repo.snapshot(a.id, PM_NOW), sources: [], links: [] });
      current = second.db;
      expect(await api.localWorkspace.getCompany({ accountId: b.id })).toEqual({ scope: 'local_database', generatedAt: PM_NOW, snapshot: second.repo.snapshot(b.id, PM_NOW), sources: [], links: [] });
      await expect(api.localWorkspace.getCompany({ accountId: a.id })).rejects.toThrow(/^LOCAL_COMPANY_READ_FAILED$/);
      current = undefined;
      await expect(api.localWorkspace.getCompany({ accountId: b.id })).rejects.toThrow(/^LOCAL_COMPANY_READ_FAILED$/);
      expect(databaseLease).toHaveBeenCalledTimes(4);
      expect(domainLease).not.toHaveBeenCalled(); expect(health).not.toHaveBeenCalled();
      expect(electron.handle).toHaveBeenCalledTimes(registeredCount);
      expect(applicationCompanyState(first.db)).toEqual(firstBefore);
      expect(applicationCompanyState(second.db)).toEqual(secondBefore);
      dispose(); dispose();
      expect(electron.removeHandler.mock.calls.filter(call => call[0] === 'local-workspace:get-company')).toHaveLength(1);
    } finally { dispose?.(); vi.restoreAllMocks(); first.close(); second.close(); electron.handle.mockReset(); electron.removeHandler.mockReset(); }
  });

  it('rolls back every earlier application and local handler when selected-company registration fails', () => {
    const handlers = new Set(['unrelated']);
    const registered: string[] = [];
    const failure = new Error('selected-company registration');
    electron.handle.mockReset().mockImplementation((channel: string) => {
      if (channel === 'local-workspace:get-company') throw failure;
      handlers.add(channel); registered.push(channel);
    });
    electron.removeHandler.mockReset().mockImplementation((channel: string) => { handlers.delete(channel); });
    const gate: Gate = {
      withDatabase: async () => { throw new Error('unexpected storage operation'); },
      withDomain: async () => { throw new Error('unexpected domain operation'); },
      getHealth: async () => { throw new Error('unexpected health operation'); },
    };
    const storage = vi.spyOn(gate, 'withDatabase');
    const domain = vi.spyOn(gate, 'withDomain');
    try {
      expect(() => registerApplicationIpc(gate, undefined, undefined, recoveryProvider)).toThrow(failure);
      expect([...handlers]).toEqual(['unrelated']);
      const removed = electron.removeHandler.mock.calls.map(call => call[0]);
      // Everything before get-company: the six earlier slices plus the first eight local channels.
      expect(registered).toHaveLength(REGISTERED_CHANNEL_COUNT - 15);
      expect(new Set(registered).size).toBe(REGISTERED_CHANNEL_COUNT - 15);
      expect([...removed].sort()).toEqual([...registered].sort());
      // Application disposes slices in reverse order. Each slice owns its
      // internal channel order, while local-workspace rolls its eight back in reverse.
      const slices = removed.map(channel => channel.split(':')[0]);
      expect(slices.filter((slice, index) => index === 0 || slice !== slices[index - 1])).toEqual(REVERSE_CHANNEL_SLICES);
      expect(removed.slice(0, 8)).toEqual([
        'local-workspace:company-create-status', 'local-workspace:create-company',
        'local-workspace:review-company', 'local-workspace:transition',
        'local-workspace:get-commitments', 'local-workspace:get',
        'local-workspace:update-company-research-settings', 'local-workspace:get-company-research-settings',
      ]);
      expect(storage).not.toHaveBeenCalled(); expect(domain).not.toHaveBeenCalled();
    } finally { vi.restoreAllMocks(); electron.handle.mockReset(); electron.removeHandler.mockReset(); }
  });
});

import { registerLocalWorkspaceIpc } from '../../src/main/workspace/registerLocalWorkspaceIpc';

import { FoundationRuntime } from '../../src/main/foundation/foundationRuntime';
import { DomainRuntime } from '../../src/main/domain/domainRuntime';
import { HealthService } from '../../src/main/health/healthService';
import { openDatabase, closeDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { createTempDatabase, createTestWorkspaceKey } from '../fixtures/tempDatabase';
import { dirname, join } from 'node:path';
import { AccountRepository } from '../../src/main/domain/accounts/accountRepository';
import type { SelectedCompanyResearchPort } from '../../src/main/workspace/localWorkspaceProvider';
import type { SelectedResearch } from '../../src/shared/contracts/localWorkspaceContract';
const task3LocalChannels = [
  'local-workspace:get-company-research-settings', 'local-workspace:update-company-research-settings',
  'local-workspace:get', 'local-workspace:get-commitments', 'local-workspace:transition',
  'local-workspace:review-company', 'local-workspace:create-company', 'local-workspace:company-create-status',
  'local-workspace:get-company', 'local-workspace:research-company', 'local-workspace:company-research-status',
  'local-workspace:link-company-person', 'local-workspace:get-call-settings', 'local-workspace:update-call-settings',
  'local-workspace:admit-company-draft-email', 'local-workspace:admit-company-phone-route', 'local-workspace:open-company-draft', 'local-workspace:get-company-draft', 'local-workspace:save-company-draft', 'local-workspace:prepare-company-draft',
  'local-workspace:territory-clearance-read', 'local-workspace:territory-clearance-confirm', 'local-workspace:territory-clearance-revoke',
];
/** Channels registered by the six slices ahead of local-workspace. */
const EARLIER_SLICE_CHANNEL_COUNT = REGISTERED_CHANNEL_COUNT - task3LocalChannels.length;
async function task3ApplicationFixture() {
  const temp = createTempDatabase(); const key = createTestWorkspaceKey();
  const runtime = new FoundationRuntime({ appVersion: '1', databasePath: temp.path, databaseExists: false,
    backupDirectory: join(dirname(temp.path), 'backups'), keyEnvelopePath: join(dirname(temp.path), 'envelope.json') }, {
    loadWorkspaceKey: async () => ({ ...key, bytes: Buffer.from(key.bytes) }), prepareEncryptedDatabase: async () => undefined,
    openDatabase, closeDatabase, migrateToLatest,
    createDomainRuntime: database => new DomainRuntime({ database, clock: { now: () => PM_NOW }, ids: { next: () => crypto.randomUUID() } }),
    createHealthService: options => new HealthService(options),
  });
  try {
    const selected = await runtime.withDatabase(database => {
      const repo = new AccountRepository({ database, clock: { now: () => PM_NOW }, ids: { next: () => crypto.randomUUID() } });
      const account = repo.create({ commandId: crypto.randomUUID(), name: 'Application selected', domain: null });
      const input = { commandId: crypto.randomUUID(), accountId: account.id };
      repo.enqueue({ ...input, limits: { maxCompanies: 1, maxPages: 1, maxBytes: 10000, maxCostMicros: 100 } });
      return input;
    });
    const read = (input: SelectedResearch) => runtime.withDatabase(database => new AccountRepository({ database, clock: { now: () => PM_NOW }, ids: { next: () => crypto.randomUUID() } }).readSelectedResearch(input));
    return { runtime, selected, read, async close() { await runtime.shutdown(); key.bytes.fill(0); temp.cleanup(); } };
  } catch (error) { await runtime.shutdown(); key.bytes.fill(0); temp.cleanup(); throw error; }
}

describe('Task 3 application selected capability registration', () => {
  it('appends exactly two channels without implicit work and resolves the current capability only on explicit execution', async () => {
    const f = await task3ApplicationFixture(); let dispose: (() => void) | undefined;
    electron.handle.mockReset(); electron.removeHandler.mockReset();
    try {
      const first = { researchCompany: vi.fn(f.read) }; const second = { researchCompany: vi.fn(f.read) };
      let port: SelectedCompanyResearchPort | null = first;
      const current = vi.fn(() => port);
      const storage = vi.spyOn(f.runtime, 'withDatabase'); const domain = vi.spyOn(f.runtime, 'withDomain');
      dispose = registerApplicationIpc(f.runtime, undefined, undefined, recoveryProvider,
        undefined, undefined, { selectedCompanyResearch: { current } });
      expect(storage).not.toHaveBeenCalled(); expect(domain).not.toHaveBeenCalled(); expect(current).not.toHaveBeenCalled();
      expect(first.researchCompany).not.toHaveBeenCalled(); expect(second.researchCompany).not.toHaveBeenCalled();
      const registered = electron.handle.mock.calls.map(call => call[0]);
      expect(registered).toHaveLength(REGISTERED_CHANNEL_COUNT); expect(new Set(registered).size).toBe(REGISTERED_CHANNEL_COUNT);
      expect(registered.filter(channel => channel.startsWith('local-workspace:'))).toEqual(task3LocalChannels);
      const api = createCallieApi({ invoke: async (channel, ...args) => registeredIpcHandler(electron.handle, channel)({ senderFrame: { url: 'callie://app/index.html' } }, ...args) });
      expect(typeof api.localWorkspace.researchCompany).toBe('function');
      expect(await api.localWorkspace.getCompanyResearchStatus(f.selected)).toMatchObject({ ...f.selected, state: 'queued' });
      expect(first.researchCompany).not.toHaveBeenCalled(); expect(second.researchCompany).not.toHaveBeenCalled();
      expect(await api.localWorkspace.researchCompany(f.selected)).toEqual(await f.read(f.selected));
      expect(first.researchCompany).toHaveBeenCalledTimes(1); expect(first.researchCompany).toHaveBeenLastCalledWith(f.selected);
      port = second;
      expect(await api.localWorkspace.getCompanyResearchStatus(f.selected)).toMatchObject({ ...f.selected, state: 'queued' });
      expect(second.researchCompany).not.toHaveBeenCalled();
      expect(await api.localWorkspace.researchCompany(f.selected)).toEqual(await f.read(f.selected));
      expect(second.researchCompany).toHaveBeenCalledTimes(1); expect(first.researchCompany).toHaveBeenCalledTimes(1);
      port = null;
      expect(await api.localWorkspace.researchCompany(f.selected)).toMatchObject({ ...f.selected, state: 'queued' });
      expect(await api.localWorkspace.getCompanyResearchStatus(f.selected)).toMatchObject({ ...f.selected, state: 'queued' });
      expect(second.researchCompany).toHaveBeenCalledTimes(1);
      dispose(); dispose();
      const removed = electron.removeHandler.mock.calls.map(call => call[0]);
      expect(removed.slice(0, task3LocalChannels.length)).toEqual([...task3LocalChannels].reverse());
      expect([...removed].sort()).toEqual([...registered].sort());
      expect(new Set(removed).size).toBe(REGISTERED_CHANNEL_COUNT);
    } finally { dispose?.(); vi.restoreAllMocks(); await f.close(); electron.handle.mockReset(); electron.removeHandler.mockReset(); }
  });

  it.each(['local-workspace:research-company', 'local-workspace:company-research-status'])('rolls back append-only local registrations and earlier features exactly once when %s fails', channel => {
    const active = new Set(['unrelated']); const registered: string[] = [];
    const failure = new Error('selected research registration');
    electron.handle.mockReset().mockImplementation((name: string) => { if (name === channel) throw failure; active.add(name); registered.push(name); });
    electron.removeHandler.mockReset().mockImplementation((name: string) => { active.delete(name); });
    const gate = fakeGate(); const current = vi.fn(() => null);
    try {
      expect(() => registerApplicationIpc(gate, undefined, undefined, recoveryProvider,
        undefined, undefined, { selectedCompanyResearch: { current } })).toThrow(failure);
      expect([...active]).toEqual(['unrelated']);
      const localCount = task3LocalChannels.indexOf(channel);
      expect(registered).toHaveLength(EARLIER_SLICE_CHANNEL_COUNT + localCount);
      const removed = electron.removeHandler.mock.calls.map(call => call[0]);
      expect(removed.slice(0, localCount)).toEqual(task3LocalChannels.slice(0, localCount).reverse());
      expect([...removed].sort()).toEqual([...registered].sort()); expect(new Set(removed).size).toBe(registered.length);
      const slices = removed.map(name => name.split(':')[0]);
      expect(slices.filter((slice, index) => index === 0 || slice !== slices[index - 1])).toEqual(REVERSE_CHANNEL_SLICES);
      expect(current).not.toHaveBeenCalled(); expect(gate.withDatabase).not.toHaveBeenCalled(); expect(gate.withDomain).not.toHaveBeenCalled();
    } finally { electron.handle.mockReset(); electron.removeHandler.mockReset(); }
  });
});

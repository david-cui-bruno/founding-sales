import type { DiscoveryBrief, DiscoverySnapshot } from '../../src/shared/contracts/discoveryContract';
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
import type { SourcingStatus } from '../../src/shared/contracts/sourcingContract';
import type { SourcingProvider } from '../../src/main/sourcing/registerSourcingIpc';
import { startApplication, type ApplicationStartupDependencies } from '../../src/main/startApplication';
import { fakeDomainRuntime } from '../fixtures/fakeDomainRuntime';
import type { AppDatabase } from '../../src/main/db/database';
import type { SourcingPoller } from '../../src/main/sourcing/sourcingPoller';
import { createOutboundCommandService } from '../../src/main/communications/outboundCommandService';
import type { OutboundCommandServiceApi } from '../../src/main/communications/outboundPorts';
import { registeredIpcHandler } from '../fixtures/registeredIpcHandler';
import { createCallieApi } from '../../src/preload/createCallieApi';
import { registerLeadDetailIpc } from '../../src/main/leads/registerLeadDetailIpc';
import {
  createConversationsProvider,
  createFridayProvider,
  createImportProvider,
  createLeadDetailProvider,
  createLeadsProvider,
  createLearningsProvider,
  createPipelineProvider,
  createReviewProvider,
  createShellProvider,
  createTodayProvider,
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

const explicitSourcingProvider = (): SourcingProvider => {
  const status = {
    lastPolledAt: null, lastKey: null, backlogCount: null,
    counters: { imported: 0, replayed: 0, needsIdentity: 0, scoreUpdates: 0, quarantined: 0 },
    credentialState: 'none', hmacSaltState: 'none',
    execution: {
      state: 'idle', pollId: null, startedAt: null, lastCompletedAt: null,
      consecutiveFailures: 0, lastFailureAt: null, lastFailureCode: null, backlogCount: null,
    },
    health: {
      status: 'healthy', reasons: [], lastSuccessAgeMs: null,
      state: {
        state: 'idle', pollId: null, startedAt: null, lastCompletedAt: null,
        consecutiveFailures: 0, lastFailureAt: null, lastFailureCode: null, backlogCount: null,
      },
    },
  } as SourcingStatus;
  return {
    pollNow: async () => status, retry: async () => status,
    status: async () => status, setHmacSalt: async () => status,
  };
};

describe('registerApplicationIpc', () => {
  const degradedHealth: AppHealth = {
    appVersion: '1.0.0', schemaVersion: 14, databasePath: '/fixture.sqlite3',
    databaseEncrypted: true, cipherVersion: 'cipher', fts5Available: true,
    pendingJobs: 0, interruptedJobsRecovered: 0, domainStatus: 'ready', domainReady: true,
    domainBlockingViolationCount: 0, domainRepairableIssueCount: 0,
    domainProjectionRefreshCandidateCount: 0, pendingProjectionRebuilds: 0,
    domainStartupEvaluatedAt: '2026-09-01T12:00:00.000Z', operationalStatus: 'degraded',
    sourcing: {
      status: 'degraded', reasons: ['POLL_EXCEEDED_TOTAL_DEADLINE'], lastSuccessAgeMs: null,
      state: {
        state: 'running', pollId: 'poll-real', startedAt: '2026-09-01T11:45:00.000Z',
        lastCompletedAt: null, consecutiveFailures: 0, lastFailureAt: null,
        lastFailureCode: null, backlogCount: null,
      },
    },
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
      registerTodayIpc: track('today', unregisters[3]!),
      registerPipelineIpc: track('pipeline', unregisters[4]!),
      registerReviewIpc: track('review', unregisters[5]!),
      registerFridayIpc: track('friday', unregisters[6]!),
      registerImportIpc: track('imports', unregisters[7]!),
      registerConversationsIpc: track('conversations', unregisters[8]!),
      registerLearningsIpc: track('learnings', unregisters[9]!),
      registerSourcingIpc: track('sourcing', unregisters[10]!),
      registerShellIpc: track('shell', unregisters[11]!),
      registerRecoveryIpc: track('recovery', unregisters[12]!),
      registerDiscoveryIpc: track('discovery', unregisters[13]!),
      registerDailyIpc: track('daily', unregisters[14]!),
      registerLocalWorkspaceIpc: track('localWorkspace', unregisters[15]!),
    } as unknown as FeatureRegistrars;
    return { registrars, calls };
  }

  it.each(['outer', 'nested'] as const)('startup consumes accepted %s IPC rollback and closes outbound despite cleanup errors', async (failureAt) => {
    const handlers = new Set<string>(); const features = new Set<string>(); const listeners = new Set<() => void>();
    const registrationError = new Error('registration'); const cleanupError = new Error('cleanup');
    const { registrars } = fakeRegistrars([]);
    for (const name of Object.keys(registrars) as (keyof FeatureRegistrars)[]) {
      registrars[name] = vi.fn(() => {
        if (failureAt === 'outer' && name === 'registerTodayIpc') throw registrationError;
        features.add(name);
        return () => { features.delete(name); if (name === 'registerHealthIpc') throw cleanupError; };
      });
    }
    registrars.registerLeadDetailIpc = registerLeadDetailIpc;
    electron.handle.mockReset().mockImplementation((channel: string) => {
      if (failureAt === 'nested' && channel === 'lead-detail:outbound-capabilities') throw registrationError;
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
      createDomainRuntime: () => fakeDomainRuntime(), createHealthService: () => ({ getHealth: () => degradedHealth }),
      createSourcingPoller: () => ({ getHealth: () => degradedHealth.sourcing, stop: (): void => undefined,
        idle: async (): Promise<void> => undefined }) as unknown as SourcingPoller,
      createBackupService: () => ({ start: async () => undefined, shutdown: async () => undefined,
        listAvailableBackups: async () => [], createBackup: async () => { throw new Error('unexpected backup'); } }),
      createRecoveryService: () => ({ ...recoveryProvider, shutdown: async () => undefined }),
      createOutboundCommandService: (input) => { service = createOutboundCommandService(input); dispose.mockImplementation(() => service.dispose()); return { ...service, dispose }; },
      registerApplicationIpc: (runtime, trust, _unused, sourcing, recovery, shell, enrichment, logs, outbound) =>
        registerApplicationIpc(runtime, trust, registrars, sourcing, recovery, shell, enrichment, logs, outbound),
      createAppleBridgeSupervisor: () => { throw new Error('unexpected helper'); }, closeDatabase: close,
    };
    const error = await startApplication({ appVersion: '1', userDataPath: '/fixture/rollback', createWindow: window,
      registerOutboundLifecycle: (owned) => { Object.values(owned).forEach((callback) => listeners.add(callback)); return () => listeners.clear(); },
    }, dependencies).catch((caught: unknown) => caught) as AggregateError;
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
    const registration = vi.fn<typeof registerApplicationIpc>((runtime, trust, _unused, sourcing, recovery, shell, enrichment, logs, outbound) =>
      registerApplicationIpc(runtime, trust, registrars, sourcing, recovery, shell, enrichment, logs, outbound));
    const dependencies: ApplicationStartupDependencies = {
      loadWorkspaceKey: async () => ({ bytes: Buffer.alloc(32, 0x2a), version: 1 }),
      prepareEncryptedDatabase: async () => undefined,
      openDatabase: opened,
      migrateToLatest: async () => ({ fromVersion: 0, toVersion: 2, appliedMigrationIds: [] }),
      createDomainRuntime: domainCreated, createHealthService: () => ({ getHealth: () => degradedHealth }),
      createSourcingPoller: () => ({ getHealth: () => degradedHealth.sourcing, stop: (): void => undefined,
        idle: async (): Promise<void> => undefined }) as unknown as SourcingPoller,
      createBackupService: () => ({ start: async () => undefined, shutdown: async () => undefined,
        listAvailableBackups: async () => [], createBackup: async () => { throw new Error('unexpected backup'); } }),
      createRecoveryService: () => ({ ...recoveryProvider, shutdown: async () => undefined }),
      createOutboundCommandService: (input) => { service = createOutboundCommandService(input); dispose.mockImplementation(() => service.dispose()); return { ...service, dispose }; },
      registerApplicationIpc: registration,
      createAppleBridgeSupervisor: () => { throw new Error('unexpected helper'); }, closeDatabase: close,
    };
    const error = await startApplication({ appVersion: '1', userDataPath: '/fixture/rollback', createWindow: window,
      registerOutboundLifecycle: (owned) => { Object.values(owned).forEach((callback) => listeners.add(callback)); return () => listeners.clear(); },
    }, dependencies).catch((caught: unknown) => caught) as AggregateError;
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

  it.each([3, 7, 13, 14, 15, 16])('rolls back all successful outer registrations when registrar %s fails', (nth) => {
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
    try { registerApplicationIpc(fakeGate(), undefined, registrars, explicitSourcingProvider(), recoveryProvider); } catch (error) { caught = error; }
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
    const dispose = registerApplicationIpc(fakeGate(), undefined, registrars, explicitSourcingProvider(), recoveryProvider);
    expect(dispose).toThrow();
    expect(registry.size).toBe(0);
    expect(order).toEqual(Object.keys(registrars).reverse());
    expect(dispose).not.toThrow();
    expect(order).toHaveLength(16);
  });

  it('leases the current domain separately for every actual discovery handler invocation', async () => {
    electron.handle.mockReset(); electron.removeHandler.mockReset();
    const snapshot: DiscoverySnapshot = { prepared: [], judgment: [], counts: { unassessed: 1, research: 0, watch: 0, excluded: 0 },
      processing: 'idle' as const, researchCapability: 'not_configured' as const, generatedAt: '2026-09-06T12:00:00.000Z', revision: 0 };
    const brief: DiscoveryBrief = { personId: 'p', salesCycleId: 's', personName: 'Synthetic Owner', assessment: null,
      stale: false, latestOverride: null, pilotNextStep: null };
    const request = { commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', personId: 'p', salesCycleId: 's',
      assessmentId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', expectedFingerprint: 'a'.repeat(64) };
    const mutation = { revision: 1, affectedPersonIds: ['p'], affectedSalesCycleIds: ['s'] };
    const receipt = { mutation, personId: 'p', salesCycleId: 's', assessmentId: request.assessmentId, actionId: 'a' };
    let current: Partial<FounderSalesDomain> = { getDiscovery: () => snapshot };
    const gate: Gate = { withDatabase: vi.fn(), getHealth: vi.fn(), withDomain: vi.fn(async operation => operation(current as FounderSalesDomain)) };
    const dispose = registerApplicationIpc(gate, undefined, undefined, explicitSourcingProvider(), recoveryProvider);
    expect(gate.withDomain).not.toHaveBeenCalled();
    const api = createCallieApi({ invoke: (channel, ...args) => Promise.resolve(
      registeredIpcHandler(electron.handle, channel)({ senderFrame: { url: 'callie://app/index.html' } }, ...args)) });
    await expect(api.discovery.get()).resolves.toEqual(snapshot);
    current = { getDiscoveryBrief: personId => { expect(personId).toBe('p'); return brief; } };
    await expect(api.discovery.getBrief({ personId: 'p' })).resolves.toEqual(brief);
    current = { beginDiscovery: input => { expect(input).toEqual(request); return receipt; } };
    await expect(api.discovery.begin(request)).resolves.toEqual(receipt);
    const override = { commandId: request.commandId, personId: 'p', assessmentId: request.assessmentId,
      expectedFingerprint: request.expectedFingerprint, decision: 'watch' as const, reason: 'Founder context' };
    current = { overrideDiscovery: input => { expect(input).toEqual(override); return mutation; } };
    await expect(api.discovery.override(override)).resolves.toEqual(mutation);
    expect(gate.withDomain).toHaveBeenCalledTimes(4);
    dispose();
  });

  it('rolls back prior application handlers if discovery registration partially fails', () => {
    const handlers = new Set(['unrelated']); const failure = new Error('discovery registration');
    electron.handle.mockReset().mockImplementation((channel: string) => {
      if (channel === 'discovery:begin') throw failure;
      handlers.add(channel);
    });
    electron.removeHandler.mockReset().mockImplementation((channel: string) => { handlers.delete(channel); });
    expect(() => registerApplicationIpc(fakeGate(), undefined, undefined, explicitSourcingProvider(), recoveryProvider)).toThrow(failure);
    expect([...handlers]).toEqual(['unrelated']);
    electron.handle.mockReset(); electron.removeHandler.mockReset();
  });

  it('uses the ninth outbound service argument without displacing enrichment or shell arguments', async () => {
    const request = { commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', channel: 'call' as const,
      personId: 'p', salesCycleId: 's', contactMethodId: 'c', expectedContactSnapshot: 'a'.repeat(64) };
    const receipt = { commandId: request.commandId, channel: 'call' as const, status: 'unknown' as const,
      reasonCode: 'handoff_uncertain' as const, mutation: { revision: 1, affectedPersonIds: ['p'], affectedSalesCycleIds: ['s'] } };
    const outbound = { beginOutbound: vi.fn(async () => receipt), getCapabilities: vi.fn(), invalidate: vi.fn(), resumeAfterUnlock: vi.fn(), dispose: vi.fn() };
    const enrichment = { request: vi.fn(async () => ({ written: false, refusalReason: 'credentials_unavailable' as const })) };
    const shell = { revealDatabase: vi.fn(), revealLogDirectory: vi.fn() };
    const { registrars } = fakeRegistrars(Array.from({ length: 16 }, () => vi.fn()));
    const registerDetail = vi.fn<FeatureRegistrars['registerLeadDetailIpc']>(() => vi.fn());
    registrars.registerLeadDetailIpc = registerDetail;
    const gate = fakeGate();
    registerApplicationIpc(gate, undefined, registrars, explicitSourcingProvider(), recoveryProvider,
      shell, enrichment, '/fixture/logs', outbound);
    const provider = registerDetail.mock.calls[0][0];
    await expect(provider.beginOutbound(request)).resolves.toEqual(receipt);
    await provider.getOutboundCapabilities();
    await provider.findContactInfo({ personId: 'p' });
    expect(outbound.beginOutbound).toHaveBeenCalledWith(request);
    expect(outbound.getCapabilities).toHaveBeenCalledTimes(1);
    expect(enrichment.request).toHaveBeenCalledWith({ personId: 'p' });
    expect(registrars.registerShellIpc).toHaveBeenCalledWith(shell, undefined);
    expect(gate.withDomain).not.toHaveBeenCalled();
  });

  it('registers all sixteen feature slices and unregisters each exactly once', () => {
    const unregisters = Array.from({ length: 16 }, () => vi.fn());
    const { registrars, calls } = fakeRegistrars(unregisters);

    const unregister = registerApplicationIpc(
      fakeGate(), undefined, registrars, explicitSourcingProvider(), recoveryProvider,
    );
    expect(calls).toEqual([
      'health', 'leads', 'leadDetail', 'today',
      'pipeline', 'review', 'friday', 'imports',
      'conversations', 'learnings', 'sourcing', 'shell', 'recovery', 'discovery', 'daily', 'localWorkspace',
    ]);

    unregister();
    unregister();
    expect(unregisters.every((fn) => fn.mock.calls.length === 1)).toBe(true);
  });

  it('unregisters slices in reverse registration order', () => {
    const order: string[] = [];
    const unregisters = [
      'health', 'leads', 'leadDetail', 'today',
      'pipeline', 'review', 'friday', 'imports',
      'conversations', 'learnings', 'sourcing', 'shell', 'recovery', 'discovery', 'daily', 'localWorkspace',
    ].map((name) => vi.fn(() => order.push(name)));
    const { registrars } = fakeRegistrars(unregisters);

    registerApplicationIpc(fakeGate(), undefined, registrars, explicitSourcingProvider(), recoveryProvider)();
    expect(order).toEqual([
      'localWorkspace', 'daily', 'discovery', 'recovery', 'shell', 'sourcing', 'learnings', 'conversations',
      'imports', 'friday', 'review', 'pipeline',
      'today', 'leadDetail', 'leads', 'health',
    ]);
  });

  it('passes the trusted-URL predicate to every slice registrar', () => {
    const unregisters = Array.from({ length: 16 }, () => vi.fn());
    const { registrars } = fakeRegistrars(unregisters);
    const trust = (url: string) => url.startsWith('app://');

    registerApplicationIpc(fakeGate(), trust, registrars, explicitSourcingProvider(), recoveryProvider);
    for (const registrar of Object.values(registrars)) {
      const args = vi.mocked(registrar).mock.calls[0]!;
      expect(args.length === 1 ? (args[0] as { isTrustedRendererUrl?: unknown }).isTrustedRendererUrl : args[1]).toBe(trust);
    }
  });

  it('registers the primary runtime health unchanged instead of overlaying sourcing IPC status', async () => {
    const unregisters = Array.from({ length: 16 }, () => vi.fn());
    const { registrars } = fakeRegistrars(unregisters);
    let registeredHealth: { getHealth(): Promise<unknown> } | undefined;
    registrars.registerHealthIpc = vi.fn((provider) => {
      registeredHealth = provider;
      return unregisters[0]!;
    });
    const runtime = fakeGate();
    vi.mocked(runtime.getHealth).mockResolvedValue(degradedHealth);
    const healthySourcing = {
      health: {
        status: 'healthy', reasons: [], lastSuccessAgeMs: null,
        state: {
          state: 'idle', pollId: null, startedAt: null, lastCompletedAt: null,
          consecutiveFailures: 0, lastFailureAt: null, lastFailureCode: null, backlogCount: null,
        },
      },
    } as SourcingStatus;

    registerApplicationIpc(runtime, undefined, registrars, {
      pollNow: async () => healthySourcing,
      retry: async () => healthySourcing,
      status: async () => healthySourcing,
      setHmacSalt: async () => healthySourcing,
    }, recoveryProvider);

    await expect(registeredHealth?.getHealth()).resolves.toEqual(degradedHealth);
  });

  it('rejects a missing sourcing provider instead of registering a healthy fallback', () => {
    const unregisters = Array.from({ length: 16 }, () => vi.fn());
    const { registrars, calls } = fakeRegistrars(unregisters);

    expect(() => registerApplicationIpc(
      fakeGate(), undefined, registrars, undefined as never, recoveryProvider,
    )).toThrow('Sourcing provider is required.');
    expect(calls).toEqual([]);
  });

  it('retains the original thirty gated provider smoke cases', async () => {
    const domain = {
      listLeadRows: vi.fn(() => 'lead-rows'),
      updateLeadField: vi.fn(() => 'updated'),
      bulkUpdateLeads: vi.fn(() => 'bulk'),
      getLeadDetail: vi.fn(() => 'detail'),
      recordOutboundRefusal: vi.fn(() => 'outbound'),
      confirmTransition: vi.fn(() => 'transition'),
      getToday: vi.fn(() => 'today'),
      completePrimaryAction: vi.fn(() => 'complete'),
      snoozePrimaryAction: vi.fn(() => 'snooze'),
      pinWithinLane: vi.fn(() => 'pin'),
      logPastActivity: vi.fn(() => 'log'),
      getPipelineProjection: vi.fn(() => 'pipeline'),
      listReviewItems: vi.fn(() => 'reviews'),
      resolveReviewItem: vi.fn(() => 'resolved'),
      getFridayReport: vi.fn(() => 'friday'),
      getMetricDrilldown: vi.fn(() => 'drilldown'),
      createJobRequest: vi.fn(() => 'job-created'),
      markJobFilled: vi.fn(() => 'job-filled'),
      cancelJobRequest: vi.fn(() => 'job-cancelled'),
      previewLeadImport: vi.fn(() => 'preview'),
      remapLeadImport: vi.fn(() => 'remap'),
      commitLeadImport: vi.fn(() => 'commit'),
      getImportJob: vi.fn(() => 'status'),
      listConversations: vi.fn(() => 'conversations'),
      getConversationDetail: vi.fn(() => 'conversation-detail'),
      attachTranscript: vi.fn(() => 'transcript-attached'),
      listLearnings: vi.fn(() => 'learnings'),
      captureLearning: vi.fn(() => 'learning-captured'),
      addLearningEvidence: vi.fn(() => 'evidence-added'),
      updateLearningStatus: vi.fn(() => 'status-updated'),
    } as unknown as FounderSalesDomain;
    const gate = fakeGate(domain);

    const leads = createLeadsProvider(gate);
    await expect(leads.list({} as never)).resolves.toBe('lead-rows');
    await expect(leads.updateField({} as never)).resolves.toBe('updated');
    await expect(leads.bulkUpdate({} as never)).resolves.toBe('bulk');

    const detail = createLeadDetailProvider(gate);
    await expect(detail.get({} as never)).resolves.toBe('detail');
    await expect(detail.beginOutbound({} as never)).resolves.toBe('outbound');
    await expect(detail.confirmTransition({} as never)).resolves.toBe('transition');

    const today = createTodayProvider(gate);
    await expect(today.get()).resolves.toBe('today');
    await expect(today.complete({} as never)).resolves.toBe('complete');
    await expect(today.snooze({} as never)).resolves.toBe('snooze');
    await expect(today.pin({} as never)).resolves.toBe('pin');
    await expect(today.logPastActivity({} as never)).resolves.toBe('log');

    await expect(createPipelineProvider(gate).get()).resolves.toBe('pipeline');

    const review = createReviewProvider(gate);
    await expect(review.list({} as never)).resolves.toBe('reviews');
    await expect(review.resolve({} as never)).resolves.toBe('resolved');

    const friday = createFridayProvider(gate);
    await expect(friday.getCurrent()).resolves.toBe('friday');
    await expect(friday.getDrilldown({} as never)).resolves.toBe('drilldown');
    await expect(friday.createJob({} as never)).resolves.toBe('job-created');
    await expect(friday.fillJob({} as never)).resolves.toBe('job-filled');
    await expect(friday.cancelJob({} as never)).resolves.toBe('job-cancelled');

    const imports = createImportProvider(gate);
    await expect(imports.preview({} as never)).resolves.toBe('preview');
    await expect(imports.remap({} as never)).resolves.toBe('remap');
    await expect(imports.commit({} as never)).resolves.toBe('commit');
    await expect(imports.status({} as never)).resolves.toBe('status');

    const conversations = createConversationsProvider(gate);
    await expect(conversations.list({} as never)).resolves.toBe('conversations');
    await expect(conversations.get({} as never)).resolves.toBe('conversation-detail');
    await expect(conversations.attachTranscript({} as never)).resolves.toBe(
      'transcript-attached',
    );

    const learnings = createLearningsProvider(gate);
    await expect(learnings.list({} as never)).resolves.toBe('learnings');
    await expect(learnings.capture({} as never)).resolves.toBe('learning-captured');
    await expect(learnings.addEvidence({} as never)).resolves.toBe('evidence-added');
    await expect(learnings.updateStatus({} as never)).resolves.toBe('status-updated');

    expect(gate.withDomain).toHaveBeenCalledTimes(30);
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
      operationalStatus: 'ready',
      sourcing: {
        status: 'healthy', reasons: [], lastSuccessAgeMs: null,
        state: {
          state: 'idle', pollId: null, startedAt: null, lastCompletedAt: null,
          consecutiveFailures: 0, lastFailureAt: null, lastFailureCode: null,
          backlogCount: null,
        },
      },
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
describe('all40 shipped provider mappings and owned detail exceptions', () => {
  const at = '2026-09-10T15:00:00.000Z';
  const person = { personId: 'mapping-person' };
  const outboundInput = { commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ...person, salesCycleId: 'mapping-cycle',
    channel: 'call' as const, contactMethodId: 'mapping-phone', expectedContactSnapshot: 'a'.repeat(64) };
  type Mapping = { name: string; facade: keyof FounderSalesDomain; factory: (gate: Gate) => object; method: string; args: unknown[]; forwarded?: unknown[] };
  const cases: Mapping[] = [
    { name: 'leads.list', facade: 'listLeadRows', factory: createLeadsProvider, method: 'list', args: [{ query: 'map', stages: [], priorities: [], sort: 'person_name', cursor: null, limit: 7 }] },
    { name: 'leads.updateField', facade: 'updateLeadField', factory: createLeadsProvider, method: 'updateField', args: [{ personId: 'p', field: 'person_name', value: 'Mapped name' }] },
    { name: 'leads.bulkUpdate', facade: 'bulkUpdateLeads', factory: createLeadsProvider, method: 'bulkUpdate', args: [{ personIds: ['p', 'q'], field: 'organization_label', value: 'Mapped organization' }] },
    { name: 'detail.get', facade: 'getLeadDetail', factory: createLeadDetailProvider, method: 'get', args: [person] },
    { name: 'detail.beginOutbound', facade: 'recordOutboundRefusal', factory: createLeadDetailProvider, method: 'beginOutbound', args: [outboundInput], forwarded: [outboundInput, 'phone_route_unverified'] },
    { name: 'detail.confirmTransition', facade: 'confirmTransition', factory: createLeadDetailProvider, method: 'confirmTransition', args: [{ salesCycleId: 'c', transition: 'review_to_ready', expectedRevision: 8 }] },
    { name: 'detail.dismissLead', facade: 'dismissLead', factory: createLeadDetailProvider, method: 'dismissLead', args: [{ ...person, salesCycleId: 'c', qualificationGateReason: 'out_of_area', expectedRevision: 9 }] },
    { name: 'detail.overrideCloudScore', facade: 'enqueueCloudScoreOverride', factory: createLeadDetailProvider, method: 'overrideCloudScore', args: [{ ...person, direction: 'down' }] },
    { name: 'today.get', facade: 'getToday', factory: createTodayProvider, method: 'get', args: [] },
    { name: 'today.complete', facade: 'completePrimaryAction', factory: createTodayProvider, method: 'complete', args: [{ salesCycleId: 'c', actionId: 'a', outcome: 'resolved', activityId: null }] },
    { name: 'today.snooze', facade: 'snoozePrimaryAction', factory: createTodayProvider, method: 'snooze', args: [{ salesCycleId: 'c', resurfaceAt: at }] },
    { name: 'today.pin', facade: 'pinWithinLane', factory: createTodayProvider, method: 'pin', args: [{ salesCycleId: 'c', reason: 'choice', expiresAt: at, comparedSalesCycleId: 'd' }] },
    { name: 'today.logPastActivity', facade: 'logPastActivity', factory: createTodayProvider, method: 'logPastActivity', args: [{ ...person, salesCycleId: 'c', kind: 'note', direction: 'internal', occurredAt: at, summary: 'history', outcome: null }] },
    { name: 'today.addLeadNote', facade: 'addLeadNote', factory: createTodayProvider, method: 'addLeadNote', args: [{ ...person, salesCycleId: 'c', text: 'note' }] },
    { name: 'today.logCallOutcome', facade: 'logCallOutcome', factory: createTodayProvider, method: 'logCallOutcome', args: [{ ...person, salesCycleId: 'c', outcome: 'no_answer', callbackAt: null, occurredAt: at }] },
    { name: 'today.markActivityInError', facade: 'markActivityInError', factory: createTodayProvider, method: 'markActivityInError', args: [{ ...person, activityId: 'a', reason: 'Wrong date' }] },
    { name: 'today.getLeadTriageSnapshot', facade: 'getLeadTriageSnapshot', factory: createTodayProvider, method: 'getLeadTriageSnapshot', args: [{ limit: 17 }] },
    { name: 'today.getTriageQueue', facade: 'getTriageQueue', factory: createTodayProvider, method: 'getTriageQueue', args: [] },
    { name: 'today.setReviewPosition', facade: 'setReviewPosition', factory: createTodayProvider, method: 'setReviewPosition', args: [{ position: 13 }] },
    { name: 'pipeline.get', facade: 'getPipelineProjection', factory: createPipelineProvider, method: 'get', args: [] },
    { name: 'review.list', facade: 'listReviewItems', factory: createReviewProvider, method: 'list', args: [{ kinds: ['system_error'], cursor: null, limit: 11 }] },
    { name: 'review.resolve', facade: 'resolveReviewItem', factory: createReviewProvider, method: 'resolve', args: [{ kind: 'unmatched_communication', reviewId: 'r', expectedVersion: 2, action: 'mark_personal', personId: null, sourceEventId: null }] },
    { name: 'friday.getCurrent', facade: 'getFridayReport', factory: createFridayProvider, method: 'getCurrent', args: [], forwarded: [undefined] },
    { name: 'friday.getDrilldown', facade: 'getMetricDrilldown', factory: createFridayProvider, method: 'getDrilldown', args: [{ metricId: 'jobs_requested' }] },
    { name: 'friday.createJob', facade: 'createJobRequest', factory: createFridayProvider, method: 'createJob', args: [{ jobId: 'j', salesCycleId: null, requestedAt: at }] },
    { name: 'friday.fillJob', facade: 'markJobFilled', factory: createFridayProvider, method: 'fillJob', args: [{ jobId: 'j', contractorAcceptedAt: at }] },
    { name: 'friday.cancelJob', facade: 'cancelJobRequest', factory: createFridayProvider, method: 'cancelJob', args: [{ jobId: 'j' }] },
    { name: 'imports.preview', facade: 'previewLeadImport', factory: createImportProvider, method: 'preview', args: [{ kind: 'csv', sourceName: 'mapping.csv', content: 'Name\nMapped owner\n' }] },
    { name: 'imports.remap', facade: 'remapLeadImport', factory: createImportProvider, method: 'remap', args: [{ previewId: 'v', contentHash: 'a'.repeat(64), mapping: { Name: 'person_name' } }] },
    { name: 'imports.commit', facade: 'commitLeadImport', factory: createImportProvider, method: 'commit', args: [{ previewId: 'v', contentHash: 'a'.repeat(64), mapping: { Name: 'person_name' }, source: { channel: 'registry', referredByPersonId: null }, duplicateDecisions: [] }] },
    { name: 'imports.status', facade: 'getImportJob', factory: createImportProvider, method: 'status', args: [{ jobId: 'i' }] },
    { name: 'conversations.list', facade: 'listConversations', factory: createConversationsProvider, method: 'list', args: [{ filter: 'all', query: 'map', cursor: null, limit: 19 }] },
    { name: 'conversations.get', facade: 'getConversationDetail', factory: createConversationsProvider, method: 'get', args: [{ activityId: 'a' }] },
    { name: 'conversations.attachTranscript', facade: 'attachTranscript', factory: createConversationsProvider, method: 'attachTranscript', args: [{ ...person, activityId: 'a', rawText: 'Mapped transcript' }] },
    { name: 'learnings.list', facade: 'listLearnings', factory: createLearningsProvider, method: 'list', args: [{ categories: ['pain'], statuses: ['active'], query: 'map', limit: 23 }] },
    { name: 'learnings.capture', facade: 'captureLearning', factory: createLearningsProvider, method: 'capture', args: [{ category: 'pain', statement: 'Mapped learning', confidence: 'medium', evidence: [{ personId: null, activityId: null, quote: 'evidence', notedAt: at }], contradictionOf: null }] },
    { name: 'learnings.addEvidence', facade: 'addLearningEvidence', factory: createLearningsProvider, method: 'addEvidence', args: [{ learningId: 'l', expectedVersion: 3, evidence: { personId: null, activityId: null, quote: 'more', notedAt: at } }] },
    { name: 'learnings.updateStatus', facade: 'updateLearningStatus', factory: createLearningsProvider, method: 'updateStatus', args: [{ learningId: 'l', expectedVersion: 4, status: 'retired', reason: null }] },
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
    expect(method.mock.calls).toEqual([entry.forwarded ?? entry.args]);
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
  it('keeps Friday omitted, explicit undefined and explicit zero offset distinct at the facade', async () => {
    const getFridayReport = vi.fn(); const gate = fakeGate({ getFridayReport });
    const provider = createFridayProvider(gate); const zero = { weekOffset: 0 };
    await provider.getCurrent(); await provider.getCurrent(undefined); await provider.getCurrent(zero);
    expect(getFridayReport.mock.calls).toEqual([[undefined], [undefined], [zero]]);
    expect(getFridayReport.mock.calls[2]?.[0]).toBe(zero);
  });
  it.each(['text', 'email'] as const)('absent outbound %s records fixed channel refusal through the gate', async channel => {
    const input = { ...outboundInput, channel }; const value = { refused: channel };
    const recordOutboundRefusal = vi.fn(() => value);
    const gate = fakeGate({ recordOutboundRefusal } as unknown as Partial<FounderSalesDomain>);
    await expect(createLeadDetailProvider(gate).beginOutbound(input)).resolves.toBe(value);
    expect(recordOutboundRefusal.mock.calls).toEqual([[input, 'channel_unavailable']]);
    expect(gate.withDomain).toHaveBeenCalledTimes(1);
  });
  it('detail fixed capabilities and absent enrichment do not enter an unavailable gate', async () => {
    const gate = fakeGate(); vi.mocked(gate.withDomain).mockRejectedValue(new Error('gate unavailable'));
    const provider = createLeadDetailProvider(gate);
    const unavailable = { state: 'unavailable', reasonCode: 'not_integrated' };
    await expect(provider.getOutboundCapabilities()).resolves.toEqual({
      phoneHandoff: { state: 'unavailable', reasonCode: 'phone_route_unverified' },
      callObservation: unavailable, recording: unavailable, messagesSend: unavailable, gmailSend: unavailable,
      managedAudioImport: unavailable, appleTranscriptExtraction: unavailable, localDrafts: true,
    });
    await expect(provider.findContactInfo(person)).resolves.toEqual({ written: false, refusalReason: 'credentials_unavailable' });
    expect(gate.withDomain).not.toHaveBeenCalled(); expect(gate.getHealth).not.toHaveBeenCalled();
  });
  it('detail injected outbound, capabilities and enrichment own arguments, results and rejection without a gate', async () => {
    const gate = fakeGate(); vi.mocked(gate.withDomain).mockRejectedValue(new Error('gate unavailable'));
    const outbound: OutboundCommandServiceApi = { beginOutbound: vi.fn(), getCapabilities: vi.fn(), invalidate: vi.fn(), resumeAfterUnlock: vi.fn(), dispose: vi.fn() };
    const enrichment = { request: vi.fn() };
    const provider = createLeadDetailProvider(gate, enrichment, outbound);
    const routes = [
      { method: vi.mocked(outbound.beginOutbound), run: () => provider.beginOutbound(outboundInput), args: [outboundInput] },
      { method: vi.mocked(outbound.getCapabilities), run: () => provider.getOutboundCapabilities(), args: [] as unknown[] },
      { method: enrichment.request, run: () => provider.findContactInfo(person), args: [person] },
    ];
    for (const [index, route] of routes.entries()) {
      const value = { owner: index };
      route.method.mockResolvedValueOnce(value as never);
      await expect(route.run()).resolves.toBe(value);
      expect(route.method.mock.calls).toEqual([route.args]);
      const error = new Error(`owned:${index}`); route.method.mockRejectedValueOnce(error);
      await expect(route.run()).rejects.toBe(error);
    }
    expect(gate.withDomain).not.toHaveBeenCalled(); expect(gate.getHealth).not.toHaveBeenCalled();
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
      const sourcing = explicitSourcingProvider();
      const poll = vi.spyOn(sourcing, 'pollNow');
      const firstBefore = applicationCompanyState(first.db);
      const secondBefore = applicationCompanyState(second.db);
      dispose = registerApplicationIpc(gate, undefined, undefined, sourcing, recoveryProvider);
      expect(databaseLease).not.toHaveBeenCalled();
      expect(domainLease).not.toHaveBeenCalled();
      const registeredCount = electron.handle.mock.calls.length;
      expect(electron.handle.mock.calls.filter(call => call[0] === 'local-workspace:get-company')).toHaveLength(1);
      const api = createCallieApi({ invoke: async (channel, ...args) => registeredIpcHandler(electron.handle, channel)({ senderFrame: { url: 'callie://app/index.html' } }, ...args) });
      expect(await api.localWorkspace.getCompany({ accountId: a.id })).toEqual({ scope: 'local_database', generatedAt: PM_NOW, snapshot: first.repo.snapshot(a.id, PM_NOW), sources: [], links: [] });
      current = second.db;
      expect(await api.localWorkspace.getCompany({ accountId: b.id })).toEqual({ scope: 'local_database', generatedAt: PM_NOW, snapshot: second.repo.snapshot(b.id, PM_NOW), sources: [], links: [] });
      await expect(api.localWorkspace.getCompany({ accountId: a.id })).rejects.toThrow(/^LOCAL_COMPANY_READ_FAILED$/);
      current = undefined;
      await expect(api.localWorkspace.getCompany({ accountId: b.id })).rejects.toThrow(/^LOCAL_COMPANY_READ_FAILED$/);
      expect(databaseLease).toHaveBeenCalledTimes(4);
      expect(domainLease).not.toHaveBeenCalled(); expect(health).not.toHaveBeenCalled(); expect(poll).not.toHaveBeenCalled();
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
      expect(() => registerApplicationIpc(gate, undefined, undefined, explicitSourcingProvider(), recoveryProvider)).toThrow(failure);
      expect([...handlers]).toEqual(['unrelated']);
      const removed = electron.removeHandler.mock.calls.map(call => call[0]);
      expect(registered).toHaveLength(63);
      expect(new Set(registered).size).toBe(63);
      expect([...removed].sort()).toEqual([...registered].sort());
      // Application disposes slices in reverse order. Historical slices own their
      // internal channel order, while local-workspace rolls its six back in reverse.
      const slices = removed.map(channel => channel.split(':')[0]);
      expect(slices.filter((slice, index) => index === 0 || slice !== slices[index - 1])).toEqual([
        'local-workspace', 'daily', 'discovery', 'recovery', 'shell', 'sourcing',
        'learnings', 'conversations', 'imports', 'friday', 'review', 'pipeline',
        'today', 'lead-detail', 'leads', 'health',
      ]);
      expect(removed.slice(0, 6)).toEqual([
        'local-workspace:company-create-status', 'local-workspace:create-company',
        'local-workspace:review-company', 'local-workspace:transition',
        'local-workspace:get-commitments', 'local-workspace:get',
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
  'local-workspace:get', 'local-workspace:get-commitments', 'local-workspace:transition',
  'local-workspace:review-company', 'local-workspace:create-company', 'local-workspace:company-create-status',
  'local-workspace:get-company', 'local-workspace:research-company', 'local-workspace:company-research-status',
];
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
      dispose = registerApplicationIpc(f.runtime, undefined, undefined, explicitSourcingProvider(), recoveryProvider,
        undefined, undefined, undefined, undefined, { selectedCompanyResearch: { current } });
      expect(storage).not.toHaveBeenCalled(); expect(domain).not.toHaveBeenCalled(); expect(current).not.toHaveBeenCalled();
      expect(first.researchCompany).not.toHaveBeenCalled(); expect(second.researchCompany).not.toHaveBeenCalled();
      const registered = electron.handle.mock.calls.map(call => call[0]);
      expect(registered).toHaveLength(66); expect(new Set(registered).size).toBe(66);
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
      expect(removed.slice(0, 9)).toEqual([...task3LocalChannels].reverse());
      expect([...removed].sort()).toEqual([...registered].sort());
      expect(new Set(removed).size).toBe(66);
    } finally { dispose?.(); vi.restoreAllMocks(); await f.close(); electron.handle.mockReset(); electron.removeHandler.mockReset(); }
  });

  it.each(['local-workspace:research-company', 'local-workspace:company-research-status'])('rolls back append-only local registrations and earlier features exactly once when %s fails', channel => {
    const active = new Set(['unrelated']); const registered: string[] = [];
    const failure = new Error('selected research registration');
    electron.handle.mockReset().mockImplementation((name: string) => { if (name === channel) throw failure; active.add(name); registered.push(name); });
    electron.removeHandler.mockReset().mockImplementation((name: string) => { active.delete(name); });
    const gate = fakeGate(); const current = vi.fn(() => null);
    try {
      expect(() => registerApplicationIpc(gate, undefined, undefined, explicitSourcingProvider(), recoveryProvider,
        undefined, undefined, undefined, undefined, { selectedCompanyResearch: { current } })).toThrow(failure);
      expect([...active]).toEqual(['unrelated']);
      const localCount = task3LocalChannels.indexOf(channel);
      expect(registered).toHaveLength(57 + localCount);
      const removed = electron.removeHandler.mock.calls.map(call => call[0]);
      expect(removed.slice(0, localCount)).toEqual(task3LocalChannels.slice(0, localCount).reverse());
      expect([...removed].sort()).toEqual([...registered].sort()); expect(new Set(removed).size).toBe(registered.length);
      const slices = removed.map(name => name.split(':')[0]);
      expect(slices.filter((slice, index) => index === 0 || slice !== slices[index - 1])).toEqual([
        'local-workspace', 'daily', 'discovery', 'recovery', 'shell', 'sourcing', 'learnings', 'conversations',
        'imports', 'friday', 'review', 'pipeline', 'today', 'lead-detail', 'leads', 'health',
      ]);
      expect(current).not.toHaveBeenCalled(); expect(gate.withDatabase).not.toHaveBeenCalled(); expect(gate.withDomain).not.toHaveBeenCalled();
    } finally { electron.handle.mockReset(); electron.removeHandler.mockReset(); }
  });
});

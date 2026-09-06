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

  it.each([3, 7, 13])('rolls back all successful outer registrations when registrar %s fails', (nth) => {
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
    expect(order).toHaveLength(13);
  });

  it('uses the ninth outbound service argument without displacing enrichment or shell arguments', async () => {
    const request = { commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', channel: 'call' as const,
      personId: 'p', salesCycleId: 's', contactMethodId: 'c', expectedContactSnapshot: 'a'.repeat(64) };
    const receipt = { commandId: request.commandId, channel: 'call' as const, status: 'unknown' as const,
      reasonCode: 'handoff_uncertain' as const, mutation: { revision: 1, affectedPersonIds: ['p'], affectedSalesCycleIds: ['s'] } };
    const outbound = { beginOutbound: vi.fn(async () => receipt), getCapabilities: vi.fn(), invalidate: vi.fn(), resumeAfterUnlock: vi.fn(), dispose: vi.fn() };
    const enrichment = { request: vi.fn(async () => ({ written: false, refusalReason: 'credentials_unavailable' as const })) };
    const shell = { revealDatabase: vi.fn(), revealLogDirectory: vi.fn() };
    const { registrars } = fakeRegistrars(Array.from({ length: 13 }, () => vi.fn()));
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

  it('registers all thirteen feature slices and unregisters each exactly once', () => {
    const unregisters = Array.from({ length: 13 }, () => vi.fn());
    const { registrars, calls } = fakeRegistrars(unregisters);

    const unregister = registerApplicationIpc(
      fakeGate(), undefined, registrars, explicitSourcingProvider(), recoveryProvider,
    );
    expect(calls).toEqual([
      'health', 'leads', 'leadDetail', 'today',
      'pipeline', 'review', 'friday', 'imports',
      'conversations', 'learnings', 'sourcing', 'shell', 'recovery',
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
      'conversations', 'learnings', 'sourcing', 'shell', 'recovery',
    ].map((name) => vi.fn(() => order.push(name)));
    const { registrars } = fakeRegistrars(unregisters);

    registerApplicationIpc(fakeGate(), undefined, registrars, explicitSourcingProvider(), recoveryProvider)();
    expect(order).toEqual([
      'recovery', 'shell', 'sourcing', 'learnings', 'conversations',
      'imports', 'friday', 'review', 'pipeline',
      'today', 'leadDetail', 'leads', 'health',
    ]);
  });

  it('passes the trusted-URL predicate to every slice registrar', () => {
    const unregisters = Array.from({ length: 13 }, () => vi.fn());
    const { registrars } = fakeRegistrars(unregisters);
    const trust = (url: string) => url.startsWith('app://');

    registerApplicationIpc(fakeGate(), trust, registrars, explicitSourcingProvider(), recoveryProvider);
    for (const registrar of Object.values(registrars)) {
      expect(vi.mocked(registrar).mock.calls[0]![1]).toBe(trust);
    }
  });

  it('registers the primary runtime health unchanged instead of overlaying sourcing IPC status', async () => {
    const unregisters = Array.from({ length: 13 }, () => vi.fn());
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
    const unregisters = Array.from({ length: 13 }, () => vi.fn());
    const { registrars, calls } = fakeRegistrars(unregisters);

    expect(() => registerApplicationIpc(
      fakeGate(), undefined, registrars, undefined as never, recoveryProvider,
    )).toThrow('Sourcing provider is required.');
    expect(calls).toEqual([]);
  });

  it('routes every provider method through withDomain to the exact facade use case', async () => {
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

import { describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  showItemInFolder: vi.fn(),
}));

vi.mock('electron', () => ({
  shell: { showItemInFolder: electron.showItemInFolder },
}));

import type { FounderSalesDomain } from '../../src/main/domain/founderSalesDomain';
import type { AppHealth } from '../../src/shared/healthContract';
import type { SourcingStatus } from '../../src/shared/contracts/sourcingContract';
import type { SourcingProvider } from '../../src/main/sourcing/registerSourcingIpc';
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
    } as unknown as FeatureRegistrars;
    return { registrars, calls };
  }

  it('registers all twelve feature slices and unregisters each exactly once', () => {
    const unregisters = Array.from({ length: 12 }, () => vi.fn());
    const { registrars, calls } = fakeRegistrars(unregisters);

    const unregister = registerApplicationIpc(
      fakeGate(), undefined, registrars, explicitSourcingProvider(),
    );
    expect(calls).toEqual([
      'health', 'leads', 'leadDetail', 'today',
      'pipeline', 'review', 'friday', 'imports',
      'conversations', 'learnings', 'sourcing', 'shell',
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
      'conversations', 'learnings', 'sourcing', 'shell',
    ].map((name) => vi.fn(() => order.push(name)));
    const { registrars } = fakeRegistrars(unregisters);

    registerApplicationIpc(fakeGate(), undefined, registrars, explicitSourcingProvider())();
    expect(order).toEqual([
      'shell', 'sourcing', 'learnings', 'conversations',
      'imports', 'friday', 'review', 'pipeline',
      'today', 'leadDetail', 'leads', 'health',
    ]);
  });

  it('passes the trusted-URL predicate to every slice registrar', () => {
    const unregisters = Array.from({ length: 12 }, () => vi.fn());
    const { registrars } = fakeRegistrars(unregisters);
    const trust = (url: string) => url.startsWith('app://');

    registerApplicationIpc(fakeGate(), trust, registrars, explicitSourcingProvider());
    for (const registrar of Object.values(registrars)) {
      expect(vi.mocked(registrar).mock.calls[0]![1]).toBe(trust);
    }
  });

  it('registers the primary runtime health unchanged instead of overlaying sourcing IPC status', async () => {
    const unregisters = Array.from({ length: 12 }, () => vi.fn());
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
    });

    await expect(registeredHealth?.getHealth()).resolves.toEqual(degradedHealth);
  });

  it('rejects a missing sourcing provider instead of registering a healthy fallback', () => {
    const unregisters = Array.from({ length: 12 }, () => vi.fn());
    const { registrars, calls } = fakeRegistrars(unregisters);

    expect(() => registerApplicationIpc(
      fakeGate(), undefined, registrars, undefined as never,
    )).toThrow('Sourcing provider is required.');
    expect(calls).toEqual([]);
  });

  it('routes every provider method through withDomain to the exact facade use case', async () => {
    const domain = {
      listLeadRows: vi.fn(() => 'lead-rows'),
      updateLeadField: vi.fn(() => 'updated'),
      bulkUpdateLeads: vi.fn(() => 'bulk'),
      getLeadDetail: vi.fn(() => 'detail'),
      beginOutbound: vi.fn(() => 'outbound'),
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

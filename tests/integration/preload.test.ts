import type { LeadTriageSnapshot, LeadTriageEvidence } from '../../src/shared/contracts/leadTriageReportContract';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourcingStatus } from '../../src/shared/contracts/sourcingContract';
import type { AppHealth } from '../../src/shared/healthContract';

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: { invoke: electron.invoke },
}));

type ExposedCallieApi = {
  health: { get: () => Promise<unknown> };
  leads: { list: (input: unknown) => Promise<unknown> };
  leadDetail: Record<string, unknown>;
  today: { get: () => Promise<unknown>; getLeadTriageSnapshot: (input: unknown) => Promise<unknown> };
  pipeline: { get: () => Promise<unknown> };
  review: Record<string, unknown>;
  friday: Record<string, unknown>;
  imports: Record<string, unknown>;
  conversations: Record<string, unknown>;
  learnings: Record<string, unknown>;
  sourcing: {
    pollNow: () => Promise<unknown>;
    retry: () => Promise<unknown>;
    status: () => Promise<unknown>;
  };
  recovery: import('../../src/shared/contracts/recoveryContract').RecoveryProvider;
  shell: {
    revealDatabase: () => Promise<unknown>;
    revealLogDirectory: () => Promise<unknown>;
  };
  appleSpike: Record<string, unknown>;
};

describe('preload workflow bridge', () => {
  beforeEach(async () => {
    electron.exposeInMainWorld.mockReset();
    electron.invoke.mockReset();
    vi.resetModules();
    await import('../../src/preload');
  });

  function exposedApi(): ExposedCallieApi {
    const exposure = electron.exposeInMainWorld.mock.calls[0] as
      | [string, ExposedCallieApi]
      | undefined;

    if (exposure === undefined) {
      throw new Error('callie preload API was not exposed');
    }

    expect(exposure[0]).toBe('callie');
    return exposure[1];
  }

  const health: AppHealth = {
    appVersion: '1.0.0',
    schemaVersion: 2,
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
  };

  it('exposes exactly the composed workflow APIs plus the Apple spike surface', () => {
    const api = exposedApi();

    expect(Object.keys(api).sort()).toEqual([
      'appleSpike',
      'conversations',
      'friday',
      'health',
      'imports',
      'leadDetail',
      'leads',
      'learnings',
      'pipeline',
      'recovery',
      'review',
      'shell',
      'sourcing',
      'today',
    ]);
    expect(Object.keys(api.recovery).sort()).toEqual(['beginSetup', 'completeSetup', 'saveSetupMaterial', 'selectAndRunRestoreDrill', 'status']);
    expect(Object.keys(api.health)).toEqual(['get']);
    expect(Object.keys(api.leads).sort()).toEqual([
      'bulkUpdate', 'list', 'updateField',
    ]);
    expect(Object.keys(api.leadDetail).sort()).toEqual([
      'beginOutbound', 'confirmTransition', 'dismissLead', 'findContactInfo', 'get', 'overrideCloudScore',
    ]);
    expect(Object.keys(api.today).sort()).toEqual([
      'addLeadNote', 'complete', 'get', 'getLeadTriageSnapshot', 'getTriageQueue', 'logCallOutcome',
      'logPastActivity', 'markActivityInError', 'pin', 'setReviewPosition', 'snooze',
    ]);
    expect(Object.keys(api.pipeline)).toEqual(['get']);
    expect(Object.keys(api.review).sort()).toEqual(['list', 'resolve']);
    expect(Object.keys(api.friday).sort()).toEqual([
      'cancelJob', 'createJob', 'fillJob', 'getCurrent', 'getDrilldown',
    ]);
    expect(Object.keys(api.imports).sort()).toEqual([
      'commit', 'preview', 'remap', 'status',
    ]);
    expect(Object.keys(api.conversations).sort()).toEqual([
      'attachTranscript', 'get', 'list',
    ]);
    expect(Object.keys(api.learnings).sort()).toEqual([
      'addEvidence', 'capture', 'list', 'updateStatus',
    ]);
    expect(Object.keys(api.sourcing).sort()).toEqual(['pollNow', 'retry', 'setHmacSalt', 'status']);
    expect(Object.keys(api.shell).sort()).toEqual(['revealDatabase', 'revealLogDirectory']);
  });

  it('invokes only health:get without arguments for the health probe', async () => {
    electron.invoke.mockResolvedValue(health);

    const api = exposedApi();
    await expect(api.health.get()).resolves.toEqual(health);
    expect(electron.invoke).toHaveBeenCalledTimes(1);
    expect(electron.invoke).toHaveBeenCalledWith('health:get');
  });

  it('validates feature requests before invoking and uses the exact channel names', async () => {
    electron.invoke.mockResolvedValue({
      rows: [], nextCursor: null, total: 0, revision: 0,
    });

    const api = exposedApi();
    const request = {
      query: '',
      stages: [] as string[],
      priorities: [] as string[],
      sort: 'priority',
      cursor: null as string | null,
      limit: 50,
    };
    await expect(api.leads.list(request)).resolves.toEqual({
      rows: [], nextCursor: null, total: 0, revision: 0,
    });
    expect(electron.invoke).toHaveBeenCalledWith('leads:list', request);

    await expect(
      api.leads.list({ ...request, blended_score: true }),
    ).rejects.toThrow();
    expect(electron.invoke).toHaveBeenCalledTimes(1);
  });

  it('exposes the validated read-only lead snapshot through the composed API', async () => {
    const snapshot: LeadTriageSnapshot = { generatedAt: '2026-08-31T15:00:00.000Z', requestedLimit: 30,
      scannedQueueRows: 0, leads: [], revisionBefore: 0, revisionAfter: 0, privacyScanPassed: true };
    electron.invoke.mockResolvedValue(snapshot);
    const api = exposedApi();
    expect(api.today.getLeadTriageSnapshot).toBeTypeOf('function');
    await expect(api.today.getLeadTriageSnapshot({ limit: 30 })).resolves.toEqual(snapshot);
    expect(electron.invoke).toHaveBeenCalledWith('today:get-lead-triage-snapshot', { limit: 30 });
  });

  it('rejects invalid snapshot requests locally and unsafe responses before exposure', async () => {
    const api = exposedApi();
    for (const input of [{ limit: 19 }, { limit: 31 }, { limit: 20.5 }, { limit: 30, extra: true }, {}]) {
      await expect(api.today.getLeadTriageSnapshot(input)).rejects.toThrow();
    }
    expect(electron.invoke).not.toHaveBeenCalled();
    const valid: LeadTriageSnapshot = { generatedAt: '2026-08-31T15:00:00.000Z', requestedLimit: 30,
      scannedQueueRows: 0, leads: [], revisionBefore: 0, revisionAfter: 0, privacyScanPassed: true };
    for (const patch of [{ privacyScanPassed: undefined as unknown }, { revisionAfter: 1 }, { rawPayload: { email: 'owner@example.com' } }]) {
      electron.invoke.mockResolvedValue({ ...valid, ...patch });
      await expect(api.today.getLeadTriageSnapshot({ limit: 30 })).rejects.toThrow();
    }
  });

  it('rejects extra snapshot arguments locally and a response for a different request limit', async () => {
    const valid: LeadTriageSnapshot = { generatedAt: '2026-08-31T15:00:00.000Z', requestedLimit: 30,
      scannedQueueRows: 0, leads: [], revisionBefore: 0, revisionAfter: 0, privacyScanPassed: true };
    electron.invoke.mockResolvedValue(valid);
    const read = exposedApi().today.getLeadTriageSnapshot as (...args: unknown[]) => Promise<unknown>;
    await expect(read({ limit: 30 }, {})).rejects.toThrow();
    expect(electron.invoke).not.toHaveBeenCalled();
    await expect(read({ limit: 20 })).rejects.toThrow();
  });


  it.each(['Avery +14015550100', 'owner@example.com', '123 Hope Street'])('rejects otherwise strict IPC evidence leaking %s', async (unsafe) => {
    const evidence: LeadTriageEvidence = {
  rank: 1, queueIndex: 0, personId: 'person-safe', salesCycleId: 'cycle-safe', personName: 'Avery',
  locality: null, region: null, postalCode: null,
  organization: { label: null, relationship: null, evidenceCodes: [] },
  fit: { points: null, band: null, evidenceCodes: ['fit_evidence_missing'] },
  timing: { value: null, band: null, triggers: [] }, cloud: { fit: null, timing: null, contributions: [] },
  reachability: null, dataConfidence: null,
  contacts: { phoneCount: 0, emailCount: 0, usableDirectCount: 0, maskedPrimaryPhone: null, evidenceCodes: [] },
  compliance: { status: 'unknown', refusalReasonCodes: [] }, identityConcernCodes: [],
};
    electron.invoke.mockResolvedValue({ generatedAt: '2026-08-31T15:00:00.000Z', requestedLimit: 30,
      scannedQueueRows: 1, leads: [{ ...evidence, personName: unsafe }], revisionBefore: 0, revisionAfter: 0, privacyScanPassed: true });
    await expect(exposedApi().today.getLeadTriageSnapshot({ limit: 30 })).rejects.toThrow('Unsafe triage artifact');
  });

  it('invokes today:get and pipeline:get without arguments', async () => {
    electron.invoke.mockResolvedValue({ stages: [], revision: 0 });
    const api = exposedApi();
    await expect(api.pipeline.get()).resolves.toEqual({
      stages: [], revision: 0,
    });
    expect(electron.invoke).toHaveBeenCalledWith('pipeline:get');
  });

  it('invokes shell:reveal-database without arguments and validates the ack', async () => {
    electron.invoke.mockResolvedValue({ revealed: true });
    const api = exposedApi();

    await expect(api.shell.revealDatabase()).resolves.toEqual({ revealed: true });
    expect(electron.invoke).toHaveBeenCalledWith('shell:reveal-database');

    electron.invoke.mockResolvedValue({ revealed: true, path: '/leak' });
    await expect(api.shell.revealDatabase()).rejects.toThrow();
  });

  it('invokes shell:reveal-log-directory without arguments', async () => {
    electron.invoke.mockResolvedValue({ revealed: true });

    await expect(exposedApi().shell.revealLogDirectory()).resolves.toEqual({ revealed: true });
    expect(electron.invoke).toHaveBeenCalledWith('shell:reveal-log-directory');
  });

  it('sends friday:get with no payload by default and one strict week request otherwise', async () => {
    const report = {
      periodStartsAt: '2026-08-31T04:00:00.000Z',
      periodEndsAt: '2026-09-05T04:00:00.000Z',
      asOf: '2026-08-31T15:00:00.000Z',
      metrics: [] as never[],
      sourceRows: [] as never[],
      jobs: [] as never[],
      revision: 0,
    };
    electron.invoke.mockResolvedValue(report);
    const api = exposedApi() as unknown as {
      friday: {
        getCurrent: (input?: { weekOffset: number }) => Promise<unknown>;
      };
    };

    await expect(api.friday.getCurrent()).resolves.toEqual(report);
    expect(electron.invoke).toHaveBeenCalledWith('friday:get');

    await expect(api.friday.getCurrent({ weekOffset: -2 })).resolves.toEqual(report);
    expect(electron.invoke).toHaveBeenCalledWith('friday:get', { weekOffset: -2 });

    await expect(api.friday.getCurrent({ weekOffset: 1 })).rejects.toThrow();
    expect(electron.invoke).toHaveBeenCalledTimes(2);
  });

  it('invokes the sourcing channels without arguments and validates the status', async () => {
    const sourcingStatus: SourcingStatus = {
      lastPolledAt: null as string | null,
      lastKey: null as string | null,
      backlogCount: null as number | null,
      counters: { imported: 0, replayed: 0, needsIdentity: 0, scoreUpdates: 0, quarantined: 0 },
      credentialState: 'none',
      hmacSaltState: 'none',
      execution: {
        state: 'idle', pollId: null, startedAt: null,
        lastCompletedAt: '2026-09-01T12:00:00.000Z', consecutiveFailures: 0,
        lastFailureAt: null, lastFailureCode: null, backlogCount: 0,
      },
      health: {
        status: 'healthy', reasons: [], lastSuccessAgeMs: 0,
        state: {
          state: 'idle', pollId: null, startedAt: null,
          lastCompletedAt: '2026-09-01T12:00:00.000Z', consecutiveFailures: 0,
          lastFailureAt: null, lastFailureCode: null, backlogCount: 0,
        },
      },
    };
    electron.invoke.mockResolvedValue(sourcingStatus);
    const api = exposedApi();

    await expect(api.sourcing.status()).resolves.toEqual(sourcingStatus);
    expect(electron.invoke).toHaveBeenCalledWith('sourcing:status');
    await expect(api.sourcing.pollNow()).resolves.toEqual(sourcingStatus);
    expect(electron.invoke).toHaveBeenCalledWith('sourcing:poll-now');
    await expect(api.sourcing.retry()).resolves.toEqual(sourcingStatus);
    expect(electron.invoke).toHaveBeenCalledWith('sourcing:retry');

    electron.invoke.mockResolvedValue({
      ...sourcingStatus, credentialState: 'plaintext',
    });
    await expect(api.sourcing.status()).rejects.toThrow();
  });

  it('rejects a malformed main-process response before exposing it to the renderer', async () => {
    electron.invoke.mockResolvedValue({
      appVersion: '1.0.0',
      schemaVersion: 2,
      databasePath: '/tmp/callie.sqlite3',
      databaseEncrypted: true,
      cipherVersion: 'SQLite3 Multiple Ciphers 2.3.5',
      fts5Available: true,
      pendingJobs: -1,
      interruptedJobsRecovered: 0,
    });

    await expect(exposedApi().health.get()).rejects.toThrow();
  });

  it('rejects a malformed feature response before renderer exposure', async () => {
    electron.invoke.mockResolvedValue({
      rows: 'not-an-array', nextCursor: null, total: 0, revision: 0,
    });
    const api = exposedApi();
    await expect(api.leads.list({
      query: '', stages: [], priorities: [],
      sort: 'priority', cursor: null, limit: 50,
    })).rejects.toThrow();
  });
});

// Each failure stays fixed and excludes request/response contents.
it('recovery preload validates both directions and exposes no path or generic invoke', async () => {
  const { createCallieApi } = await import('../../src/preload/createCallieApi');
  const invoke = vi.fn(async (): Promise<unknown> => ({ kind: 'cancelled' }));
  const api = createCallieApi({ invoke }).recovery;
  await expect(api.selectAndRunRestoreDrill({ founderConfirmed: true, materialSource: 'paste', recoveryMaterial: 'synthetic-secret', path: '/private' } as never)).rejects.toThrow(/^RECOVERY_FAILED$/);
  expect(invoke).not.toHaveBeenCalled();
  expect(await api.saveSetupMaterial({ sessionId: 'fixture' })).toEqual({ kind: 'cancelled' });
  expect(invoke).toHaveBeenLastCalledWith('recovery:save-setup-material', { sessionId: 'fixture' });
  invoke.mockResolvedValue({ material: 'synthetic-secret' });
  await expect(api.status()).rejects.toThrow(/^RECOVERY_FAILED$/);
  expect(invoke).toHaveBeenLastCalledWith('recovery:status');
  await expect((api.status as (...args: unknown[]) => Promise<unknown>)({})).rejects.toThrow(/^RECOVERY_FAILED$/);
});

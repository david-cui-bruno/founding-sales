import type { DiscoveryBrief, DiscoverySnapshot } from '../../src/shared/contracts/discoveryContract';
import { createLeadDetailApi } from '../../src/preload/apis/leadDetailApi';
import { createIpcClient } from '../../src/preload/ipcClient';
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
  discovery: import('../../src/shared/contracts/discoveryContract').DiscoveryApi;
  localWorkspace: import('../../src/shared/preload').CalliePreloadApi['localWorkspace'];
  daily: import('../../src/shared/preload').CalliePreloadApi['daily'];
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
  delegation: import('../../src/shared/preload').CalliePreloadApi['delegation'];
  linkedin: import('../../src/shared/contracts/linkedInContract').LinkedInApi;
  phoneSetup: import('../../src/shared/contracts/phoneSetupContract').PhoneSetupApi;
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
      'daily',
      'delegation',
      'discovery',
      'friday',
      'health',
      'imports',
      'leadDetail',
      'leads',
      'learnings',
      'linkedin',
      'localWorkspace',
      'outreach',
      'phoneSetup',
      'pipeline',
      'recovery',
      'review',
      'shell',
      'sourcing',
      'today',
    ]);
    expect(Object.keys(api.delegation).sort()).toEqual([
      'approveMeeting', 'approveRequestedFollowup', 'beginPhone', 'bootstrap', 'configure', 'configureIntake', 'configurePolicy', 'configureResearch',
      'editReplyDraft', 'editRequestedFollowup', 'getAccountPreparation', 'getMeetingApproval', 'getPhoneHandoffState', 'getRequestedFollowup', 'googleConnections', 'pair', 'policyImport', 'prepareRequestedFollowup', 'reconcileReplyDraft', 'researchSetup', 'status', 'submit', 'sync',
    ]);
    expect(Object.keys(api.linkedin).sort()).toEqual([
      'begin', 'copy', 'get', 'open', 'prepare', 'recover', 'reportOutcome', 'save',
    ]);
    expect(Object.keys(api.delegation.policyImport).sort()).toEqual(['confirm', 'resume', 'selectAndPreview', 'status']);
    const { policyImport, googleConnections, researchSetup, ...delegationMethods } = api.delegation;
    if (!googleConnections) throw new Error('Current preload must expose Google connections');
    expect(Object.keys(googleConnections).sort()).toEqual(['begin', 'disclosure', 'revoke', 'status']);
    if (!researchSetup) throw new Error('Current preload must expose research setup');
    expect(Object.keys(researchSetup).sort()).toEqual(['approve', 'cancelPending', 'retry', 'setState', 'status']);
    for (const namespace of [delegationMethods, api.linkedin, policyImport, googleConnections, researchSetup]) {
      for (const method of Object.values(namespace)) expect(method).toBeTypeOf('function');
    }
    for (const namespace of [api.delegation, api.linkedin, policyImport, googleConnections, researchSetup]) {
      expect(namespace).not.toHaveProperty('invoke');
      expect(namespace).not.toHaveProperty('run');
      expect(namespace).not.toHaveProperty('dispatch');
    }
    expect(Object.keys(api.phoneSetup).sort()).toEqual(['clear', 'confirm', 'status']);
    for (const method of ['status', 'confirm', 'clear'] as const) expect(api.phoneSetup[method]).toBeTypeOf('function');
    expect(api.phoneSetup).not.toHaveProperty('invoke');
    expect(api.phoneSetup).not.toHaveProperty('run');
    expect(Object.keys(api.recovery).sort()).toEqual(['beginSetup', 'completeSetup', 'saveSetupMaterial', 'selectAndRunRestoreDrill', 'status']);
    expect(Object.keys(api.discovery).sort()).toEqual(['begin', 'get', 'getBrief', 'override']);
    expect(Object.keys(api.health)).toEqual(['get']);
    expect(Object.keys(api.leads).sort()).toEqual([
      'bulkUpdate', 'list', 'updateField',
    ]);
    expect(Object.keys(api.leadDetail).sort()).toEqual([
      'beginOutbound', 'confirmTransition', 'dismissLead', 'findContactInfo', 'get', 'getOutboundCapabilities', 'overrideCloudScore',
    ]);
    expect(Object.keys(api.localWorkspace).sort()).toEqual([
      'admitCompanyDraftEmail', 'admitCompanyPhoneRoute', 'createCompany', 'get', 'getCallSettings', 'getCommitments', 'getCompany', 'getCompanyCreateStatus', 'getCompanyDraft',
      'getCompanyResearchSettings', 'getCompanyResearchStatus', 'linkCompanyPerson', 'openCompanyDraft', 'prepareCompanyDraft', 'researchCompany', 'reviewCompany', 'saveCompanyDraft', 'transition', 'updateCallSettings', 'updateCompanyResearchSettings',
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

  const discoveryRequest = { commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', personId: 'person-1',
    salesCycleId: 'cycle-1', assessmentId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', expectedFingerprint: 'a'.repeat(64) };
  const discoveryMutation = { revision: 1, affectedPersonIds: ['person-1'], affectedSalesCycleIds: ['cycle-1'] };
  const discoveryReceipt = { mutation: discoveryMutation, personId: 'person-1', salesCycleId: 'cycle-1',
    assessmentId: discoveryRequest.assessmentId, actionId: 'action-1' };
  const discoveryBrief: DiscoveryBrief = { personId: 'person-1', salesCycleId: 'cycle-1', personName: 'Synthetic Owner',
    assessment: null, stale: false, latestOverride: null, pilotNextStep: null };
  const discoverySnapshot: DiscoverySnapshot = { prepared: [discoveryBrief], judgment: [],
    counts: { unassessed: 1, research: 0, watch: 0, excluded: 0 }, processing: 'idle',
    researchCapability: 'not_configured', generatedAt: '2026-09-06T12:00:00.000Z', revision: 0 };
  const discoveryOverride = { commandId: discoveryRequest.commandId, personId: discoveryRequest.personId,
    assessmentId: discoveryRequest.assessmentId, expectedFingerprint: discoveryRequest.expectedFingerprint,
    decision: 'watch' as const, reason: 'Founder context' };

  it('exposes the strict discovery namespace with exact channels and no-input get', async () => {
    const api = exposedApi().discovery;
    electron.invoke.mockResolvedValueOnce(discoverySnapshot).mockResolvedValueOnce(discoveryBrief)
      .mockResolvedValueOnce(discoveryReceipt).mockResolvedValueOnce(discoveryMutation);
    await expect(api.get()).resolves.toEqual(discoverySnapshot);
    await expect(api.getBrief({ personId: 'person-1' })).resolves.toEqual(discoveryBrief);
    await expect(api.begin(discoveryRequest)).resolves.toEqual(discoveryReceipt);
    await expect(api.override(discoveryOverride)).resolves.toEqual(discoveryMutation);
    expect(electron.invoke.mock.calls).toEqual([['discovery:get'], ['discovery:get-brief', { personId: 'person-1' }],
      ['discovery:begin', discoveryRequest], ['discovery:override', discoveryOverride]]);
  });

  it('rejects malformed discovery input and extra arguments before invoking', async () => {
    const api = exposedApi().discovery;
    await expect(Reflect.apply(api.get, api, [undefined])).rejects.toThrow();
    for (const [method, input] of [['getBrief', { personId: 'person-1' }], ['begin', discoveryRequest],
      ['override', discoveryOverride]] as const) {
      await expect(api[method]({ ...input, surprise: true } as never)).rejects.toThrow();
      await expect(Reflect.apply(api[method], api, [])).rejects.toThrow();
      await expect(Reflect.apply(api[method], api, [input, input])).rejects.toThrow();
    }
    for (const invalid of [{ commandId: 'bad' }, { assessmentId: 'bad' }, { expectedFingerprint: 'F'.repeat(64) }]) {
      await expect(api.begin({ ...discoveryRequest, ...invalid })).rejects.toThrow();
      await expect(api.override({ ...discoveryOverride, ...invalid })).rejects.toThrow();
    }
    expect(electron.invoke).not.toHaveBeenCalled();
  });

  it.each(['personId', 'salesCycleId', 'assessmentId', 'mutationPerson', 'mutationCycle'] as const)(
    'independently refuses discovery begin receipt ownership mismatch: %s', async key => {
      const changed = structuredClone(discoveryReceipt);
      if (key === 'personId') { changed.personId = 'other-person'; changed.mutation.affectedPersonIds = ['other-person']; }
      if (key === 'salesCycleId') { changed.salesCycleId = 'other-cycle'; changed.mutation.affectedSalesCycleIds = ['other-cycle']; }
      if (key === 'assessmentId') changed.assessmentId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
      if (key === 'mutationPerson') changed.mutation.affectedPersonIds = ['other-person'];
      if (key === 'mutationCycle') changed.mutation.affectedSalesCycleIds = ['other-cycle'];
      electron.invoke.mockResolvedValue(changed);
      await expect(exposedApi().discovery.begin(discoveryRequest)).rejects.toThrow();
    });

  it('independently refuses wrong-Person brief and override responses', async () => {
    electron.invoke.mockResolvedValueOnce({ ...discoveryBrief, personId: 'other-person' })
      .mockResolvedValueOnce({ ...discoveryMutation, affectedPersonIds: ['other-person'] });
    await expect(exposedApi().discovery.getBrief({ personId: 'person-1' })).rejects.toThrow();
    await expect(exposedApi().discovery.override(discoveryOverride)).rejects.toThrow();
  });

  it.each(['duplicate prepared', 'duplicate judgment', 'cross bucket', 'over cap', 'unknown field'])(
    'independently refuses invalid discovery snapshot: %s', async invalid => {
      electron.invoke.mockResolvedValue({ ...discoverySnapshot,
        ...(invalid === 'duplicate prepared' ? { prepared: [discoveryBrief, discoveryBrief] } : {}),
        ...(invalid === 'duplicate judgment' ? { prepared: [], judgment: [discoveryBrief, discoveryBrief] } : {}),
        ...(invalid === 'cross bucket' ? { judgment: [discoveryBrief] } : {}),
        ...(invalid === 'over cap' ? { prepared: Array.from({ length: 11 }, (_, i) => ({ ...discoveryBrief, personId: `p-${i}` })) } : {}),
        ...(invalid === 'unknown field' ? { surprise: true } : {}),
      });
      await expect(exposedApi().discovery.get()).rejects.toThrow();
    });

  it('independently refuses unknown fields in discovery command responses', async () => {
    electron.invoke.mockResolvedValueOnce({ ...discoveryBrief, surprise: true })
      .mockResolvedValueOnce({ ...discoveryReceipt, surprise: true })
      .mockResolvedValueOnce({ ...discoveryMutation, surprise: true });
    await expect(exposedApi().discovery.getBrief({ personId: 'person-1' })).rejects.toThrow();
    await expect(exposedApi().discovery.begin(discoveryRequest)).rejects.toThrow();
    await expect(exposedApi().discovery.override(discoveryOverride)).rejects.toThrow();
  });

  it.each(['begin', 'getBrief', 'override'] as const)('freezes discovery %s identity across an asynchronous response', async method => {
    const input = { ...(method === 'begin' ? discoveryRequest : method === 'override' ? discoveryOverride : { personId: 'person-1' }) };
    let resolve!: (value: unknown) => void;
    electron.invoke.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const pending = exposedApi().discovery[method](input as never);
    input.personId = 'other-person';
    resolve(method === 'begin' ? { ...discoveryReceipt, personId: 'other-person',
      mutation: { ...discoveryMutation, affectedPersonIds: ['other-person'] } }
      : method === 'getBrief' ? { ...discoveryBrief, personId: 'other-person' }
        : { ...discoveryMutation, affectedPersonIds: ['other-person'] });
    await expect(pending).rejects.toThrow();
    expect(electron.invoke.mock.calls[0][1].personId).toBe('person-1');
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

describe('strict outbound preload boundary', () => {
  const request = { commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', channel: 'call' as const, personId: 'p', salesCycleId: 's', contactMethodId: 'c', expectedContactSnapshot: 'a'.repeat(64) };
  const receipt = { commandId: request.commandId, channel: 'call', status: 'handoff_accepted', reasonCode: null as null, mutation: { revision: 1, affectedPersonIds: ['p'], affectedSalesCycleIds: ['s'] } };
  it('validates UUID/snapshot and binds a strict receipt to the submitted command and channel', async () => {
    const invoke = vi.fn(async (): Promise<unknown> => receipt);
    const api = createLeadDetailApi(createIpcClient({ invoke }));
    await expect(api.beginOutbound(request)).resolves.toEqual(receipt);
    expect(invoke).toHaveBeenCalledWith('lead-detail:begin-outbound', request);
    for (const patch of [{ commandId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }, { channel: 'text' }, { reasonCode: 'handoff_uncertain' }]) {
      invoke.mockResolvedValueOnce({ ...receipt, ...patch });
      await expect(api.beginOutbound(request)).rejects.toThrow();
    }
    const count = invoke.mock.calls.length;
    for (const field of ['commandId', 'expectedContactSnapshot']) {
      const invalid = { ...request }; delete invalid[field as keyof typeof invalid];
      await expect(api.beginOutbound(invalid)).rejects.toThrow();
    }
    await expect(api.beginOutbound({ ...request, body: 'not allowed' } as never)).rejects.toThrow();
    expect(invoke).toHaveBeenCalledTimes(count);
  });
  it('queries capabilities with a strict empty payload and rejects invalid response', async () => {
    const invoke = vi.fn(async () => ({ localDrafts: true }));
    const api = createLeadDetailApi(createIpcClient({ invoke }));
    await expect(api.getOutboundCapabilities()).rejects.toThrow();
    expect(invoke).toHaveBeenCalledWith('lead-detail:outbound-capabilities', {});
  });
});

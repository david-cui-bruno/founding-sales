import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LeadDetail } from '../../src/shared/contracts/leadDetailContract';
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
  leadDetail: { get: (input: unknown) => Promise<unknown> };
  localWorkspace: import('../../src/shared/preload').CalliePreloadApi['localWorkspace'];
  daily: import('../../src/shared/preload').CalliePreloadApi['daily'];
  delegation: import('../../src/shared/preload').CalliePreloadApi['delegation'];
  linkedin: import('../../src/shared/contracts/linkedInContract').LinkedInApi;
  phoneSetup: import('../../src/shared/contracts/phoneSetupContract').PhoneSetupApi;
  outreach: Record<string, unknown>;
  recovery: import('../../src/shared/contracts/recoveryContract').RecoveryProvider;
  shell: {
    revealDatabase: () => Promise<unknown>;
    revealLogDirectory: () => Promise<unknown>;
  };
  appleSpike: Record<string, unknown>;
};

/** Schema-shaped read-only detail. Fictional person, no real contact data. */
const detail: LeadDetail = {
  personId: 'person-fixture',
  salesCycleId: 'cycle-fixture',
  personName: 'Fixture Owner',
  phones: [],
  emails: [],
  organizationLabel: null,
  propertySummaries: [],
  stage: 'ready',
  workflowStatus: 'active',
  sourceLabel: 'frbo',
  segment: 'hot',
  cloudScores: null,
  cloudLinked: false,
  findContactEligibility: { eligible: false, refusalReason: 'qualification_required' },
  priorityContext: null,
  priorityReasons: [],
  nextAction: null,
  optedOut: false,
  cadence: null,
  outboundAttempts: [],
  activities: [],
  conversations: [],
  properties: [],
  history: [],
  revision: 0,
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
  };

  it('exposes exactly the composed workflow APIs plus the Apple spike surface', () => {
    const api = exposedApi();

    expect(Object.keys(api).sort()).toEqual([
      'appleSpike',
      'daily',
      'delegation',
      'health',
      'leadDetail',
      'leads',
      'linkedin',
      'localWorkspace',
      'outreach',
      'phoneSetup',
      'recovery',
      'shell',
    ]);
    for (const removed of ['today', 'pipeline', 'review', 'friday', 'imports', 'conversations', 'learnings', 'sourcing', 'discovery']) {
      expect(api, removed).not.toHaveProperty(removed);
    }
    expect(Object.keys(api.delegation).sort()).toEqual([
      'approveRequestedFollowup', 'beginPhone', 'bootstrap', 'configure', 'configureIntake', 'configurePolicy', 'configureResearch',
      'editReplyDraft', 'editRequestedFollowup', 'getAccountPreparation', 'getPhoneHandoffState', 'getRequestedFollowup', 'getSelectedAccountFreshness', 'googleConnections', 'pair', 'policyImport', 'prepareRequestedFollowup', 'reconcileReplyDraft', 'refreshSelectedAccount', 'researchSetup', 'status', 'submit', 'sync',
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
    expect(Object.keys(api.health)).toEqual(['get']);
    expect(Object.keys(api.daily)).toEqual(['get']);
    expect(Object.keys(api.leads)).toEqual(['list']);
    expect(Object.keys(api.leadDetail)).toEqual(['get']);
    expect(Object.keys(api.localWorkspace).sort()).toEqual([
      'admitCompanyDraftEmail', 'admitCompanyPhoneRoute', 'confirmTerritoryClearance', 'createCompany', 'get', 'getCallSettings', 'getCommitments', 'getCompany', 'getCompanyCreateStatus', 'getCompanyDraft',
      'getCompanyResearchSettings', 'getCompanyResearchStatus', 'linkCompanyPerson', 'openCompanyDraft', 'prepareCompanyDraft', 'readTerritoryClearance', 'researchCompany', 'reviewCompany', 'revokeTerritoryClearance', 'saveCompanyDraft', 'transition', 'updateCallSettings', 'updateCompanyResearchSettings',
    ]);
    expect(Object.keys(api.outreach).sort()).toEqual([
      'configure', 'connectGmail', 'disconnectGmail', 'generateDraft', 'inspectLocalAuthority', 'openDraft', 'saveDraft', 'sendDraft', 'status',
    ]);
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

  it('invokes lead-detail:get with the exact person request and validates the read-only detail', async () => {
    electron.invoke.mockResolvedValue(detail);
    const api = exposedApi();

    await expect(api.leadDetail.get({ personId: detail.personId })).resolves.toEqual(detail);
    expect(electron.invoke).toHaveBeenCalledWith('lead-detail:get', { personId: detail.personId });

    await expect(api.leadDetail.get({ personId: detail.personId, extra: true })).rejects.toThrow();
    await expect(api.leadDetail.get({})).rejects.toThrow();
    expect(electron.invoke).toHaveBeenCalledTimes(1);

    electron.invoke.mockResolvedValue({ ...detail, personId: 42 });
    await expect(api.leadDetail.get({ personId: detail.personId })).rejects.toThrow();
  });

  it('invokes daily:get without arguments and rejects a malformed snapshot', async () => {
    electron.invoke.mockResolvedValue(null);
    const api = exposedApi();

    await expect(api.daily.get()).rejects.toThrow();
    expect(electron.invoke).toHaveBeenCalledTimes(1);
    expect(electron.invoke).toHaveBeenCalledWith('daily:get');
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

  it('rejects a health response that still carries the removed sourcing overlay', async () => {
    electron.invoke.mockResolvedValue({ ...health, operationalStatus: 'ready', sourcing: { status: 'healthy' } });

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

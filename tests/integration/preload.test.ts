import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  today: { get: () => Promise<unknown> };
  pipeline: { get: () => Promise<unknown> };
  review: Record<string, unknown>;
  friday: Record<string, unknown>;
  imports: Record<string, unknown>;
  conversations: Record<string, unknown>;
  learnings: Record<string, unknown>;
  sourcing: { pollNow: () => Promise<unknown>; status: () => Promise<unknown> };
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

  const health = {
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
      'conversations',
      'friday',
      'health',
      'imports',
      'leadDetail',
      'leads',
      'learnings',
      'pipeline',
      'review',
      'sourcing',
      'today',
    ]);
    expect(Object.keys(api.health)).toEqual(['get']);
    expect(Object.keys(api.leads).sort()).toEqual([
      'bulkUpdate', 'list', 'updateField',
    ]);
    expect(Object.keys(api.leadDetail).sort()).toEqual([
      'beginOutbound', 'confirmTransition', 'get', 'overrideCloudScore',
    ]);
    expect(Object.keys(api.today).sort()).toEqual([
      'complete', 'get', 'logPastActivity', 'pin', 'snooze',
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
    expect(Object.keys(api.sourcing).sort()).toEqual(['pollNow', 'setHmacSalt', 'status']);
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

  it('invokes today:get and pipeline:get without arguments', async () => {
    electron.invoke.mockResolvedValue({ stages: [], revision: 0 });
    const api = exposedApi();
    await expect(api.pipeline.get()).resolves.toEqual({
      stages: [], revision: 0,
    });
    expect(electron.invoke).toHaveBeenCalledWith('pipeline:get');
  });

  it('invokes the sourcing channels without arguments and validates the status', async () => {
    const sourcingStatus = {
      lastPolledAt: null as string | null,
      lastKey: null as string | null,
      backlogCount: null as number | null,
      counters: { imported: 0, replayed: 0, needsIdentity: 0, scoreUpdates: 0, quarantined: 0 },
      credentialState: 'none',
      hmacSaltState: 'none',
    };
    electron.invoke.mockResolvedValue(sourcingStatus);
    const api = exposedApi();

    await expect(api.sourcing.status()).resolves.toEqual(sourcingStatus);
    expect(electron.invoke).toHaveBeenCalledWith('sourcing:status');
    await expect(api.sourcing.pollNow()).resolves.toEqual(sourcingStatus);
    expect(electron.invoke).toHaveBeenCalledWith('sourcing:poll-now');

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

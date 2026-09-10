// @vitest-environment jsdom
// Construction evidence only. Stage0 does not render App or perform a workflow write.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appHealthSchema } from '../../src/shared/healthContract';
import { fridayReportSchema } from '../../src/shared/contracts/fridayContract';
import { localCommitmentsSnapshotSchema, localWorkspaceSnapshotSchema } from '../../src/shared/contracts/localWorkspaceContract';
import {
  CONTINUITY_NOW, CONTINUITY_READ_CHANNELS, CONTINUITY_REGISTERED_CHANNELS, CONTINUITY_URL,
  createContinuityDomainFixture,
} from '../fixtures/continuityDomainFixture';
import type { RegisteredIpcHandler } from '../fixtures/registeredIpcHandler';

// Only Electron's registration/invoke transport is replaced. No native DB,
// runtime, health result, domain service, readiness gate or provider is mocked.
const transport = vi.hoisted(() => ({
  handlers: new Map<string, RegisteredIpcHandler>(),
  registrations: [] as string[], removals: [] as string[],
}));
vi.mock('electron', () => ({ ipcMain: {
  handle: (channel: string, handler: RegisteredIpcHandler) => {
    if (transport.handlers.has(channel)) throw new Error(`Duplicate handler: ${channel}`);
    transport.registrations.push(channel);
    transport.handlers.set(channel, handler);
  },
  removeHandler: (channel: string) => {
    transport.removals.push(channel);
    transport.handlers.delete(channel);
  },
} }));

type Fixture = Awaited<ReturnType<typeof createContinuityDomainFixture>>;
const fixtures: Fixture[] = [];
async function fixture() {
  const value = await createContinuityDomainFixture(transport.handlers);
  fixtures.push(value);
  return value;
}
async function expectCleaned(value: Fixture) {
  const first = value.dispose();
  expect(value.dispose()).toBe(first);
  expect(await first).toEqual({
    databaseClosed: true, keysZeroed: true, directoryRemoved: true,
    registrationsRemaining: 0, pendingInvocations: 0,
    cleanupRuns: 1, runtimeShutdowns: 1, domainShutdowns: 1, databaseCloses: 1,
    pollerStops: 1, pollerIdleWaits: 1,
  });
  expect(transport.handlers.size).toBe(0);
  expect([...transport.registrations].sort()).toEqual([...CONTINUITY_REGISTERED_CHANNELS].sort());
  expect([...transport.removals].sort()).toEqual([...CONTINUITY_REGISTERED_CHANNELS].sort());
  expect(transport.registrations).toHaveLength(12);
  expect(transport.removals).toHaveLength(12);
  expect(value.counts()).toMatchObject({ credentialLoads: 0, inboxCreations: 0, pollSchedules: 0 });
}
beforeEach(() => {
  expect(transport.handlers.size).toBe(0);
  transport.registrations.length = 0;
  transport.removals.length = 0;
  // Fix time only, matching the accepted construction reference. Native/IPC
  // scheduling remains real. No renderer deadline or poll transitions in Stage0.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(CONTINUITY_NOW));
});
afterEach(async () => {
  try { for (const value of fixtures.splice(0)) await value.dispose(); }
  finally { vi.useRealTimers(); }
});

describe('continuity public boundary construction', () => {
  it('S0.1 constructs one real foundation and serves exact readonly public projections without reinitialization', async () => {
    const value = await fixture();
    // Initialization deliberately writes builtins/settings. Readonly comparison
    // starts after real bootstrap, never against an empty pre-migration file.
    const baseline = await value.evidence();
    expect(baseline.changes).toBeGreaterThan(0);
    expect(baseline).toMatchObject({ accounts: [], accountCommands: [], jobs: [], workflowStates: [], keysZeroed: true });
    expect(value.counts()).toMatchObject({
      keyLoads: 1, preparations: 1, databaseOpens: 1, migrations: 1,
      domainConstructions: 1, domainBootstraps: 1, healthConstructions: 1,
      healthReads: 0, domainEntries: 0, databaseEntries: 0,
    });

    const health = appHealthSchema.parse(await value.api.health.get());
    expect(health).toMatchObject({
      appVersion: 'continuity-stage0', databaseEncrypted: true, fts5Available: true,
      domainStatus: 'ready', domainReady: true, domainBlockingViolationCount: 0,
      domainStartupEvaluatedAt: CONTINUITY_NOW, operationalStatus: 'ready',
    });
    // An unstarted/unprovisioned real poller is honestly healthy with no success
    // yet. This does not prove polling, provider pairing or worker availability.
    expect(health.sourcing).toEqual({
      status: 'healthy', reasons: [], lastSuccessAgeMs: null,
      state: { state: 'idle', pollId: null, startedAt: null, lastCompletedAt: null,
        consecutiveFailures: 0, lastFailureAt: null, lastFailureCode: null, backlogCount: null },
    });
    const overview = localWorkspaceSnapshotSchema.parse(await value.api.localWorkspace.get());
    expect(overview).toEqual({ scope: 'local_database', generatedAt: CONTINUITY_NOW,
      workflowMode: 'legacy', transitionReceipt: null, accounts: { state: 'available', snapshots: [] } });
    const commitments = localCommitmentsSnapshotSchema.parse(await value.api.localWorkspace.getCommitments());
    expect(commitments).toEqual({ scope: 'local_database', generatedAt: CONTINUITY_NOW,
      revision: baseline.changes, reviewErrorCount: 0, items: [] });
    const friday = fridayReportSchema.parse(await value.api.friday.getCurrent());
    expect(friday).toMatchObject({ asOf: CONTINUITY_NOW, jobs: [], revision: baseline.changes });
    expect(friday.metrics.find(metric => metric.id === 'jobs_requested')?.numericValue).toBe(0);
    expect(friday.metrics.find(metric => metric.id === 'jobs_filled')?.numericValue).toBe(0);
    expect(friday.metrics.find(metric => metric.id === 'fill_rate')).toMatchObject({ numericValue: null, numerator: 0, denominator: 0 });
    expect(fridayReportSchema.parse(await value.api.friday.getCurrent({ weekOffset: 0 }))).toEqual(friday);
    expect(appHealthSchema.parse(await value.api.health.get())).toEqual(health);

    expect(value.trace().map(({ channel, args }) => ({ channel, args }))).toEqual([
      { channel: 'health:get', args: [] },
      { channel: 'local-workspace:get', args: [] },
      { channel: 'local-workspace:get-commitments', args: [] },
      { channel: 'friday:get', args: [] },
      { channel: 'friday:get', args: [{ weekOffset: 0 }] },
      { channel: 'health:get', args: [] },
    ]);
    expect(value.trace().every(entry => entry.handlerStarted && entry.outcome === 'resolved')).toBe(true);
    expect(await value.evidence()).toEqual(baseline);
    expect(value.counts()).toEqual({
      keyLoads: 1, preparations: 1, databaseOpens: 1, migrations: 1,
      domainConstructions: 1, domainBootstraps: 1, healthConstructions: 1,
      healthReads: 2, domainEntries: 3, databaseEntries: 1, evidenceReads: 2,
      databaseCloses: 0, domainShutdowns: 0, runtimeShutdowns: 0,
      credentialLoads: 0, inboxCreations: 0, pollSchedules: 0,
      pollerStops: 0, pollerIdleWaits: 0, cleanupRuns: 0,
    });
    await expectCleaned(value);
  });

  it('S0.2 refuses malformed and untrusted reads before provider entry and disposes each resource once', async () => {
    const value = await fixture();
    const baseline = await value.evidence();
    const before = value.counts();
    // The preload rejects this typed-but-invalid value before transport.
    await expect(value.api.friday.getCurrent({ weekOffset: 1 })).rejects.toThrow();
    expect(value.trace()).toHaveLength(0);
    const malformed: { channel: string; args: unknown[] }[] = [
      { channel: 'health:get', args: [undefined] },
      { channel: 'local-workspace:get', args: [undefined] },
      { channel: 'local-workspace:get-commitments', args: [undefined] },
      { channel: 'friday:get', args: [undefined] },
      { channel: 'friday:get', args: [{ weekOffset: 0, extra: true }] },
      { channel: 'friday:get', args: [{ weekOffset: 0 }, { weekOffset: 0 }] },
    ];
    for (const { channel, args } of malformed) {
      await expect(value.invokeFrom(CONTINUITY_URL, channel, ...args)).rejects.toThrow();
    }
    for (const channel of CONTINUITY_READ_CHANNELS) {
      await expect(value.invokeFrom('https://untrusted.invalid/', channel)).rejects.toThrow();
    }
    expect(value.trace()).toHaveLength(10);
    expect(value.trace().every(entry => entry.handlerStarted && entry.outcome === 'rejected')).toBe(true);
    await expect(value.invokeFrom(CONTINUITY_URL, 'stage0:unsupported')).rejects.toThrow('four readonly channels');
    expect(value.trace().at(-1)).toMatchObject({ handlerStarted: false, outcome: 'rejected' });
    expect(value.counts()).toEqual(before);
    expect(before).toMatchObject({ healthReads: 0, databaseEntries: 0, domainEntries: 0,
      keyLoads: 1, preparations: 1, databaseOpens: 1, migrations: 1,
      domainConstructions: 1, domainBootstraps: 1, healthConstructions: 1 });
    expect(await value.evidence()).toEqual(baseline);
    await expectCleaned(value);
    await expect(value.api.localWorkspace.get()).rejects.toThrow('disposed');
    expect(value.counts()).toMatchObject({ healthReads: 0, databaseEntries: 0, domainEntries: 0,
      databaseCloses: 1, domainShutdowns: 1, runtimeShutdowns: 1, cleanupRuns: 1 });
  });
});

// @vitest-environment jsdom
// Step A is native encrypted SQL + actual preload/registrars, NOT renderer/browser acceptance.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CalliePreloadApi } from '../../src/shared/preload';
import type { LeadsListRequest } from '../../src/shared/contracts/leadsContract';
import type { ReviewListRequest } from '../../src/shared/contracts/reviewContract';
import type { IpcInvoker } from '../../src/preload/ipcClient';
import type { RegisteredIpcHandler } from '../fixtures/registeredIpcHandler';
import {
  createReliabilityDomainFixture, RELIABILITY_NOW, RELIABILITY_URL,
  type CleanupEvidence, type ReliabilityDomainFixture,
} from '../fixtures/reliabilityDomainFixture';

const boundary = vi.hoisted(() => {
  const handlers = new Map<string, RegisteredIpcHandler>();
  const state = { handlers, api: undefined as unknown, exposures: [] as string[],
    invoker: null as IpcInvoker | null, failOnChannel: null as string | null };
  return Object.assign(state, { register(channel: string, handler: RegisteredIpcHandler) {
    if (state.failOnChannel === channel) throw new Error('INJECTED_REGISTRATION_FAILURE');
    if (handlers.has(channel)) throw new Error(`Duplicate channel ${channel}`);
    handlers.set(channel, handler);
  } });
});
vi.mock('electron', () => ({
  safeStorage: {}, dialog: {},
  contextBridge: { exposeInMainWorld(name: string, api: unknown) {
    boundary.exposures.push(name); boundary.api = api;
  } },
  ipcMain: { handle: boundary.register, removeHandler: (channel: string) => { boundary.handlers.delete(channel); } },
  ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]) => {
      if (boundary.invoker === null) return Promise.reject(new Error('NO_ACTIVE_RELIABILITY_FIXTURE'));
      return boundary.invoker.invoke(channel, ...args);
    },
    on: () => { throw new Error('Apple observation is not part of Step A'); },
    removeListener: () => { throw new Error('Apple observation is not part of Step A'); },
  },
}));

let api: CalliePreloadApi;
beforeAll(async () => {
  await import('../../src/preload');
  expect(boundary.exposures).toEqual(['callie']);
  // The object comes only from the actual preload contextBridge exposure.
  api = boundary.api as CalliePreloadApi;
  expect(typeof api.appleSpike.getStatus).toBe('function');
  expect(typeof api.leads.list).toBe('function');
  expect(typeof api.review.list).toBe('function');
});
afterEach(() => {
  boundary.invoker = null;
  boundary.failOnChannel = null;
  expect(boundary.handlers.size).toBe(0);
});

const cleanEvidence: CleanupEvidence = {
  databaseClosed: true, keyZeroed: true, temporaryDirectoryRemoved: true,
  registrationsRemaining: 0, pendingInvocations: 0, externalInvocations: 0,
};
async function withFixture(run: (fixture: ReliabilityDomainFixture) => Promise<void>) {
  const fixture = await createReliabilityDomainFixture(boundary.handlers);
  boundary.invoker = fixture.invoker;
  let failure: unknown;
  let failed = false;
  try { await run(fixture); } catch (error) { failure = error; failed = true; }
  try {
    expect(await fixture.dispose()).toEqual(cleanEvidence);
    expect(await fixture.dispose()).toEqual(cleanEvidence);
  } catch (cleanupError) {
    if (failed) throw new AggregateError([failure, cleanupError], 'Smoke assertion and cleanup failed', { cause: failure });
    throw cleanupError;
  } finally { boundary.invoker = null; }
  if (failed) throw failure;
}

const emptyReviewRequest: ReviewListRequest = { kinds: [], cursor: null, limit: 1 };

describe('reliability Step A: construction and public schema smoke, not historical behavioral RED', () => {
  it('constructs 208 valid retained reviews and reads real metadata through exposed preload and shipped registrars', async () => {
    await withFixture(async fixture => {
      expect(fixture.constructionEvidence()).toMatchObject({ encrypted: true, integrity: 'ok', fts5Available: true, schemaVersion: 24 });
      const expected = fixture.seedReviews();
      const stored = fixture.reviewOwners();
      expect(stored).toHaveLength(208);
      expect(new Set(stored.map(row => row.reviewId)).size).toBe(208);
      expect(new Set(stored.map(row => row.activationKey)).size).toBe(208);
      expect(stored.map(row => row.reviewId)).toEqual(expected.map(row => row.reviewId));
      expect(stored.filter(row => row.reason === 'operational_cycle_exists')).toHaveLength(205);
      expect(stored.filter(row => row.reason === 'unknown_inbound_handle')).toHaveLength(3);
      for (const [index, row] of stored.entries()) {
        const owner = expected[index]!;
        expect(row).toMatchObject({ status: 'open', version: 1, resolution: null, resolvedAt: null,
          activationKey: owner.activationKey, personId: owner.personId, prospectId: owner.prospectId,
          sourceCycleId: owner.sourceCycleId, prospectPersonId: owner.personId,
          cyclePersonId: owner.personId, cycleProspectId: owner.prospectId,
          createdAt: index < 205 ? '2026-08-31T15:00:00.000Z' : '2026-08-31T16:00:00.000Z' });
      }
      const before = fixture.snapshot();
      const changes = fixture.totalChanges();
      const entriesBefore = fixture.counts().domainEntries;
      fixture.setPhase('probe');
      const summary = await api.review.list(emptyReviewRequest);
      expect(fixture.counts().domainEntries).toBe(entriesBefore + 1);
      expect(summary).toMatchObject({ totalOpenCount: 208, matchedCount: 208,
        countScope: 'lifecycle_review_items', observedAt: RELIABILITY_NOW,
        queues: {
          system_error: { source: 'lifecycle_review_items', openCount: 205 },
          unmatched_communication: { source: 'lifecycle_review_items', openCount: 3 },
          ambiguous_identity: { source: 'not_integrated', openCount: null },
          transcript_suggestion: { source: 'not_integrated', openCount: null },
          import_problem: { source: 'not_integrated', openCount: null },
          adapter_failure: { source: 'not_integrated', openCount: null },
        } });
      expect(summary.items.map(item => item.reviewId)).toEqual([stored[0]!.reviewId]);
      expect(summary.nextCursor).toEqual(expect.any(String));
      const first = await api.review.list({ kinds: [], cursor: null, limit: 200 });
      expect(first.items).toHaveLength(200);
      expect(first.nextCursor).toEqual(expect.any(String));
      const second = await api.review.list({ kinds: [], cursor: first.nextCursor, limit: 200 });
      expect(second.items).toHaveLength(8);
      expect(second.nextCursor).toBeNull();
      expect([...first.items, ...second.items].map(item => item.reviewId)).toEqual(stored.map(row => row.reviewId));
      expect(fixture.snapshot()).toEqual(before);
      expect(fixture.totalChanges()).toBe(changes);
      const trace = fixture.trace();
      expect(trace).toHaveLength(3);
      expect(trace[0]).toMatchObject({ channel: 'review:list', args: [emptyReviewRequest], phase: 'probe', handlerStarted: true, outcome: 'resolved', result: summary });
      expect(Object.isFrozen(trace)).toBe(true);
      expect(Object.isFrozen(trace[0]!.args)).toBe(true);
      expect(fixture.counts().externalInvocations).toBe(0);
    });
  }, 60_000);

  it('imports a separate 208-person CSV through public Import and independently joins every paged Leads owner', async () => {
    await withFixture(async fixture => {
      expect(fixture.reviewOwners()).toEqual([]);
      const { owners, receipt } = await fixture.importLeads(api);
      expect(receipt.importedRowCount).toBe(208);
      expect(owners).toHaveLength(208);
      expect(fixture.trace().map(entry => [entry.channel, entry.phase])).toEqual([
        ['imports:preview', 'setup'], ['imports:commit', 'setup'],
      ]);
      const before = fixture.snapshot();
      const changes = fixture.totalChanges();
      fixture.setPhase('probe');
      const request: LeadsListRequest = { query: '', stages: [], priorities: [], sort: 'person_name', cursor: null, limit: 200 };
      const first = await api.leads.list(request);
      expect(first.total).toBe(208);
      expect(first.rows).toHaveLength(200);
      expect(first.nextCursor).toEqual(expect.any(String));
      const second = await api.leads.list({ ...request, cursor: first.nextCursor });
      expect(second.total).toBe(208);
      expect(second.rows).toHaveLength(8);
      expect(second.nextCursor).toBeNull();
      const rows = [...first.rows, ...second.rows];
      expect(rows.map(row => [row.personId, row.personName, row.salesCycleId])).toEqual(
        owners.map(owner => [owner.personId, owner.name, owner.salesCycleId]),
      );
      expect(new Set(rows.map(row => row.personId)).size).toBe(208);
      const last = owners[207]!;
      const detail = await api.leadDetail.get({ personId: last.personId });
      expect(detail).toMatchObject({ personId: last.personId, salesCycleId: last.salesCycleId, personName: last.name, stage: 'unreviewed' });
      expect(detail.outboundAttempts).toEqual([]);
      expect(fixture.snapshot()).toEqual(before);
      expect(fixture.totalChanges()).toBe(changes);
      expect(fixture.trace().filter(entry => entry.phase === 'probe').map(entry => entry.channel)).toEqual([
        'leads:list', 'leads:list', 'lead-detail:get',
      ]);
      expect(fixture.counts().externalInvocations).toBe(0);
    });
  }, 60_000);

  it('preserves real required registrations, rejects untrusted/missing calls and retires every owned resource', async () => {
    await withFixture(async fixture => {
      for (const channel of ['today:get', 'daily:get', 'local-workspace:get', 'discovery:get',
        'lead-detail:get', 'review:list', 'leads:list', 'outreach:delegation-status']) {
        expect(boundary.handlers.has(channel), channel).toBe(true);
      }
      expect(await api.delegation.status()).toEqual({ state: 'unconfigured', workspaceId: null, endpoint: null, configuration: null });
      const entries = fixture.counts().domainEntries;
      const storedHandler = boundary.handlers.get('review:list')!;
      await expect(fixture.invokeFrom('https://untrusted.invalid', 'review:list', emptyReviewRequest)).rejects.toThrow(/trusted renderer/);
      expect(fixture.counts().domainEntries).toBe(entries);
      await expect(fixture.invoker.invoke('missing:reliability-channel')).rejects.toThrow('MISSING_RELIABILITY_HANDLER');
      expect(fixture.counts().domainEntries).toBe(entries);
      expect(() => boundary.register('review:list', storedHandler)).toThrow('Duplicate channel');
      expect(boundary.handlers.get('review:list')).toBe(storedHandler);
      expect(await fixture.dispose()).toEqual(cleanEvidence);
      expect(boundary.handlers.size).toBe(0);
      await expect(api.review.list(emptyReviewRequest)).rejects.toThrow('RELIABILITY_FIXTURE_DISPOSED');
      await expect(Promise.resolve().then(() => storedHandler({ senderFrame: { url: RELIABILITY_URL } }, emptyReviewRequest)))
        .rejects.toThrow('RELIABILITY_FIXTURE_DISPOSED');
      expect(fixture.counts().domainEntries).toBe(entries);
      await fixture.idle();
    });
  }, 30_000);

  it('cleans partial native construction when actual registrar installation fails', async () => {
    const reports: CleanupEvidence[] = [];
    boundary.failOnChannel = 'leads:list'; // health was registered before this real registration
    await expect(createReliabilityDomainFixture(boundary.handlers, evidence => reports.push(evidence)))
      .rejects.toThrow('INJECTED_REGISTRATION_FAILURE');
    expect(reports).toEqual([cleanEvidence]);
    expect(boundary.handlers.size).toBe(0);
  }, 30_000);
});

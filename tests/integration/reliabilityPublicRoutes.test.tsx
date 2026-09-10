// @vitest-environment jsdom
// Native encrypted SQL + actual preload/registrars and jsdom routes, NOT browser/OS acceptance.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import type { CalliePreloadApi } from '../../src/shared/preload';
import { leadsListResponseSchema, type LeadsListRequest, type LeadFieldUpdateRequest, type LeadBulkUpdateRequest } from '../../src/shared/contracts/leadsContract';
import { leadDetailSchema } from '../../src/shared/contracts/leadDetailContract';
import { discoveryBriefSchema } from '../../src/shared/contracts/discoveryContract';
import { reviewSnapshotSchema, type ReviewKind, type ReviewListRequest, type ReviewSnapshot, type ResolveReviewRequest } from '../../src/shared/contracts/reviewContract';
import { mutationReceiptSchema } from '../../src/shared/contracts/commonContract';
import { appHealthSchema } from '../../src/shared/healthContract';
import { FounderApp } from '../../src/renderer/app/FounderApp';
import { PresentationRoot } from '../../src/renderer/app/PresentationRoot';
import { useTheme } from '../../src/renderer/app/useTheme';
import { useDensity } from '../../src/renderer/app/useDensity';
import type { FoundationHealth } from '../../src/renderer/foundation/useFoundationHealth';
import type { IpcInvoker } from '../../src/preload/ipcClient';
import type { RegisteredIpcHandler } from '../fixtures/registeredIpcHandler';
import {
  createReliabilityDomainFixture, RELIABILITY_NOW, RELIABILITY_URL,
  type CleanupEvidence, type ReliabilityDomainFixture, type ReliabilityTrace, type ReviewOwner,
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
let originalUrl: string;
let originalTheme: string | null;
let originalDensity: string | null;
beforeEach(() => {
  originalUrl = window.location.href;
  originalTheme = document.documentElement.getAttribute('data-theme');
  originalDensity = document.documentElement.getAttribute('data-density');
  window.history.replaceState(null, '', window.location.pathname);
});
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
  cleanup();
  window.history.replaceState(null, '', originalUrl);
  for (const [name, value] of [['data-theme', originalTheme], ['data-density', originalDensity]] as const) {
    if (value === null) document.documentElement.removeAttribute(name);
    else document.documentElement.setAttribute(name, value);
  }
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
  const cleanupErrors: unknown[] = [];
  try { cleanup(); } catch (error) { cleanupErrors.push(error); }
  // Component effects are stopped before admission closes and delivery is cancelled.
  // A failed unmount still attempts fixture retirement, preserving both errors.
  try {
    expect(await fixture.dispose()).toEqual(cleanEvidence);
    expect(await fixture.dispose()).toEqual(cleanEvidence);
  } catch (error) { cleanupErrors.push(error); }
  finally { boundary.invoker = null; }
  if (cleanupErrors.length > 0) throw new AggregateError(failed ? [failure, ...cleanupErrors] : cleanupErrors,
    'Fixture assertion or cleanup failed', { cause: failed ? failure : cleanupErrors[0] });
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

// Explicit renderer admission fixture, NOT a FoundationRuntime startup audit.
// gate.getHealth continues to reject. No response DTO or API method is replaced.
const rendererAdmissionHealth: FoundationHealth = {
  status: 'ready', retry: () => { throw new Error('Health retry is outside this route test'); },
  health: appHealthSchema.parse({
    appVersion: 'fixture-admission-only', schemaVersion: 24, databasePath: '/fixture-admission-only',
    databaseEncrypted: true, cipherVersion: 'fixture-admission-only', fts5Available: true,
    pendingJobs: 0, interruptedJobsRecovered: 0, domainStatus: 'ready', domainReady: true,
    domainBlockingViolationCount: 0, domainRepairableIssueCount: 0,
    domainProjectionRefreshCandidateCount: 0, pendingProjectionRebuilds: 0,
    domainStartupEvaluatedAt: RELIABILITY_NOW, operationalStatus: 'ready',
    sourcing: { status: 'healthy', reasons: [], lastSuccessAgeMs: null,
      state: { state: 'idle', pollId: null, startedAt: null, lastCompletedAt: null,
        consecutiveFailures: 0, lastFailureAt: null, lastFailureCode: null, backlogCount: null } },
  }),
};
function ActualWorkspace({ initialRoute = 'today' }: { initialRoute?: 'today' | 'inbox' | 'leads' }) {
  const theme = useTheme();
  const density = useDensity();
  return <PresentationRoot><FounderApp api={api} health={rendererAdmissionHealth}
    theme={theme} density={density} initialRoute={initialRoute} /></PresentationRoot>;
}
const kindLabels: Record<ReviewKind, string> = {
  unmatched_communication: 'Unmatched communications', system_error: 'System errors',
  ambiguous_identity: 'Ambiguous identities', transcript_suggestion: 'Transcript suggestions',
  import_problem: 'Import problems', adapter_failure: 'Adapter failures',
};
const unavailableKinds = ['ambiguous_identity', 'transcript_suggestion', 'import_problem', 'adapter_failure'] as const;
const pageRequest = (kind: ReviewKind, cursor: string | null = null): ReviewListRequest => ({ kinds: [kind], cursor, limit: 200 });
const readEntries = (fixture: ReliabilityDomainFixture) => fixture.trace().filter(entry => entry.channel === 'review:list');
const listed = (entry: ReliabilityTrace): ReviewSnapshot => reviewSnapshotSchema.parse(entry.result);
const latestList = (fixture: ReliabilityDomainFixture) => listed(readEntries(fixture).at(-1)!);
async function flush(fixture: ReliabilityDomainFixture) {
  await act(async () => { await fixture.idle(); });
}
function inboxLink() {
  const link = within(screen.getByRole('navigation', { name: 'Primary' })).getByRole('link', {
    // Adjacent inline spans concatenate in jsdom. Chromium may insert whitespace.
    name: /^Inbox\s*(?:\d+ open local reviews|Checking local reviews|Local review count unavailable)$/,
  });
  expect(link.getAttribute('href')).toBe('#/inbox');
  const label = within(link).getByText('Inbox', { selector: '.nav-rail__label' });
  const localBadge = link.querySelector<HTMLElement>('.nav-rail__badge');
  expect(localBadge).not.toBeNull();
  for (const element of [label, localBadge!]) {
    expect(element.closest('[hidden], [aria-hidden="true"]')).toBeNull();
    expect(window.getComputedStyle(element).display).not.toBe('none');
    expect(window.getComputedStyle(element).visibility).not.toBe('hidden');
  }
  const observation = localBadge!.getAttribute('aria-label')!;
  expect(observation).toMatch(/^(?:\d+ open local reviews|Checking local reviews|Local review count unavailable)$/);
  expect(localBadge!.textContent).toBe(observation === 'Checking local reviews' ? '…'
    : observation === 'Local review count unavailable' ? '?' : observation.split(' ')[0]);
  return link;
}
function inboxHeading(count: number) {
  const heading = screen.getByRole('heading', { level: 1,
    name: new RegExp(`^Inbox\\s*· ${count} open local reviews$`) });
  expect(heading.firstChild?.textContent).toBe('Inbox');
  const countLabel = heading.querySelector<HTMLElement>('.page-header__count');
  expect(countLabel?.textContent?.trim()).toBe(`· ${count} open local reviews`);
  for (const element of [heading, countLabel!]) {
    expect(element.closest('[hidden], [aria-hidden="true"]')).toBeNull();
    expect(window.getComputedStyle(element).display).not.toBe('none');
    expect(window.getComputedStyle(element).visibility).not.toBe('hidden');
  }
  return heading;
}
async function badge(count: number) {
  await waitFor(() => expect(inboxLink()
    .querySelector('[aria-label]')?.getAttribute('aria-label')).toBe(`${count} open local reviews`));
}
async function startToday(fixture: ReliabilityDomainFixture) {
  fixture.setPhase('ui');
  render(<ActualWorkspace />);
  expect(screen.getByRole('link', { name: 'Today' }).getAttribute('aria-current')).toBe('page');
  expect(await screen.findByTestId('today-route')).toBeTruthy();
  expect(await screen.findByRole('heading', { name: 'Suggested contacts' })).toBeTruthy();
  await waitFor(() => expect(fixture.trace().find(entry => entry.channel === 'discovery:get')?.outcome).toBe('resolved'));
  await flush(fixture);
  expect(readEntries(fixture).map(entry => entry.args)).toEqual([[emptyReviewRequest]]);
  const more = screen.getByRole('button', { name: 'More workspaces' });
  expect(more.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(more);
  expect(more.getAttribute('aria-expanded')).toBe('true');
  await badge(208);
  expect(inboxLink().getAttribute('aria-current')).toBeNull();
  expect(document.querySelectorAll('.presentation-root[data-presentation="native-a"]')).toHaveLength(1);
}
async function enterInbox(fixture: ReliabilityDomainFixture) {
  fireEvent.click(inboxLink());
  await waitFor(() => expect(inboxLink().getAttribute('aria-current')).toBe('page'));
  await waitFor(() => expect(inboxHeading(208)).toBeTruthy());
  await flush(fixture);
}
async function selectQueue(fixture: ReliabilityDomainFixture, kind: ReviewKind, count: number) {
  fireEvent.click(screen.getByRole('tab', { name: `${kindLabels[kind]} ${count}` }));
  await screen.findByText(`Showing ${Math.min(count, 200)} of ${count} in this view.`);
  await flush(fixture);
}
function assertQueueRows(kind: ReviewOwner['kind'], owners: readonly ReviewOwner[]) {
  const buttons = within(screen.getByRole('list', { name: kindLabels[kind] })).getAllByRole('button');
  expect(buttons).toHaveLength(owners.length);
  if (kind === 'unmatched_communication') {
    expect(buttons.map(button => button.querySelector('.review-item__title')?.textContent)).toEqual(
      owners.map(owner => `Email from ${owner.activationKey.replace('inbound-handle:email:', '')}`),
    );
  } else {
    // System rows have no unique identity-bearing DOM attribute or copy. Exact IDs
    // are checked in the actual UI request trace + independent SQL, not invented DOM IDs.
    expect(buttons.map(button => button.querySelector('.review-item__title')?.textContent))
      .toEqual(owners.map(() => 'operational_cycle_exists'));
  }
}
function assertInventory(fixture: ReliabilityDomainFixture, options: {
  today: boolean; capabilityReads?: 1 | 2; mutations?: number; rejected?: number;
}) {
  const trace = fixture.trace();
  const allowed = new Set(['review:list', 'review:resolve', ...(options.capabilityReads ? ['lead-detail:outbound-capabilities'] : []), ...(options.today ? [
    'local-workspace:get', 'local-workspace:get-commitments', 'daily:get',
    'outreach:delegation-status', 'today:get', 'discovery:get',
  ] : [])]);
  for (const entry of trace) {
    expect(allowed.has(entry.channel), `Unaccounted channel ${entry.channel}`).toBe(true);
    expect(['ui', 'probe']).toContain(entry.phase);
    expect(entry.handlerStarted).toBe(true);
    expect(entry.outcome).not.toBe('pending');
    if (entry.channel === 'lead-detail:outbound-capabilities') {
      expect(entry).toMatchObject({ phase: 'ui', args: [{}], handlerSettled: true, outcome: 'resolved' });
      expect(entry.result).toEqual({
        phoneHandoff: { state: 'unavailable', reasonCode: 'phone_route_unverified' },
        callObservation: { state: 'unavailable', reasonCode: 'not_integrated' },
        recording: { state: 'unavailable', reasonCode: 'not_integrated' },
        messagesSend: { state: 'unavailable', reasonCode: 'not_integrated' },
        gmailSend: { state: 'unavailable', reasonCode: 'not_integrated' },
        managedAudioImport: { state: 'unavailable', reasonCode: 'not_integrated' },
        appleTranscriptExtraction: { state: 'unavailable', reasonCode: 'not_integrated' }, localDrafts: true,
      });
    } else if (entry.channel !== 'review:list' && entry.channel !== 'review:resolve') {
      expect(entry.phase).toBe('ui'); expect(entry.args).toEqual([]); expect(entry.outcome).toBe('resolved');
    }
  }
  if (options.today) {
    for (const channel of ['local-workspace:get', 'local-workspace:get-commitments', 'daily:get', 'outreach:delegation-status', 'today:get']) {
      expect(trace.filter(entry => entry.channel === channel), channel).toHaveLength(1);
    }
    // Genuine useDiscovery initial read and bounded 5-second polling are retained.
    // Every poll stays in this inventory, with real completed outcomes, never ignored.
    const discoveryReads = trace.filter(entry => entry.channel === 'discovery:get');
    expect(discoveryReads.length).toBeGreaterThanOrEqual(1);
    expect(discoveryReads.length).toBeLessThanOrEqual(13);
  }
  expect(trace.filter(entry => entry.channel === 'lead-detail:outbound-capabilities')).toHaveLength(options.capabilityReads ?? 0);
  expect(trace.filter(entry => entry.channel === 'review:resolve')).toHaveLength(options.mutations ?? 0);
  expect(trace.filter(entry => entry.outcome === 'rejected')).toHaveLength(options.rejected ?? 0);
  expect(fixture.counts().externalInvocations).toBe(0);
}
function assertResolution(fixture: ReliabilityDomainFixture, owner: ReviewOwner,
  before: ReturnType<ReliabilityDomainFixture['reviewOwners']>, entry: ReliabilityTrace) {
  const receipt = mutationReceiptSchema.parse(entry.result);
  expect(receipt.affectedPersonIds).toEqual([owner.personId]);
  expect(receipt.affectedSalesCycleIds).toEqual([owner.newCycleId]);
  const after = fixture.reviewOwners();
  expect(after).toHaveLength(208);
  expect(after.filter(row => row.reviewId !== owner.reviewId)).toEqual(before.filter(row => row.reviewId !== owner.reviewId));
  const resolved = after.find(row => row.reviewId === owner.reviewId)!;
  expect(resolved).toMatchObject({ status: 'resolved', version: 2, resolvedAt: RELIABILITY_NOW });
  expect(resolved.resolution).not.toBeNull();
  expect(after.filter(row => row.status === 'open')).toHaveLength(207);
  const cycles = fixture.snapshot().sales_cycles as Record<string, unknown>[];
  expect(cycles.find(row => row.id === owner.newCycleId)).toMatchObject({ person_id: owner.personId,
    prospect_id: owner.prospectId, stage: 'contacted', workflow_status: 'active' });
  return receipt;
}
function promoteRequest(owner: ReviewOwner, sourceEventId: string): ResolveReviewRequest {
  return { kind: 'unmatched_communication' as const, reviewId: owner.reviewId, expectedVersion: 1,
    action: 'promote' as const, personId: null, sourceEventId };
}

describe('reliability Step B: actual Inbox/public lifecycle joins, not packaged acceptance', () => {
  for (const majority of ['system_error', 'unmatched_communication'] as const) {
    for (const tied of [false, true]) {
      it(`reaches exact 208 through actual Inbox with ${majority} majority and ${tied ? 'equal' : 'older/later'} timestamps`, async () => {
        await withFixture(async fixture => {
          const owners = fixture.seedReviews({ majority, tied });
          const stored = fixture.reviewOwners();
          expect(stored.map(row => row.reviewId)).toEqual(owners.map(row => row.reviewId));
          if (tied) {
            expect(new Set(stored.map(row => row.createdAt))).toEqual(new Set(['2026-08-31T15:00:00.000Z']));
            expect(stored.map(row => row.reviewId)).toEqual(stored.map(row => row.reviewId).sort());
          }
          const before = fixture.snapshot(); const changes = fixture.totalChanges();
          await startToday(fixture);
          const startup = listed(readEntries(fixture)[0]!);
          expect(startup.totalOpenCount).toBe(208);
          await enterInbox(fixture);
          const expectedRequests: ReviewListRequest[] = [emptyReviewRequest, pageRequest('unmatched_communication'), emptyReviewRequest];
          const minority = majority === 'system_error' ? 'unmatched_communication' : 'system_error';
          await selectQueue(fixture, minority, 3);
          if (minority !== 'unmatched_communication') expectedRequests.push(pageRequest(minority));
          assertQueueRows(minority, owners.filter(row => row.kind === minority));
          const minorityPage = [...readEntries(fixture)].reverse().find(entry => (entry.args[0] as ReviewListRequest).kinds[0] === minority)!;
          expect(listed(minorityPage).items.map(item => item.reviewId)).toEqual(owners.filter(row => row.kind === minority).map(row => row.reviewId));
          expect(listed(minorityPage).nextCursor).toBeNull();
          await selectQueue(fixture, majority, 205);
          expectedRequests.push(pageRequest(majority));
          const first = latestList(fixture);
          expect(first.items.map(item => item.reviewId)).toEqual(owners.filter(row => row.kind === majority).slice(0, 200).map(row => row.reviewId));
          expect(first.nextCursor).toEqual(expect.any(String));
          assertQueueRows(majority, owners.filter(row => row.kind === majority).slice(0, 200));
          fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
          await screen.findByText('Showing 205 of 205 in this view.'); await flush(fixture);
          expectedRequests.push(pageRequest(majority, first.nextCursor));
          const last = latestList(fixture);
          expect(last.items).toHaveLength(5); expect(last.nextCursor).toBeNull();
          const actualIds = [...first.items, ...last.items, ...listed(minorityPage).items].map(item => item.reviewId);
          expect(new Set(actualIds).size).toBe(208);
          expect([...actualIds].sort()).toEqual(owners.map(row => row.reviewId).sort());
          expect([...first.items, ...last.items].map(item => item.reviewId)).toEqual(owners.filter(row => row.kind === majority).map(row => row.reviewId));
          assertQueueRows(majority, owners.filter(row => row.kind === majority));
          expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
          for (const kind of unavailableKinds) {
            expect(last.queues[kind]).toEqual({ source: 'not_integrated', openCount: null });
            fireEvent.click(screen.getByRole('tab', { name: `${kindLabels[kind]} Not available in this Inbox` }));
            await screen.findByText('Showing 0 of 0 in this view.'); await flush(fixture);
            expectedRequests.push(pageRequest(kind));
            expect(screen.getByText('This source is not integrated into this local Inbox. No count or health conclusion is available.')).toBeTruthy();
            expect(latestList(fixture).items).toEqual([]);
            expect(latestList(fixture).queues[kind]).toEqual({ source: 'not_integrated', openCount: null });
            for (const action of ['Retry', 'Dismiss', 'Accept', 'Repair', 'Mark personal', 'Never Record']) {
              expect(screen.queryByRole('button', { name: action })).toBeNull();
            }
          }
          expect(readEntries(fixture).map(entry => entry.args)).toEqual(expectedRequests.map(request => [request]));
          expect(readEntries(fixture).every(entry => entry.phase === 'ui')).toBe(true);
          await badge(208);
          expect(fixture.snapshot()).toEqual(before); expect(fixture.totalChanges()).toBe(changes);
          assertInventory(fixture, { today: true, capabilityReads: 1 });
        });
      }, 60_000);
    }
  }

  it('promotes one actual selected Inbox review through the public form and rejects its old cursor without read writes', async () => {
    await withFixture(async fixture => {
      const owners = fixture.seedReviews();
      const owner = owners.find(row => row.kind === 'unmatched_communication')!;
      const { sourceEventId } = fixture.seedPromoteEvidence(owner.reviewId);
      const before = fixture.reviewOwners();
      fixture.setPhase('probe');
      const first = await api.review.list({ kinds: [], cursor: null, limit: 200 });
      expect(first.nextCursor).toEqual(expect.any(String));
      // startToday checks only the new UI reads, so preserve the named probe separately.
      fixture.setPhase('ui');
      render(<ActualWorkspace />);
      await screen.findByTestId('today-route');
      await waitFor(() => expect(fixture.trace().find(entry => entry.channel === 'discovery:get')?.outcome).toBe('resolved'));
      await flush(fixture);
      fireEvent.click(screen.getByRole('button', { name: 'More workspaces' })); await badge(208);
      expect(screen.getByRole('link', { name: 'Today' }).getAttribute('aria-current')).toBe('page');
      await enterInbox(fixture);
      await screen.findByText('Showing 3 of 3 in this view.');
      const row = within(screen.getByRole('list', { name: 'Unmatched communications' })).getAllByRole('button')[0]!;
      expect(row.textContent).toContain(owner.activationKey.replace('inbound-handle:email:', ''));
      fireEvent.click(row);
      fireEvent.change(screen.getByLabelText('Matched source event ID'), { target: { value: sourceEventId } });
      const request = promoteRequest(owner, sourceEventId);
      fireEvent.click(screen.getByRole('button', { name: 'Promote' }));
      await screen.findByText('Showing 2 of 2 in this view.'); await flush(fixture); await badge(207);
      const mutations = fixture.trace().filter(entry => entry.channel === 'review:resolve');
      expect(mutations).toHaveLength(1);
      expect(mutations[0]).toMatchObject({ args: [request], phase: 'ui', outcome: 'resolved' });
      assertResolution(fixture, owner, before, mutations[0]!);
      const remaining = before.filter(row => row.reason === 'unknown_inbound_handle' && row.reviewId !== owner.reviewId);
      expect(remaining).toHaveLength(2);
      const latestUiPage = [...readEntries(fixture)].reverse().find(entry => entry.phase === 'ui'
        && (entry.args[0] as ReviewListRequest).kinds[0] === 'unmatched_communication')!;
      expect(latestUiPage).toMatchObject({ args: [pageRequest('unmatched_communication')], outcome: 'resolved' });
      expect(listed(latestUiPage).items.map(item => item.reviewId)).toEqual(remaining.map(row => row.reviewId));
      expect(listed(latestUiPage).nextCursor).toBeNull();
      expect(latestList(fixture)).toMatchObject({ totalOpenCount: 207, matchedCount: 2,
        queues: { unmatched_communication: { source: 'lifecycle_review_items', openCount: 2 }, system_error: { openCount: 205 } } });
      expect(readEntries(fixture).filter(entry => entry.phase === 'ui').map(entry => entry.args)).toEqual([
        [emptyReviewRequest], [pageRequest('unmatched_communication')], [emptyReviewRequest],
        [emptyReviewRequest], [pageRequest('unmatched_communication')],
      ]);
      const readSnapshot = fixture.snapshot(); const changes = fixture.totalChanges();
      fixture.setPhase('probe');
      const stale: ReviewListRequest = { kinds: [], cursor: first.nextCursor, limit: 200 };
      await expect(api.review.list(stale)).rejects.toThrow('LIST_CURSOR_STALE');
      const fresh = await api.review.list({ kinds: [], cursor: null, limit: 200 });
      expect(fresh.totalOpenCount).toBe(207);
      expect(fresh.items.some(item => item.reviewId === owner.reviewId)).toBe(false);
      expect(readEntries(fixture).filter(entry => entry.phase === 'probe').map(entry => entry.args)).toEqual([
        [{ kinds: [], cursor: null, limit: 200 }], [stale], [{ kinds: [], cursor: null, limit: 200 }],
      ]);
      expect(fixture.snapshot()).toEqual(readSnapshot); expect(fixture.totalChanges()).toBe(changes);
      assertInventory(fixture, { today: true, capabilityReads: 1, mutations: 1, rejected: 1 });
    });
  }, 60_000);
});

describe('reliability Step B: real observation delivery ownership', () => {
  const cases = [
    { strict: false, newerFirst: false, obsoleteFailure: false },
    { strict: false, newerFirst: true, obsoleteFailure: false },
    { strict: true, newerFirst: false, obsoleteFailure: false },
    { strict: true, newerFirst: true, obsoleteFailure: false },
    { strict: true, newerFirst: true, obsoleteFailure: true },
  ];
  for (const scenario of cases) {
    it(`${scenario.strict ? 'initial Inbox StrictMode child-before-parent' : 'Today to Inbox stable API'}: ${scenario.newerFirst ? 'summary-new first' : 'page-old first'}${scenario.obsoleteFailure ? ', obsolete page transport rejection' : ''}`, async () => {
      await withFixture(async fixture => {
        const owners = fixture.seedReviews();
        const owner = owners.find(row => row.kind === 'unmatched_communication')!;
        const { sourceEventId } = fixture.seedPromoteEvidence(owner.reviewId);
        const before = fixture.reviewOwners();
        if (!scenario.strict) await startToday(fixture);
        const count = scenario.strict ? 2 : 1;
        const oldPages = Array.from({ length: count }, (_, index) => fixture.holdReviewList(pageRequest('unmatched_communication'), index + 1));
        const oldSummaries = Array.from({ length: count }, (_, index) => fixture.holdReviewList(emptyReviewRequest, index + 1));
        fixture.setPhase('ui');
        if (scenario.strict) {
          render(<StrictMode><ActualWorkspace initialRoute="inbox" /></StrictMode>);
          fireEvent.click(screen.getByRole('button', { name: 'More workspaces' }));
        } else fireEvent.click(inboxLink());
        let arrivals: ReliabilityTrace[] = [];
        await act(async () => { arrivals = await Promise.all([...oldPages, ...oldSummaries].map(hold => hold.arrived())); });
        expect(new Set(arrivals.map(entry => entry.id)).size).toBe(count * 2);
        for (const entry of arrivals) {
          expect(entry).toMatchObject({ channel: 'review:list', phase: 'ui', handlerStarted: true,
            handlerSettled: true, deliveryHeld: true, outcome: 'pending' });
          expect(listed(entry)).toMatchObject({ totalOpenCount: 208, observedAt: RELIABILITY_NOW });
        }
        // The real child page begins before its parent summary effect, including
        // the first StrictMode mount while the summary hook is not active yet.
        expect(arrivals[0]!.id).toBeLessThan(arrivals[count]!.id);
        expect(inboxLink().getAttribute('aria-current')).toBe('page');
        const startsBeforeProbe = readEntries(fixture);
        expect(startsBeforeProbe.map(entry => entry.args)).toEqual(scenario.strict
          ? [[pageRequest('unmatched_communication')], [emptyReviewRequest], [pageRequest('unmatched_communication')], [emptyReviewRequest]]
          : [[emptyReviewRequest], [pageRequest('unmatched_communication')], [emptyReviewRequest]]);
        // Named public probe, NOT a UI-initiated Promote. It creates the differing
        // persisted count while all captured old domain observations remain 208.
        fixture.setPhase('probe');
        const request = promoteRequest(owner, sourceEventId);
        const receipt = await api.review.resolve(request);
        const mutation = fixture.trace().find(entry => entry.channel === 'review:resolve')!;
        expect(mutation).toMatchObject({ phase: 'probe', args: [request], outcome: 'resolved', result: receipt });
        assertResolution(fixture, owner, before, mutation);
        const afterMutation = fixture.snapshot(); const changes = fixture.totalChanges();
        fixture.setPhase('ui');
        const newer = fixture.holdReviewList(emptyReviewRequest);
        let newerArrival!: ReliabilityTrace;
        await act(async () => { fireEvent.focus(window); newerArrival = await newer.arrived(); });
        expect(newerArrival.id).toBeGreaterThan(Math.max(...arrivals.map(entry => entry.id)));
        expect(listed(newerArrival)).toMatchObject({ totalOpenCount: 207, observedAt: RELIABILITY_NOW });
        // Older summaries may settle but cannot become the newest owner either.
        await act(async () => { oldSummaries.forEach(hold => hold.release()); });
        expect(screen.getByLabelText('Checking local reviews')).toBeTruthy();
        const finishPages = async () => {
          await act(async () => {
            oldPages.forEach((hold, index) => {
              if (scenario.obsoleteFailure && index === oldPages.length - 1) hold.rejectDelivery();
              else hold.release();
            });
          });
          if (scenario.obsoleteFailure) {
            expect(await screen.findByText('The review queues could not load')).toBeTruthy();
          } else {
            expect(await screen.findByText('Showing 3 of 3 in this view.')).toBeTruthy();
            assertQueueRows('unmatched_communication', owners.filter(row => row.kind === 'unmatched_communication'));
            // Current route generation may render its genuine older page. This
            // does not grant that request ownership of the later global badge.
            expect(inboxHeading(208)).toBeTruthy();
          }
        };
        if (scenario.newerFirst) {
          await act(async () => { newer.release(); }); await badge(207);
          await finishPages(); await badge(207);
        } else {
          await finishPages();
          expect(screen.getByLabelText('Checking local reviews')).toBeTruthy();
          await act(async () => { newer.release(); }); await badge(207);
        }
        await flush(fixture);
        expect(readEntries(fixture).map(entry => entry.args)).toEqual([
          ...startsBeforeProbe.map(entry => entry.args), [emptyReviewRequest],
        ]);
        expect(readEntries(fixture).every(entry => entry.phase === 'ui')).toBe(true);
        expect(fixture.trace().filter(entry => entry.phase === 'probe')).toEqual([mutation]);
        expect(fixture.snapshot()).toEqual(afterMutation); expect(fixture.totalChanges()).toBe(changes);
        assertInventory(fixture, { today: !scenario.strict, capabilityReads: scenario.strict ? 2 : 1, mutations: 1, rejected: scenario.obsoleteFailure ? 1 : 0 });
      });
    }, 60_000);
  }
});

type ObservedReadOutcome = { value: ReviewSnapshot | null; error: unknown };
describe('reliability Step B: finite after-handler transport lifetime', () => {
  for (const decision of ['release', 'rejectDelivery', 'cancel'] as const) {
    it(`uses one real result with ${decision}, rejects duplicate ownership and terminal decisions`, async () => {
      await withFixture(async fixture => {
        fixture.setPhase('probe');
        const before = fixture.snapshot(); const changes = fixture.totalChanges();
        const hold = fixture.holdReviewList(emptyReviewRequest);
        expect(() => fixture.holdReviewList(emptyReviewRequest)).toThrow('DUPLICATE_REVIEW_DELIVERY_HOLD');
        expect(() => hold.release()).toThrow('REVIEW_DELIVERY_ALREADY_DECIDED_OR_NOT_ARRIVED');
        const pending = api.review.list(emptyReviewRequest);
        // Attach the owner before selecting rejection to prevent an unhandled rejection.
        const outcome = pending.then((value): ObservedReadOutcome => ({ value, error: null }), (error: unknown): ObservedReadOutcome => ({ value: null, error }));
        const arrival = await hold.arrived();
        expect(arrival).toMatchObject({ handlerStarted: true, handlerSettled: true, deliveryHeld: true, outcome: 'pending' });
        expect(listed(arrival).totalOpenCount).toBe(0);
        hold[decision]();
        expect(() => hold[decision]()).toThrow('REVIEW_DELIVERY_ALREADY_DECIDED_OR_NOT_ARRIVED');
        const result = await outcome;
        if (decision === 'release') expect(result).toEqual({ value: listed(arrival), error: null });
        else expect(result.error).toMatchObject({ message: decision === 'cancel' ? 'REVIEW_DELIVERY_CANCELLED' : 'REVIEW_DELIVERY_REJECTED' });
        await fixture.idle();
        expect(fixture.trace()).toHaveLength(1);
        expect(fixture.trace()[0]!.result).toEqual(arrival.result);
        expect(fixture.snapshot()).toEqual(before); expect(fixture.totalChanges()).toBe(changes);
        assertInventory(fixture, { today: false, rejected: decision === 'release' ? 0 : 1 });
      });
    }, 30_000);
  }

  it('reports an unused hold as a cleanup failure while retiring every owned resource', async () => {
    const evidence: CleanupEvidence[] = [];
    const fixture = await createReliabilityDomainFixture(boundary.handlers, result => evidence.push(result));
    boundary.invoker = fixture.invoker;
    const hold = fixture.holdReviewList(emptyReviewRequest);
    const disposal = fixture.dispose();
    await expect(disposal).rejects.toMatchObject({ message: 'Reliability fixture cleanup failed',
      errors: [expect.objectContaining({ message: 'UNUSED_REVIEW_DELIVERY_HOLD' })] });
    expect(fixture.dispose()).toBe(disposal);
    expect(evidence).toEqual([cleanEvidence]);
    expect(hold.state()).toBe('cancelled');
    await expect(hold.arrived()).rejects.toThrow('REVIEW_DELIVERY_CANCELLED');
    expect(() => hold.release()).toThrow('RELIABILITY_FIXTURE_DISPOSED');
    expect(() => fixture.holdReviewList(emptyReviewRequest)).toThrow('RELIABILITY_FIXTURE_DISPOSED');
    expect(fixture.trace()).toEqual([]);
  }, 30_000);

  for (const waitForArrival of [false, true]) {
    it(`cancels ${waitForArrival ? 'arrived' : 'already-started'} delivery before drain and refuses post-disposal invocation`, async () => {
      await withFixture(async fixture => {
        fixture.setPhase('probe');
        const hold = fixture.holdReviewList(emptyReviewRequest);
        const pending = api.review.list(emptyReviewRequest).then((value): ObservedReadOutcome => ({ value, error: null }),
          (error: unknown): ObservedReadOutcome => ({ value: null, error }));
        if (waitForArrival) await hold.arrived();
        expect(await fixture.dispose()).toEqual(cleanEvidence);
        expect(await pending).toMatchObject({ value: null, error: { message: 'REVIEW_DELIVERY_CANCELLED' } });
        expect(hold.state()).toBe('cancelled');
        expect(fixture.trace()).toHaveLength(1);
        expect(fixture.trace()[0]).toMatchObject({ channel: 'review:list', handlerStarted: true, outcome: 'rejected' });
        const entries = fixture.counts().domainEntries;
        await expect(api.review.list(emptyReviewRequest)).rejects.toThrow('RELIABILITY_FIXTURE_DISPOSED');
        expect(fixture.counts().domainEntries).toBe(entries);
        expect(() => hold.release()).toThrow('RELIABILITY_FIXTURE_DISPOSED');
        await fixture.idle();
      });
    }, 30_000);
  }
});

// C1 layout is only the finite DOM geometry required by the shipped virtualizer.
// No virtualizer, component, preload API or response is replaced.
async function withLeadsLayout(run: (fixture: ReliabilityDomainFixture) => Promise<void>) {
  const prototype = HTMLElement.prototype;
  const names = ['offsetWidth', 'offsetHeight', 'clientHeight', 'scrollHeight', 'scrollTo'] as const;
  const originals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(prototype, name)]));
  // Restoration uses own descriptors. Delegation must also honor inherited accessors.
  const effective = new Map(names.map(name => {
    let owner: object | null = prototype;
    while (owner !== null) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, name);
      if (descriptor) return [name, descriptor] as const;
      owner = Object.getPrototypeOf(owner) as object | null;
    }
    return [name, undefined] as const;
  }));
  const isGrid = (element: HTMLElement) => element.matches('.leads-grid__scroll');
  let layoutActive = true;
  const queuedScrolls = new Set<HTMLElement>();
  let failure: unknown;
  let failed = false;
  const restorationErrors: unknown[] = [];
  try {
    for (const name of ['offsetWidth', 'offsetHeight', 'clientHeight', 'scrollHeight'] as const) {
      const previous = effective.get(name);
      Object.defineProperty(prototype, name, { configurable: true, get(this: HTMLElement) {
        if (!isGrid(this)) {
          if (!previous?.get) throw new Error(`Missing original ${name} accessor`);
          return previous.get.call(this);
        }
        if (name === 'offsetWidth') return 960;
        // virtual-core getMaxScrollOffset needs real body height minus clientHeight.
        if (name === 'scrollHeight') return Math.max(480, Number.parseFloat(this.querySelector<HTMLElement>('.leads-grid__body')?.style.height ?? '0'));
        return 480;
      } });
    }
    Object.defineProperty(prototype, 'scrollTo', { configurable: true, writable: true,
      value(this: HTMLElement, options: ScrollToOptions | number, y?: number) {
        if (!isGrid(this)) {
          const previous = effective.get('scrollTo')?.value as HTMLElement['scrollTo'] | undefined;
          if (previous) return typeof options === 'number' ? previous.call(this, options, y ?? 0) : previous.call(this, options);
          throw new Error('Unexpected non-grid scrollTo in C1');
        }
        const top = typeof options === 'number' ? y ?? 0 : options.top ?? this.scrollTop;
        const next = Math.max(0, Math.min(top, this.scrollHeight - this.clientHeight));
        if (next === this.scrollTop) return;
        this.scrollTop = next;
        if (queuedScrolls.has(this)) return;
        queuedScrolls.add(this);
        queueMicrotask(() => {
          // Logical cancellation: retired or disconnected owners never dispatch.
          if (!queuedScrolls.delete(this) || !layoutActive || !this.isConnected) return;
          this.dispatchEvent(new Event('scroll'));
        });
      } });
    await withFixture(run); // unmount and native fixture disposal finish before descriptor restoration
  } catch (error) { failure = error; failed = true; }
  finally {
    layoutActive = false;
    queuedScrolls.clear();
    for (const name of names) {
      try {
        const previous = originals.get(name);
        if (previous) Object.defineProperty(prototype, name, previous);
        else Reflect.deleteProperty(prototype, name);
        expect(Object.getOwnPropertyDescriptor(prototype, name)).toEqual(previous);
      } catch (error) { restorationErrors.push(error); }
    }
  }
  if (restorationErrors.length > 0) throw new AggregateError(failed ? [failure, ...restorationErrors] : restorationErrors,
    'C1 layout assertion and restoration failed');
  if (failed) throw failure;
}
type ImportedOwner = ReturnType<ReliabilityDomainFixture['importedOwners']>[number];
const leadRequest = (query = '', cursor: string | null = null, sort: LeadsListRequest['sort'] = 'person_name'): LeadsListRequest =>
  ({ query, stages: [], priorities: [], sort, cursor, limit: 200 });
const channelEntries = (fixture: ReliabilityDomainFixture, channel: string) => fixture.trace().filter(entry => entry.channel === channel);
const latestLeads = (fixture: ReliabilityDomainFixture) => leadsListResponseSchema.parse(channelEntries(fixture, 'leads:list').at(-1)!.result);
const safeMutationError = 'The change could not be confirmed. Your input is kept. Review the records before retrying.';
const unavailableCapabilities = {
  phoneHandoff: { state: 'unavailable', reasonCode: 'phone_route_unverified' },
  callObservation: { state: 'unavailable', reasonCode: 'not_integrated' },
  recording: { state: 'unavailable', reasonCode: 'not_integrated' },
  messagesSend: { state: 'unavailable', reasonCode: 'not_integrated' },
  gmailSend: { state: 'unavailable', reasonCode: 'not_integrated' },
  managedAudioImport: { state: 'unavailable', reasonCode: 'not_integrated' },
  appleTranscriptExtraction: { state: 'unavailable', reasonCode: 'not_integrated' }, localDrafts: true,
};
function assertLeadsInventory(fixture: ReliabilityDomainFixture, options: {
  requests: LeadsListRequest[]; mutations?: { channel: 'leads:update-field' | 'leads:bulk-update'; input: LeadFieldUpdateRequest | LeadBulkUpdateRequest }[];
  detail?: ImportedOwner; rejected?: number;
}) {
  const mutations = options.mutations ?? [];
  const trace = fixture.trace();
  const allowed = new Set(['imports:preview', 'imports:commit', 'leads:list', 'review:list', 'lead-detail:outbound-capabilities',
    ...mutations.map(mutation => mutation.channel), ...(options.detail ? ['lead-detail:get', 'discovery:get-brief'] : [])]);
  for (const entry of trace) {
    expect(allowed.has(entry.channel), `Unaccounted C1 channel ${entry.channel}`).toBe(true);
    expect(entry.phase).toBe(entry.channel.startsWith('imports:') ? 'setup' : 'ui');
    expect(entry.handlerStarted).toBe(true); expect(entry.handlerSettled).toBe(true);
    expect(entry.outcome).not.toBe('pending');
  }
  expect(trace.filter(entry => entry.outcome === 'rejected')).toHaveLength(options.rejected ?? 0);
  const preview = channelEntries(fixture, 'imports:preview');
  const commit = channelEntries(fixture, 'imports:commit');
  expect(preview).toHaveLength(1); expect(commit).toHaveLength(1);
  expect(preview[0]!.args).toEqual([{ kind: 'csv', sourceName: 'reliability-208.csv', content:
    ['Name,Email,Organization', ...Array.from({ length: 208 }, (_, index) => {
      const suffix = String(index).padStart(4, '0');
      return `Reliability Lead ${suffix},rel-lead-${suffix}@fixture.invalid,Fictional Shared Organization`;
    })].join('\n') + '\n' }]);
  expect(commit[0]!.args).toEqual([{
    previewId: (preview[0]!.result as { previewId: string }).previewId,
    contentHash: (preview[0]!.result as { contentHash: string }).contentHash,
    mapping: { Name: 'person_name', Email: 'email', Organization: 'organization' },
    source: { channel: 'registry', referredByPersonId: null }, duplicateDecisions: [],
  }]);
  expect(channelEntries(fixture, 'leads:list').map(entry => entry.args)).toEqual(options.requests.map(request => [request]));
  for (const entry of channelEntries(fixture, 'leads:list')) leadsListResponseSchema.parse(entry.result);
  expect(channelEntries(fixture, 'review:list').map(entry => entry.args)).toEqual([[emptyReviewRequest]]);
  expect(listed(channelEntries(fixture, 'review:list')[0]!).totalOpenCount).toBe(0);
  const capabilities = channelEntries(fixture, 'lead-detail:outbound-capabilities');
  expect(capabilities).toHaveLength(1); expect(capabilities[0]!.args).toEqual([{}]);
  expect(capabilities[0]!.result).toEqual(unavailableCapabilities);
  expect(trace.filter(entry => ['leads:update-field', 'leads:bulk-update'].includes(entry.channel))
    .map(entry => ({ channel: entry.channel, input: entry.args[0] }))).toEqual(mutations);
  if (options.detail) {
    const owner = options.detail;
    const details = channelEntries(fixture, 'lead-detail:get');
    const briefs = channelEntries(fixture, 'discovery:get-brief');
    expect(details).toHaveLength(1); expect(briefs).toHaveLength(1);
    expect(details[0]!.args).toEqual([{ personId: owner.personId }]);
    expect(briefs[0]!.args).toEqual([{ personId: owner.personId }]);
    expect(leadDetailSchema.parse(details[0]!.result)).toMatchObject({ personId: owner.personId,
      salesCycleId: owner.salesCycleId, personName: owner.name, stage: 'unreviewed', outboundAttempts: [] });
    expect(discoveryBriefSchema.parse(briefs[0]!.result)).toEqual({ personId: owner.personId,
      salesCycleId: owner.salesCycleId, personName: owner.name, assessment: null, stale: false, latestOverride: null, pilotNextStep: null });
  }
  expect(fixture.counts().externalInvocations).toBe(0);
}
async function startNameLeads(fixture: ReliabilityDomainFixture, owners: readonly ImportedOwner[]) {
  fixture.setPhase('ui'); render(<ActualWorkspace initialRoute="leads" />);
  await screen.findByText('Showing 200 of 208'); await flush(fixture);
  fireEvent.click(screen.getByRole('button', { name: 'More workspaces' })); await badge(0);
  expect(screen.getByRole('link', { name: 'Leads' }).getAttribute('aria-current')).toBe('page');
  expect(channelEntries(fixture, 'leads:list').map(entry => entry.args)).toEqual([[leadRequest('', null, 'priority')]]);
  fireEvent.click(screen.getByRole('combobox', { name: 'Sort leads' }));
  fireEvent.click(within(screen.getByRole('listbox', { name: 'Sort leads' })).getByRole('option', { name: 'Name' }));
  await screen.findByText('Showing 200 of 208'); await flush(fixture);
  const first = latestLeads(fixture);
  expect(first.total).toBe(208); expect(first.nextCursor).toEqual(expect.any(String));
  expect(first.rows.map(row => [row.personId, row.personName, row.salesCycleId])).toEqual(
    owners.slice(0, 200).map(owner => [owner.personId, owner.name, owner.salesCycleId]));
  expect(screen.getByRole('grid', { name: 'Leads' }).getAttribute('aria-rowcount')).toBe('201');
  return { requests: [leadRequest('', null, 'priority'), leadRequest()], first };
}
async function loadRemainingLeads(fixture: ReliabilityDomainFixture, owners: readonly ImportedOwner[], firstCursor: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
  await screen.findByText('Showing 208 of 208'); await flush(fixture);
  const last = latestLeads(fixture);
  expect(last.total).toBe(208); expect(last.nextCursor).toBeNull();
  expect(last.rows.map(row => [row.personId, row.personName, row.salesCycleId])).toEqual(
    owners.slice(200).map(owner => [owner.personId, owner.name, owner.salesCycleId]));
  expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  expect(screen.getByRole('grid', { name: 'Leads' }).getAttribute('aria-rowcount')).toBe('209');
  expect(channelEntries(fixture, 'leads:list').at(-1)!.args).toEqual([leadRequest('', firstCursor)]);
}
async function virtualRow(owner: ImportedOwner, index: number) {
  const scroll = screen.getByRole('grid', { name: 'Leads' }).querySelector<HTMLElement>('.leads-grid__scroll')!;
  fireEvent.scroll(scroll, { target: { scrollTop: Math.min(index * 46, scroll.scrollHeight - scroll.clientHeight) } });
  let row: HTMLElement | undefined;
  await waitFor(() => {
    row = [...scroll.querySelectorAll<HTMLElement>('[data-person-id]')].find(element => element.dataset['personId'] === owner.personId);
    expect(row).toBeDefined();
  });
  expect(row!.getAttribute('aria-rowindex')).toBe(String(index + 2));
  return row!;
}
async function filterLeads(fixture: ReliabilityDomainFixture, query: string, count: number) {
  const input = screen.getByRole('searchbox', { name: 'Search leads' });
  fireEvent.change(input, { target: { value: query } });
  await screen.findByText(`Showing ${Math.min(count, 200)} of ${count}`); await flush(fixture);
  expect(latestLeads(fixture).total).toBe(count);
}
async function selectFirstLast(fixture: ReliabilityDomainFixture, owners: readonly ImportedOwner[], firstCursor: string) {
  const firstRow = await virtualRow(owners[0]!, 0);
  fireEvent.click(within(firstRow).getByRole('checkbox', { name: `Select ${owners[0]!.name}` }));
  await loadRemainingLeads(fixture, owners, firstCursor);
  const lastRow = await virtualRow(owners[207]!, 207);
  fireEvent.click(within(lastRow).getByRole('checkbox', { name: `Select ${owners[207]!.name}` }));
  await filterLeads(fixture, owners[0]!.name, 1);
  expect(within(screen.getByRole('toolbar', { name: 'Bulk actions' })).getByText('2 selected · 1 outside view')).toBeTruthy();
  return [owners[0]!.personId, owners[207]!.personId].sort();
}
function beginBulk(value: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Set organization' }));
  const input = screen.getByRole('textbox', { name: 'Organization for 2 selected' }) as HTMLInputElement;
  fireEvent.change(input, { target: { value } });
  return input;
}
function assertBulkPending(input: HTMLInputElement, owner: ImportedOwner) {
  expect(input.readOnly).toBe(true);
  for (const name of ['Save organization', 'Cancel organization', 'Clear']) {
    const button = screen.getByRole('button', { name }) as HTMLButtonElement;
    expect(button.disabled).toBe(true); fireEvent.click(button);
  }
  fireEvent.keyDown(input, { key: 'Enter' }); fireEvent.keyDown(input, { key: 'Enter' }); fireEvent.blur(input);
  const row = document.querySelector<HTMLElement>(`[data-person-id="${owner.personId}"]`)!;
  const checkbox = within(row).getByRole('checkbox', { name: `Select ${owner.name}` }) as HTMLInputElement;
  expect(checkbox.checked).toBe(true); expect(checkbox.disabled).toBe(true); fireEvent.click(checkbox);
  fireEvent.click(row); fireEvent.keyDown(row, { key: 'Enter' });
  fireEvent.doubleClick(within(row).getByText(owner.name, { selector: '.leads-grid__name' }));
  expect(screen.queryByRole('region', { name: 'Unfinished edit' })).toBeNull();
  expect(screen.queryByRole('complementary', { name: `${owner.name} details` })).toBeNull();
  expect(screen.getByText('2 selected · 1 outside view')).toBeTruthy();
}
function assertExactBulk(fixture: ReliabilityDomainFixture, owners: readonly ImportedOwner[], selected: string[], value: string,
  before: ReturnType<ReliabilityDomainFixture['snapshot']>, assignments: ReturnType<ReliabilityDomainFixture['organizationAssignments']>) {
  const mutation = channelEntries(fixture, 'leads:bulk-update'); expect(mutation).toHaveLength(1);
  const receipt = mutationReceiptSchema.parse(mutation[0]!.result);
  expect(receipt.affectedPersonIds).toEqual(selected);
  expect(receipt.affectedSalesCycleIds).toEqual(owners.filter(owner => selected.includes(owner.personId)).map(owner => owner.salesCycleId).sort());
  const after = fixture.organizationAssignments(); expect(after).toHaveLength(208);
  expect(after.filter(row => !selected.includes(row.personId))).toEqual(assignments.filter(row => !selected.includes(row.personId)));
  const changed = after.filter(row => selected.includes(row.personId)); expect(changed).toHaveLength(2);
  expect(changed.map(row => row.personId)).toEqual(selected);
  expect(new Set(changed.map(row => row.organizationId)).size).toBe(1);
  for (const row of changed) {
    expect(row.canonicalName).toBe(value);
    expect(row.organizationId).not.toBe(assignments.find(old => old.personId === row.personId)!.organizationId);
    expect(row.prospectId).toBe(owners.find(owner => owner.personId === row.personId)!.prospectId);
  }
  const current = fixture.snapshot();
  for (const table of Object.keys(before)) {
    if (['organizations', 'organization_aliases', 'prospect_organizations'].includes(table)) continue;
    expect(current[table], table).toEqual(before[table]);
  }
  expect(current['organizations']).toEqual(expect.arrayContaining(before['organizations']!));
  expect(current['organization_aliases']).toEqual(expect.arrayContaining(before['organization_aliases']!));
}

describe('reliability Step C1: actual Leads public routes with independent encrypted ownership', () => {
  it('reaches Name208 through real paging and keyboard-opens owner208, disclosing its actual Discovery brief', async () => {
    await withLeadsLayout(async fixture => {
      const { owners } = await fixture.importLeads(api);
      const before = fixture.snapshot(); const changes = fixture.totalChanges();
      const { requests, first } = await startNameLeads(fixture, owners);
      await loadRemainingLeads(fixture, owners, first.nextCursor!); requests.push(leadRequest('', first.nextCursor));
      const penultimate = await virtualRow(owners[206]!, 206);
      penultimate.focus(); expect(document.activeElement).toBe(penultimate);
      fireEvent.keyDown(penultimate, { key: 'ArrowDown' });
      await waitFor(() => expect(document.activeElement?.getAttribute('data-person-id')).toBe(owners[207]!.personId));
      const last = document.activeElement as HTMLElement;
      expect(last.getAttribute('aria-selected')).toBe('true'); expect(last.getAttribute('aria-rowindex')).toBe('209');
      fireEvent.keyDown(last, { key: 'Enter' });
      const inspector = await screen.findByRole('complementary', { name: `${owners[207]!.name} details` });
      await flush(fixture);
      expect(channelEntries(fixture, 'discovery:get-brief')).toHaveLength(0);
      fireEvent.click(within(inspector).getByText('Details', { selector: 'summary' }));
      await waitFor(() => expect(channelEntries(fixture, 'discovery:get-brief').at(-1)?.outcome).toBe('resolved'));
      await flush(fixture);
      expect(within(within(inspector).getByRole('region', { name: `Discovery evidence for ${owners[207]!.name}` }))
        .getByText('Not assessed')).toBeTruthy();
      expect(fixture.snapshot()).toEqual(before); expect(fixture.totalChanges()).toBe(changes);
      assertLeadsInventory(fixture, { requests, detail: owners[207]! });
    });
  }, 60_000);

  it('captures first+last across paging/filtering and admits one exact bulk mutation while pending', async () => {
    await withLeadsLayout(async fixture => {
      const { owners } = await fixture.importLeads(api);
      const { requests, first } = await startNameLeads(fixture, owners);
      const selected = await selectFirstLast(fixture, owners, first.nextCursor!);
      requests.push(leadRequest('', first.nextCursor), leadRequest(owners[0]!.name));
      const value = 'Fictional Exact Pair Organization';
      const request: LeadBulkUpdateRequest = { personIds: selected, field: 'organization_label', value };
      const hold = fixture.holdLeads({ channel: 'leads:bulk-update', request, at: 'before-handler' });
      const before = fixture.snapshot(); const assignments = fixture.organizationAssignments();
      const changes = fixture.totalChanges(); const entries = fixture.counts().domainEntries;
      const input = beginBulk(value);
      // Native events share one React batch, before any pending-state rerender.
      act(() => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      });
      const arrival = await hold.arrived();
      expect(arrival).toMatchObject({ phase: 'ui', args: [request], handlerStarted: false, outcome: 'pending' });
      expect(arrival.result).toBeUndefined(); assertBulkPending(input, owners[0]!);
      expect(channelEntries(fixture, 'leads:bulk-update')).toHaveLength(1);
      expect(fixture.counts().domainEntries).toBe(entries);
      expect(fixture.snapshot()).toEqual(before); expect(fixture.totalChanges()).toBe(changes);
      await act(async () => { hold.release(); }); await flush(fixture);
      expect(screen.getByText('Saved', { selector: '[role="status"]' })).toBeTruthy();
      expect(screen.queryByRole('toolbar', { name: 'Bulk actions' })).toBeNull();
      expect((screen.getByRole('checkbox', { name: `Select ${owners[0]!.name}` }) as HTMLInputElement).checked).toBe(false);
      assertExactBulk(fixture, owners, selected, value, before, assignments);
      requests.push(leadRequest(owners[0]!.name));
      assertLeadsInventory(fixture, { requests, mutations: [{ channel: 'leads:bulk-update', input: request }] });
    });
  }, 60_000);

  it('rolls back a genuine later-person ambiguity and retains the exact bulk draft/checks across filters', async () => {
    await withLeadsLayout(async fixture => {
      const { owners } = await fixture.importLeads(api);
      const selected = [owners[0]!.personId, owners[207]!.personId].sort();
      expect(fixture.seedAmbiguousMembership(selected[1]!)).toHaveLength(2);
      const { requests, first } = await startNameLeads(fixture, owners);
      expect(await selectFirstLast(fixture, owners, first.nextCursor!)).toEqual(selected);
      requests.push(leadRequest('', first.nextCursor), leadRequest(owners[0]!.name));
      const value = 'Fictional Atomic Refusal Organization';
      const request: LeadBulkUpdateRequest = { personIds: selected, field: 'organization_label', value };
      const hold = fixture.holdLeads({ channel: 'leads:bulk-update', request, at: 'before-handler' });
      const before = fixture.snapshot(); const reads = channelEntries(fixture, 'leads:list').length;
      const input = beginBulk(value); fireEvent.click(screen.getByRole('button', { name: 'Save organization' }));
      expect((await hold.arrived()).handlerStarted).toBe(false); assertBulkPending(input, owners[0]!);
      await act(async () => { hold.release(); }); await flush(fixture);
      expect(screen.getByRole('alert').textContent).toBe(safeMutationError);
      const rejected = channelEntries(fixture, 'leads:bulk-update'); expect(rejected).toHaveLength(1);
      expect(rejected[0]).toMatchObject({ handlerStarted: true, handlerSettled: true, outcome: 'rejected', error: 'The organization assignment is ambiguous.' });
      expect(rejected[0]!.result).toBeUndefined(); expect(channelEntries(fixture, 'leads:list')).toHaveLength(reads);
      expect(fixture.snapshot()).toEqual(before); // total_changes may include rolled-back attempts
      for (const owner of [owners[207]!, owners[0]!]) {
        await filterLeads(fixture, owner.name, 1); requests.push(leadRequest(owner.name));
        expect(screen.getByText('2 selected · 1 outside view')).toBeTruthy();
        expect((screen.getByRole('textbox', { name: 'Organization for 2 selected' }) as HTMLInputElement).value).toBe(value);
        expect((screen.getByRole('checkbox', { name: `Select ${owner.name}` }) as HTMLInputElement).checked).toBe(true);
        expect(screen.getByRole('alert').textContent).toBe(safeMutationError);
      }
      fireEvent.click(screen.getByRole('button', { name: 'Cancel organization' }));
      expect(screen.queryByRole('textbox', { name: 'Organization for 2 selected' })).toBeNull();
      expect(screen.getByText('2 selected · 1 outside view')).toBeTruthy();
      expect(fixture.snapshot()).toEqual(before);
      assertLeadsInventory(fixture, { requests, mutations: [{ channel: 'leads:bulk-update', input: request }], rejected: 1 });
    });
  }, 60_000);

  it('retains a passively hidden inline draft and forwards only one captured update through pending duplicate actions', async () => {
    await withLeadsLayout(async fixture => {
      const { owners } = await fixture.importLeads(api);
      const { requests } = await startNameLeads(fixture, owners);
      const owner = owners[0]!; const draft = 'Fictional Retained Name';
      const row = await virtualRow(owner, 0);
      fireEvent.doubleClick(within(row).getByText(owner.name, { selector: '.leads-grid__name' }));
      fireEvent.change(screen.getByRole('textbox', { name: `Edit name for ${owner.name}` }), { target: { value: draft } });
      const search = screen.getByRole('searchbox', { name: 'Search leads' }); search.focus();
      await filterLeads(fixture, owners[207]!.name, 1); requests.push(leadRequest(owners[207]!.name));
      const retained = screen.getByRole('textbox', { name: `Edit name for ${owner.name}` }) as HTMLInputElement;
      expect(retained.value).toBe(draft); expect(document.activeElement).toBe(search);
      fireEvent.click(screen.getByRole('button', { name: 'Resume edit' })); expect(document.activeElement).toBe(retained);
      const request: LeadFieldUpdateRequest = { personId: owner.personId, field: 'person_name', value: draft };
      const hold = fixture.holdLeads({ channel: 'leads:update-field', request, at: 'before-handler' });
      const before = fixture.snapshot(); const changes = fixture.totalChanges();
      fireEvent.keyDown(retained, { key: 'Enter' });
      expect(await hold.arrived()).toMatchObject({ handlerStarted: false, args: [request] });
      for (const name of ['Resume edit', 'Save edit', 'Cancel edit']) {
        const button = screen.getByRole('button', { name }) as HTMLButtonElement;
        expect(button.disabled).toBe(true); fireEvent.click(button);
      }
      fireEvent.keyDown(retained, { key: 'Enter' }); fireEvent.keyDown(retained, { key: 'Enter' }); fireEvent.blur(retained);
      expect(retained.readOnly).toBe(true); expect(retained.value).toBe(draft);
      const other = document.querySelector<HTMLElement>(`[data-person-id="${owners[207]!.personId}"]`)!;
      fireEvent.click(within(other).getByRole('checkbox')); fireEvent.click(other); fireEvent.keyDown(other, { key: 'Enter' });
      fireEvent.doubleClick(within(other).getByText(owners[207]!.name, { selector: '.leads-grid__name' }));
      expect(screen.queryByRole('textbox', { name: `Edit name for ${owners[207]!.name}` })).toBeNull();
      expect(screen.queryByRole('toolbar', { name: 'Bulk actions' })).toBeNull();
      expect(channelEntries(fixture, 'lead-detail:get')).toHaveLength(0);
      // A second passive control change while pending must still retain the first owner.
      fireEvent.change(search, { target: { value: owners[206]!.name } });
      await screen.findByText('Showing 1 of 1');
      await waitFor(() => expect(channelEntries(fixture, 'leads:list').at(-1)?.outcome).toBe('resolved'));
      requests.push(leadRequest(owners[206]!.name));
      const pendingInput = screen.getByRole('textbox', { name: `Edit name for ${owner.name}` }) as HTMLInputElement;
      expect(pendingInput.value).toBe(draft); expect(pendingInput.readOnly).toBe(true);
      expect(channelEntries(fixture, 'leads:update-field')).toHaveLength(1);
      expect(fixture.snapshot()).toEqual(before); expect(fixture.totalChanges()).toBe(changes);
      await act(async () => { hold.release(); }); await flush(fixture);
      expect(screen.getByText('Saved', { selector: '[role="status"]' })).toBeTruthy();
      expect(screen.queryByRole('region', { name: 'Unfinished edit' })).toBeNull();
      const receipt = mutationReceiptSchema.parse(channelEntries(fixture, 'leads:update-field')[0]!.result);
      expect(receipt.affectedPersonIds).toEqual([owner.personId]); expect(receipt.affectedSalesCycleIds).toEqual([owner.salesCycleId]);
      const stored = fixture.importedOwners();
      expect(stored.find(value => value.personId === owner.personId)).toEqual({ ...owner, name: draft });
      expect(stored.filter(value => value.personId !== owner.personId)).toEqual(owners.filter(value => value.personId !== owner.personId));
      requests.push(leadRequest(owners[206]!.name));
      assertLeadsInventory(fixture, { requests, mutations: [{ channel: 'leads:update-field', input: request }] });
    });
  }, 60_000);

  it('keeps an acknowledged bulk Saved when real list delivery fails and Refresh never resubmits it', async () => {
    await withLeadsLayout(async fixture => {
      const { owners } = await fixture.importLeads(api);
      const { requests, first } = await startNameLeads(fixture, owners);
      const selected = await selectFirstLast(fixture, owners, first.nextCursor!);
      requests.push(leadRequest('', first.nextCursor), leadRequest(owners[0]!.name));
      const value = 'Fictional Acknowledged Organization';
      const request: LeadBulkUpdateRequest = { personIds: selected, field: 'organization_label', value };
      const write = fixture.holdLeads({ channel: 'leads:bulk-update', request, at: 'before-handler' });
      const read = fixture.holdLeads({ channel: 'leads:list', request: leadRequest(owners[0]!.name), at: 'after-handler' });
      const before = fixture.snapshot(); const assignments = fixture.organizationAssignments();
      const input = beginBulk(value); fireEvent.keyDown(input, { key: 'Enter' }); await write.arrived();
      await act(async () => { write.release(); });
      const arrival = await read.arrived();
      expect(arrival).toMatchObject({ handlerStarted: true, handlerSettled: true, deliveryHeld: true, outcome: 'pending' });
      expect(leadsListResponseSchema.parse(arrival.result).rows.map(row => row.personId)).toEqual([owners[0]!.personId]);
      expect(screen.getByText('Saved', { selector: '[role="status"]' })).toBeTruthy();
      expect(screen.queryByRole('toolbar', { name: 'Bulk actions' })).toBeNull();
      assertExactBulk(fixture, owners, selected, value, before, assignments);
      const persisted = fixture.snapshot(); const changes = fixture.totalChanges();
      await act(async () => { read.rejectDelivery(); }); await flush(fixture);
      expect(screen.getByText('Saved; list refresh failed', { selector: '[role="status"]' })).toBeTruthy();
      expect(screen.getByText('Leads could not be loaded')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Save organization' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Refresh list' }));
      await screen.findByText('Showing 1 of 1'); await flush(fixture);
      expect((screen.getByRole('checkbox', { name: `Select ${owners[0]!.name}` }) as HTMLInputElement).checked).toBe(false);
      expect(fixture.snapshot()).toEqual(persisted); expect(fixture.totalChanges()).toBe(changes);
      expect(channelEntries(fixture, 'leads:bulk-update')).toHaveLength(1);
      requests.push(leadRequest(owners[0]!.name), leadRequest(owners[0]!.name));
      assertLeadsInventory(fixture, { requests, mutations: [{ channel: 'leads:bulk-update', input: request }], rejected: 1 });
    });
  }, 60_000);
});

function mutationControl(fixture: ReliabilityDomainFixture, kind: 'inline' | 'bulk', owner: ImportedOwner, occurrence = 1) {
  if (kind === 'inline') {
    const request: LeadFieldUpdateRequest = { personId: owner.personId, field: 'person_name', value: 'Fictional Control Name' };
    return { channel: 'leads:update-field', request,
      hold: fixture.holdLeads({ channel: 'leads:update-field', request, at: 'before-handler' }, occurrence),
      call: () => api.leads.updateField(request) };
  }
  const request: LeadBulkUpdateRequest = { personIds: [owner.personId], field: 'organization_label', value: 'Fictional Control Organization' };
  return { channel: 'leads:bulk-update', request,
    hold: fixture.holdLeads({ channel: 'leads:bulk-update', request, at: 'before-handler' }, occurrence),
    call: () => api.leads.bulkUpdate(request) };
}
function observeOutcome<T>(pending: Promise<T>): Promise<{ value: T | null; error: unknown }> {
  return pending.then((value): { value: T | null; error: unknown } => ({ value, error: null }),
    (error: unknown): { value: T | null; error: unknown } => ({ value: null, error }));
}
function assertControlInventory(fixture: ReliabilityDomainFixture, channel: string, args: readonly unknown[][]) {
  expect(fixture.trace().map(entry => entry.channel)).toEqual(['imports:preview', 'imports:commit', ...args.map(() => channel)]);
  expect(channelEntries(fixture, channel).map(entry => entry.args)).toEqual(args);
  expect(channelEntries(fixture, channel).every(entry => entry.phase === 'probe' && entry.outcome !== 'pending')).toBe(true);
  expect(fixture.counts().externalInvocations).toBe(0);
}
describe('reliability Step C1: finite Leads handler admission and real-result delivery lifetime', () => {
  for (const kind of ['inline', 'bulk'] as const) {
    for (const decision of ['cancel', 'dispose-before-wait', 'dispose-arrived', 'release-dispose', 'forwarded-drain'] as const) {
      it(`${kind} ${decision} never forwards cancelled admission and drains only genuinely started handlers`, async () => {
        await withFixture(async fixture => {
          const { owners } = await fixture.importLeads(api); fixture.setPhase('probe');
          const before = fixture.snapshot(); const changes = fixture.totalChanges(); const entries = fixture.counts().domainEntries;
          const control = mutationControl(fixture, kind, owners[0]!);
          const { hold } = control;
          expect('rejectDelivery' in hold).toBe(false);
          expect(() => mutationControl(fixture, kind, owners[0]!)).toThrow('DUPLICATE_LEADS_CONTROL');
          expect(() => hold.release()).toThrow('LEADS_CONTROL_ALREADY_DECIDED_OR_NOT_ARRIVED');
          const outcome = observeOutcome(control.call());
          if (decision !== 'dispose-before-wait') {
            const arrival = await hold.arrived();
            expect(arrival).toMatchObject({ handlerStarted: false, outcome: 'pending', channel: control.channel, args: [control.request] });
            expect(arrival.result).toBeUndefined(); expect(arrival.handlerSettled).toBeUndefined();
          }
          expect(fixture.snapshot()).toEqual(before); expect(fixture.totalChanges()).toBe(changes);
          expect(fixture.counts().domainEntries).toBe(entries);
          if (decision === 'cancel') {
            hold.cancel();
            expect(() => hold.cancel()).toThrow('LEADS_CONTROL_ALREADY_DECIDED_OR_NOT_ARRIVED');
            expect(await outcome).toMatchObject({ value: null, error: { message: 'LEADS_CONTROL_CANCELLED' } });
            expect(fixture.snapshot()).toEqual(before); expect(fixture.totalChanges()).toBe(changes);
          } else {
            if (decision === 'release-dispose' || decision === 'forwarded-drain') hold.release();
            if (decision === 'forwarded-drain') {
              // One microtask forwards the already-released real handler. No held
              // callback or fake result fabricates the committed mutation.
              await Promise.resolve();
              expect(channelEntries(fixture, control.channel)[0]!.handlerStarted).toBe(true);
              expect(fixture.counts().domainEntries).toBe(entries + 1);
              expect(fixture.snapshot()).not.toEqual(before);
            }
            const disposal = fixture.dispose();
            expect(await disposal).toEqual(cleanEvidence);
            const result = await outcome;
            if (decision === 'forwarded-drain') {
              expect(result.error).toBeNull();
              expect(mutationReceiptSchema.parse(result.value).affectedPersonIds).toEqual([owners[0]!.personId]);
            } else expect(result).toMatchObject({ value: null, error: { message: decision === 'release-dispose'
              ? 'RELIABILITY_FIXTURE_DISPOSED' : 'LEADS_CONTROL_CANCELLED' } });
            expect(fixture.dispose()).toBe(disposal);
            expect(() => hold.release()).toThrow('RELIABILITY_FIXTURE_DISPOSED');
          }
          await fixture.idle();
          const entry = channelEntries(fixture, control.channel)[0]!;
          expect(entry.handlerStarted).toBe(decision === 'forwarded-drain');
          expect(entry.outcome).toBe(decision === 'forwarded-drain' ? 'resolved' : 'rejected');
          if (decision !== 'forwarded-drain') { expect(entry.result).toBeUndefined(); expect(fixture.counts().domainEntries).toBe(entries); }
          assertControlInventory(fixture, control.channel, [[control.request]]);
        });
      }, 60_000);
    }

    it(`${kind} admits an earlier exact request but cancels only the owned second future occurrence`, async () => {
      await withFixture(async fixture => {
        const { owners } = await fixture.importLeads(api); fixture.setPhase('probe');
        const control = mutationControl(fixture, kind, owners[0]!, 2);
        const first = mutationReceiptSchema.parse(await control.call());
        expect(first.affectedPersonIds).toEqual([owners[0]!.personId]); expect(control.hold.state()).toBe('waiting');
        const afterFirst = fixture.snapshot(); const changes = fixture.totalChanges(); const entries = fixture.counts().domainEntries;
        const second = observeOutcome(control.call());
        expect((await control.hold.arrived()).handlerStarted).toBe(false);
        control.hold.cancel();
        expect(await second).toMatchObject({ error: { message: 'LEADS_CONTROL_CANCELLED' } });
        await fixture.idle();
        expect(fixture.snapshot()).toEqual(afterFirst); expect(fixture.totalChanges()).toBe(changes);
        expect(fixture.counts().domainEntries).toBe(entries);
        assertControlInventory(fixture, control.channel, [[control.request], [control.request]]);
      });
    }, 60_000);

    it(`${kind} unused admission is reported while cleanup still retires every owned resource`, async () => {
      const reports: CleanupEvidence[] = [];
      const fixture = await createReliabilityDomainFixture(boundary.handlers, result => reports.push(result));
      boundary.invoker = fixture.invoker;
      let failure: unknown;
      let failed = false;
      try {
        const { owners } = await fixture.importLeads(api);
        const control = mutationControl(fixture, kind, owners[0]!);
        const disposal = fixture.dispose();
        await expect(disposal).rejects.toMatchObject({ message: 'Reliability fixture cleanup failed',
          errors: [expect.objectContaining({ message: 'UNUSED_LEADS_CONTROL' })] });
        expect(fixture.dispose()).toBe(disposal);
        expect(control.hold.state()).toBe('cancelled');
        await expect(control.hold.arrived()).rejects.toThrow('LEADS_CONTROL_CANCELLED');
        expect(reports).toEqual([cleanEvidence]);
        expect(channelEntries(fixture, control.channel)).toEqual([]);
      } catch (error) { failure = error; failed = true; }
      finally {
        // Expected unused-control rejection is asserted above, not silently hidden.
        // If the test failed earlier, preserve both that error and retirement errors.
        try { await fixture.dispose(); } catch (error) {
          if (failed) failure = new AggregateError([failure, error], 'Unused admission assertion and cleanup failed');
        }
        boundary.invoker = null;
      }
      if (failed) throw failure;
    }, 60_000);
  }

  for (const decision of ['release', 'rejectDelivery', 'cancel'] as const) {
    it(`leads:list ${decision} retains the actual completed result and all stored rows`, async () => {
      await withFixture(async fixture => {
        await fixture.importLeads(api); fixture.setPhase('probe');
        const request = leadRequest(); const before = fixture.snapshot(); const changes = fixture.totalChanges();
        const hold = fixture.holdLeads({ channel: 'leads:list', request, at: 'after-handler' });
        expect(() => fixture.holdLeads({ channel: 'leads:list', request, at: 'after-handler' })).toThrow('DUPLICATE_LEADS_CONTROL');
        expect(() => hold.release()).toThrow('LEADS_CONTROL_ALREADY_DECIDED_OR_NOT_ARRIVED');
        const outcome = observeOutcome(api.leads.list(request));
        const arrival = await hold.arrived();
        expect(arrival).toMatchObject({ handlerStarted: true, handlerSettled: true, deliveryHeld: true, outcome: 'pending' });
        const page = leadsListResponseSchema.parse(arrival.result); expect(page.total).toBe(208); expect(page.rows).toHaveLength(200);
        hold[decision](); expect(() => hold[decision]()).toThrow('LEADS_CONTROL_ALREADY_DECIDED_OR_NOT_ARRIVED');
        const result = await outcome;
        if (decision === 'release') expect(result).toEqual({ value: page, error: null });
        else expect(result).toMatchObject({ value: null, error: { message: decision === 'cancel' ? 'LEADS_CONTROL_CANCELLED' : 'LEADS_DELIVERY_REJECTED' } });
        await fixture.idle();
        expect(channelEntries(fixture, 'leads:list')[0]!.result).toEqual(arrival.result);
        expect(fixture.snapshot()).toEqual(before); expect(fixture.totalChanges()).toBe(changes);
        assertControlInventory(fixture, 'leads:list', [[request]]);
      });
    }, 60_000);
  }
});

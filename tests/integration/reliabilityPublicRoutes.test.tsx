// @vitest-environment jsdom
// Native encrypted SQL + actual preload/registrars and jsdom routes, NOT browser/OS acceptance.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import type { CalliePreloadApi } from '../../src/shared/preload';
import type { LeadsListRequest } from '../../src/shared/contracts/leadsContract';
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
function ActualWorkspace({ initialRoute = 'today' }: { initialRoute?: 'today' | 'inbox' }) {
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

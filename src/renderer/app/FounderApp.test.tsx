// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';

import { openImportScript } from '../../main/applicationMenu';
import { discoveryBriefSchema, discoverySnapshotSchema, type DiscoveryApi } from '../../shared/contracts/discoveryContract';
import type { PipelineSnapshot } from '../../shared/contracts/pipelineContract';
import type { TodaySnapshot } from '../../shared/contracts/todayContract';
import type { LeadDetail } from '../../shared/contracts/leadDetailContract';
import type { CalliePreloadApi } from '../../shared/preload';
import type { AppHealth } from '../../shared/healthContract';
import { dailyFixture, localSnapshot, commitments, fixtureNow } from '../features/today/nativeDesk.fixture';
import type { FoundationHealth } from '../foundation/useFoundationHealth';
import { FounderApp, type FounderAppProps } from './FounderApp';
import { useTheme } from './useTheme';
import { useDensity } from './useDensity';
import { PresentationRoot } from './PresentationRoot';

function FounderAppHarness(props: Omit<FounderAppProps, 'theme' | 'density'>) {
  const theme = useTheme();
  const density = useDensity();
  return <PresentationRoot><FounderApp {...props} theme={theme} density={density} /></PresentationRoot>;
}

const detail: LeadDetail = {
  personId: 'person-kevin',
  salesCycleId: 'cycle-kevin',
  personName: 'Kevin Shin',
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
  priorityReasons: ['Direct phone on file'],
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

const todaySnapshot: TodaySnapshot = {
  lanes: [
    {
      id: 'new_p0',
      items: [
        {
          id: 'item-1',
          lane: 'new_p0',
          personId: 'person-kevin',
          salesCycleId: 'cycle-kevin',
          personName: 'Kevin Shin',
          contextLabel: null,
          stage: 'ready',
          priorityContext: null,
          action: {
            id: 'action-1',
            type: 'call',
            channel: 'call',
            label: 'call',
          },
          reason: 'new p0',
          activeTriggers: [],
          verifyFirst: false,
          pinned: false,
          consentRequirement: null,
          cloudScores: null,
        },
      ],
      overflowCount: 0,
    },
  ],
  dialBudget: 20,
  scheduledDials: 1,
  conversationTarget: 5,
  reviewErrorCount: 0,
  unreviewedBacklogCount: 0,
  unreviewedCloudSignalCount: 0,
  conversationsHeld: 0,
  revision: 0,
};

const pipelineSnapshot: PipelineSnapshot = {
  stages: [
    {
      stage: 'ready',
      cards: [
        {
          personId: 'person-kevin',
          salesCycleId: 'cycle-kevin',
          personName: 'Kevin Shin',
          contextLabel: null,
          stage: 'ready',
          stageEnteredAt: '2026-08-30T12:00:00.000Z',
          priorityContext: null,
          nextAction: null,
          lostReasonCode: null,
        },
      ],
    },
  ],
  revision: 0,
};

const emptyReview = {
  items: [] as never[],
  totalOpenCount: 0,
  revision: 0,
};

const preparedBrief = discoveryBriefSchema.parse({
  personId: 'person-kevin', salesCycleId: 'cycle-kevin', personName: 'Kevin Shin', stale: false, latestOverride: null, pilotNextStep: null,
  assessment: { id: '10000000-0000-4000-8000-000000000001', personId: 'person-kevin', salesCycleId: 'cycle-kevin', prospectId: 'prospect-kevin', fingerprint: 'a'.repeat(64), policyVersion: 'discovery-v1', ruleVersionId: 'rules', modelVersion: null, evaluatedAt: '2026-09-06T12:00:00.000Z', expiresAt: '2026-09-07T12:00:00.000Z', localDate: '2026-09-06', overrideId: null, disposition: 'candidate', reasonCodes: [], axes: { fit: null, timing: { milliPoints: 0, band: 'cold', hasSupportedTrigger: false }, reachability: 'none' }, claims: [], unknowns: ['Management unknown'], questions: ['Who handles maintenance?'], identitySupported: true, needsResearch: false, ranking: { priority: null, earliestTriggerExpiresAt: null, dataConfidence: 0, lastContactAt: null, latestSourceObservedAt: null } },
});
const discoveryApi = (): DiscoveryApi => ({
  get: vi.fn(async () => discoverySnapshotSchema.parse({ prepared: [preparedBrief], judgment: [], counts: { unassessed: 2881, research: 0, watch: 0, excluded: 0 }, processing: 'running', researchCapability: 'not_configured', generatedAt: '2026-09-06T12:00:00.000Z', revision: 1 })),
  getBrief: vi.fn(async () => preparedBrief),
  begin: vi.fn(async request => ({ personId: request.personId, salesCycleId: request.salesCycleId, assessmentId: request.assessmentId, actionId: 'action-kevin', mutation: { revision: 2, affectedPersonIds: ['person-kevin'], affectedSalesCycleIds: ['cycle-kevin'] } })),
  override: vi.fn(async () => ({ revision: 2, affectedPersonIds: ['person-kevin'], affectedSalesCycleIds: ['cycle-kevin'] })),
});

function fakeCallieApi(): CalliePreloadApi {
  const pending = vi.fn(() => new Promise<never>(() => undefined));
  return {
    discovery: discoveryApi(),
    health: { get: vi.fn(async () => healthValue) },
    daily: { get: vi.fn(async () => ({ ...dailyFixture(), workflowMode: 'legacy' as const })) },
    localWorkspace: {
      get: vi.fn(async () => localSnapshot({ workflowMode: 'legacy' })),
      getCommitments: vi.fn(async () => commitments()),
      reviewCompany: pending, createCompany: pending, getCompanyCreateStatus: pending, transition: pending,
    },
    delegation: {
      status: vi.fn(async () => ({ state: 'unconfigured' as const, workspaceId: null, endpoint: null, configuration: null })),
      policyImport: { selectAndPreview: pending, confirm: pending, resume: pending, status: pending },
      prepareRequestedFollowup: pending, getRequestedFollowup: pending, editRequestedFollowup: pending, approveRequestedFollowup: pending,
      beginPhone: pending, bootstrap: pending, configurePolicy: pending, configureResearch: pending, pair: pending, configure: pending, submit: pending, sync: pending,
    },
    linkedin: { prepare: pending, get: pending, recover: pending, save: pending, begin: pending, open: pending, copy: pending, reportOutcome: pending },
    phoneSetup: { status: pending, confirm: pending, clear: pending },
    outreach: {
      status: vi.fn(async () => ({ model: 'unconfigured' as const, modelName: '', gmail: 'unconfigured' as const, accountEmail: null, senderName: '', postalAddress: '' })),
      configure: pending, connectGmail: pending, disconnectGmail: pending, openDraft: pending, saveDraft: pending, generateDraft: pending, sendDraft: pending,
    },
    leads: {
      list: vi.fn(async () => ({
        rows: [], nextCursor: null, total: 0, revision: 0,
      })),
      updateField: pending,
      bulkUpdate: pending,
    },
    leadDetail: {
      get: vi.fn(async () => detail),
      beginOutbound: vi.fn<CalliePreloadApi['leadDetail']['beginOutbound']>(() => new Promise(() => undefined)),
      getOutboundCapabilities: pending,
      confirmTransition: vi.fn<CalliePreloadApi['leadDetail']['confirmTransition']>(() => new Promise(() => undefined)),
      findContactInfo: vi.fn<CalliePreloadApi['leadDetail']['findContactInfo']>(() => new Promise(() => undefined)),
      dismissLead: pending,
      overrideCloudScore: pending,
    },
    today: {
      get: vi.fn(async () => todaySnapshot),
      complete: pending,
      snooze: pending,
      pin: pending,
      logPastActivity: vi.fn<CalliePreloadApi['today']['logPastActivity']>(() => new Promise(() => undefined)),
      getLeadTriageSnapshot: pending, addLeadNote: pending, logCallOutcome: pending, markActivityInError: pending, getTriageQueue: pending, setReviewPosition: pending,
    },
    pipeline: { get: vi.fn(async () => pipelineSnapshot) },
    review: { list: vi.fn(async () => emptyReview), resolve: pending },
    friday: {
      getCurrent: pending,
      getDrilldown: pending,
      createJob: pending,
      fillJob: pending,
      cancelJob: pending,
    },
    imports: {
      preview: pending,
      remap: pending,
      commit: pending,
      status: pending,
    },
    conversations: {
      list: vi.fn(async () => ({
        rows: [], total: 0, nextCursor: null, revision: 0,
      })),
      get: pending,
      attachTranscript: pending,
    },
    learnings: {
      list: vi.fn(async () => ({
        rows: [], totalActiveCount: 0, revision: 0,
      })),
      capture: pending,
      addEvidence: pending,
      updateStatus: pending,
    },
    sourcing: { pollNow: pending, status: pending, retry: pending, setHmacSalt: pending },
    shell: { revealDatabase: pending, revealLogDirectory: pending },
    recovery: { status: pending, beginSetup: pending, saveSetupMaterial: pending, completeSetup: pending, selectAndRunRestoreDrill: pending },
    appleSpike: { getStatus: pending, probeCapabilities: pending, requestContacts: pending, promptAccessibility: pending, scanRecentNotes: pending, scanTestMessages: pending, startCallObservation: pending, stopCallObservation: pending, sendTestMessage: pending, subscribeObservationEvidence: pending },
  };
}

const healthValue: AppHealth = {
  appVersion: '1.0.0', schemaVersion: 24, databasePath: '/synthetic/foundation.sqlite3', databaseEncrypted: true,
  cipherVersion: 'synthetic', fts5Available: true, pendingJobs: 0, interruptedJobsRecovered: 0,
  domainStatus: 'ready', domainReady: true, domainBlockingViolationCount: 0, domainRepairableIssueCount: 0,
  domainProjectionRefreshCandidateCount: 0, pendingProjectionRebuilds: 0, domainStartupEvaluatedAt: fixtureNow,
  operationalStatus: 'ready', sourcing: { status: 'healthy', reasons: [], lastSuccessAgeMs: null,
    state: { state: 'idle', pollId: null, startedAt: null, lastCompletedAt: null, consecutiveFailures: 0, lastFailureAt: null, lastFailureCode: null, backlogCount: null } },
};
const readyHealth: FoundationHealth = {
  status: 'ready',
  health: healthValue,
  retry: vi.fn(),
};

// jsdom lacks the native dialog API. Model open state only here, as in
// ImportDialog.test. Packaged bauhausWorkflow verifies real modal behavior.
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement) { this.setAttribute('open', ''); },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value(this: HTMLDialogElement) { this.removeAttribute('open'); },
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
  window.location.hash = '';
});

describe('FounderApp', () => {
  it('defaults to the Today route inside the navigation shell', async () => {
    window.location.hash = '';
    const api = fakeCallieApi();
    render(<FounderAppHarness api={api} health={readyHealth} />);

    expect(screen.getByRole('navigation', { name: 'Primary' })).not.toBeNull();
    expect(
      screen.getByRole('link', { name: 'Today' }).getAttribute('aria-current'),
    ).toBe('page');
    expect(await screen.findByRole('button', { name: 'Kevin Shin' })).not.toBeNull();
    expect(screen.getByTestId('today-route')).toBeTruthy();
    expect(api.daily.get).toHaveBeenCalled();
    expect(api.localWorkspace.get).toHaveBeenCalled();
    expect(document.querySelectorAll('.presentation-root[data-presentation="native-a"]')).toHaveLength(1);
  });

  it('opens the same global inspector from Today and Pipeline routes', async () => {
    window.location.hash = '';
    render(<FounderAppHarness api={fakeCallieApi()} health={readyHealth} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Kevin Shin' }));
    expect(
      await screen.findByRole('complementary', { name: 'Kevin Shin details' }),
    ).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Close inspector' }));
    expect(
      screen.queryByRole('complementary', { name: 'Kevin Shin details' }),
    ).toBeNull();

    fireEvent.click(screen.getByRole('link', { name: 'Pipeline' }));
    fireEvent.click(await screen.findByRole('button', { name: /Kevin Shin/ }));
    expect(
      await screen.findByRole('complementary', { name: 'Kevin Shin details' }),
    ).not.toBeNull();
  });

  it('opens the global import dialog from the Leads route', async () => {
    window.location.hash = '#/leads';
    render(<FounderAppHarness api={fakeCallieApi()} health={readyHealth} />);

    fireEvent.click(
      await screen.findByRole('button', { name: 'Import' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Import leads' });
    expect(dialog.tagName).toBe('DIALOG');
    expect(dialog.hasAttribute('open')).toBe(true);
  });

  it('handles the native Import payload across navigation and repeated commands', async () => {
    window.location.hash = '#/today';
    const baseApi = fakeCallieApi();
    const api: CalliePreloadApi = {
      ...baseApi,
      imports: {
        ...baseApi.imports,
        preview: vi.fn<CalliePreloadApi['imports']['preview']>(() => new Promise(() => undefined)),
        commit: vi.fn<CalliePreloadApi['imports']['commit']>(() => new Promise(() => undefined)),
      },
    };
    render(
      <StrictMode>
        <FounderAppHarness api={api} health={readyHealth} />
      </StrictMode>,
    );
    await screen.findByRole('button', { name: 'Kevin Shin' });

    await act(async () => { window.eval(openImportScript); });
    const dialog = await screen.findByRole('dialog', { name: 'Import leads' });
    await waitFor(() => expect(
      screen.getByRole('link', { name: 'Leads' }).getAttribute('aria-current'),
    ).toBe('page'));
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(api.imports.preview).not.toHaveBeenCalled();
    expect(api.imports.commit).not.toHaveBeenCalled();

    await act(async () => { window.eval(openImportScript); });
    expect(screen.getAllByRole('dialog', { name: 'Import leads' })).toHaveLength(1);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: 'Import leads' })).toBeNull();

    await act(async () => { window.eval(openImportScript); });
    expect(await screen.findByRole('dialog', { name: 'Import leads' })).toBeTruthy();
    expect(api.imports.preview).not.toHaveBeenCalled();
    expect(api.imports.commit).not.toHaveBeenCalled();
  });

  it('routes Conversations and Learnings to their live workspaces', async () => {
    window.location.hash = '';
    render(<FounderAppHarness api={fakeCallieApi()} health={readyHealth} />);

    for (const name of ['Conversations', 'Learnings']) {
      expect(
        screen.getByRole('link', { name }).getAttribute('aria-disabled'),
      ).toBeNull();
    }

    fireEvent.click(screen.getByRole('link', { name: 'Conversations' }));
    expect(await screen.findByText('No conversations yet')).not.toBeNull();

    fireEvent.click(screen.getByRole('link', { name: 'Learnings' }));
    expect(
      (await screen.findAllByRole('button', { name: 'Capture learning' })).length,
    ).toBeGreaterThan(0);
  });
});

it('opens contact context with read-only suggestions and diagnostics only on request', async () => {
  const api = fakeCallieApi();
  render(<FounderAppHarness api={api} health={readyHealth} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Kevin Shin' }));
  const page = await screen.findByRole('complementary', { name: 'Kevin Shin details' });
  expect(within(page).getByRole('heading', { name: 'Known portfolio' })).toBeTruthy();
  expect(screen.queryByText('Who handles maintenance?')).toBeNull();
  expect(api.discovery.get).toHaveBeenCalled(); expect(api.discovery.getBrief).not.toHaveBeenCalled();
  fireEvent.click(within(page).getByText('Details', { selector: 'summary' }));
  expect(await within(page).findByText('Who handles maintenance?')).toBeTruthy();
  expect(api.discovery.getBrief).toHaveBeenCalledWith({ personId: 'person-kevin' });
  expect(api.discovery.begin).not.toHaveBeenCalled();
  expect(api.leadDetail.beginOutbound).not.toHaveBeenCalled(); expect(api.leadDetail.findContactInfo).not.toHaveBeenCalled();
  expect(api.leadDetail.confirmTransition).not.toHaveBeenCalled(); expect(api.today.logPastActivity).not.toHaveBeenCalled();
});

it('injects persisted outreach into the actual contact workspace even when Gmail is unconfigured', async () => {
  const api = fakeCallieApi();
  vi.mocked(api.leadDetail.get).mockResolvedValue({ ...detail, emails: [{ id: 'email-kevin', kind: 'email', value: 'kevin@example.com', label: null, valid: true, contactSnapshot: 'a'.repeat(64), validationState: 'valid', reachability: 'direct', sourceLabel: null, vendorRank: null, phoneKind: null, ownershipState: 'verified_person', evidenceObservedAt: null, compliance: null }] });
  const setup: import('../../shared/contracts/outreachContract').OutreachStatus = { model: 'unconfigured', modelName: '', gmail: 'unconfigured', accountEmail: null, senderName: '', postalAddress: '' };
  let draft: import('../../shared/contracts/outreachContract').EmailDraft = { id: 'draft', personId: 'person-kevin', salesCycleId: 'cycle-kevin', contactMethodId: 'email-kevin', recipient: 'kevin@example.com', subject: 'Subject', body: 'Saved text', revision: 1, status: 'draft', generation: 'none', messageId: null, notice: null, updatedAt: '2026-09-08T12:00:00.000Z' };
  const outreach: CalliePreloadApi['outreach'] = { status: vi.fn(async () => setup), configure: vi.fn(), connectGmail: vi.fn(), disconnectGmail: vi.fn(), openDraft: vi.fn(async () => draft),
    saveDraft: vi.fn(async input => { draft = { ...draft, subject: input.subject, body: input.body, revision: draft.revision + 1 }; return draft; }), generateDraft: vi.fn(), sendDraft: vi.fn() };
  render(<FounderAppHarness api={{ ...api, outreach }} health={readyHealth} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Kevin Shin' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Email' }));
  await waitFor(() => expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('Saved text'));
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'My actual edited text' } });
  fireEvent.click(screen.getByRole('button', { name: 'Close draft' }));
  await waitFor(() => expect(screen.queryByLabelText('Message')).toBeNull());
  expect(draft.body).toBe('My actual edited text'); expect(outreach.sendDraft).not.toHaveBeenCalled();
  expect(outreach.openDraft).toHaveBeenCalledWith({ personId: 'person-kevin', contactMethodId: 'email-kevin' });
});

it('does not replace a different contact selection when an earlier detail replies late', async () => {
  const api = fakeCallieApi(); const first = todaySnapshot.lanes[0].items[0];
  vi.mocked(api.today.get).mockResolvedValue({ ...todaySnapshot, lanes: [{ id: 'new_p0', overflowCount: 0, items: [first, { ...first, personId: 'person-dana', personName: 'Dana Whitman', salesCycleId: 'cycle-dana', id: 'item-dana' }] }] });
  let resolve!: (value: LeadDetail) => void;
  vi.mocked(api.leadDetail.get).mockImplementation(({ personId }) => personId === 'person-kevin' ? new Promise(done => { resolve = done; }) : Promise.resolve({ ...detail, personId, salesCycleId: 'cycle-dana', personName: 'Dana Whitman' }));
  render(<FounderAppHarness api={api} health={readyHealth} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Kevin Shin' }));
  fireEvent.click(screen.getByRole('button', { name: 'Dana Whitman' }));
  await screen.findByRole('complementary', { name: 'Dana Whitman details' });
  await act(async () => resolve(detail));
  expect(screen.getByRole('complementary', { name: 'Dana Whitman details' })).toBeTruthy();
  expect(screen.queryByRole('article', { name: 'Kevin Shin full page' })).toBeNull();
  expect(api.discovery.begin).not.toHaveBeenCalled();
});

it('uses the required external appearance states and setters in Settings', async () => {
  window.location.hash = '#/settings';
  const theme = { preference: 'dark' as const, resolvedTheme: 'dark' as const, setPreference: vi.fn() };
  const density = { density: 'compact' as const, setDensity: vi.fn() };
  render(<PresentationRoot><FounderApp api={fakeCallieApi()} health={readyHealth} theme={theme} density={density} initialRoute="settings" /></PresentationRoot>);
  fireEvent.click(await screen.findByRole('button', { name: 'Appearance' }));
  const dark = screen.getByRole('button', { name: 'Dark appearance' });
  expect(dark.getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByRole('button', { name: 'Compact density' }).getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: 'Light appearance' }));
  fireEvent.click(screen.getByRole('button', { name: 'Comfortable density' }));
  expect(theme.setPreference).toHaveBeenCalledWith('light');
  expect(density.setDensity).toHaveBeenCalledWith('comfortable');
});
it('preserves the global inspector node when external appearance states change', async () => {
  const api = fakeCallieApi();
  const theme = { preference: 'dark' as const, resolvedTheme: 'dark' as const, setPreference: vi.fn() };
  const density = { density: 'compact' as const, setDensity: vi.fn() };
  const view = render(<PresentationRoot><FounderApp api={api} health={readyHealth} theme={theme} density={density} /></PresentationRoot>);
  fireEvent.click(await screen.findByRole('button', { name: 'Kevin Shin' }));
  const inspector = await screen.findByRole('complementary', { name: 'Kevin Shin details' });
  view.rerender(<PresentationRoot><FounderApp api={api} health={readyHealth} theme={{ ...theme, preference: 'light', resolvedTheme: 'light' }} density={{ ...density, density: 'comfortable' }} /></PresentationRoot>);
  expect(screen.getByRole('complementary', { name: 'Kevin Shin details' })).toBe(inspector);
});

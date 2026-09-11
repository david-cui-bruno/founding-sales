// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';

import { openImportScript } from '../../main/applicationMenu';
import { discoveryBriefSchema, discoverySnapshotSchema, type DiscoveryApi } from '../../shared/contracts/discoveryContract';
import type { ReviewSnapshot } from '../../shared/contracts/reviewContract';
import type { PipelineSnapshot } from '../../shared/contracts/pipelineContract';
import type { TodaySnapshot } from '../../shared/contracts/todayContract';
import type { LeadDetail } from '../../shared/contracts/leadDetailContract';
import type { CalliePreloadApi } from '../../shared/preload';
import type { AppHealth } from '../../shared/healthContract';
import type { ImportCommitReceipt, ImportPreview } from '../../shared/contracts/importContract';
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

const emptyReview = reliabilityOwnerSnapshot(0);

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

const importPreview: ImportPreview = {
  previewId: 'preview-founder-app',
  contentHash: 'a'.repeat(64),
  columns: ['Name', 'Phone'],
  sampleRows: [{ rowNumber: 2, cells: ['Kevin', '4015550101'] }],
  suggestedMapping: { Name: 'person_name', Phone: 'phone' },
  rowCount: 1,
  validCount: 1,
  errors: [],
  duplicateCandidates: [],
  expiresAt: '2027-01-01T00:00:00.000Z',
};
const importReceipt: ImportCommitReceipt = {
  jobId: 'job-founder-app',
  importedPersonIds: ['person-imported'],
  importedRowCount: 1,
  revision: 2,
};

function fakeCallieApi(): CalliePreloadApi {
  const pending = vi.fn(() => new Promise<never>(() => undefined));
  return {
    discovery: discoveryApi(),
    health: { get: vi.fn(async () => healthValue) },
    daily: { get: vi.fn(async () => ({ ...dailyFixture(), workflowMode: 'legacy' as const })) },
    localWorkspace: {
      get: vi.fn(async () => localSnapshot({ workflowMode: 'legacy' })),
      getCompany: pending,
      researchCompany: pending, getCompanyResearchStatus: pending, getCallSettings: async () => { throw Error('Call capacity unavailable in this fixture'); }, updateCallSettings: async () => { throw Error('Call capacity unavailable in this fixture'); }, linkCompanyPerson: pending,
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
      inspectLocalAuthority: vi.fn(() => new Promise<never>(() => undefined)),
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
    review: { list: vi.fn(async () => emptyReview), resolve: vi.fn(() => new Promise<never>(() => undefined)) },
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

  it('keeps the local company draft across real Accounts route navigation', async () => {
    window.location.hash = '#/accounts';
    const api = fakeCallieApi();
    vi.mocked(api.daily.get).mockResolvedValue(dailyFixture());
    vi.mocked(api.localWorkspace.get).mockResolvedValue(localSnapshot({ workflowMode: 'meeting_first' }));
    api.localWorkspace.reviewCompany = vi.fn<CalliePreloadApi['localWorkspace']['reviewCompany']>(() => new Promise(() => undefined));
    api.localWorkspace.createCompany = vi.fn<CalliePreloadApi['localWorkspace']['createCompany']>(() => new Promise(() => undefined));
    render(<FounderAppHarness api={api} health={readyHealth} />);

    const addCompany = await screen.findByRole('button', { name: 'Add company' });
    await waitFor(() => expect((addCompany as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(addCompany);
    fireEvent.change(screen.getByRole('textbox', { name: 'Company name' }), {
      target: { value: ' Harbor Management ' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Company domain (optional)' }), {
      target: { value: ' HARBOR.EXAMPLE ' },
    });

    fireEvent.click(screen.getByRole('link', { name: 'Campaigns' }));
    await screen.findByRole('heading', { name: 'Campaigns' });
    fireEvent.click(screen.getByRole('link', { name: 'Leads' }));
    await screen.findByRole('heading', { name: 'Leads' });
    fireEvent.click(screen.getByRole('link', { name: 'Accounts' }));

    expect(((await screen.findByRole('textbox', { name: 'Company name' })) as HTMLInputElement).value).toBe(' Harbor Management ');
    expect((screen.getByRole('textbox', { name: 'Company domain (optional)' }) as HTMLInputElement).value).toBe(' HARBOR.EXAMPLE ');
    expect(api.localWorkspace.reviewCompany).not.toHaveBeenCalled();
    expect(api.localWorkspace.createCompany).not.toHaveBeenCalled();
  });

  it('keeps the local company draft across a real committed Import refresh remount', async () => {
    window.location.hash = '#/accounts';
    const baseApi = fakeCallieApi();
    const api: CalliePreloadApi = {
      ...baseApi,
      imports: {
        ...baseApi.imports,
        preview: vi.fn<CalliePreloadApi['imports']['preview']>(async () => importPreview),
        commit: vi.fn<CalliePreloadApi['imports']['commit']>(async () => importReceipt),
      },
    };
    vi.mocked(api.daily.get).mockResolvedValue(dailyFixture());
    vi.mocked(api.localWorkspace.get).mockResolvedValue(localSnapshot({ workflowMode: 'meeting_first' }));
    api.localWorkspace.reviewCompany = vi.fn<CalliePreloadApi['localWorkspace']['reviewCompany']>(() => new Promise(() => undefined));
    api.localWorkspace.createCompany = vi.fn<CalliePreloadApi['localWorkspace']['createCompany']>(() => new Promise(() => undefined));
    render(<FounderAppHarness api={api} health={readyHealth} />);

    const addCompany = await screen.findByRole('button', { name: 'Add company' });
    await waitFor(() => expect((addCompany as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(addCompany);
    fireEvent.change(screen.getByRole('textbox', { name: 'Company name' }), {
      target: { value: ' Harbor Management ' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Company domain (optional)' }), {
      target: { value: ' HARBOR.EXAMPLE ' },
    });

    await act(async () => { window.eval(openImportScript); });
    fireEvent.change(await screen.findByLabelText('Paste spreadsheet rows'), {
      target: { value: 'Name\tPhone\nKevin\t4015550101' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Preview rows' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Import 1 row' }));
    await screen.findByText('Imported 1 row.');
    fireEvent.click(screen.getByRole('link', { name: 'Accounts' }));

    expect(((await screen.findByRole('textbox', { name: 'Company name' })) as HTMLInputElement).value).toBe(' Harbor Management ');
    expect((screen.getByRole('textbox', { name: 'Company domain (optional)' }) as HTMLInputElement).value).toBe(' HARBOR.EXAMPLE ');
    expect(api.imports.preview).toHaveBeenCalledOnce();
    expect(api.imports.commit).toHaveBeenCalledOnce();
    expect(api.localWorkspace.reviewCompany).not.toHaveBeenCalled();
    expect(api.localWorkspace.createCompany).not.toHaveBeenCalled();
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
    saveDraft: vi.fn(async input => { draft = { ...draft, subject: input.subject, body: input.body, revision: draft.revision + 1 }; return draft; }), generateDraft: vi.fn(), sendDraft: vi.fn(),
    // Synthetic current-draft ownership only. Gmail remains unconfigured.
    inspectLocalAuthority: vi.fn(async input => {
      if (input.draftId !== draft.id || input.expectedRevision !== draft.revision) throw Error('Synthetic draft changed');
      return { draftId: draft.id, expectedRevision: draft.revision, personId: draft.personId, contactMethodId: draft.contactMethodId, state: 'allowed' as const, reason: null, checkedAt: draft.updatedAt };
    }) };
  render(<FounderAppHarness api={{ ...api, outreach }} health={readyHealth} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Kevin Shin' }));
  const disclosure = await screen.findByText('Opening Email may use configured AI to prepare a draft. It does not send.');
  expect(disclosure.isConnected).toBe(true);
  for (let element: HTMLElement | null = disclosure; element !== null; element = element.parentElement) {
    expect(element.hidden).toBe(false); expect(element.getAttribute('aria-hidden')).not.toBe('true');
    const style = getComputedStyle(element);
    expect(style.display).not.toBe('none'); expect(style.visibility).not.toMatch(/^(hidden|collapse)$/); expect(style.opacity).not.toBe('0');
  }
  expect(outreach.openDraft).not.toHaveBeenCalled(); expect(outreach.sendDraft).not.toHaveBeenCalled();
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

function reliabilityOwnerSnapshot(count: number, limit = 1): ReviewSnapshot {
  return {
    items: Array.from({ length: Math.min(count, limit) }, (_, index) => ({
      kind: 'unmatched_communication' as const, reviewId: `summary-review-${index}`,
      channel: 'email' as const, handle: `summary-${index}@example.com`,
      occurredAt: '2026-09-10T00:00:00.000Z', summary: `Fictional local review ${index}`,
    })),
    totalOpenCount: count, revision: count,
    nextCursor: count > limit ? 'synthetic-summary-rest' : null,
    matchedCount: count, countScope: 'lifecycle_review_items' as const,
    observedAt: '2026-09-10T00:00:00.000Z',
    queues: {
      unmatched_communication: { source: 'lifecycle_review_items' as const, openCount: count },
      system_error: { source: 'lifecycle_review_items' as const, openCount: 0 },
      ambiguous_identity: { source: 'not_integrated' as const, openCount: null },
      transcript_suggestion: { source: 'not_integrated' as const, openCount: null },
      import_problem: { source: 'not_integrated' as const, openCount: null },
      adapter_failure: { source: 'not_integrated' as const, openCount: null },
    },
  };
}

function reliabilityInboxLink() {
  const more = screen.getByRole('button', { name: 'More workspaces' });
  if (more.getAttribute('aria-expanded') !== 'true') fireEvent.click(more);
  return within(screen.getByRole('navigation', { name: 'Primary' }))
    .getByRole('link', { name: /Inbox/ });
}

function reliabilitySummaryEvidence(link: HTMLElement) {
  return [link.textContent ?? '', link.getAttribute('aria-label') ?? '',
    ...Array.from(link.querySelectorAll('[aria-label]'), node => node.getAttribute('aria-label') ?? ''),
  ].join(' ');
}

describe('reliability: startup review observation owned above Inbox', () => {
  it('shows 208 observed local reviews on Today before Inbox ever mounts', async () => {
    const api = fakeCallieApi();
    vi.mocked(api.review.list).mockResolvedValue(reliabilityOwnerSnapshot(208));
    render(<StrictMode><FounderAppHarness api={api} health={readyHealth} /></StrictMode>);
    const inbox = reliabilityInboxLink();
    await waitFor(() => expect(reliabilitySummaryEvidence(inbox)).toMatch(/208 open local reviews/i));
    expect(screen.getByRole('link', { name: 'Today' }).getAttribute('aria-current')).toBe('page');
    expect(screen.queryByRole('tablist', { name: 'Review queues' })).toBeNull();
    expect(api.review.list).toHaveBeenCalledWith({ kinds: [], cursor: null, limit: 1 });
    // Exact StrictMode mount count is intentionally not guessed in this RED.
    for (const [request] of vi.mocked(api.review.list).mock.calls) {
      expect(request).toEqual({ kinds: [], cursor: null, limit: 1 });
    }
    expect(api.review.resolve).not.toHaveBeenCalled();
  });

  it('exposes a pending observation instead of a checked zero', async () => {
    const api = fakeCallieApi();
    vi.mocked(api.review.list).mockImplementation(() => new Promise(() => undefined));
    render(<FounderAppHarness api={api} health={readyHealth} />);
    const inbox = reliabilityInboxLink();
    await waitFor(() => expect(reliabilitySummaryEvidence(inbox)).toMatch(/loading|checking/i));
    expect(reliabilitySummaryEvidence(inbox)).not.toMatch(/\b0\b/);
    expect(api.review.resolve).not.toHaveBeenCalled();
  });

  it('reports an unavailable summary safely after an initial read rejection', async () => {
    const api = fakeCallieApi();
    vi.mocked(api.review.list).mockRejectedValue(new Error('PRIVATE_TOKEN /secret/workspace.sqlite'));
    render(<FounderAppHarness api={api} health={readyHealth} />);
    const inbox = reliabilityInboxLink();
    await waitFor(() => expect(reliabilitySummaryEvidence(inbox)).toMatch(/unavailable|could not/i));
    expect(reliabilitySummaryEvidence(inbox)).not.toMatch(/\b0\b/);
    expect(screen.queryByText(/PRIVATE_TOKEN|secret\/workspace/)).toBeNull();
    expect(api.review.resolve).not.toHaveBeenCalled();
  });

  it('marks a failed focus refresh unavailable instead of leaving an authoritative old count', async () => {
    const api = fakeCallieApi();
    vi.mocked(api.review.list).mockResolvedValue(reliabilityOwnerSnapshot(208));
    render(<FounderAppHarness api={api} health={readyHealth} />);
    const inbox = reliabilityInboxLink();
    await waitFor(() => expect(reliabilitySummaryEvidence(inbox)).toMatch(/208 open local reviews/i));
    vi.mocked(api.review.list).mockRejectedValue(new Error('private refresh failure'));
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(reliabilitySummaryEvidence(inbox)).toMatch(/unavailable|could not/i));
    expect(reliabilitySummaryEvidence(inbox)).not.toMatch(/208 open local reviews/i);
    expect(screen.queryByText('private refresh failure')).toBeNull();
  });


});

describe('reliability: exact summary lifecycle reads', () => {
  it('deduplicates initial route entry, then reads once per route/focus but not Import opening', async () => {
    const api = fakeCallieApi();
    render(<FounderAppHarness api={api} health={readyHealth} />);
    await waitFor(() => expect(api.review.list).toHaveBeenCalledTimes(1));
    reliabilityInboxLink();
    await act(async () => { fireEvent.click(screen.getByRole('link', { name: 'Leads' })); });
    expect(api.review.list).toHaveBeenCalledTimes(2);
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(api.review.list).toHaveBeenCalledTimes(3);
    await act(async () => { window.dispatchEvent(new CustomEvent('callie:open-import')); });
    expect(screen.getByRole('dialog', { name: 'Import leads' })).toBeTruthy();
    expect(api.review.list).toHaveBeenCalledTimes(3);
    for (const [request] of vi.mocked(api.review.list).mock.calls) {
      expect(request).toEqual({ kinds: [], cursor: null, limit: 1 });
    }
    expect(api.review.resolve).not.toHaveBeenCalled();
  });

  it('refreshes summary and selected page after one successful resolution, retaining failed input', async () => {
    const api = fakeCallieApi();
    let remaining = 1;
    let rejectFirst!: (error: Error) => void;
    const first = new Promise<never>((_, reject) => { rejectFirst = reject; });
    vi.mocked(api.review.list).mockImplementation(async request => reliabilityOwnerSnapshot(remaining, request.limit));
    vi.mocked(api.review.resolve).mockReturnValueOnce(first).mockImplementationOnce(async () => {
      remaining = 0;
      return { revision: 2, affectedPersonIds: [], affectedSalesCycleIds: [] };
    });
    render(<FounderAppHarness api={api} health={readyHealth} initialRoute="inbox" />);
    fireEvent.click(await screen.findByRole('button', { name: /summary-0@example.com/ }));
    const evidence = screen.getByLabelText<HTMLInputElement>('Matched source event ID');
    fireEvent.change(evidence, { target: { value: 'source-retained' } });
    const promote = screen.getByRole('button', { name: 'Promote' });
    await act(async () => { fireEvent.click(promote); fireEvent.click(promote); });
    expect(api.review.resolve).toHaveBeenCalledTimes(1);
    expect(evidence.closest('fieldset')?.disabled).toBe(true);
    await act(async () => { rejectFirst(new Error('PRIVATE_DATABASE_PATH')); });
    expect(evidence.value).toBe('source-retained');
    expect(screen.queryByText(/PRIVATE_DATABASE_PATH/)).toBeNull();
    expect(screen.getByRole('alert').textContent).toMatch(/input is kept/i);
    await act(async () => { fireEvent.click(promote); });
    expect(api.review.resolve).toHaveBeenCalledTimes(2);
    const reads = vi.mocked(api.review.list).mock.calls.map(([request]) => request);
    expect(reads.filter(request => request.limit === 1)).toEqual([
      { kinds: [], cursor: null, limit: 1 }, { kinds: [], cursor: null, limit: 1 },
    ]);
    expect(reads.filter(request => request.limit === 200)).toEqual([
      { kinds: ['unmatched_communication'], cursor: null, limit: 200 },
      { kinds: ['unmatched_communication'], cursor: null, limit: 200 },
    ]);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Inbox · 0 open local reviews');
  });

  it('cannot publish an unmounted owner observation into a new healthy workspace', async () => {
    const oldApi = fakeCallieApi();
    let finish!: (snapshot: ReturnType<typeof reliabilityOwnerSnapshot>) => void;
    vi.mocked(oldApi.review.list).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const old = render(<FounderAppHarness api={oldApi} health={readyHealth} />);
    await waitFor(() => expect(oldApi.review.list).toHaveBeenCalledTimes(1));
    old.unmount();
    const nextApi = fakeCallieApi();
    vi.mocked(nextApi.review.list).mockResolvedValue(reliabilityOwnerSnapshot(7));
    render(<FounderAppHarness api={nextApi} health={readyHealth} />);
    const inbox = reliabilityInboxLink();
    await waitFor(() => expect(reliabilitySummaryEvidence(inbox)).toMatch(/7 open local reviews/));
    await act(async () => { finish(reliabilityOwnerSnapshot(208)); });
    expect(reliabilitySummaryEvidence(inbox)).toMatch(/7 open local reviews/);
    expect(reliabilitySummaryEvidence(inbox)).not.toMatch(/208/);
  });
});


function orderingReads(api: ReturnType<typeof fakeCallieApi>) {
  const reads: { input: Parameters<typeof api.review.list>[0];
    resolve(snapshot: ReturnType<typeof reliabilityOwnerSnapshot>): void; reject(error: Error): void }[] = [];
  vi.mocked(api.review.list).mockImplementation(input => new Promise((resolve, reject) => {
    reads.push({ input, resolve, reject });
  }));
  return reads;
}
async function orderingSettle(read: ReturnType<typeof orderingReads>[number], count: number | 'fail') {
  await act(async () => {
    if (count === 'fail') read.reject(new Error('PRIVATE_ORDERING_FAILURE'));
    else read.resolve(reliabilityOwnerSnapshot(count, read.input.limit));
  });
}
function orderingLimits(reads: ReturnType<typeof orderingReads>) { return reads.map(read => read.input.limit); }

describe('R2: request-start observation ownership through FounderApp', () => {
  it.each(['page-first', 'summary-first', 'page-rejects'] as const)(
    'child page starts before parent summary, %s cannot steal the badge', async order => {
      const api = fakeCallieApi();
      const reads = orderingReads(api);
      render(<FounderAppHarness api={api} health={readyHealth} initialRoute="inbox" />);
      const inbox = reliabilityInboxLink();
      expect(orderingLimits(reads)).toEqual([200, 1]);
      if (order === 'page-first') {
        await orderingSettle(reads[0]!, 208);
        expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Inbox · 208 open local reviews');
        expect(reliabilitySummaryEvidence(inbox)).toMatch(/checking|loading/i);
        await orderingSettle(reads[1]!, 7);
      } else {
        await orderingSettle(reads[1]!, 7);
        await orderingSettle(reads[0]!, order === 'page-rejects' ? 'fail' : 208);
      }
      expect(reliabilitySummaryEvidence(inbox)).toMatch(/7 open local reviews/i);
      expect(reliabilitySummaryEvidence(inbox)).not.toMatch(/208 open local reviews/i);
      if (order === 'page-rejects') expect(screen.getByRole('alert').textContent).toMatch(/could not load/i);
      else expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Inbox · 208 open local reviews');
      expect(screen.queryByText('PRIVATE_ORDERING_FAILURE')).toBeNull();
      expect(orderingLimits(reads)).toEqual([200, 1]);
    });
  it.each([208, 'fail'] as const)('focus summary survives older tab page %s', async oldResult => {
    const api = fakeCallieApi();
    const reads = orderingReads(api);
    render(<FounderAppHarness api={api} health={readyHealth} initialRoute="inbox" />);
    const inbox = reliabilityInboxLink();
    await orderingSettle(reads[0]!, 1);
    await orderingSettle(reads[1]!, 1);
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /System errors/ })); });
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(orderingLimits(reads)).toEqual([200, 1, 200, 1]);
    await orderingSettle(reads[3]!, 7);
    await orderingSettle(reads[2]!, oldResult);
    expect(reliabilitySummaryEvidence(inbox)).toMatch(/7 open local reviews/i);
    expect(screen.queryByText('PRIVATE_ORDERING_FAILURE')).toBeNull();
    expect(reads).toHaveLength(4);
  });
  it.each(['page-first', 'summary-first', 'page-fails'] as const)(
    'successful resolve starts summary before reload and %s settles by start order', async order => {
      const api = fakeCallieApi();
      const reads = orderingReads(api);
      vi.mocked(api.review.resolve).mockResolvedValue({ revision: 2, affectedPersonIds: [], affectedSalesCycleIds: [] });
      render(<FounderAppHarness api={api} health={readyHealth} initialRoute="inbox" />);
      const inbox = reliabilityInboxLink();
      await orderingSettle(reads[0]!, 1);
      await orderingSettle(reads[1]!, 1);
      fireEvent.click(screen.getByRole('button', { name: /summary-0@example.com/ }));
      fireEvent.change(screen.getByLabelText('Matched source event ID'), { target: { value: 'source-ordering' } });
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Promote' })); });
      expect(orderingLimits(reads)).toEqual([200, 1, 1, 200]);
      if (order === 'summary-first') {
        await orderingSettle(reads[2]!, 208);
        expect(reliabilitySummaryEvidence(inbox)).toMatch(/checking|loading/i);
        await orderingSettle(reads[3]!, 0);
      } else {
        await orderingSettle(reads[3]!, order === 'page-fails' ? 'fail' : 0);
        await orderingSettle(reads[2]!, order === 'page-fails' ? 208 : 'fail');
      }
      expect(reliabilitySummaryEvidence(inbox)).toMatch(order === 'page-fails' ? /unavailable|could not/i : /0 open local reviews/i);
      expect(reliabilitySummaryEvidence(inbox)).not.toMatch(/208 open local reviews/i);
      expect(api.review.resolve).toHaveBeenCalledTimes(1);
      expect(reads).toHaveLength(4);
      expect(screen.queryByText('PRIVATE_ORDERING_FAILURE')).toBeNull();
    });
  it.each(['page-first', 'summary-first', 'old-rejections'] as const)(
    'StrictMode cleanup/replay preserves newest request with %s', async order => {
      const api = fakeCallieApi();
      const reads = orderingReads(api);
      render(<StrictMode><FounderAppHarness api={api} health={readyHealth} initialRoute="inbox" /></StrictMode>);
      const inbox = reliabilityInboxLink();
      expect(orderingLimits(reads)).toEqual([200, 1, 200, 1]);
      if (order === 'page-first') {
        await orderingSettle(reads[2]!, 208);
        expect(reliabilitySummaryEvidence(inbox)).toMatch(/checking|loading/i);
        await orderingSettle(reads[3]!, 7);
      } else {
        await orderingSettle(reads[3]!, 7);
        await orderingSettle(reads[2]!, order === 'old-rejections' ? 'fail' : 208);
      }
      await orderingSettle(reads[0]!, order === 'old-rejections' ? 'fail' : 999);
      await orderingSettle(reads[1]!, order === 'old-rejections' ? 'fail' : 999);
      expect(reliabilitySummaryEvidence(inbox)).toMatch(/7 open local reviews/i);
      expect(reliabilitySummaryEvidence(inbox)).not.toMatch(/208|999/);
      expect(reads).toHaveLength(4);
      expect(screen.queryByText('PRIVATE_ORDERING_FAILURE')).toBeNull();
    });
  it.each([208, 'fail'] as const)('later route observation survives actually older startup %s', async older => {
    const api = fakeCallieApi();
    const reads = orderingReads(api);
    render(<FounderAppHarness api={api} health={readyHealth} />);
    const inbox = reliabilityInboxLink();
    await act(async () => { fireEvent.click(inbox); });
    expect(orderingLimits(reads)).toEqual([1, 200, 1]);
    await orderingSettle(reads[2]!, 7);
    await orderingSettle(reads[1]!, 7);
    await orderingSettle(reads[0]!, older);
    expect(reliabilitySummaryEvidence(inbox)).toMatch(/7 open local reviews/i);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Inbox · 7 open local reviews');
    expect(reads).toHaveLength(3);
  });
});

// Real routeRegistry and real global Import refreshKey, not a synthetic form key.
describe('FounderApp company phase continuity', () => {
  const cases = (['reviewed', 'reviewing', 'creating', 'unknown', 'conflict'] as const).flatMap(phase =>
    (['route navigation', 'committed Import'] as const).map(boundary => ({ phase, boundary })));
  it.each(cases)('retains $phase across actual $boundary without intake replay or extra summary reads', async ({ phase, boundary }) => {
    window.location.hash = '#/accounts';
    const api = fakeCallieApi();
    vi.mocked(api.daily.get).mockResolvedValue(dailyFixture());
    vi.mocked(api.localWorkspace.get).mockResolvedValue(localSnapshot({ workflowMode: 'meeting_first' }));
    type Review = Awaited<ReturnType<CalliePreloadApi['localWorkspace']['reviewCompany']>>;
    type Result = Awaited<ReturnType<CalliePreloadApi['localWorkspace']['createCompany']>>;
    let resolveReview!: (value: Review) => void;
    let resolveCreate!: (value: Result) => void;
    const pendingReview = new Promise<Review>(resolve => { resolveReview = resolve; });
    const pendingCreate = new Promise<Result>(resolve => { resolveCreate = resolve; });
    const input = { name: 'Harbor Management', domain: 'harbor.example' };
    const reviewed: Review = { scope: 'local_database', input, complete: true, candidates: [] };
    api.localWorkspace.reviewCompany = vi.fn<CalliePreloadApi['localWorkspace']['reviewCompany']>(async () => phase === 'reviewing' ? pendingReview : reviewed);
    api.localWorkspace.createCompany = vi.fn<CalliePreloadApi['localWorkspace']['createCompany']>(async request => {
      if (phase === 'unknown') throw new Error('unconfirmed');
      if (phase === 'conflict') return { status: 'command_conflict', commandId: request.commandId };
      return pendingCreate;
    });
    api.localWorkspace.getCompanyCreateStatus = vi.fn<CalliePreloadApi['localWorkspace']['getCompanyCreateStatus']>(async request => ({ status: 'not_recorded', commandId: request.commandId }));
    api.imports.preview = vi.fn<CalliePreloadApi['imports']['preview']>(async () => importPreview);
    api.imports.commit = vi.fn<CalliePreloadApi['imports']['commit']>(async () => importReceipt);
    render(<FounderAppHarness api={api} health={readyHealth} />);
    const add = await screen.findByRole('button', { name: 'Add company' });
    await waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(add);
    fireEvent.change(screen.getByRole('textbox', { name: 'Company name' }), { target: { value: ' Harbor Management ' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Company domain (optional)' }), { target: { value: ' HARBOR.EXAMPLE ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review company' }));
    if (phase === 'reviewing') await screen.findByText('Reviewing local companies…');
    else {
      await screen.findByText('No matching companies in the current local review.');
      if (phase !== 'reviewed') {
        fireEvent.click(screen.getByRole('button', { name: 'Create company' }));
        await screen.findByText(phase === 'creating' ? 'Saving company…' : phase === 'unknown' ? /Save outcome unknown/ : /Command conflict/);
      }
    }
    const commands = { review: vi.mocked(api.localWorkspace.reviewCompany).mock.calls.length, create: vi.mocked(api.localWorkspace.createCompany).mock.calls.length, status: vi.mocked(api.localWorkspace.getCompanyCreateStatus).mock.calls.length };
    const request = vi.mocked(api.localWorkspace.createCompany).mock.calls[0]?.[0];
    await waitFor(() => expect(api.review.list).toHaveBeenCalledTimes(1));
    if (boundary === 'route navigation') {
      fireEvent.click(screen.getByRole('link', { name: 'Campaigns' }));
      await screen.findByRole('heading', { name: 'Campaigns' });
      expect(screen.queryByRole('textbox', { name: 'Company name' })).toBeNull();
      fireEvent.click(screen.getByRole('link', { name: 'Leads' })); await screen.findByRole('heading', { name: 'Leads' });
      fireEvent.click(screen.getByRole('link', { name: 'Accounts' }));
    } else {
      const previousInput = screen.getByRole('textbox', { name: 'Company name' });
      await act(async () => { window.eval(openImportScript); });
      const dialog = await screen.findByRole('dialog', { name: 'Import leads' });
      expect(screen.getByRole('link', { name: 'Leads' }).getAttribute('aria-current')).toBe('page');
      await waitFor(() => expect(api.review.list).toHaveBeenCalledTimes(2));
      fireEvent.change(within(dialog).getByLabelText('Paste spreadsheet rows'), { target: { value: 'Name\tPhone\nKevin\t4015550101' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Preview rows' }));
      fireEvent.click(await within(dialog).findByRole('button', { name: 'Import 1 row' }));
      await within(dialog).findByText('Imported 1 row.');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
      expect(api.imports.preview).toHaveBeenCalledOnce(); expect(api.imports.commit).toHaveBeenCalledOnce();
      expect(previousInput.isConnected).toBe(false);
      expect(screen.getByRole('link', { name: 'Leads' }).getAttribute('aria-current')).toBe('page');
      await waitFor(() => expect(api.review.list).toHaveBeenCalledTimes(3));
      fireEvent.click(screen.getByRole('link', { name: 'Accounts' }));
    }
    const name = await screen.findByRole('textbox', { name: 'Company name' });
    expect((name as HTMLInputElement).value).toBe(phase === 'reviewing' ? ' Harbor Management ' : input.name);
    expect((screen.getByRole('textbox', { name: 'Company domain (optional)' }) as HTMLInputElement).value).toBe(phase === 'reviewing' ? ' HARBOR.EXAMPLE ' : input.domain);
    const close = screen.getByRole('button', { name: 'Close company form' }) as HTMLButtonElement;
    expect(close.disabled).toBe(['creating', 'unknown', 'conflict'].includes(phase));
    if (phase === 'reviewed') await waitFor(() => expect((screen.getByRole('button', { name: 'Create company' }) as HTMLButtonElement).disabled).toBe(false));
    else await screen.findByText(phase === 'reviewing' ? 'Reviewing local companies…' : phase === 'creating' ? 'Saving company…' : phase === 'unknown' ? /Save outcome unknown/ : /Command conflict/);
    expect(api.localWorkspace.reviewCompany).toHaveBeenCalledTimes(commands.review);
    expect(api.localWorkspace.createCompany).toHaveBeenCalledTimes(commands.create);
    expect(api.localWorkspace.getCompanyCreateStatus).toHaveBeenCalledTimes(commands.status);
    await waitFor(() => expect(api.review.list).toHaveBeenCalledTimes(4));
    const summaryRequest: Parameters<CalliePreloadApi['review']['list']>[0] = { kinds: [], cursor: null, limit: 1 };
    expect(vi.mocked(api.review.list).mock.calls).toEqual(Array.from({ length: 4 }, () => [summaryRequest]));
    if (phase === 'reviewing') {
      await act(async () => { resolveReview(reviewed); });
      expect(await screen.findByText('No matching companies in the current local review.')).toBeTruthy();
    } else if (phase === 'creating') {
      await act(async () => { resolveCreate({ status: 'command_conflict', commandId: request!.commandId }); });
      expect(await screen.findByText(/Command conflict/)).toBeTruthy();
      expect((screen.getByRole('button', { name: 'Close company form' }) as HTMLButtonElement).disabled).toBe(true);
    } else if (phase === 'unknown') {
      await waitFor(() => expect((screen.getByRole('button', { name: 'Check save status' }) as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(screen.getByRole('button', { name: 'Check save status' })); await screen.findByText(/not recorded yet/);
      expect(vi.mocked(api.localWorkspace.getCompanyCreateStatus).mock.calls).toEqual([[request]]);
      expect(request).toEqual({ ...input, commandId: expect.stringMatching(/^[a-f\d-]{36}$/) });
      expect(api.localWorkspace.createCompany).toHaveBeenCalledOnce();
    }
  });
});


// Task 4 additive public composition tests. No new-module import: baseline can reach missing UI.
import type { LocalCompanyDetail, LocalCompanyResearchStatus, SelectedResearch } from '../../shared/contracts/localWorkspaceContract';
const f4AppReleases: Array<() => void> = [];
const f4AppPending: Promise<unknown>[] = [];
function f4AppDeferred<T>(fallback: T) { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); f4AppReleases.push(() => resolve(fallback)); f4AppPending.push(promise); return { promise, resolve }; }
afterEach(async () => { try { cleanup(); } finally { try { await act(async () => { for (const release of f4AppReleases.splice(0)) release(); await Promise.allSettled(f4AppPending.splice(0)); }); } finally { vi.restoreAllMocks(); } } });
function f4AppDetail(accountId = 'a'): LocalCompanyDetail {
  const snapshot = structuredClone(dailyFixture().accounts.find(item => item.account.id === accountId)!);
  snapshot.portfolio = []; snapshot.claims = []; snapshot.routes = [];
  return { scope: 'local_database', generatedAt: fixtureNow, snapshot, sources: [{ id: `first-use-${accountId}`, url: `https://${accountId}.example/source`, fetchedAt: fixtureNow, sha256: 'd'.repeat(64), excerpt: `Founder selected source ${accountId}`, permitted: true }], links: [] };
}
function f4AppStatus(r: SelectedResearch, state: LocalCompanyResearchStatus['state']): LocalCompanyResearchStatus { return { ...r, state, receipt: state === 'completed' ? { accountId: r.accountId, version: 2, duplicate: false } : null, reason: null }; }
function f4FounderApi() {
  const api = fakeCallieApi();
  vi.mocked(api.daily.get).mockResolvedValue(dailyFixture());
  vi.mocked(api.localWorkspace.get).mockResolvedValue(localSnapshot({ accounts: { state: 'available', snapshots: dailyFixture().accounts } }));
  api.localWorkspace.getCompany = vi.fn<CalliePreloadApi['localWorkspace']['getCompany']>(async ({ accountId }) => f4AppDetail(accountId));
  api.localWorkspace.researchCompany = vi.fn<CalliePreloadApi['localWorkspace']['researchCompany']>(async r => f4AppStatus(r, 'held'));
  api.localWorkspace.getCompanyResearchStatus = vi.fn<CalliePreloadApi['localWorkspace']['getCompanyResearchStatus']>(async r => f4AppStatus(r, 'not_recorded'));
  return api;
}

it('F4-founder-01 selecting a real local row exposes explicit Research through FounderApp routes', async () => {
  const api = f4FounderApi(); render(<FounderAppHarness api={api} health={readyHealth} initialRoute="accounts" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Local account · Account A' }));
  expect(await screen.findByRole('button', { name: /^Research(?: company)?$/i })).toBeTruthy();
  expect(await screen.findByText('Founder selected source a')).toBeTruthy();
  expect(api.localWorkspace.getCompany).toHaveBeenCalledWith({ accountId: 'a' }); expect(api.localWorkspace.researchCompany).not.toHaveBeenCalled();
}, 10_000);

it('F4-founder-02 Campaigns and back retain selected local account and the same pending request without automatic execution', async () => {
  const api = f4FounderApi(); const r = { accountId: 'a', commandId: '10000000-0000-4000-8000-000000000001' };
  const gate = f4AppDeferred(f4AppStatus(r, 'completed')); const uuid = vi.spyOn(crypto, 'randomUUID').mockReturnValue('10000000-0000-4000-8000-000000000001');
  api.localWorkspace.researchCompany = vi.fn<CalliePreloadApi['localWorkspace']['researchCompany']>(() => gate.promise);
  render(<StrictMode><FounderAppHarness api={api} health={readyHealth} initialRoute="accounts" /></StrictMode>);
  fireEvent.click(await screen.findByRole('button', { name: 'Local account · Account A' })); await screen.findByText('Founder selected source a');
  const research = screen.getByRole('button', { name: /^Research(?: company)?$/i }); act(() => { fireEvent.click(research); fireEvent.click(research); });
  expect(api.localWorkspace.researchCompany).toHaveBeenCalledOnce(); const original = vi.mocked(api.localWorkspace.researchCompany).mock.calls[0][0];
  fireEvent.click(screen.getByRole('link', { name: 'Campaigns' })); await screen.findByRole('heading', { level: 1, name: 'Campaigns' });
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  fireEvent.click(screen.getByRole('link', { name: 'Accounts' })); await screen.findByText('Founder selected source a');
  expect(screen.getByRole('button', { name: 'Local account · Account A' }).getAttribute('aria-current')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: /^Research(?: company)?$/i })); expect(api.localWorkspace.researchCompany).toHaveBeenCalledOnce(); expect(uuid).toHaveBeenCalledOnce();
  await act(async () => gate.resolve(f4AppStatus(original, 'completed'))); expect(await screen.findByText(/^Research known · completed$/)).toBeTruthy();
  expect(vi.mocked(api.localWorkspace.researchCompany).mock.calls[0][0]).toBe(original);
}, 10_000);

it('F4-founder-03 actual Import commit refresh retains selected pending research and global modal ownership', async () => {
  const api = f4FounderApi(); const r = { accountId: 'a', commandId: '10000000-0000-4000-8000-000000000001' };
  const gate = f4AppDeferred(f4AppStatus(r, 'completed')); vi.spyOn(crypto, 'randomUUID').mockReturnValue('10000000-0000-4000-8000-000000000001');
  api.localWorkspace.researchCompany = vi.fn<CalliePreloadApi['localWorkspace']['researchCompany']>(() => gate.promise);
  api.imports.preview = vi.fn<CalliePreloadApi['imports']['preview']>(async () => importPreview); api.imports.commit = vi.fn<CalliePreloadApi['imports']['commit']>(async () => importReceipt);
  render(<FounderAppHarness api={api} health={readyHealth} initialRoute="accounts" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Local account · Account A' })); await screen.findByText('Founder selected source a');
  fireEvent.click(screen.getByRole('button', { name: /^Research(?: company)?$/i })); const original = vi.mocked(api.localWorkspace.researchCompany).mock.calls[0][0];
  // This real application event opens the global dialog without routing away, so commit exercises Accounts' keyed remount.
  await act(async () => { window.dispatchEvent(new Event('callie:open-import')); });
  const dialog = await screen.findByRole('dialog', { name: 'Import leads' }); expect(dialog.tagName).toBe('DIALOG');
  fireEvent.keyDown(window, { key: 'k', metaKey: true, ctrlKey: true }); expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull();
  fireEvent.change(within(dialog).getByLabelText('Paste spreadsheet rows'), { target: { value: 'Name\tPhone\nKevin\t4015550101' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Preview rows' })); fireEvent.click(await screen.findByRole('button', { name: 'Import 1 row' }));
  await screen.findByText('Imported 1 row.'); expect(api.imports.commit).toHaveBeenCalledOnce();
  const liveDialog = screen.queryByRole('dialog', { name: 'Import leads' }); if (liveDialog) fireEvent.click(within(liveDialog).getByRole('button', { name: 'Close' }));
  await screen.findByText('Founder selected source a'); expect(screen.getByRole('button', { name: 'Local account · Account A' }).getAttribute('aria-current')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: /^Research(?: company)?$/i })); expect(api.localWorkspace.researchCompany).toHaveBeenCalledOnce();
  await act(async () => gate.resolve(f4AppStatus(original, 'completed'))); expect(await screen.findByText(/^Research known · completed$/)).toBeTruthy();
  expect(vi.mocked(api.localWorkspace.researchCompany).mock.calls[0][0]).toBe(original);
}, 10_000);

it('F4-founder-04 palette Escape does not close selected research or resume its pending request', async () => {
  const api = f4FounderApi(); const r = { accountId: 'a', commandId: '10000000-0000-4000-8000-000000000001' };
  const gate = f4AppDeferred(f4AppStatus(r, 'completed')); vi.spyOn(crypto, 'randomUUID').mockReturnValue('10000000-0000-4000-8000-000000000001'); api.localWorkspace.researchCompany = vi.fn<CalliePreloadApi['localWorkspace']['researchCompany']>(() => gate.promise);
  render(<FounderAppHarness api={api} health={readyHealth} initialRoute="accounts" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Local account · Account A' })); await screen.findByText('Founder selected source a');
  const research = screen.getByRole('button', { name: /^Research(?: company)?$/i }); fireEvent.click(research);
  fireEvent.keyDown(window, { key: 'k', metaKey: true, ctrlKey: true }); const palette = await screen.findByRole('dialog', { name: 'Command palette' });
  fireEvent.keyDown(within(palette).getByRole('combobox'), { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull());
  expect(screen.getByText('Founder selected source a')).toBeTruthy(); expect(api.localWorkspace.researchCompany).toHaveBeenCalledOnce();
  expect(screen.getByRole('button', { name: 'Local account · Account A' }).getAttribute('aria-current')).toBe('true');
  await act(async () => gate.resolve(f4AppStatus(r, 'completed'))); expect(await screen.findByText(/^Research known · completed$/)).toBeTruthy();
}, 10_000);

it('F4-founder-05 intake Open account selects the same research detail rather than a worker account', async () => {
  const api = f4FounderApi(); const newSnapshot = f4AppDetail('a').snapshot;
  newSnapshot.account = { id: 'new-local', name: 'New Local Company', domain: 'new.example', version: 1 };
  let saved = false;
  api.localWorkspace.get = vi.fn<CalliePreloadApi['localWorkspace']['get']>(async () => localSnapshot({ accounts: { state: 'available', snapshots: saved ? [...dailyFixture().accounts, newSnapshot] : dailyFixture().accounts } }));
  api.localWorkspace.reviewCompany = vi.fn<CalliePreloadApi['localWorkspace']['reviewCompany']>(async input => ({ scope: 'local_database', input, candidates: [], complete: true }));
  api.localWorkspace.createCompany = vi.fn<CalliePreloadApi['localWorkspace']['createCompany']>(async input => { saved = true; return { status: 'saved', commandId: input.commandId, account: newSnapshot.account, replayed: false }; });
  api.localWorkspace.getCompany = vi.fn<CalliePreloadApi['localWorkspace']['getCompany']>(async ({ accountId }) => accountId === 'new-local' ? { ...f4AppDetail('a'), snapshot: newSnapshot } : f4AppDetail(accountId));
  render(<FounderAppHarness api={api} health={readyHealth} initialRoute="accounts" />);
  const add = await screen.findByRole('button', { name: 'Add company' }); await waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(add);
  fireEvent.change(screen.getByRole('textbox', { name: 'Company name' }), { target: { value: 'New Local Company' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Company domain (optional)' }), { target: { value: 'new.example' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review company' })); const create = await screen.findByRole('button', { name: 'Create company' });
  await waitFor(() => expect((create as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(create);
  await waitFor(() => expect(api.localWorkspace.getCompany).toHaveBeenCalledWith({ accountId: 'new-local' }));
  expect(screen.getByRole('button', { name: 'Local account · New Local Company' }).getAttribute('aria-current')).toBe('true');
  expect(await screen.findByRole('button', { name: /^Research(?: company)?$/i })).toBeTruthy(); expect(api.localWorkspace.researchCompany).not.toHaveBeenCalled();
}, 10_000);


// Task 6 additive actual FounderApp composition. No ContactLink or new owner imports.
// APIs below are fake projections. Real ImportDialog and global inspector are NOT mocked.
const t6AppQuote = 'Avery manages Account A. Office team: office@a.example.';
function t6AppCompany(): LocalCompanyDetail { const value = f4AppDetail(); value.sources[0].excerpt = t6AppQuote; return value; }
function t6AppPerson(): LeadDetail {
  return { ...structuredClone(detail), personId: 'person-51', personName: 'Avery', salesCycleId: 'cycle-51', organizationLabel: 'Shared Organization', emails: [{ id: 'method-person-51', contactSnapshot: 'b'.repeat(64), kind: 'email', value: 'avery@example.test', label: 'User supplied', valid: true, validationState: 'valid', reachability: 'direct', sourceLabel: 'Imported spreadsheet', vendorRank: null, phoneKind: null, ownershipState: 'unknown', evidenceObservedAt: null, compliance: null }] };
}
function t6AppRows(start: number, count: number): Awaited<ReturnType<CalliePreloadApi['leads']['list']>>['rows'] {
  return Array.from({ length: count }, (_, i): Awaited<ReturnType<CalliePreloadApi['leads']['list']>>['rows'][number] => { const n = start + i; return { personId: `person-${n}`, personName: n === 1 || n === 51 ? 'Avery' : `Person ${n}`, salesCycleId: `cycle-${n}`, initials: 'AV', organization: 'Shared Organization', propertySummary: null, stage: 'ready', source: 'custom', segment: 'warm', priorityContext: null, cloudScores: null, nextAction: null, optedOut: false, lastActivityAt: null }; });
}
async function t6AppFillReview() {
  fireEvent.change(screen.getByRole('textbox', { name: 'Role' }), { target: { value: 'Manager' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Relationship' }), { target: { value: 'Manages company' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Source quotation' }), { target: { value: t6AppQuote } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'I confirm this saved person and quoted relationship' }));
  await waitFor(() => expect((screen.getByRole('button', { name: 'Link saved person' }) as HTMLButtonElement).disabled).toBe(false));
}
it('T6-A01 actual global import mapping and duplicate commit retains account, explicit person51 selection links then opens sole exact inspector', async () => {
  const api = f4FounderApi(); let linked = false; const company = t6AppCompany();
  api.localWorkspace.getCompany = vi.fn<CalliePreloadApi['localWorkspace']['getCompany']>(async () => ({ ...company, links: linked ? [{ id: 'stored-person-link', kind: 'person_role', personId: 'person-51', role: 'Manager', relationship: 'Manages company', evidenceIds: ['first-use-a'], authority: 'unconfirmed', authorityEvidenceIds: [], validFrom: fixtureNow, validTo: null }] : [] }));
  api.localWorkspace.linkCompanyPerson = vi.fn<CalliePreloadApi['localWorkspace']['linkCompanyPerson']>(async input => { linked = true; return { accountId: input.accountId, version: 2, duplicate: false }; });
  const preview: ImportPreview = { ...importPreview, sampleRows: [{ rowNumber: 2, cells: ['Avery', 'avery@example.test'] }], duplicateCandidates: [{ rowNumber: 2, personIds: ['person-1', 'person-51'], reason: 'Same name, explicit review required' }] };
  api.imports.preview = vi.fn<CalliePreloadApi['imports']['preview']>(async () => preview);
  api.imports.remap = vi.fn<CalliePreloadApi['imports']['remap']>(async input => ({ ...preview, suggestedMapping: input.mapping }));
  api.imports.commit = vi.fn<CalliePreloadApi['imports']['commit']>(async () => ({ ...importReceipt, importedPersonIds: ['person-51'] }));
  api.leads.list = vi.fn<CalliePreloadApi['leads']['list']>(async input => ({ rows: input.cursor === null ? t6AppRows(1, 50) : t6AppRows(51, 2), nextCursor: input.cursor === null ? 'opaque-person-page-2' : null, total: 52, revision: 2 }));
  api.leadDetail.get = vi.fn<CalliePreloadApi['leadDetail']['get']>(async () => t6AppPerson());
  const savedPeople = [t6AppPerson(), { ...t6AppPerson(), personId: 'person-52' }];
  const peopleBefore = structuredClone(savedPeople);
  api.leadDetail.get = vi.fn<CalliePreloadApi['leadDetail']['get']>(async ({ personId }) => structuredClone(savedPeople.find(person => person.personId === personId)!));
  api.leadDetail.getOutboundCapabilities = vi.fn<CalliePreloadApi['leadDetail']['getOutboundCapabilities']>(async () => { throw Error('Synthetic capabilities unavailable'); });
  render(<FounderAppHarness api={api} health={readyHealth} initialRoute="accounts" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Local account · Account A' })); await screen.findByText(t6AppQuote);
  expect(api.localWorkspace.getCompany).toHaveBeenCalledWith({ accountId: 'a' });
  fireEvent.click(await screen.findByRole('button', { name: 'Import named person' }));
  const dialog = await screen.findByRole('dialog', { name: 'Import leads' }); expect(screen.getAllByRole('dialog', { name: 'Import leads' })).toHaveLength(1);
  expect((within(dialog).getByLabelText('Paste spreadsheet rows') as HTMLTextAreaElement).value).toBe('');
  fireEvent.keyDown(window, { key: 'k', metaKey: true, ctrlKey: true }); expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull();
  fireEvent.change(within(dialog).getByLabelText('Paste spreadsheet rows'), { target: { value: 'Name\tPhone\nAvery\tavery@example.test' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Preview rows' })); const commit = await within(dialog).findByRole('button', { name: 'Import 1 row' });
  expect((commit as HTMLButtonElement).disabled).toBe(true); expect(api.imports.commit).not.toHaveBeenCalled();
  fireEvent.change(within(dialog).getByLabelText('Phone'), { target: { value: 'email' } });
  await waitFor(() => expect(api.imports.remap).toHaveBeenCalledWith({ previewId: preview.previewId, contentHash: preview.contentHash, mapping: { Name: 'person_name', Phone: 'email' } }));
  await waitFor(() => expect((within(dialog).getByLabelText('Phone') as HTMLSelectElement).value).toBe('email'));
  fireEvent.change(within(dialog).getByLabelText('Duplicate action for row 2'), { target: { value: 'merge' } });
  fireEvent.change(within(dialog).getByLabelText('Merge target for row 2'), { target: { value: 'person-51' } });
  await waitFor(() => expect((within(dialog).getByRole('button', { name: 'Import 1 row' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Import 1 row' })); await within(dialog).findByText('Imported 1 row.');
  expect(api.imports.commit).toHaveBeenCalledWith({ previewId: preview.previewId, contentHash: preview.contentHash, mapping: { Name: 'person_name', Phone: 'email' }, source: { channel: 'custom', referredByPersonId: null }, duplicateDecisions: [{ rowNumber: 2, decision: 'merge', personId: 'person-51' }] });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close' })); await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Import leads' })).toBeNull());
  await screen.findByText(t6AppQuote); expect(screen.getByRole('button', { name: 'Local account · Account A' }).getAttribute('aria-current')).toBe('true');
  expect(api.localWorkspace.linkCompanyPerson).not.toHaveBeenCalled(); expect(api.leadDetail.get).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Find saved person' })); await screen.findByRole('button', { name: 'Select Avery · person-1' });
  expect(api.leads.list).toHaveBeenLastCalledWith({ query: '', stages: [], priorities: [], sort: 'person_name', cursor: null, limit: 50 });
  fireEvent.click(screen.getByRole('button', { name: 'Load more' })); fireEvent.click(await screen.findByRole('button', { name: 'Select Avery · person-51' }));
  await screen.findByText('avery@example.test'); expect(api.leads.list).toHaveBeenLastCalledWith({ query: '', stages: [], priorities: [], sort: 'person_name', cursor: 'opaque-person-page-2', limit: 50 });
  expect(api.leadDetail.get).toHaveBeenLastCalledWith({ personId: 'person-51' }); await t6AppFillReview();
  const reads = vi.mocked(api.localWorkspace.getCompany).mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: 'Link saved person' })); const saved = await screen.findByRole('button', { name: 'Open saved contact' });
  expect(api.localWorkspace.getCompany).toHaveBeenCalledTimes(reads + 1); expect(api.localWorkspace.linkCompanyPerson).toHaveBeenCalledOnce();
  expect(vi.mocked(api.localWorkspace.linkCompanyPerson).mock.calls[0][0]).toEqual(expect.objectContaining({ accountId: 'a', sourceQuotes: [{ sourceId: 'first-use-a', quote: t6AppQuote }], link: expect.objectContaining({ personId: 'person-51', authority: 'unconfirmed', authorityEvidenceIds: [], validTo: null }) }));
  vi.mocked(api.leadDetail.get).mockClear(); fireEvent.click(saved);
  await screen.findByRole('complementary', { name: 'Avery details' }); expect(screen.getAllByRole('complementary', { name: 'Avery details' })).toHaveLength(1);
  expect(api.leadDetail.get).toHaveBeenCalledWith({ personId: 'person-51' }); expect(screen.getAllByRole('button', { name: 'Close inspector' })).toHaveLength(1);
  expect(api.leads.updateField).not.toHaveBeenCalled(); expect(api.leads.bulkUpdate).not.toHaveBeenCalled(); expect(api.leadDetail.beginOutbound).not.toHaveBeenCalled(); expect(api.leadDetail.findContactInfo).not.toHaveBeenCalled(); expect(api.localWorkspace.researchCompany).not.toHaveBeenCalled();
  // Fake link implementation above changes only its local link flag. This is NOT main storage proof.
  expect(savedPeople).toEqual(peopleBefore);
}, 10_000);
it('T6-A02 office-only actual account reaches missing contact UI and global import has no office prefill', async () => {
  const api = f4FounderApi(); const office = f4AppDetail(); office.sources[0].excerpt = 'Office team only: office@a.example +1 401 555 0100';
  api.imports.preview = vi.fn<CalliePreloadApi['imports']['preview']>(async () => { throw Error('Preview requires explicit user action'); });
  api.localWorkspace.getCompany = vi.fn<CalliePreloadApi['localWorkspace']['getCompany']>(async () => office);
  api.localWorkspace.linkCompanyPerson = vi.fn<CalliePreloadApi['localWorkspace']['linkCompanyPerson']>(async () => { throw Error('No reviewed saved person'); });
  render(<FounderAppHarness api={api} health={readyHealth} initialRoute="accounts" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Local account · Account A' })); await screen.findByText(office.sources[0].excerpt);
  expect(await screen.findByText('Contact not established')).toBeTruthy(); expect(screen.queryByText(/verified person/i)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Import named person' })); const dialog = await screen.findByRole('dialog', { name: 'Import leads' });
  expect((within(dialog).getByLabelText('Paste spreadsheet rows') as HTMLTextAreaElement).value).toBe(''); expect(api.imports.preview).not.toHaveBeenCalled(); expect(api.localWorkspace.linkCompanyPerson).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close' })); expect(screen.getByRole('button', { name: 'Local account · Account A' }).getAttribute('aria-current')).toBe('true');
}, 10_000);
it('T6-A03 actual Campaigns route and global Import remount retain dirty reviewed identity without auto-link', async () => {
  const api = f4FounderApi(); api.localWorkspace.getCompany = vi.fn<CalliePreloadApi['localWorkspace']['getCompany']>(async () => t6AppCompany());
  api.leads.list = vi.fn<CalliePreloadApi['leads']['list']>(async () => ({ rows: t6AppRows(51, 1), nextCursor: null, total: 1, revision: 1 }));
  api.leadDetail.get = vi.fn<CalliePreloadApi['leadDetail']['get']>(async () => t6AppPerson());
  api.localWorkspace.linkCompanyPerson = vi.fn<CalliePreloadApi['localWorkspace']['linkCompanyPerson']>(async () => ({ accountId: 'a', version: 2, duplicate: false }));
  api.imports.preview = vi.fn<CalliePreloadApi['imports']['preview']>(async () => importPreview); api.imports.commit = vi.fn<CalliePreloadApi['imports']['commit']>(async () => importReceipt);
  render(<FounderAppHarness api={api} health={readyHealth} initialRoute="accounts" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Local account · Account A' })); await screen.findByText(t6AppQuote);
  fireEvent.click(await screen.findByRole('button', { name: 'Find saved person' })); fireEvent.click(await screen.findByRole('button', { name: 'Select Avery · person-51' })); await screen.findByText('avery@example.test'); await t6AppFillReview();
  fireEvent.click(screen.getByRole('link', { name: 'Campaigns' })); await screen.findByRole('heading', { level: 1, name: 'Campaigns' }); fireEvent.click(screen.getByRole('link', { name: 'Accounts' })); await screen.findByText(t6AppQuote);
  expect((screen.getByRole('textbox', { name: 'Role' }) as HTMLInputElement).value).toBe('Manager');
  fireEvent.click(screen.getByRole('button', { name: 'Import named person' })); const dialog = await screen.findByRole('dialog', { name: 'Import leads' });
  fireEvent.change(within(dialog).getByLabelText('Paste spreadsheet rows'), { target: { value: 'Name\tPhone\nKevin\t4015550101' } }); fireEvent.click(within(dialog).getByRole('button', { name: 'Preview rows' })); fireEvent.click(await within(dialog).findByRole('button', { name: 'Import 1 row' })); await within(dialog).findByText('Imported 1 row.'); fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
  await screen.findByText(t6AppQuote); expect((screen.getByRole('textbox', { name: 'Role' }) as HTMLInputElement).value).toBe('Manager'); expect((screen.getByRole('textbox', { name: 'Source quotation' }) as HTMLInputElement).value).toBe(t6AppQuote);
  expect(screen.getByRole('button', { name: 'Local account · Account A' }).getAttribute('aria-current')).toBe('true'); expect(api.localWorkspace.linkCompanyPerson).not.toHaveBeenCalled();
}, 10_000);

it('T6-A04 actual route departure preserves pending link, lost reply offers exact replay without new UUID', async () => {
  const api = f4FounderApi(); api.localWorkspace.getCompany = vi.fn<CalliePreloadApi['localWorkspace']['getCompany']>(async () => t6AppCompany());
  api.leads.list = vi.fn<CalliePreloadApi['leads']['list']>(async () => ({ rows: t6AppRows(51, 1), nextCursor: null, total: 1, revision: 1 }));
  api.leadDetail.get = vi.fn<CalliePreloadApi['leadDetail']['get']>(async () => t6AppPerson());
  let resolve!: (receipt: Awaited<ReturnType<CalliePreloadApi['localWorkspace']['linkCompanyPerson']>>) => void;
  let reject!: (error: Error) => void;
  const pending = new Promise<Awaited<ReturnType<CalliePreloadApi['localWorkspace']['linkCompanyPerson']>>>((yes, no) => { resolve = yes; reject = no; });
  api.localWorkspace.linkCompanyPerson = vi.fn<CalliePreloadApi['localWorkspace']['linkCompanyPerson']>().mockImplementationOnce(() => pending).mockResolvedValue({ accountId: 'a', version: 2, duplicate: true });
  const view = render(<FounderAppHarness api={api} health={readyHealth} initialRoute="accounts" />);
  try {
    fireEvent.click(await screen.findByRole('button', { name: 'Local account · Account A' })); await screen.findByText(t6AppQuote);
    fireEvent.click(await screen.findByRole('button', { name: 'Find saved person' })); fireEvent.click(await screen.findByRole('button', { name: 'Select Avery · person-51' })); await screen.findByText('avery@example.test'); await t6AppFillReview();
    fireEvent.click(screen.getByRole('button', { name: 'Link saved person' })); expect(api.localWorkspace.linkCompanyPerson).toHaveBeenCalledOnce();
    const original = vi.mocked(api.localWorkspace.linkCompanyPerson).mock.calls[0][0];
    fireEvent.click(screen.getByRole('link', { name: 'Campaigns' })); await screen.findByRole('heading', { level: 1, name: 'Campaigns' });
    fireEvent.click(screen.getByRole('link', { name: 'Accounts' })); await screen.findByText(t6AppQuote);
    expect(api.localWorkspace.linkCompanyPerson).toHaveBeenCalledOnce();
    const replayWhilePending = screen.queryByRole('button', { name: 'Replay link' });
    if (replayWhilePending) expect((replayWhilePending as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('link', { name: 'Campaigns' })); await screen.findByRole('heading', { level: 1, name: 'Campaigns' });
    expect(screen.queryByRole('button', { name: 'Find saved person' })).toBeNull();
    const readsWhileAway = vi.mocked(api.localWorkspace.getCompany).mock.calls.length;
    await act(async () => { reject(Error('lost renderer reply')); await Promise.allSettled([pending]); });
    expect(api.localWorkspace.getCompany).toHaveBeenCalledTimes(readsWhileAway);
    expect(api.localWorkspace.linkCompanyPerson).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('link', { name: 'Accounts' })); await screen.findByText(t6AppQuote);
    const replay = await screen.findByRole('button', { name: 'Replay link' }); expect((replay as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(replay); await waitFor(() => expect(api.localWorkspace.linkCompanyPerson).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.localWorkspace.linkCompanyPerson).mock.calls[1][0]).toBe(original);
    expect(screen.getByRole('button', { name: 'Local account · Account A' }).getAttribute('aria-current')).toBe('true');
  } finally { view.unmount(); await act(async () => { resolve({ accountId: 'a', version: 2, duplicate: false }); await Promise.allSettled([pending]); }); }
}, 10_000);

it('capacity save retains actual Settings editor and returning normally to Today reads current values', async () => {
  window.location.hash = '#/settings';
  const api = fakeCallieApi();
  let stored: import('../../shared/contracts/localWorkspaceContract').MeetingFirstAccountCallSettings = {
    newCallSlots: null, totalCallCapacity: null, revision: 0, updatedAt: '2026-09-11T12:00:00.000Z',
  };
  api.localWorkspace.getCallSettings = vi.fn(async () => stored);
  api.localWorkspace.updateCallSettings = vi.fn(async input => stored = { newCallSlots: input.newCallSlots, totalCallCapacity: input.totalCallCapacity, revision: input.expectedRevision + 1, updatedAt: stored.updatedAt });
  api.daily.get = vi.fn(async () => dailyFixture({ answers: [], callSettings: { newCallSlots: stored.newCallSlots, totalCallCapacity: stored.totalCallCapacity } }));
  api.localWorkspace.get = vi.fn(async () => localSnapshot({ workflowMode: 'meeting_first' }));
  render(<FounderAppHarness api={api} health={readyHealth} initialRoute="settings" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Call capacity' }));
  await waitFor(() => expect((screen.getByRole('button', { name: 'Save call capacity' }) as HTMLButtonElement).disabled).toBe(false));
  const editor = screen.getByRole('region', { name: 'Call capacity' });
  fireEvent.change(within(editor).getByLabelText('New call slots configuration'), { target: { value: 'number' } });
  fireEvent.change(within(editor).getByLabelText('New call slots'), { target: { value: '0' } });
  fireEvent.click(within(editor).getByRole('button', { name: 'Save call capacity' })); await screen.findByText('Call capacity saved.');
  expect(screen.getByRole('region', { name: 'Call capacity' })).toBe(editor);
  expect(screen.getByRole('button', { name: 'Call capacity' }).getAttribute('aria-current')).toBe('true');
  expect(api.localWorkspace.updateCallSettings).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('link', { name: 'Today' }));
  await screen.findByRole('button', { name: 'Call · Account A' });
  expect(screen.queryByRole('region', { name: 'Call capacity' })).toBeNull();
  expect(screen.getByText(/New-call slots:/).textContent).toContain('New-call slots: 0');
});

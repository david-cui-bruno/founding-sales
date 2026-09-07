// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { discoveryBriefSchema, discoverySnapshotSchema, type DiscoveryApi } from '../../shared/contracts/discoveryContract';
import type { PipelineSnapshot } from '../../shared/contracts/pipelineContract';
import type { TodaySnapshot } from '../../shared/contracts/todayContract';
import type { LeadDetail } from '../../shared/contracts/leadDetailContract';
import type { CalliePreloadApi } from '../../shared/preload';
import type { FoundationHealth } from '../foundation/useFoundationHealth';
import { FounderApp } from './FounderApp';

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
    health: { get: vi.fn(async () => ({}) as never) },
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
    },
    today: {
      get: vi.fn(async () => todaySnapshot),
      complete: pending,
      snooze: pending,
      pin: pending,
      logPastActivity: vi.fn<CalliePreloadApi['today']['logPastActivity']>(() => new Promise(() => undefined)),
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
    sourcing: { pollNow: pending, status: pending },
    appleSpike: {} as never,
  } as unknown as CalliePreloadApi;
}

const readyHealth: FoundationHealth = {
  status: 'ready',
  health: {} as never,
  retry: vi.fn(),
};

afterEach(() => {
  cleanup();
  window.location.hash = '';
});

describe('FounderApp', () => {
  it('defaults to the Today route inside the navigation shell', async () => {
    window.location.hash = '';
    render(<FounderApp api={fakeCallieApi()} health={readyHealth} />);

    expect(screen.getByRole('navigation', { name: 'Primary' })).not.toBeNull();
    expect(
      screen.getByRole('link', { name: 'Today' }).getAttribute('aria-current'),
    ).toBe('page');
    expect(await screen.findByRole('button', { name: 'Kevin Shin' })).not.toBeNull();
  });

  it('opens the same global inspector from Today and Pipeline routes', async () => {
    window.location.hash = '';
    render(<FounderApp api={fakeCallieApi()} health={readyHealth} />);

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
    render(<FounderApp api={fakeCallieApi()} health={readyHealth} />);

    fireEvent.click(
      await screen.findByRole('button', { name: 'Import' }),
    );
    expect(await screen.findByRole('dialog')).not.toBeNull();
  });

  it('routes Conversations and Learnings to their live workspaces', async () => {
    window.location.hash = '';
    render(<FounderApp api={fakeCallieApi()} health={readyHealth} />);

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

it('injects discovery into Today and the selected full inspector without enrichment or outbound side effects', async () => {
  const api = fakeCallieApi();
  render(<FounderApp api={api} health={readyHealth} />);
  fireEvent.click(await screen.findByRole('button', { name: 'View evidence for Kevin Shin' }));
  const page = await screen.findByRole('article', { name: 'Kevin Shin full page' });
  expect(await within(page).findByText('Who handles maintenance?')).toBeTruthy();
  expect(api.discovery.getBrief).toHaveBeenCalledWith({ personId: 'person-kevin' });
  expect(api.discovery.begin).not.toHaveBeenCalled();
  fireEvent.click(within(page).getByRole('button', { name: 'Close inspector' }));
  fireEvent.click(screen.getByRole('button', { name: 'Contact options for Kevin Shin' }));
  await screen.findByRole('article', { name: 'Kevin Shin full page' });
  await waitFor(() => expect(api.discovery.begin).toHaveBeenCalledTimes(1));
  expect(api.leadDetail.beginOutbound).not.toHaveBeenCalled();
  expect(api.leadDetail.findContactInfo).not.toHaveBeenCalled();
  expect(api.leadDetail.confirmTransition).not.toHaveBeenCalled();
  expect(api.today.logPastActivity).not.toHaveBeenCalled();
});

it('refreshes the same selected inspector after preparation instead of showing cached unreviewed detail', async () => {
  const api = fakeCallieApi();
  vi.mocked(api.leadDetail.get).mockResolvedValueOnce({ ...detail, stage: 'unreviewed' });
  render(<FounderApp api={api} health={readyHealth} />);
  fireEvent.click(await screen.findByRole('button', { name: 'View evidence for Kevin Shin' }));
  const firstPage = await screen.findByRole('article', { name: 'Kevin Shin full page' });
  expect(within(firstPage).getByText('Founder manual controls')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Contact options for Kevin Shin' }));
  await waitFor(() => expect(api.leadDetail.get).toHaveBeenCalledTimes(2));
  const page = await screen.findByRole('article', { name: 'Kevin Shin full page' });
  expect(within(page).queryByText('Founder manual controls')).toBeNull();
});

it('does not replace a different inspector selection when an earlier preparation replies late', async () => {
  const api = fakeCallieApi();
  vi.mocked(api.today.get).mockResolvedValue({ ...todaySnapshot, lanes: [{ id: 'new_p0', overflowCount: 0, items: [{ ...todaySnapshot.lanes[0].items[0], personId: 'person-dana', personName: 'Dana Whitman', salesCycleId: 'cycle-dana', id: 'item-dana' }] }] });
  vi.mocked(api.leadDetail.get).mockImplementation(async ({ personId }) => personId === 'person-dana' ? { ...detail, personId, salesCycleId: 'cycle-dana', personName: 'Dana Whitman' } : detail);
  let resolve!: (receipt: Awaited<ReturnType<DiscoveryApi['begin']>>) => void;
  vi.mocked(api.discovery.begin).mockImplementation(() => new Promise(done => { resolve = done; }));
  render(<FounderApp api={api} health={readyHealth} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Contact options for Kevin Shin' }));
  fireEvent.click(screen.getByRole('button', { name: 'Dana Whitman' }));
  await screen.findByRole('complementary', { name: 'Dana Whitman details' });
  await act(async () => resolve({ personId: 'person-kevin', salesCycleId: 'cycle-kevin', assessmentId: preparedBrief.assessment!.id, actionId: 'action-kevin', mutation: { revision: 2, affectedPersonIds: ['person-kevin'], affectedSalesCycleIds: ['cycle-kevin'] } }));
  expect(screen.getByRole('complementary', { name: 'Dana Whitman details' })).toBeTruthy();
  expect(screen.queryByRole('article', { name: 'Kevin Shin full page' })).toBeNull();
});

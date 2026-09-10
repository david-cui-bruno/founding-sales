/** Actual-App, complete typed read-only all-route fixture. No preload/client or production API factory. */
import { StrictMode } from 'react';
import { installApplicationModalScenario } from './applicationModalScenario';
import { installApplicationLeadsScenario } from './applicationLeadsScenario';
import { createRoot } from 'react-dom/client';
import { App } from '../../src/renderer/App';
import type { CalliePreloadApi } from '../../src/shared/preload';
import type { AppHealth } from '../../src/shared/healthContract';
import type { TodaySnapshot } from '../../src/shared/contracts/todayContract';
import type { DiscoverySnapshot } from '../../src/shared/contracts/discoveryContract';
import { outboundCapabilitiesSchema, type OutboundCapabilities } from '../../src/shared/contracts/outboundContract';
import type { DailySnapshot } from '../../src/shared/contracts/dailyContract';
import { leadDetailRequestSchema, leadDetailSchema, type LeadDetail } from '../../src/shared/contracts/leadDetailContract';
import { leadRowSchema } from '../../src/shared/contracts/leadsContract';
import { appleSpikeStatusSchema } from '../../src/shared/appleSpikeContract';
import { nativeDeskFixture, nativeDeskReviewFixture, localSnapshot, commitments, fixtureNow } from '../../src/renderer/features/today/nativeDesk.fixture';
import '../../src/renderer/app.css';

export type Call = { method: string; kind: 'read' | 'command' | 'forbidden'; args?: unknown[] };
const calls: Call[] = [];
const forbidden = (method: string) => async (): Promise<never> => {
  calls.push({ method, kind: 'forbidden' });
  throw Error(`Application fixture forbids ${method}`);
};
const healthValue: AppHealth = {
  appVersion: '1.0.0', schemaVersion: 2, databasePath: '/synthetic/startup.sqlite3',
  databaseEncrypted: true, cipherVersion: 'synthetic', fts5Available: true,
  pendingJobs: 0, interruptedJobsRecovered: 0, domainStatus: 'ready', domainReady: true,
  domainBlockingViolationCount: 0, domainRepairableIssueCount: 0,
  domainProjectionRefreshCandidateCount: 0, pendingProjectionRebuilds: 0,
  domainStartupEvaluatedAt: fixtureNow, operationalStatus: 'ready',
  sourcing: { status: 'healthy', reasons: [], lastSuccessAgeMs: null,
    state: { state: 'idle', pollId: null, startedAt: null, lastCompletedAt: null,
      consecutiveFailures: 0, lastFailureAt: null, lastFailureCode: null, backlogCount: null } },
};
const desk = nativeDeskFixture(nativeDeskReviewFixture());
let localMode: 'meeting_first' | 'legacy' = new URLSearchParams(location.search).get('mode') === 'legacy' ? 'legacy' : 'meeting_first';
let detailMode: 'ready' | 'pending' | 'failed' = 'ready';
const read = <T,>(method: string, value: () => T) => async (...args: unknown[]): Promise<T> => {
  calls.push({ method, kind: 'read', args: structuredClone(args) });
  return structuredClone(value());
};
// Every bridge member is explicit and checked. Even synthetic command mutations
// from nativeDeskFixture are NOT exposed. Any accidental command is logged/fails.
const unavailable = { state: 'unavailable', reasonCode: 'not_integrated' } as const;
const outboundCapabilities: OutboundCapabilities = {
  phoneHandoff: unavailable, callObservation: unavailable, recording: unavailable,
  messagesSend: unavailable, gmailSend: unavailable, managedAudioImport: unavailable,
  appleTranscriptExtraction: unavailable, localDrafts: true,
};
outboundCapabilitiesSchema.parse(outboundCapabilities);
const detail: LeadDetail = leadDetailSchema.parse({
  personId: 'person-kevin', salesCycleId: 'cycle-kevin', personName: 'Kevin Shin',
  phones: [], emails: [], organizationLabel: 'Harbor Test Management', propertySummaries: [],
  stage: 'ready', workflowStatus: 'active', sourceLabel: 'custom', segment: 'warm',
  cloudScores: null, cloudLinked: false,
  findContactEligibility: { eligible: false, refusalReason: 'qualification_required' },
  priorityContext: null, priorityReasons: [], nextAction: null, optedOut: false, cadence: null,
  outboundAttempts: [], activities: [], conversations: [], properties: [], history: [], revision: 1,
});
const row = leadRowSchema.parse({
  personId: detail.personId, salesCycleId: detail.salesCycleId, personName: detail.personName,
  initials: 'KS', organization: detail.organizationLabel, propertySummary: null,
  stage: 'ready', source: 'custom', segment: 'warm', priorityContext: null, cloudScores: null,
  nextAction: null, optedOut: false, lastActivityAt: null,
});
const api: CalliePreloadApi = {
  health: { get: read('health.get', () => healthValue) },
  daily: { get: read<DailySnapshot>('daily.get', () => ({ ...nativeDeskReviewFixture(), workflowMode: localMode })) },
  localWorkspace: {
    reviewCompany: forbidden('localWorkspace.reviewCompany'),
    createCompany: forbidden('localWorkspace.createCompany'),
    getCompanyCreateStatus: forbidden('localWorkspace.getCompanyCreateStatus'),
    get: read('localWorkspace.get', () => localSnapshot({ workflowMode: localMode })),
    getCommitments: read('localWorkspace.getCommitments', () => commitments()),
    transition: forbidden('localWorkspace.transition'),
  },
  delegation: {
    status: async () => { calls.push({ method: 'delegation.status', kind: 'read' }); return desk.api.delegation.status(); },
    policyImport: { selectAndPreview: forbidden('policyImport.selectAndPreview'), confirm: forbidden('policyImport.confirm'), resume: forbidden('policyImport.resume'), status: forbidden('policyImport.status') },
    prepareRequestedFollowup: forbidden('delegation.prepareRequestedFollowup'), getRequestedFollowup: forbidden('delegation.getRequestedFollowup'),
    editRequestedFollowup: forbidden('delegation.editRequestedFollowup'), approveRequestedFollowup: forbidden('delegation.approveRequestedFollowup'),
    beginPhone: forbidden('delegation.beginPhone'), bootstrap: forbidden('delegation.bootstrap'),
    configurePolicy: forbidden('delegation.configurePolicy'), configureResearch: forbidden('delegation.configureResearch'),
    pair: forbidden('delegation.pair'), configure: forbidden('delegation.configure'), submit: forbidden('delegation.submit'), sync: forbidden('delegation.sync'),
  },
  linkedin: { prepare: forbidden('linkedin.prepare'), get: forbidden('linkedin.get'), recover: forbidden('linkedin.recover'), save: forbidden('linkedin.save'), begin: forbidden('linkedin.begin'), open: forbidden('linkedin.open'), copy: forbidden('linkedin.copy'), reportOutcome: forbidden('linkedin.reportOutcome') },
  phoneSetup: { status: forbidden('phoneSetup.status'), confirm: forbidden('phoneSetup.confirm'), clear: forbidden('phoneSetup.clear') },
  outreach: { status: read<Awaited<ReturnType<CalliePreloadApi['outreach']['status']>>>('outreach.status', () => ({ model: 'unconfigured', modelName: '', gmail: 'unconfigured', accountEmail: null, senderName: '', postalAddress: '' })), connectGmail: forbidden('outreach.connectGmail'), disconnectGmail: forbidden('outreach.disconnectGmail'), configure: forbidden('outreach.configure'), openDraft: forbidden('outreach.openDraft'), saveDraft: forbidden('outreach.saveDraft'), generateDraft: forbidden('outreach.generateDraft'), sendDraft: forbidden('outreach.sendDraft') },
  leads: { list: read<Awaited<ReturnType<CalliePreloadApi['leads']['list']>>>('leads.list', () => ({ rows: [row], nextCursor: null, total: 1, revision: 1 })), updateField: forbidden('leads.updateField'), bulkUpdate: forbidden('leads.bulkUpdate') },
  leadDetail: { get: async (input) => {
    calls.push({ method: 'leadDetail.get', kind: 'read', args: [structuredClone(input)] });
    if (leadDetailRequestSchema.parse(input).personId !== detail.personId) throw Error('Unknown synthetic person');
    if (detailMode === 'failed') throw Error('Synthetic unavailable detail');
    if (detailMode === 'pending') return new Promise<LeadDetail>(resolve => pendingDetails.push(resolve));
    return structuredClone(detail);
  }, beginOutbound: forbidden('leadDetail.beginOutbound'), getOutboundCapabilities: read('leadDetail.getOutboundCapabilities', () => outboundCapabilities), confirmTransition: forbidden('leadDetail.confirmTransition'), dismissLead: forbidden('leadDetail.dismissLead'), overrideCloudScore: forbidden('leadDetail.overrideCloudScore'), findContactInfo: forbidden('leadDetail.findContactInfo') },
  today: {
    get: read<TodaySnapshot>('today.get', () => ({ lanes: [], dialBudget: 0, scheduledDials: 0, conversationTarget: 0, reviewErrorCount: 0, revision: 1, unreviewedBacklogCount: 0, unreviewedCloudSignalCount: 0, conversationsHeld: 0 })),
    getLeadTriageSnapshot: forbidden('today.getLeadTriageSnapshot'), complete: forbidden('today.complete'), snooze: forbidden('today.snooze'), pin: forbidden('today.pin'), logPastActivity: forbidden('today.logPastActivity'), addLeadNote: forbidden('today.addLeadNote'), logCallOutcome: forbidden('today.logCallOutcome'), markActivityInError: forbidden('today.markActivityInError'), getTriageQueue: forbidden('today.getTriageQueue'), setReviewPosition: forbidden('today.setReviewPosition'),
  },
  discovery: {
    get: read<DiscoverySnapshot>('discovery.get', () => ({ prepared: [], judgment: [], counts: { unassessed: 0, research: 0, watch: 0, excluded: 0 }, processing: 'idle' as const, researchCapability: 'not_configured' as const, generatedAt: fixtureNow, revision: 1 })),
    getBrief: forbidden('discovery.getBrief'), begin: forbidden('discovery.begin'), override: forbidden('discovery.override'),
  },
  pipeline: { get: read<Awaited<ReturnType<CalliePreloadApi['pipeline']['get']>>>('pipeline.get', () => ({ stages: [{ stage: 'ready', cards: [{ personId: detail.personId, salesCycleId: 'cycle-kevin', personName: detail.personName, contextLabel: detail.organizationLabel, stage: 'ready', stageEnteredAt: fixtureNow, priorityContext: null, nextAction: null, lostReasonCode: null }] }], revision: 1 })) },
  review: { list: read<Awaited<ReturnType<CalliePreloadApi['review']['list']>>>('review.list', () => ({
    items: [], totalOpenCount: 0, revision: 1, nextCursor: null, matchedCount: 0,
    countScope: 'lifecycle_review_items', observedAt: fixtureNow,
    queues: {
      unmatched_communication: { source: 'lifecycle_review_items', openCount: 0 },
      system_error: { source: 'lifecycle_review_items', openCount: 0 },
      ambiguous_identity: { source: 'not_integrated', openCount: null },
      transcript_suggestion: { source: 'not_integrated', openCount: null },
      import_problem: { source: 'not_integrated', openCount: null },
      adapter_failure: { source: 'not_integrated', openCount: null },
    },
  })), resolve: forbidden('review.resolve') },
  friday: { getCurrent: read<Awaited<ReturnType<CalliePreloadApi['friday']['getCurrent']>>>('friday.getCurrent', () => ({ periodStartsAt: '2026-09-07T00:00:00.000Z', periodEndsAt: '2026-09-14T00:00:00.000Z', asOf: fixtureNow, metrics: [], sourceRows: [], jobs: [], revision: 1 })), getDrilldown: forbidden('friday.getDrilldown'), createJob: forbidden('friday.createJob'), fillJob: forbidden('friday.fillJob'), cancelJob: forbidden('friday.cancelJob') },
  imports: { preview: forbidden('imports.preview'), remap: forbidden('imports.remap'), commit: forbidden('imports.commit'), status: forbidden('imports.status') },
  conversations: { list: read<Awaited<ReturnType<CalliePreloadApi['conversations']['list']>>>('conversations.list', () => ({ rows: [], nextCursor: null, total: 0, revision: 1 })), get: forbidden('conversations.get'), attachTranscript: forbidden('conversations.attachTranscript') },
  learnings: { list: read<Awaited<ReturnType<CalliePreloadApi['learnings']['list']>>>('learnings.list', () => ({ rows: [], totalActiveCount: 0, revision: 1 })), capture: forbidden('learnings.capture'), addEvidence: forbidden('learnings.addEvidence'), updateStatus: forbidden('learnings.updateStatus') },
  sourcing: { pollNow: forbidden('sourcing.pollNow'), retry: forbidden('sourcing.retry'), status: read<Awaited<ReturnType<CalliePreloadApi['sourcing']['status']>>>('sourcing.status', () => ({ lastPolledAt: null, lastKey: null, backlogCount: null, counters: { imported: 0, replayed: 0, needsIdentity: 0, scoreUpdates: 0, quarantined: 0 }, credentialState: 'none', hmacSaltState: 'none', execution: healthValue.sourcing.state, health: healthValue.sourcing })), setHmacSalt: forbidden('sourcing.setHmacSalt') },
  shell: { revealDatabase: forbidden('shell.revealDatabase'), revealLogDirectory: forbidden('shell.revealLogDirectory') },
  recovery: { status: read<Awaited<ReturnType<CalliePreloadApi['recovery']['status']>>>('recovery.status', () => ({ setupCompletedAt: null, lastRestoreDrillAt: null, outreachReady: false, backup: { status: 'missing', createdAt: null, verifiedAt: null } })), beginSetup: forbidden('recovery.beginSetup'), saveSetupMaterial: forbidden('recovery.saveSetupMaterial'), completeSetup: forbidden('recovery.completeSetup'), selectAndRunRestoreDrill: forbidden('recovery.selectAndRunRestoreDrill') },
  appleSpike: { getStatus: read('appleSpike.getStatus', () => appleSpikeStatusSchema.parse({ enabled: false, bridge: { state: 'disabled', reason: 'not_packaged_or_configured' } })), probeCapabilities: forbidden('appleSpike.probeCapabilities'), requestContacts: forbidden('appleSpike.requestContacts'), promptAccessibility: forbidden('appleSpike.promptAccessibility'), scanRecentNotes: forbidden('appleSpike.scanRecentNotes'), scanTestMessages: forbidden('appleSpike.scanTestMessages'), startCallObservation: forbidden('appleSpike.startCallObservation'), stopCallObservation: forbidden('appleSpike.stopCallObservation'), sendTestMessage: forbidden('appleSpike.sendTestMessage'), subscribeObservationEvidence: forbidden('appleSpike.subscribeObservationEvidence') },
};


const pendingDetails: ((value: LeadDetail) => void)[] = [];
// Observation only. Sample rendered frames during navigation, not just after a
// heading has settled, and remember any transient replacement of the root.
function sampleFrame(root: Element | null) {
  const currentRoot = document.querySelector('.presentation-root');
  const rail = document.querySelector('.nav-rail');
  const workspace = document.querySelector('.app-shell__workspace');
  const style = currentRoot ? getComputedStyle(currentRoot) : null;
  return {
    sameRoot: currentRoot === root && root?.isConnected === true,
    rootCount: document.querySelectorAll('.presentation-root[data-presentation="native-a"]').length,
    font: style?.fontFamily ?? null, color: style?.color ?? null,
    theme: document.documentElement.dataset.theme, density: document.documentElement.dataset.density,
    canvas: workspace ? getComputedStyle(workspace).backgroundColor : null,
    rail: rail ? getComputedStyle(rail).backgroundColor : null,
    railWidth: rail?.getBoundingClientRect().width ?? null,
    brands: [...document.querySelectorAll('.nav-rail__brand-native')].filter(element => element.getClientRects().length > 0).map(element => element.textContent?.trim()),
    legacyBrands: [...document.querySelectorAll('.nav-rail__brand')].filter(element => element.getClientRects().length > 0).length,
  };
}
let frameRequest = 0;
let frameObserver: MutationObserver | null = null;
let frames: ReturnType<typeof sampleFrame>[] = [];
let rootReplaced = false;
const scenarioParams = new URLSearchParams(location.search);
if (scenarioParams.get('modalScenario') === '1' && scenarioParams.get('leadsScenario') === '1') {
  throw Error('Application scenarios are mutually exclusive');
}
const modalScenario = scenarioParams.get('modalScenario') === '1'
  ? installApplicationModalScenario(api, calls, detail) : undefined;
const leadsScenario = scenarioParams.get('leadsScenario') === '1'
  ? installApplicationLeadsScenario(api, calls, detail) : undefined;
if (leadsScenario) {
  window.callie = leadsScenario.api;
} else {
  window.callie = modalScenario?.api ?? api;
}
const controls = {
  ...(modalScenario ? { modal: modalScenario.controller } : {}),
  ...(leadsScenario ? { leads: leadsScenario.controller } : {}),
  calls,
  setMode(mode: typeof localMode) { localMode = mode; window.dispatchEvent(new Event('focus')); },
  setDetailMode(mode: typeof detailMode) { detailMode = mode; },
  resolvePendingDetails() { for (const resolve of pendingDetails.splice(0)) resolve(structuredClone(detail)); },
  startPresentationFrames() {
    cancelAnimationFrame(frameRequest);
    frameObserver?.disconnect();
    const root = document.querySelector('.presentation-root');
    rootReplaced = false;
    frames = [sampleFrame(root)];
    frameObserver = new MutationObserver(records => {
      if (!root?.isConnected || records.some(record => [...record.removedNodes].some(node => node === root || node.contains(root)))) rootReplaced = true;
    });
    frameObserver.observe(document.getElementById('root')!, { childList: true, subtree: true });
    const record = () => {
      frames.push(sampleFrame(root));
      if (frames.length < 1000) frameRequest = requestAnimationFrame(record);
    };
    frameRequest = requestAnimationFrame(record);
  },
  stopPresentationFrames() {
    cancelAnimationFrame(frameRequest);
    frameObserver?.disconnect();
    frameObserver = null;
    return { frames: structuredClone(frames), rootReplaced };
  },
  frame: () => new Promise<void>(resolve => requestAnimationFrame(() => resolve())),
};
export type ApplicationPresentationBrowser = typeof controls;
declare global { interface Window { applicationPresentation: ApplicationPresentationBrowser } }
window.applicationPresentation = controls;
document.body.dataset.platform = 'darwin';
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);

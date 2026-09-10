/** Actual-App, synthetic no-IO startup fixture. No preload/client or production API factory. */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../../src/renderer/App';
import type { CalliePreloadApi } from '../../src/shared/preload';
import type { AppHealth } from '../../src/shared/healthContract';
import type { TodaySnapshot } from '../../src/shared/contracts/todayContract';
import type { DiscoverySnapshot } from '../../src/shared/contracts/discoveryContract';
import { outboundCapabilitiesSchema, type OutboundCapabilities } from '../../src/shared/contracts/outboundContract';
import type { DailySnapshot } from '../../src/shared/contracts/dailyContract';
import { nativeDeskFixture, nativeDeskReviewFixture, localSnapshot, commitments, fixtureNow } from '../../src/renderer/features/today/nativeDesk.fixture';
import '../../src/renderer/app.css';

export type Call = { method: string; kind: 'read' | 'forbidden' };
const calls: Call[] = [];
const forbidden = (method: string) => async (): Promise<never> => {
  calls.push({ method, kind: 'forbidden' });
  throw Error(`Startup fixture forbids ${method}`);
};
function controlled<T>(method: string) {
  const pending: { resolve(value: T): void; reject(error: Error): void }[] = [];
  return {
    read: (): Promise<T> => {
      calls.push({ method, kind: 'read' });
      return new Promise<T>((resolve, reject) => pending.push({ resolve, reject }));
    },
    resolve(value: T) { pending.splice(0).forEach(request => request.resolve(structuredClone(value))); },
    reject() { pending.splice(0).forEach(request => request.reject(Error('Synthetic private failure, never display this'))); },
    count: () => pending.length,
  };
}
const health = controlled<AppHealth>('health.get');
const daily = controlled<DailySnapshot>('daily.get');
const delegation = controlled<Awaited<ReturnType<CalliePreloadApi['delegation']['status']>>>('delegation.status');
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
let localMode: 'meeting_first' | 'legacy' = 'meeting_first';
const read = <T,>(method: string, value: () => T) => async (): Promise<T> => {
  calls.push({ method, kind: 'read' });
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
const api: CalliePreloadApi = {
  health: { get: health.read },
  daily: { get: daily.read },
  localWorkspace: {
    reviewCompany: forbidden('localWorkspace.reviewCompany'),
    createCompany: forbidden('localWorkspace.createCompany'),
    getCompanyCreateStatus: forbidden('localWorkspace.getCompanyCreateStatus'),
    get: read('localWorkspace.get', () => localSnapshot({ workflowMode: localMode })),
    getCompany: forbidden('localWorkspace.getCompany'),
    researchCompany: forbidden('localWorkspace.researchCompany'),
    getCompanyResearchStatus: forbidden('localWorkspace.getCompanyResearchStatus'),
    linkCompanyPerson: forbidden('localWorkspace.linkCompanyPerson'),
    getCommitments: read('localWorkspace.getCommitments', () => commitments()),
    transition: forbidden('localWorkspace.transition'),
  },
  delegation: {
    status: delegation.read,
    policyImport: { selectAndPreview: forbidden('policyImport.selectAndPreview'), confirm: forbidden('policyImport.confirm'), resume: forbidden('policyImport.resume'), status: forbidden('policyImport.status') },
    prepareRequestedFollowup: forbidden('delegation.prepareRequestedFollowup'), getRequestedFollowup: forbidden('delegation.getRequestedFollowup'),
    editRequestedFollowup: forbidden('delegation.editRequestedFollowup'), approveRequestedFollowup: forbidden('delegation.approveRequestedFollowup'),
    beginPhone: forbidden('delegation.beginPhone'), bootstrap: forbidden('delegation.bootstrap'),
    configurePolicy: forbidden('delegation.configurePolicy'), configureResearch: forbidden('delegation.configureResearch'),
    pair: forbidden('delegation.pair'), configure: forbidden('delegation.configure'), submit: forbidden('delegation.submit'), sync: forbidden('delegation.sync'),
  },
  linkedin: { prepare: forbidden('linkedin.prepare'), get: forbidden('linkedin.get'), recover: forbidden('linkedin.recover'), save: forbidden('linkedin.save'), begin: forbidden('linkedin.begin'), open: forbidden('linkedin.open'), copy: forbidden('linkedin.copy'), reportOutcome: forbidden('linkedin.reportOutcome') },
  phoneSetup: { status: forbidden('phoneSetup.status'), confirm: forbidden('phoneSetup.confirm'), clear: forbidden('phoneSetup.clear') },
  outreach: { status: forbidden('outreach.status'), connectGmail: forbidden('outreach.connectGmail'), disconnectGmail: forbidden('outreach.disconnectGmail'), configure: forbidden('outreach.configure'), openDraft: forbidden('outreach.openDraft'), saveDraft: forbidden('outreach.saveDraft'), generateDraft: forbidden('outreach.generateDraft'), sendDraft: forbidden('outreach.sendDraft'), inspectLocalAuthority: forbidden('outreach.inspectLocalAuthority') },
  leads: { list: forbidden('leads.list'), updateField: forbidden('leads.updateField'), bulkUpdate: forbidden('leads.bulkUpdate') },
  leadDetail: { get: forbidden('leadDetail.get'), beginOutbound: forbidden('leadDetail.beginOutbound'), getOutboundCapabilities: read('leadDetail.getOutboundCapabilities', () => outboundCapabilities), confirmTransition: forbidden('leadDetail.confirmTransition'), dismissLead: forbidden('leadDetail.dismissLead'), overrideCloudScore: forbidden('leadDetail.overrideCloudScore'), findContactInfo: forbidden('leadDetail.findContactInfo') },
  today: {
    get: read<TodaySnapshot>('today.get', () => ({ lanes: [], dialBudget: 0, scheduledDials: 0, conversationTarget: 0, reviewErrorCount: 0, revision: 1, unreviewedBacklogCount: 0, unreviewedCloudSignalCount: 0, conversationsHeld: 0 })),
    getLeadTriageSnapshot: forbidden('today.getLeadTriageSnapshot'), complete: forbidden('today.complete'), snooze: forbidden('today.snooze'), pin: forbidden('today.pin'), logPastActivity: forbidden('today.logPastActivity'), addLeadNote: forbidden('today.addLeadNote'), logCallOutcome: forbidden('today.logCallOutcome'), markActivityInError: forbidden('today.markActivityInError'), getTriageQueue: forbidden('today.getTriageQueue'), setReviewPosition: forbidden('today.setReviewPosition'),
  },
  discovery: {
    get: read<DiscoverySnapshot>('discovery.get', () => ({ prepared: [], judgment: [], counts: { unassessed: 0, research: 0, watch: 0, excluded: 0 }, processing: 'idle' as const, researchCapability: 'not_configured' as const, generatedAt: fixtureNow, revision: 1 })),
    getBrief: forbidden('discovery.getBrief'), begin: forbidden('discovery.begin'), override: forbidden('discovery.override'),
  },
  pipeline: { get: forbidden('pipeline.get') },
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
  friday: { getCurrent: forbidden('friday.getCurrent'), getDrilldown: forbidden('friday.getDrilldown'), createJob: forbidden('friday.createJob'), fillJob: forbidden('friday.fillJob'), cancelJob: forbidden('friday.cancelJob') },
  imports: { preview: forbidden('imports.preview'), remap: forbidden('imports.remap'), commit: forbidden('imports.commit'), status: forbidden('imports.status') },
  conversations: { list: forbidden('conversations.list'), get: forbidden('conversations.get'), attachTranscript: forbidden('conversations.attachTranscript') },
  learnings: { list: forbidden('learnings.list'), capture: forbidden('learnings.capture'), addEvidence: forbidden('learnings.addEvidence'), updateStatus: forbidden('learnings.updateStatus') },
  sourcing: { pollNow: forbidden('sourcing.pollNow'), retry: forbidden('sourcing.retry'), status: forbidden('sourcing.status'), setHmacSalt: forbidden('sourcing.setHmacSalt') },
  shell: { revealDatabase: forbidden('shell.revealDatabase'), revealLogDirectory: forbidden('shell.revealLogDirectory') },
  recovery: { status: forbidden('recovery.status'), beginSetup: forbidden('recovery.beginSetup'), saveSetupMaterial: forbidden('recovery.saveSetupMaterial'), completeSetup: forbidden('recovery.completeSetup'), selectAndRunRestoreDrill: forbidden('recovery.selectAndRunRestoreDrill') },
  appleSpike: { getStatus: forbidden('appleSpike.getStatus'), probeCapabilities: forbidden('appleSpike.probeCapabilities'), requestContacts: forbidden('appleSpike.requestContacts'), promptAccessibility: forbidden('appleSpike.promptAccessibility'), scanRecentNotes: forbidden('appleSpike.scanRecentNotes'), scanTestMessages: forbidden('appleSpike.scanTestMessages'), startCallObservation: forbidden('appleSpike.startCallObservation'), stopCallObservation: forbidden('appleSpike.stopCallObservation'), sendTestMessage: forbidden('appleSpike.sendTestMessage'), subscribeObservationEvidence: forbidden('appleSpike.subscribeObservationEvidence') },
};

export type AppearanceSample = {
  source: 'mutation' | 'frame'; phase: string; theme: string | null; density: string | null;
  presentation: string | null; workflow: string | null; background: string; color: string;
  font: string; corners: string[]; width: number; height: number; overflow: boolean;
  scrollHeight: number; viewportHeight: number;
  diagnosticStrip: { top: number; right: number; bottom: number; left: number; ownsCorners: boolean[] } | null;
  deskBounds: { top: number; right: number; bottom: number; left: number } | null;
};
const samples: AppearanceSample[] = [];
function paintedBackground(element: Element | null): string {
  for (let current = element; current; current = current.parentElement) {
    const color = getComputedStyle(current).backgroundColor;
    if (color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') return color;
  }
  return 'transparent';
}
function sample(source: AppearanceSample['source']) {
  const root = document.getElementById('root');
  if (!root?.firstElementChild) return;
  const scope = document.querySelector('.presentation-root') ?? root.firstElementChild;
  const deskElement = document.querySelector('.native-desk');
  const style = getComputedStyle(scope);
  const rect = scope.getBoundingClientRect();
  const deskRect = deskElement?.getBoundingClientRect();
  const phase = document.querySelector('.diagnostics') ? (document.querySelector('[role="alert"]') ? 'health-error' : 'health-pending')
    : document.querySelector('.today-route') ? 'legacy'
    : document.querySelector('[data-testid="native-desk"]') ? 'desk'
    : root.textContent?.includes('Daily workspace unavailable') ? 'daily-error'
    : root.textContent?.includes('Loading daily workspace') ? 'daily-pending' : 'informational';
  const points = [[1, 1], [innerWidth - 2, 1], [1, innerHeight - 2], [innerWidth - 2, innerHeight - 2]];
  const cornerElements = points.map(([x, y]) => document.elementFromPoint(x, y));
  const strip = document.querySelector('.foundation-frame--admitted > .foundation-observation');
  const stripRect = strip?.querySelector(':scope > .health-observation[aria-label="Diagnostic observation"]') ? strip.getBoundingClientRect() : null;
  samples.push({ source, phase, theme: document.documentElement.getAttribute('data-theme'), density: document.documentElement.getAttribute('data-density'),
    presentation: scope.getAttribute('data-presentation'), workflow: deskElement?.getAttribute('data-workflow-mode') ?? null,
    background: getComputedStyle(document.querySelector('.app-shell__workspace') ?? scope).backgroundColor,
    color: getComputedStyle(deskElement ?? scope).color, font: style.fontFamily,
    corners: cornerElements.map(paintedBackground),
    width: rect.width, height: rect.height, overflow: document.documentElement.scrollWidth > innerWidth,
    scrollHeight: document.documentElement.scrollHeight, viewportHeight: innerHeight,
    diagnosticStrip: stripRect ? { top: stripRect.top, right: stripRect.right, bottom: stripRect.bottom, left: stripRect.left, ownsCorners: cornerElements.map(element => strip!.contains(element)) } : null,
    deskBounds: deskRect ? { top: deskRect.top, right: deskRect.right, bottom: deskRect.bottom, left: deskRect.left } : null });
}
let frameQueued = false;
// Installed before render, so a bad first commit cannot disappear behind a ready locator.
const observer = new MutationObserver(() => {
  sample('mutation');
  if (!frameQueued) {
    frameQueued = true;
    requestAnimationFrame(() => { frameQueued = false; sample('frame'); });
  }
});
observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
window.callie = api;
window.startupPresentation = {
  calls, samples,
  pending: () => ({ health: health.count(), daily: daily.count(), delegation: delegation.count() }),
  resolveHealth: () => health.resolve(healthValue), rejectHealth: health.reject,
  rejectDaily: daily.reject,
  resolveDaily(mode: DailySnapshot['workflowMode']) { daily.resolve({ ...nativeDeskReviewFixture(), workflowMode: mode }); },
  async resolveDelegation() { delegation.resolve(await desk.api.delegation.status()); },
  setLocalMode(mode: typeof localMode) { localMode = mode; },
  refresh: () => window.dispatchEvent(new Event('focus')),
  frame: () => new Promise<void>(resolve => requestAnimationFrame(() => { sample('frame'); resolve(); })),
};
export type StartupPresentationBrowser = typeof window.startupPresentation;
declare global {
  interface Window {
    startupPresentation: {
      calls: Call[]; samples: AppearanceSample[];
      pending(): { health: number; daily: number; delegation: number };
      resolveHealth(): void; rejectHealth(): void; rejectDaily(): void;
      resolveDaily(mode: DailySnapshot['workflowMode']): void; resolveDelegation(): Promise<void>;
      setLocalMode(mode: 'meeting_first' | 'legacy'): void; refresh(): void; frame(): Promise<void>;
    };
  }
}
document.body.dataset.platform = 'darwin';
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);

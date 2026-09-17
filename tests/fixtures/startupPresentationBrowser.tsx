/** Actual-App, synthetic no-IO startup fixture. No preload/client or production API factory. */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../../src/renderer/App';
import type { CalliePreloadApi } from '../../src/shared/preload';
import type { AppHealth } from '../../src/shared/healthContract';
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
  domainStartupEvaluatedAt: fixtureNow,
};
const desk = nativeDeskFixture(nativeDeskReviewFixture());
let localMode: 'meeting_first' | 'legacy' = 'meeting_first';
const read = <T,>(method: string, value: () => T) => async (): Promise<T> => {
  calls.push({ method, kind: 'read' });
  return structuredClone(value());
};
// Every bridge member is explicit and checked. Even synthetic command mutations
// from nativeDeskFixture are NOT exposed. Any accidental command is logged/fails.
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
    prepareCompanyDraft: async () => { throw Error('Company preparation unavailable in this fixture'); }, admitCompanyDraftEmail: async () => { throw Error('Company drafts unavailable in this fixture'); }, openCompanyDraft: async () => { throw Error('Company drafts unavailable in this fixture'); }, getCompanyDraft: async () => { throw Error('Company drafts unavailable in this fixture'); }, saveCompanyDraft: async () => { throw Error('Company drafts unavailable in this fixture'); }, getCompanyResearchSettings: async () => { throw Error('Local research setup unavailable in this fixture'); }, updateCompanyResearchSettings: async () => { throw Error('Local research setup unavailable in this fixture'); }, getCallSettings: async () => { throw Error('Call capacity unavailable in this fixture'); }, updateCallSettings: async () => { throw Error('Call capacity unavailable in this fixture'); }, linkCompanyPerson: forbidden('localWorkspace.linkCompanyPerson'),
    getCommitments: read('localWorkspace.getCommitments', () => commitments()),
    transition: forbidden('localWorkspace.transition'),
  },
  delegation: {
    getAccountPreparation: forbidden('delegation.getAccountPreparation'),
    status: delegation.read,
    policyImport: { selectAndPreview: forbidden('policyImport.selectAndPreview'), confirm: forbidden('policyImport.confirm'), resume: forbidden('policyImport.resume'), status: forbidden('policyImport.status') },
    prepareRequestedFollowup: forbidden('delegation.prepareRequestedFollowup'), getRequestedFollowup: forbidden('delegation.getRequestedFollowup'),
    editRequestedFollowup: forbidden('delegation.editRequestedFollowup'), approveRequestedFollowup: forbidden('delegation.approveRequestedFollowup'),
    reconcileReplyDraft: forbidden('delegation.reconcileReplyDraft'), editReplyDraft: forbidden('delegation.editReplyDraft'), getPhoneHandoffState: forbidden('delegation.getPhoneHandoffState'), beginPhone: forbidden('delegation.beginPhone'), bootstrap: forbidden('delegation.bootstrap'),
    configurePolicy: forbidden('delegation.configurePolicy'), configureResearch: forbidden('delegation.configureResearch'),
    pair: forbidden('delegation.pair'), configure: forbidden('delegation.configure'), submit: forbidden('delegation.submit'), sync: forbidden('delegation.sync'),
  },
  linkedin: { prepare: forbidden('linkedin.prepare'), get: forbidden('linkedin.get'), recover: forbidden('linkedin.recover'), save: forbidden('linkedin.save'), begin: forbidden('linkedin.begin'), open: forbidden('linkedin.open'), copy: forbidden('linkedin.copy'), reportOutcome: forbidden('linkedin.reportOutcome') },
  phoneSetup: { status: forbidden('phoneSetup.status'), confirm: forbidden('phoneSetup.confirm'), clear: forbidden('phoneSetup.clear') },
  outreach: { status: forbidden('outreach.status'), connectGmail: forbidden('outreach.connectGmail'), disconnectGmail: forbidden('outreach.disconnectGmail'), configure: forbidden('outreach.configure'), openDraft: forbidden('outreach.openDraft'), saveDraft: forbidden('outreach.saveDraft'), generateDraft: forbidden('outreach.generateDraft'), sendDraft: forbidden('outreach.sendDraft'), inspectLocalAuthority: forbidden('outreach.inspectLocalAuthority') },
  leads: { list: forbidden('leads.list') },
  leadDetail: { get: forbidden('leadDetail.get') },
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
// The removed legacy queue never renders; a confirmed legacy workflow is an explicit hold on the desk route.
const legacyHold = 'Legacy workflow is active.';
function sample(source: AppearanceSample['source']) {
  const root = document.getElementById('root');
  if (!root?.firstElementChild) return;
  const scope = document.querySelector('.presentation-root') ?? root.firstElementChild;
  const deskElement = document.querySelector('.native-desk');
  const style = getComputedStyle(scope);
  const rect = scope.getBoundingClientRect();
  const deskRect = deskElement?.getBoundingClientRect();
  const phase = document.querySelector('.diagnostics') ? (document.querySelector('[role="alert"]') ? 'health-error' : 'health-pending')
    : root.textContent?.includes(legacyHold) ? 'legacy'
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

import { googleGrantDisclosure, googleScopes, personalGoogleGrantDisclosure } from '../../src/shared/contracts/googleGrantCapabilities';
import { googleConnectionSelectorSchema } from '../../src/shared/contracts/remoteGoogleConnectionsContract';
import { researchSetupStatusSchema } from '../../src/shared/contracts/researchSetupContract';
/** Actual-App, complete typed read-only all-route fixture. No preload/client or production API factory. */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../../src/renderer/App';
import type { CalliePreloadApi } from '../../src/shared/preload';
import { appHealthSchema, type AppHealth } from '../../src/shared/healthContract';
import type { DailySnapshot } from '../../src/shared/contracts/dailyContract';
import { leadDetailRequestSchema, leadDetailSchema, type LeadDetail } from '../../src/shared/contracts/leadDetailContract';
import { leadRowSchema } from '../../src/shared/contracts/leadsContract';
import { appleSpikeStatusSchema } from '../../src/shared/appleSpikeContract';
import { nativeDeskFixture, nativeDeskReviewFixture, localSnapshot, commitments, fixtureNow } from '../../src/renderer/features/today/nativeDesk.fixture';
import '../../src/renderer/app.css';

export type Call = { method: string; kind: 'read' | 'forbidden'; args?: unknown[] };
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
  domainStartupEvaluatedAt: fixtureNow,
};
const desk = nativeDeskFixture(nativeDeskReviewFixture());
let localMode: 'meeting_first' | 'legacy' = new URLSearchParams(location.search).get('mode') === 'legacy' ? 'legacy' : 'meeting_first';
let connectionStatusUnavailable = false;
let googleConnectionReady = false;
const read = <T,>(method: string, value: () => T) => async (...args: unknown[]): Promise<T> => {
  calls.push({ method, kind: 'read', args: structuredClone(args) });
  return structuredClone(value());
};
// Every bridge member is explicit and checked. Even synthetic command mutations
// from nativeDeskFixture are NOT exposed. Any accidental command is logged/fails.
// The saved-person reads survive only for the company contact link; they return one synthetic person.
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
const fixtureHealth = { get: read('health.get', () => healthValue) };
const api: CalliePreloadApi = {
  health: fixtureHealth,
  daily: { get: read<DailySnapshot>('daily.get', () => ({ ...nativeDeskReviewFixture(), workflowMode: localMode })) },
  localWorkspace: {
    reviewCompany: forbidden('localWorkspace.reviewCompany'),
    createCompany: forbidden('localWorkspace.createCompany'),
    getCompanyCreateStatus: forbidden('localWorkspace.getCompanyCreateStatus'),
    get: read('localWorkspace.get', () => localSnapshot({ workflowMode: localMode })),
    getCompany: forbidden('localWorkspace.getCompany'),
    researchCompany: forbidden('localWorkspace.researchCompany'),
    getCompanyResearchStatus: forbidden('localWorkspace.getCompanyResearchStatus'),
    prepareCompanyDraft: async () => { throw Error('Company preparation unavailable in this fixture'); }, admitCompanyDraftEmail: async () => { throw Error('Company drafts unavailable in this fixture'); }, openCompanyDraft: async () => { throw Error('Company drafts unavailable in this fixture'); }, getCompanyDraft: async () => { throw Error('Company drafts unavailable in this fixture'); }, saveCompanyDraft: async () => { throw Error('Company drafts unavailable in this fixture'); }, getCompanyResearchSettings: read<Awaited<ReturnType<CalliePreloadApi['localWorkspace']['getCompanyResearchSettings']>>>('localWorkspace.getCompanyResearchSettings', () => {
      if (!new URLSearchParams(location.search).has('localResearchScenario')) throw Error('Local research setup unavailable in this fixture');
      // Fictional reviewed profile for rendering only. This fixture forbids saves and research.
      return { revision: 0, configuration: null, blockedReason: null, reservedOrSpentMicros: 0, profiles: [{
        id: 'browser-reviewed-profile', label: 'Fictional bounded request profile', reviewedAt: '2026-09-15', referenceUrl: 'https://example.invalid/profile',
        researchLimits: { maxCompanies: 1, maxPages: 1, maxBytes: 250000, maxCostMicros: 20000,
          knownCompanyExtraction: { version: 1, model: 'fictional-reviewed-model', maxInputBytes: 20000, maxOutputTokens: 2048, maxCostMicros: 20000, inputMicrosPerMillionTokens: 400000, outputMicrosPerMillionTokens: 1600000 } },
      }] };
    }), updateCompanyResearchSettings: forbidden('localWorkspace.updateCompanyResearchSettings'), getCallSettings: async () => { throw Error('Call capacity unavailable in this fixture'); }, updateCallSettings: async () => { throw Error('Call capacity unavailable in this fixture'); }, linkCompanyPerson: forbidden('localWorkspace.linkCompanyPerson'),
    getCommitments: read('localWorkspace.getCommitments', () => commitments()),
    transition: forbidden('localWorkspace.transition'),
  },
  delegation: {
    getAccountPreparation: forbidden('delegation.getAccountPreparation'),
    ...(new URLSearchParams(location.search).has('researchScenario') ? { researchSetup: {
      status: read('researchSetup.status', () => researchSetupStatusSchema.parse({ pending: null, blockers: [], remote: {
        workspaceId: 'fictional-research', pairingId: '12345678-1234-4234-8234-123456789012', selector: null,
        discoveryLedger: null, researchLedger: null, descriptorFingerprint: 'a'.repeat(64), credentialParameterDeclared: true,
        blockers: [], checkedAt: new Date().toISOString(), receipt: null,
        descriptor: { capability: { model: `fictional-${'model'.repeat(30)}`, webSearch: true, searchCostMicros: 40, modelCostMicros: 40 },
          reviewedAt: new Date(Date.now() - 3600000).toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(),
          provenance: `Fictional operator assertion ${'long-provenance'.repeat(20)}`, researchReservationMicros: 100, currency: 'USD' },
      } })),
      approve: forbidden('researchSetup.approve'), setState: forbidden('researchSetup.setState'),
      retry: forbidden('researchSetup.retry'), cancelPending: forbidden('researchSetup.cancelPending'),
    } } : {}),
    googleConnections: {
      status: async (input): Promise<import('../../src/shared/contracts/remoteGoogleGrantContract').RemoteGoogleGrantStatus> => { const request = googleConnectionSelectorSchema.parse(input); calls.push({ method: 'googleConnections.status', kind: 'read', args: [request] });
        if (!googleConnectionReady || request.purpose !== 'personal_availability') return { state: 'unconfigured' as const, grant: null };
        return { state: 'ready' as const, grant: { provider: 'google' as const, owner: 'remote' as const, purpose: 'personal_availability' as const, subject: 'fixture-personal', email: 'founder@gmail.com', grantedScopes: ['openid', 'email', googleScopes.availability], capabilities: ['availability' as const], availabilityCalendars: { calendarIds: [`calendar@${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.example.test`], confirmed: true as const } } };
      },
      disclosure: async input => { const request = googleConnectionSelectorSchema.parse(input); calls.push({ method: 'googleConnections.disclosure', kind: 'read', args: [request] }); return structuredClone(request.purpose === 'personal_availability' ? personalGoogleGrantDisclosure : googleGrantDisclosure); },
      begin: forbidden('googleConnections.begin'), revoke: forbidden('googleConnections.revoke'),
    },
    status: async () => { calls.push({ method: 'delegation.status', kind: 'read' }); return desk.api.delegation.status(); },
    policyImport: { selectAndPreview: forbidden('policyImport.selectAndPreview'), confirm: forbidden('policyImport.confirm'), resume: forbidden('policyImport.resume'), status: forbidden('policyImport.status') },
    prepareRequestedFollowup: forbidden('delegation.prepareRequestedFollowup'), getRequestedFollowup: forbidden('delegation.getRequestedFollowup'),
    editRequestedFollowup: forbidden('delegation.editRequestedFollowup'), approveRequestedFollowup: forbidden('delegation.approveRequestedFollowup'),
    reconcileReplyDraft: forbidden('delegation.reconcileReplyDraft'), editReplyDraft: forbidden('delegation.editReplyDraft'), getPhoneHandoffState: forbidden('delegation.getPhoneHandoffState'), beginPhone: forbidden('delegation.beginPhone'), bootstrap: forbidden('delegation.bootstrap'),
    configurePolicy: forbidden('delegation.configurePolicy'), configureResearch: forbidden('delegation.configureResearch'),
    pair: forbidden('delegation.pair'), pairing: read<null>('delegation.pairing', (): null => null), rotatePairing: forbidden('delegation.rotatePairing'), configure: forbidden('delegation.configure'), submit: forbidden('delegation.submit'), sync: forbidden('delegation.sync'),
    admitReplyFirstDraft: forbidden('delegation.admitReplyFirstDraft'), approveReply: forbidden('delegation.approveReply'), submitApprovedReply: forbidden('delegation.submitApprovedReply'),
    // Settings → Suppressed reads locally. The fixture answers with a real empty list so the section renders without any network.
    readSuppression: async () => ({ entries: [], truncated: false, generatedAt: '2026-09-18T12:00:00.000Z' }),
  },
  phoneSetup: { status: forbidden('phoneSetup.status'), confirm: forbidden('phoneSetup.confirm'), clear: forbidden('phoneSetup.clear') },
  outreach: { status: read<Awaited<ReturnType<CalliePreloadApi['outreach']['status']>>>('outreach.status', () => {
    if (connectionStatusUnavailable) throw Error('Synthetic private connection failure');
    return { model: 'unconfigured', modelName: '', gmail: 'unconfigured', accountEmail: null, senderName: '', postalAddress: '' };
  }), connectGmail: forbidden('outreach.connectGmail'), disconnectGmail: forbidden('outreach.disconnectGmail'), configure: forbidden('outreach.configure'), openDraft: forbidden('outreach.openDraft'), saveDraft: forbidden('outreach.saveDraft'), generateDraft: forbidden('outreach.generateDraft'), sendDraft: forbidden('outreach.sendDraft'), inspectLocalAuthority: forbidden('outreach.inspectLocalAuthority') },
  leads: { list: read<Awaited<ReturnType<CalliePreloadApi['leads']['list']>>>('leads.list', () => ({ rows: [row], nextCursor: null, total: 1, revision: 1 })) },
  leadDetail: { get: async (input) => {
    calls.push({ method: 'leadDetail.get', kind: 'read', args: [structuredClone(input)] });
    if (leadDetailRequestSchema.parse(input).personId !== detail.personId) throw Error('Unknown synthetic person');
    return structuredClone(detail);
  } },
  shell: { revealDatabase: forbidden('shell.revealDatabase'), revealLogDirectory: forbidden('shell.revealLogDirectory') },
  recovery: { status: read<Awaited<ReturnType<CalliePreloadApi['recovery']['status']>>>('recovery.status', () => ({ setupCompletedAt: null, lastRestoreDrillAt: null, outreachReady: false, backup: { status: 'missing', createdAt: null, verifiedAt: null } })), beginSetup: forbidden('recovery.beginSetup'), saveSetupMaterial: forbidden('recovery.saveSetupMaterial'), completeSetup: forbidden('recovery.completeSetup'), selectAndRunRestoreDrill: forbidden('recovery.selectAndRunRestoreDrill') },
  appleSpike: { getStatus: read('appleSpike.getStatus', () => appleSpikeStatusSchema.parse({ enabled: false, bridge: { state: 'disabled', reason: 'not_packaged_or_configured' } })), probeCapabilities: forbidden('appleSpike.probeCapabilities'), requestContacts: forbidden('appleSpike.requestContacts'), promptAccessibility: forbidden('appleSpike.promptAccessibility'), scanRecentNotes: forbidden('appleSpike.scanRecentNotes'), scanTestMessages: forbidden('appleSpike.scanTestMessages'), startCallObservation: forbidden('appleSpike.startCallObservation'), stopCallObservation: forbidden('appleSpike.stopCallObservation'), sendTestMessage: forbidden('appleSpike.sendTestMessage'), subscribeObservationEvidence: forbidden('appleSpike.subscribeObservationEvidence') },
};

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
// Opt-in, finite delivery control for the actual App. Default fixtures are unchanged.
const healthScenario = scenarioParams.get('healthScenario') === '1' ? (() => {
  type Slot = { phase: 'armed' | 'reading' | 'pending'; value?: AppHealth;
    resolve?: (health: AppHealth) => void; reject?: (error: Error) => void };
  let delivery: Slot | null = null;
  const originalGet = fixtureHealth.get;
  fixtureHealth.get = async () => {
    const slot = delivery?.phase === 'armed' ? delivery : null;
    if (slot) slot.phase = 'reading';
    const value = await originalGet();
    if (!slot) return value;
    return new Promise<AppHealth>((resolve, reject) => {
      slot.value = value; slot.resolve = resolve; slot.reject = reject; slot.phase = 'pending';
    });
  };
  return {
    arm() {
      if (delivery !== null) throw Error('Health delivery already owned');
      delivery = { phase: 'armed' };
    },
    phase() { return delivery?.phase ?? 'idle'; },
    settle(outcome: 'ready' | 'blocked' | 'rejected') {
      const slot = delivery;
      if (!slot || slot.phase !== 'pending' || !slot.value || !slot.resolve || !slot.reject) {
        throw Error('No pending health delivery');
      }
      delivery = null;
      if (outcome === 'rejected') slot.reject(new Error('Synthetic diagnostic delivery failure'));
      else slot.resolve(appHealthSchema.parse(outcome === 'blocked'
        ? { ...slot.value, domainReady: false, domainStatus: 'blocked', domainBlockingViolationCount: 1 }
        : slot.value));
    },
  };
})() : undefined;
window.callie = api;
const controls = {
  ...(healthScenario ? { health: healthScenario } : {}),
  calls,
  setGoogleConnectionReady(ready: boolean) { googleConnectionReady = ready; },
  setConnectionStatusUnavailable(unavailable: boolean) { connectionStatusUnavailable = unavailable; },
  setMode(mode: typeof localMode) { localMode = mode; window.dispatchEvent(new Event('focus')); },
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

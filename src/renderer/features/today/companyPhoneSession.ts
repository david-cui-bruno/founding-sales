import type { CalliePreloadApi } from '../../../shared/preload';
import type { DailySnapshot } from '../../../shared/contracts/dailyContract';
import { describeCallCampaignTemplate } from '../../../shared/contracts/callCampaignDraft';
import { delegatedPhoneStateReplySchema, type GetPhoneHandoffStateRequest, type PhoneHandoffState } from '../../../shared/contracts/delegatedPhoneStateContract';
import { manualCallOutcomes } from '../../../shared/contracts/accountOutboundContract';
import { delegatedPhoneHandoffRequestSchema, type DelegatedPhoneHandoffRequest } from '../../../shared/contracts/ownerCommandContract';
import type { DelegatedPhoneHandoffResult } from '../../../shared/contracts/delegationContract';
import type { LocalCompanyDetail } from '../../../shared/contracts/localWorkspaceContract';
import type { PhoneSetupStatus } from '../../../shared/contracts/phoneSetupContract';
import { sha256Utf8 } from '../../../shared/crypto/sha256';

export type CompanyPhoneApi = Pick<CalliePreloadApi, 'daily' | 'delegation'> & Partial<Pick<CalliePreloadApi, 'localWorkspace' | 'phoneSetup'>>;
export type PhoneConfig = Awaited<ReturnType<CompanyPhoneApi['delegation']['status']>>;
export type PhoneReport = Extract<Parameters<CompanyPhoneApi['delegation']['submit']>[0], { kind: 'complete-manual' }>;
export type CompletePhoneHistory = Extract<PhoneHandoffState, { completeness: 'complete' }>;
export type PhoneAttempt = CompletePhoneHistory['attempts'][number];
export type PhoneOutcome = Extract<PhoneReport['payload']['outcome'], { channel: 'call' }>['outcome'];
export const phoneOutcomes: PhoneOutcome[] = [...manualCallOutcomes];
/** Plain labels for the report form. Everything unnamed falls back to the sentence-cased enum value. */
const phoneOutcomeLabels: Readonly<Record<string, string>> = Object.freeze({
  connected: 'Connected',
  interested: 'Connected, interested',
  not_interested: 'Connected, not interested',
  gatekeeper: 'Gatekeeper, did not reach them',
  no_answer: 'No answer',
  voicemail: 'Voicemail',
  busy: 'Busy',
  wrong_number: 'Wrong number',
  cancelled: 'Cancelled before dialing',
  not_called: 'Not called',
  unknown: 'Unknown',
  opt_out: 'Explicit opt-out',
});
export function describePhoneOutcome(outcome: string): string {
  const named = phoneOutcomeLabels[outcome];
  if (named) return named;
  const words = outcome.replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
/**
 * `manual` is true exactly when the signed helper cannot dial from this Mac, which is the state in
 * which D6's hand-dialed path exists at all. It decides which of the two terminal controls the
 * review offers and whether the request carries `manual: true`. The saved setup is inside
 * `binding`, so a review prepared for one path can never be confirmed as the other.
 */
export type PhoneReview = { binding: string; request: DelegatedPhoneHandoffRequest; detail: LocalCompanyDetail; offer: string; target: string;
  manual: boolean; setupState: PhoneSetupStatus['state'] };
export type PhoneSession = {
  busy: boolean;
  begin: { request: DelegatedPhoneHandoffRequest; result: DelegatedPhoneHandoffResult | null } | null;
  reports: Map<string, PhoneReport>;
  listeners: Set<() => void>;
  bridge: { beginning: boolean };
};
// Memory only. Uncertain operations survive panel remount, but durable history is
// reconstructed by the existing read API after an application restart.
const retained = new WeakMap<CompanyPhoneApi['daily'], WeakMap<CompanyPhoneApi['delegation'], { entries: Map<string, PhoneSession> }>>();
// A replaced read adapter must not create a second in-flight native handoff latch.
const beginLatches = new WeakMap<CompanyPhoneApi['delegation'], { beginning: boolean }>();
export function companyPhoneSession(api: CompanyPhoneApi, workspaceId: string, selector: GetPhoneHandoffStateRequest): PhoneSession | null {
  let bridges = retained.get(api.daily);
  if (!bridges) retained.set(api.daily, bridges = new WeakMap());
  let bridge = bridges.get(api.delegation);
  if (!bridge) bridges.set(api.delegation, bridge = { entries: new Map() });
  let beginLatch = beginLatches.get(api.delegation);
  if (!beginLatch) beginLatches.set(api.delegation, beginLatch = { beginning: false });
  const key = JSON.stringify([workspaceId, selector.accountId, selector.enrollmentId, selector.stepId]);
  const existing = bridge.entries.get(key);
  if (existing) return existing;
  if (bridge.entries.size >= 32) {
    const idle = [...bridge.entries].find(([, entry]) => !entry.busy && !entry.begin && !entry.reports.size && !entry.listeners.size);
    if (!idle) return null;
    bridge.entries.delete(idle[0]);
  }
  const entry: PhoneSession = { busy: false, begin: null, reports: new Map(), listeners: new Set(), bridge: beginLatch };
  bridge.entries.set(key, entry);
  return entry;
}
export function notifyPhoneSession(session: PhoneSession) { session.listeners.forEach(listener => listener()); }
export function freezePhoneValue<T extends object>(value: T): T {
  Object.values(value).forEach(child => { if (child && typeof child === 'object') freezePhoneValue(child); });
  return Object.freeze(value);
}
export function phoneHistoryScope(snapshot: DailySnapshot, config: PhoneConfig | null, workspaceId: string): boolean {
  return snapshot.workspaceId === workspaceId && snapshot.workflowMode === 'meeting_first'
    && !snapshot.issues.some(issue => ['scope_unknown', 'scope_mismatch', 'invalid_local_record'].includes(issue.code))
    && config?.workspaceId === workspaceId && config.endpoint !== null && ['active', 'paused'].includes(config.state);
}
export function phoneSelection(snapshot: DailySnapshot, selector: GetPhoneHandoffStateRequest) {
  const matches = snapshot.campaigns.flatMap(campaign => campaign.enrollments
    .filter(enrollment => enrollment.id === selector.enrollmentId && enrollment.accountId === selector.accountId)
    .map(enrollment => ({ campaign, enrollment })));
  if (matches.length !== 1) throw Error('Selected phone enrollment is unavailable or ambiguous.');
  const { campaign, enrollment } = matches[0];
  const step = campaign.version.steps.find(candidate => candidate.id === selector.stepId && candidate.channel === 'call');
  if (!step || enrollment.campaignVersionId !== campaign.version.id) throw Error('Selected saved call step is unavailable.');
  return { campaign, enrollment, step };
}
export function parsePhoneHistory(raw: unknown, selector: GetPhoneHandoffStateRequest, snapshot: DailySnapshot, workspaceId: string): PhoneHandoffState {
  const history = delegatedPhoneStateReplySchema(selector).parse(raw);
  const { campaign } = phoneSelection(snapshot, selector);
  if (history.workspaceId !== workspaceId || history.campaign.campaignId !== campaign.version.campaignId
    || history.campaign.campaignRevision !== campaign.version.version || history.campaign.campaignVersionId !== campaign.version.id) {
    throw Error('Phone history workspace or campaign mismatch.');
  }
  return history;
}
export function phoneOwner(snapshot: DailySnapshot, accountId: string) {
  const owners = snapshot.ownerStatus.filter(owner => owner.accountId === accountId);
  const owner = owners.length === 1 ? owners[0] : undefined;
  if (!owner?.authority || owner.authority.accountId !== accountId || owner.authority.owner !== 'worker'
    || !['active', 'paused', 'revoked'].includes(owner.authority.state) || owner.executionVersion === null) {
    throw Error('Current local worker authority is unavailable.');
  }
  return owner;
}
export function phoneFreshBinding(snapshot: DailySnapshot, config: PhoneConfig, selector: GetPhoneHandoffStateRequest,
  detail: LocalCompanyDetail, setup: PhoneSetupStatus, history: PhoneHandoffState, workspaceId: string) {
  if (!phoneHistoryScope(snapshot, config, workspaceId) || snapshot.freshness.kind !== 'local_snapshot'
    || config.state !== 'active' || config.configuration?.configuration.state !== 'active') throw Error('Active matching local configuration is required for a new handoff.');
  const { campaign, enrollment, step } = phoneSelection(snapshot, selector);
  const template = describeCallCampaignTemplate(campaign.version);
  const account = snapshot.accounts.find(a => a.account.id === selector.accountId);
  const owner = phoneOwner(snapshot, selector.accountId);
  if (!account || !template || template.accountId !== selector.accountId || !campaign.version.approvedAt
    || Date.parse(campaign.version.approvedAt) > Date.now()) throw Error('An approved single-company initial call campaign is required.');
  if (owner.authority!.state !== 'active' || owner.pendingCommands.length) throw Error('Active settled worker authority is required for a new handoff.');
  if (enrollment.state !== 'active' || enrollment.personId !== null || enrollment.currentStepId !== step.id) throw Error('The selected company enrollment is not at its active call step.');
  const routes = account.routes.filter(route => route.id === enrollment.selectedRouteId);
  const route = routes.length === 1 ? routes[0] : undefined;
  if (!route || route.version !== enrollment.selectedRouteVersion || route.personId !== null || route.channel !== 'phone'
    // D2 (17 Sep 2026): a phone listed in a business directory counts, the same as a published or confirmed one.
    || route.purpose !== 'business' || !['published', 'confirmed', 'listed'].includes(route.verification) || !/^\+[1-9]\d{7,14}$/.test(route.value)) {
    throw Error('The exact selected company business phone route is unavailable.');
  }
  if (JSON.stringify(detail.snapshot) !== JSON.stringify(account) || !route.evidenceIds.length
    || !route.evidenceIds.every(id => detail.sources.some(source => source.id === id && source.permitted))) {
    throw Error('Matching permitted saved phone source evidence is unavailable.');
  }
  const caps = campaign.caps.filter(cap => cap.campaignVersionId === campaign.version.id && cap.channel === 'call');
  const cap = caps.length === 1 ? caps[0] : undefined;
  if (!cap || cap.reserved + cap.sent >= campaign.version.channelCaps.call) throw Error('A unique available saved call cap is required.');
  // D6 acceptance 2. Setup that is not `configured` used to refuse the review outright, which is
  // exactly when a hand-dialed call matters: David can see the number but Callie cannot dial it.
  // It now selects the hand-dialed path instead. Every other check above is unchanged, and `setup`
  // stays inside `binding` below, so a review prepared while configured cannot be confirmed as a
  // hand dial (or the reverse) without the final binding comparison refusing it.
  const manual = setup.state !== 'configured';
  if (history.completeness !== 'complete' || history.attempts.length) throw Error('Existing or incomplete phone history holds new handoffs. Do not redial.');
  return { account, campaign, enrollment, step, owner, route, manual, setupState: setup.state,
    binding: JSON.stringify({ account, version: campaign.version, snapshotHash: campaign.snapshotHash, enrollment, step, cap,
      owner: { authority: owner.authority, executionVersion: owner.executionVersion, pendingCommands: owner.pendingCommands },
      config, detail: { snapshot: detail.snapshot, sources: detail.sources, links: detail.links }, setup }) };
}
export function makePhoneReview(snapshot: DailySnapshot, config: PhoneConfig, selector: GetPhoneHandoffStateRequest,
  detail: LocalCompanyDetail, setup: PhoneSetupStatus, history: PhoneHandoffState, workspaceId: string): PhoneReview {
  const value = phoneFreshBinding(snapshot, config, selector, detail, setup, history, workspaceId);
  const { account, campaign, enrollment, step, owner, route } = value;
  const request = freezePhoneValue(delegatedPhoneHandoffRequestSchema.parse({ command: {
    commandId: crypto.randomUUID(), workspaceId, accountId: selector.accountId,
    expectedAuthorityGeneration: owner.authority!.generation, expectedVersion: owner.executionVersion,
    kind: 'prepare-manual', payload: { actionId: crypto.randomUUID(), channel: 'call', routeId: route.id, routeVersion: route.version,
      targetHash: sha256Utf8(route.value), contentHash: sha256Utf8(campaign.version.offer), contextRevision: enrollment.executionContextId,
      campaign: { campaignId: campaign.version.campaignId, campaignRevision: campaign.version.version, enrollmentId: enrollment.id,
        enrollmentRevision: enrollment.version, stepId: step.id } },
  }, expectedEvidenceFingerprint: account.fingerprint,
  // Only the literal true, and only when the helper cannot dial. The flag is a routing statement,
  // never a permission: the command, its evidence and every approval above are identical either way.
  ...(value.manual ? { manual: true as const } : {}) }));
  return { binding: value.binding, request, detail, offer: campaign.version.offer, target: route.value,
    manual: value.manual, setupState: value.setupState };
}
export function allowedPhoneReports(history: CompletePhoneHistory, attempt: PhoneAttempt): PhoneOutcome[] {
  if (!attempt.handoff || attempt.handoff.consumedAt === null) return [];
  const records = history.completions.filter(record => record.prepareCommandId === attempt.command.commandId);
  if (records.some(record => record.receipt.status === 'pending' || record.applied?.evidence.conflict)) return [];
  const applied = records.filter(record => record.applied !== null);
  if (applied.some(record => record.applied!.outcome.outcome === 'opt_out')) return [];
  if (records.some(record => record.receipt.status === 'rejected') || applied.some(record => record.applied!.outcome.outcome !== 'unknown')) return ['opt_out'];
  return phoneOutcomes;
}

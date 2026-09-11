import { useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { CalliePreloadApi } from '../../../shared/preload';
import { dailyCampaignSchema, dailySnapshotSchema, type DailySnapshot } from '../../../shared/contracts/dailyContract';
import { delegationSyncReportSchema, localDelegationStatusSchema } from '../../../shared/contracts/ownerCommandContract';
import { commandReceiptSchema } from '../../../shared/contracts/commandReceiptContract';
import type { AccountRoute } from '../../../shared/contracts/accountContract';
import { describeCallCampaignTemplate } from '../../../shared/contracts/callCampaignDraft';
import { captureDailySessionScope } from '../today/dailySessionScope';

type Api = Pick<CalliePreloadApi, 'daily' | 'delegation'>;
type LocalDelegationStatus = Awaited<ReturnType<Api['delegation']['status']>>;
type Campaign = DailySnapshot['campaigns'][number];
type Command = Extract<Parameters<Api['delegation']['submit']>[0], { kind: 'campaign-command' }>;
type Proof = { command: Command; campaign: Campaign; route: AccountRoute | null };
type ActionState = {
  busy: boolean;
  pending: Proof | null;
  completed: { proof: Proof; guard: string } | null;
  failed: boolean;
  listeners: Set<() => void>;
};
// Bounded per bridge pair. Never evict an uncertain command or a mounted form.
const retained = new WeakMap<Api['daily'], WeakMap<Api['delegation'], Map<string, ActionState>>>();
function actionState(api: Api, key: string): ActionState | null {
  let bridges = retained.get(api.daily);
  if (!bridges) retained.set(api.daily, bridges = new WeakMap());
  let actions = bridges.get(api.delegation);
  if (!actions) bridges.set(api.delegation, actions = new Map());
  const existing = actions.get(key);
  if (existing) return existing;
  if (actions.size >= 32) {
    const idle = [...actions].find(([, value]) => !value.pending && !value.busy && value.listeners.size === 0);
    if (!idle) return null;
    actions.delete(idle[0]);
  }
  const value: ActionState = { busy: false, pending: null, completed: null, failed: false, listeners: new Set() };
  actions.set(key, value);
  return value;
}
function notify(state: ActionState) { state.listeners.forEach(listener => listener()); }
function same(a: unknown, b: unknown) { return JSON.stringify(a) === JSON.stringify(b); }
function configured(snapshot: DailySnapshot, config: LocalDelegationStatus | null) {
  return snapshot.workspaceId !== null && snapshot.workflowMode === 'meeting_first'
    && !snapshot.issues.some(issue => ['scope_unknown', 'scope_mismatch', 'invalid_local_record'].includes(issue.code))
    && config?.workspaceId === snapshot.workspaceId && config.state === 'active'
    && config.endpoint !== null && config.configuration?.configuration.state === 'active';
}
function ownerFor(snapshot: DailySnapshot, accountId: string) {
  return snapshot.ownerStatus.find(owner => owner.accountId === accountId && owner.authority?.accountId === accountId
    && owner.authority.owner === 'worker' && owner.authority.state === 'active'
    && owner.executionVersion !== null && owner.pendingCommands.length === 0);
}
function duplicate(snapshot: DailySnapshot, accountId: string) {
  return snapshot.campaigns.some(c => c.enrollments.some(e => e.accountId === accountId
    && ['active', 'held', 'paused', 'conversation'].includes(e.state)));
}
function eligibleRoutes(routes: AccountRoute[]): AccountRoute[] {
  const latest = new Map<string, AccountRoute>();
  const ambiguous = new Set<string>();
  for (const route of routes) {
    const prior = latest.get(route.id);
    if (!prior || route.version > prior.version) { latest.set(route.id, route); ambiguous.delete(route.id); }
    else if (route.version === prior.version && !same(route, prior)) ambiguous.add(route.id);
  }
  return [...latest.values()].filter(route => !ambiguous.has(route.id) && route.channel === 'phone'
    && route.purpose === 'business' && ['published', 'confirmed'].includes(route.verification));
}
function projected(snapshot: DailySnapshot, proof: Proof): boolean {
  const { command, campaign, route } = proof;
  if (snapshot.workspaceId !== command.workspaceId) return false;
  const current = snapshot.campaigns.find(c => c.version.id === campaign.version.id);
  if (!current || current.snapshotHash !== campaign.snapshotHash) return false;
  const payload = command.payload;
  if (payload.kind === 'campaign.approve') return same(current.version, { ...campaign.version, approvedAt: payload.approvedAt });
  if (payload.kind !== 'campaign.enroll' || !route || !same(current.version, campaign.version)) return false;
  return current.enrollments.some(e => e.id === payload.enrollmentId && e.accountId === command.accountId
    && e.campaignVersionId === payload.campaignVersionId && e.selectedRouteId === route.id && e.selectedRouteVersion === route.version
    && e.personId === route.personId && e.executionContextId === payload.executionContextId && e.contextRevision === 1
    && e.currentStepId === campaign.version.steps[0].id && e.version === 1 && e.state === 'active');
}
function freeze<T extends object>(value: T): T {
  Object.values(value).forEach(child => { if (child && typeof child === 'object') freeze(child); });
  return Object.freeze(value);
}

export function CallCampaignEnrollment({ api, snapshot, config, campaign, readError, onRefresh }: {
  api: Api;
  snapshot: DailySnapshot;
  config: LocalDelegationStatus | null;
  campaign: Campaign;
  readError: boolean;
  onRefresh(): void;
}) {
  const parsed = dailySnapshotSchema.safeParse(snapshot);
  const parsedCampaign = dailyCampaignSchema.safeParse(campaign);
  const parsedConfig = localDelegationStatusSchema.safeParse(config);
  const current = parsed.success ? parsed.data : null;
  const canonical = parsedCampaign.success ? current?.campaigns.find(c => same(c, parsedCampaign.data)) : undefined;
  const template = describeCallCampaignTemplate(canonical?.version);
  const account = current?.accounts.find(a => a.account.id === template?.accountId);
  const state = useMemo(() => actionState(api, JSON.stringify([snapshot?.workspaceId, campaign?.version?.id])),
    [api.daily, api.delegation, snapshot?.workspaceId, campaign?.version?.id]);
  const [, render] = useReducer(n => n + 1, 0);
  const [routeId, setRouteId] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const [requested, setRequested] = useState(false);
  const lifetime = useRef(0);
  const routes = eligibleRoutes(account?.routes ?? []);
  const route = routes.find(r => r.id === routeId);
  const guard = JSON.stringify([snapshot?.workspaceId, snapshot?.workflowMode, snapshot?.freshness?.kind, snapshot?.issues,
    readError, config, campaign, account, current?.ownerStatus, current?.campaigns.map(c => c.enrollments), routeId]);
  const available = !!(state && current && parsedConfig.success && !readError && canonical && template && account
    && configured(current, parsedConfig.data));
  const owner = current && template ? ownerFor(current, template.accountId) : undefined;
  const alreadyEnrolled = !!(current && template && duplicate(current, template.accountId));
  const approved = canonical?.version.approvedAt != null;
  useLayoutEffect(() => { setRouteId(''); }, [api.daily, api.delegation, state]);
  useLayoutEffect(() => {
    lifetime.current++;
    state?.listeners.add(render);
    setReviewed(false);
    setRequested(false);
    return () => { lifetime.current++; state?.listeners.delete(render); };
  }, [api.daily, api.delegation, state, guard]);
  useLayoutEffect(() => {
    if (available && current && state?.pending && projected(current, state.pending)) {
      state.completed = { proof: state.pending, guard };
      state.pending = null;
      state.failed = false;
      notify(state);
    }
  }, [available, current, state, guard]);

  const run = async (retry = false) => {
    if (!available || !state || !current || !canonical || !template || !account || state.busy) return;
    if (retry ? !state.pending : state.pending || !owner || (approved ? !requested || !route || alreadyEnrolled : !reviewed)) return;
    state.busy = true; // Synchronous latch precedes the first await, including retries.
    state.failed = false;
    state.completed = null;
    notify(state);
    const generation = lifetime.current;
    let isCurrent = () => generation === lifetime.current;
    try {
      const assertScope = captureDailySessionScope(api.delegation, current.workspaceId!);
      isCurrent = () => {
        if (generation !== lifetime.current) return false;
        try { assertScope(); return true; } catch { return false; }
      };
      let proof = state.pending;
      if (!proof) {
        const rawSync = await api.delegation.sync();
        if (!isCurrent()) return;
        const sync = delegationSyncReportSchema.parse(rawSync);
        if (!sync.ownerFresh || sync.gaps !== 0) throw Error('Held');
        const rawDaily = await api.daily.get();
        if (!isCurrent()) return;
        const fresh = dailySnapshotSchema.parse(rawDaily);
        const rawStatus = await api.delegation.status();
        if (!isCurrent()) return;
        const freshConfig = localDelegationStatusSchema.parse(rawStatus);
        const freshCampaign = fresh.campaigns.find(c => c.version.id === canonical.version.id);
        const freshAccount = fresh.accounts.find(a => a.account.id === template.accountId);
        const freshOwner = ownerFor(fresh, template.accountId);
        if (fresh.workspaceId !== current.workspaceId || !configured(fresh, freshConfig) || !same(freshConfig, parsedConfig.data)
          || !freshCampaign || !same(freshCampaign, canonical) || !same(freshAccount, account)
          || !freshOwner || !same(freshOwner, owner)
          || (approved && (duplicate(fresh, template.accountId) || !route || !eligibleRoutes(freshAccount?.routes ?? []).some(r => same(r, route))))) throw Error('Held');
        const command: Command = {
          commandId: crypto.randomUUID(), workspaceId: current.workspaceId!, accountId: template.accountId,
          expectedAuthorityGeneration: freshOwner.authority!.generation, expectedVersion: freshOwner.executionVersion!, kind: 'campaign-command',
          payload: approved ? { kind: 'campaign.enroll', enrollmentId: crypto.randomUUID(), campaignVersionId: canonical.version.id,
            selectedRouteId: route!.id, executionContextId: crypto.randomUUID(), contextRevision: 1 }
            : { kind: 'campaign.approve', campaignVersionId: canonical.version.id, snapshotHash: canonical.snapshotHash, approvedAt: new Date(Date.now()).toISOString() },
        };
        proof = freeze({ command, campaign: structuredClone(canonical), route: approved ? structuredClone(route!) : null });
      }
      if (!isCurrent()) return;
      state.pending = proof; // submit may durably queue before its reply is lost.
      notify(state);
      const rawReceipt = await api.delegation.submit(proof.command);
      if (!isCurrent()) return;
      const receipt = commandReceiptSchema.parse(rawReceipt);
      if (receipt.commandId !== proof.command.commandId) throw Error('Held');
      if (receipt.status === 'rejected') {
        state.pending = null;
        setReviewed(false);
        setRequested(false);
        throw Error('Held');
      }
      const rawSync = await api.delegation.sync();
      if (!isCurrent()) return;
      const sync = delegationSyncReportSchema.parse(rawSync);
      if (!sync.ownerFresh || sync.gaps !== 0) throw Error('Held');
      const rawDaily = await api.daily.get();
      if (!isCurrent()) return;
      const fresh = dailySnapshotSchema.parse(rawDaily);
      const rawStatus = await api.delegation.status();
      if (!isCurrent()) return;
      const freshConfig = localDelegationStatusSchema.parse(rawStatus);
      if (configured(fresh, freshConfig) && same(freshConfig, parsedConfig.data) && projected(fresh, proof)) {
        state.pending = null;
        state.completed = { proof, guard };
        setReviewed(false);
        setRequested(false);
      }
    } catch {
      if (isCurrent()) {
        state.failed = true;
        setReviewed(false);
        setRequested(false);
      }
    } finally {
      state.busy = false;
      notify(state);
      if (isCurrent()) onRefresh();
    }
  };
  const locked = !!(state?.busy || state?.pending);
  const completion = available && state?.completed && current
    && (state.completed.guard === guard || projected(current, state.completed.proof)) ? state.completed.proof.command.payload.kind : null;
  return <section className="native-desk__campaign-enrollment" aria-label="Call campaign enrollment">
    <p>Enrollment adds a due manual-call item. It does not dial, send messages, or grant contact permission.</p>
    {!approved && <>
      <label className="native-desk__check"><input type="checkbox" checked={reviewed} disabled={!available || locked} onChange={event => setReviewed(event.target.checked)} />I reviewed this company, offer, call step and lifetime limits</label>
      <button type="button" disabled={!available || !owner || locked || !reviewed || completion === 'campaign.approve'} onClick={() => { void run(); }}>Approve call campaign</button>
    </>}
    {approved && <>
      <label>Business phone route<select value={routeId} disabled={!available || locked} onChange={event => setRouteId(event.target.value)}>
        <option value="">Select a business phone route</option>
        {routes.map(r => <option key={r.id} value={r.id}>{r.value} ({r.verification})</option>)}
      </select></label>
      <p>Published or confirmed describes source verification, not contact permission. A new execution context is a binding identity, not authority.</p>
      <label className="native-desk__check"><input type="checkbox" checked={requested} disabled={!available || locked || !route || alreadyEnrolled} onChange={event => setRequested(event.target.checked)} />I want this company added to the manual call queue</label>
      <button type="button" disabled={!available || !owner || locked || !route || !requested || alreadyEnrolled || completion === 'campaign.enroll'} onClick={() => { void run(); }}>Enroll company for manual call</button>
    </>}
    {(!available || !owner) && <p role="status">Campaign action held. A current workspace, exact call template, active worker and known execution version with no pending commands are required.</p>}
    {approved && alreadyEnrolled && <p role="status">This company already has a nonterminal campaign enrollment.</p>}
    {state?.pending && <><p role="status">Campaign action pending. Not confirmed. Retry only the same action or reconcile queued commands.</p>
      <button type="button" disabled={!available || state.busy} onClick={() => { void run(true); }}>Retry same campaign action</button></>}
    {state?.failed && !state.pending && <p role="status">Campaign action could not be completed. Review current data before trying again.</p>}
    {completion === 'campaign.approve' && !canonical?.enrollments.some(e => e.accountId === template?.accountId) && <p role="status">Call campaign approved. Not enrolled.</p>}
    {completion === 'campaign.enroll' && <p role="status">Company enrolled for a manual call. No call placed.</p>}
  </section>;
}

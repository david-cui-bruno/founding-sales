import { useLayoutEffect, useMemo, useReducer, useRef } from 'react';
import type { CalliePreloadApi } from '../../../shared/preload';
import { dailySnapshotSchema, type DailySnapshot } from '../../../shared/contracts/dailyContract';
import { delegationSyncReportSchema, localDelegationStatusSchema } from '../../../shared/contracts/ownerCommandContract';
import { commandReceiptSchema } from '../../../shared/contracts/commandReceiptContract';
import { campaignVersionSchema, type CampaignVersion } from '../../../shared/contracts/campaignContract';
import { createCallCampaignDraft, createLinkedInCampaignDraft, type OneCompanyCampaignChannel } from '../../../shared/contracts/callCampaignDraft';
import { captureDailySessionScope } from '../today/dailySessionScope';
import { AccountIntakeRead } from './AccountIntakeRead';

type Api = Pick<CalliePreloadApi, 'daily' | 'delegation'>;
type LocalDelegationStatus = Awaited<ReturnType<Api['delegation']['status']>>;
type DraftCommand = Extract<Parameters<Api['delegation']['submit']>[0], { kind: 'campaign-command' }> & {
  payload: { kind: 'campaign.version'; version: CampaignVersion };
};
type Preparation = ({ kind: 'copy'; command: Parameters<Api['delegation']['bootstrap']>[0] }
  | { kind: 'delegate'; command: Extract<Parameters<Api['delegation']['submit']>[0], { kind: 'delegate' }> })
  & { reviewed: { workspaceId: string; facts: string; configuration: string } };
type Draft = {
  open: boolean;
  channel: OneCompanyCampaignChannel;
  accountId: string;
  offer: string;
  busy: boolean;
  pending: DraftCommand | null;
  saved: boolean;
  failed: boolean;
  review: boolean;
  preparation: Preparation | null;
  preparationFailed: boolean;
  selection: number;
  listeners: Set<() => void>;
};
// Only this form's state, isolated by both bridge namespaces and workspace.
const drafts = new WeakMap<Api['daily'], WeakMap<Api['delegation'], Map<string | null, Draft>>>();
function retainedDraft(api: Api, workspaceId: string | null): Draft {
  let delegation = drafts.get(api.daily);
  if (!delegation) drafts.set(api.daily, delegation = new WeakMap());
  let workspaces = delegation.get(api.delegation);
  if (!workspaces) delegation.set(api.delegation, workspaces = new Map());
  let draft = workspaces.get(workspaceId);
  if (!draft) {
    draft = { open: false, channel: 'call', accountId: '', offer: '', busy: false, pending: null, saved: false, failed: false,
      review: false, preparation: null, preparationFailed: false, selection: 0, listeners: new Set() };
    workspaces.set(workspaceId, draft);
  }
  return draft;
}
function notify(draft: Draft) { draft.listeners.forEach(listener => listener()); }
function configured(snapshot: DailySnapshot, config: LocalDelegationStatus | null, readError: boolean) {
  return !readError && snapshot.workspaceId !== null && snapshot.workflowMode === 'meeting_first'
    && !snapshot.issues.some(issue => ['scope_unknown', 'scope_mismatch', 'invalid_local_record'].includes(issue.code))
    && config?.workspaceId === snapshot.workspaceId && config.state === 'active'
    && config.endpoint !== null && config.configuration?.configuration.state === 'active';
}
function readyOwner(snapshot: DailySnapshot, accountId: string) {
  if (preparationStage(snapshot, accountId) !== 'active') return undefined;
  return snapshot.ownerStatus.find(o => o.accountId === accountId);
}
function preparationStage(snapshot: DailySnapshot, accountId: string): 'copy' | 'delegate' | 'active' | 'held' {
  if (snapshot.accounts.filter(a => a.account.id === accountId).length !== 1) return 'held';
  const rows = snapshot.ownerStatus.filter(o => o.accountId === accountId);
  if (rows.length !== 1) return 'held';
  const { authority: a, executionVersion: version, pendingCommands, status } = rows[0];
  if (pendingCommands.length || status === 'pending') return 'held';
  if (a === null) return version === null && status === 'unknown' ? 'copy' : 'held';
  if (a.accountId !== accountId) return 'held';
  if (a.owner === 'local' && a.state === 'local' && a.generation === 0 && status === 'unknown') {
    if (version === 0) return 'copy';
    if (version === 1) return 'delegate';
  }
  return a.owner === 'worker' && a.state === 'active' && status === 'owner_applied'
    && Number.isSafeInteger(version) && version !== null && version >= 0 ? 'active' : 'held';
}
function selectedFacts(snapshot: DailySnapshot, accountId: string) {
  return JSON.stringify([snapshot.accounts.filter(a => a.account.id === accountId),
    snapshot.ownerStatus.filter(o => o.accountId === accountId)]);
}
function samePreparationFacts(snapshot: DailySnapshot, accountId: string, expected: string, original: Preparation | null) {
  if (selectedFacts(snapshot, accountId) === expected) return true;
  if (original?.kind !== 'copy') return false;
  const rows = snapshot.ownerStatus.filter(o => o.accountId === accountId);
  if (rows.length !== 1) return false;
  const owner = rows[0];
  if (owner.authority?.accountId !== accountId || owner.authority.owner !== 'local'
    || owner.authority.state !== 'local' || owner.authority.generation !== 0
    || owner.executionVersion !== 0 || owner.status !== 'unknown' || owner.pendingCommands.length !== 0) return false;
  // initializeLocalAuthority can commit before bootstrap is queued. Only an originally
  // absent owner may cross to this exact unfinished placeholder, never the reverse.
  const absentFacts = selectedFacts({ ...snapshot, ownerStatus: snapshot.ownerStatus.map(row => row === owner
    ? { ...row, authority: null, executionVersion: null } : row) }, accountId);
  return absentFacts === expected && absentFacts === original.reviewed.facts;
}
function projected(snapshot: DailySnapshot, command: DraftCommand) {
  // Parsing normalizes object key order. Compare every version field, never just IDs.
  return snapshot.workspaceId === command.workspaceId && snapshot.campaigns.some(c =>
    JSON.stringify(campaignVersionSchema.parse(c.version)) === JSON.stringify(command.payload.version));
}
function freeze<T extends object>(value: T): T {
  Object.values(value).forEach(child => { if (child && typeof child === 'object') freeze(child); });
  return Object.freeze(value);
}

export function CallCampaignDraft({ api, snapshot, config, readError, onRefresh }: {
  api: Api;
  snapshot: DailySnapshot;
  config: LocalDelegationStatus | null;
  readError: boolean;
  onRefresh(): void;
}) {
  const draft = useMemo(() => retainedDraft(api, snapshot.workspaceId), [api.daily, api.delegation, snapshot.workspaceId]);
  const [, render] = useReducer(n => n + 1, 0);
  const lifetime = useRef(0);
  const guard = JSON.stringify([snapshot.workspaceId, snapshot.workflowMode, snapshot.freshness.kind, snapshot.issues, readError, config,
    snapshot.accounts, snapshot.ownerStatus]);
  useLayoutEffect(() => {
    lifetime.current++;
    draft.listeners.add(render);
    return () => { lifetime.current++; draft.listeners.delete(render); };
  }, [api.daily, api.delegation, draft, guard]);
  const available = configured(snapshot, config, readError);
  const parsed = dailySnapshotSchema.safeParse(snapshot);
  const stage = parsed.success && available ? preparationStage(parsed.data, draft.accountId) : 'held';
  useLayoutEffect(() => {
    if (available && draft.pending && projected(snapshot, draft.pending)) {
      draft.pending = null;
      draft.saved = true;
      draft.failed = false;
      notify(draft);
    }
  }, [snapshot, available, draft]);

  const save = async () => {
    if (draft.busy || draft.preparation || draft.saved || !available || (!draft.pending && (!readyOwner(snapshot, draft.accountId)
      || !draft.offer.trim() || draft.offer.trim().length > 4000))) return;
    // This synchronous latch and retained identity precede every await.
    draft.busy = true;
    draft.failed = false;
    notify(draft);
    const generation = lifetime.current;
    const workspaceId = snapshot.workspaceId!;
    const accountId = draft.accountId;
    const offer = draft.offer;
    // The channel chosen before the first await is the one saved. Only these two exact templates exist.
    const createDraft = draft.channel === 'linkedin' ? createLinkedInCampaignDraft : createCallCampaignDraft;
    let isCurrent = () => generation === lifetime.current;
    try {
      const assertScope = captureDailySessionScope(api.delegation, workspaceId);
      isCurrent = () => {
        if (generation !== lifetime.current) return false;
        try { assertScope(); return true; } catch { return false; }
      };
      let command = draft.pending;
      let readConfig = config;
      if (!command) {
        const rawSync = await api.delegation.sync();
        if (!isCurrent()) return;
        const sync = delegationSyncReportSchema.parse(rawSync);
        if (!sync.ownerFresh || sync.gaps !== 0) throw Error('Held');
        const [rawSnapshot, rawStatus] = await Promise.all([api.daily.get(), api.delegation.status()]);
        if (!isCurrent()) return;
        const fresh = dailySnapshotSchema.parse(rawSnapshot);
        const freshConfig = localDelegationStatusSchema.parse(rawStatus);
        const owner = readyOwner(fresh, accountId);
        const priorOwner = readyOwner(snapshot, accountId);
        if (fresh.workspaceId !== workspaceId || !configured(fresh, freshConfig, false) || !owner
          || JSON.stringify(freshConfig) !== JSON.stringify(config)
          || JSON.stringify(owner.authority) !== JSON.stringify(priorOwner?.authority)
          || JSON.stringify(fresh.accounts.find(a => a.account.id === accountId)?.account)
            !== JSON.stringify(snapshot.accounts.find(a => a.account.id === accountId)?.account)) throw Error('Held');
        readConfig = freshConfig;
        command = freeze({
          commandId: crypto.randomUUID(), workspaceId, accountId,
          expectedAuthorityGeneration: owner.authority!.generation,
          expectedVersion: owner.executionVersion!, kind: 'campaign-command',
          payload: { kind: 'campaign.version', version: createDraft({
            campaignId: crypto.randomUUID(), versionId: crypto.randomUUID(), stepId: crypto.randomUUID(), accountId, offer,
          }) },
        });
      }
      if (!isCurrent()) return;
      // submit may durably queue before rejecting. Never replace this identity on errors.
      draft.pending = command;
      notify(draft);
      const rawReceipt = await api.delegation.submit(command);
      if (!isCurrent()) return;
      const receipt = commandReceiptSchema.parse(rawReceipt);
      if (receipt.commandId !== command.commandId) throw Error('Held');
      if (receipt.status === 'rejected') {
        draft.pending = null;
        throw Error('Held');
      }
      await api.delegation.sync();
      if (!isCurrent()) return;
      const canonical = dailySnapshotSchema.parse(await api.daily.get());
      if (!isCurrent()) return;
      if (configured(canonical, readConfig, false) && projected(canonical, command)) {
        draft.pending = null;
        draft.saved = true;
      }
    } catch {
      if (isCurrent()) draft.failed = true;
    } finally {
      draft.busy = false;
      notify(draft);
      if (isCurrent()) onRefresh();
    }
  };
  const prepare = async (action: 'copy' | 'delegate' | 'reconcile' | 'retry') => {
    if (draft.busy || !available || !draft.review || !draft.accountId || draft.pending
      || (action === 'retry' ? !draft.preparation
        : action !== 'reconcile' && (draft.preparation || stage !== action))) return;
    draft.busy = true;
    draft.preparationFailed = false;
    notify(draft);
    const generation = lifetime.current;
    const selection = draft.selection;
    const accountId = draft.accountId;
    const workspaceId = snapshot.workspaceId!;
    let isCurrent = () => generation === lifetime.current && selection === draft.selection && accountId === draft.accountId;
    try {
      const reviewed = dailySnapshotSchema.parse(snapshot);
      const reviewedConfig = localDelegationStatusSchema.parse(config);
      const assertScope = captureDailySessionScope(api.delegation, workspaceId);
      const localCurrent = isCurrent;
      isCurrent = () => { try { assertScope(); return localCurrent(); } catch { return false; } };
      const readFresh = async () => {
        const report = delegationSyncReportSchema.parse(await api.delegation.sync());
        if (!isCurrent()) throw Error('Held');
        if (!report.ownerFresh || report.gaps !== 0) throw Error('Held');
        const [rawDaily, rawStatus] = await Promise.all([api.daily.get(), api.delegation.status()]);
        if (!isCurrent()) throw Error('Held');
        const fresh = dailySnapshotSchema.parse(rawDaily);
        const freshConfig = localDelegationStatusSchema.parse(rawStatus);
        if (fresh.workspaceId !== workspaceId || !configured(fresh, freshConfig, false)
          || JSON.stringify(freshConfig) !== JSON.stringify(reviewedConfig)
          || JSON.stringify(fresh.accounts.filter(a => a.account.id === accountId))
            !== JSON.stringify(reviewed.accounts.filter(a => a.account.id === accountId))) throw Error('Held');
        return fresh;
      };
      const settle = (fresh: DailySnapshot) => {
        const next = preparationStage(fresh, accountId);
        if (draft.preparation && draft.preparation.command.accountId === accountId
          && draft.preparation.reviewed.workspaceId === fresh.workspaceId
          && (next === 'active' || draft.preparation.kind === 'copy' && next === 'delegate')) {
          draft.preparation = null;
        }
      };
      const fresh = await readFresh();
      if (!isCurrent()) return;
      if (action === 'reconcile') { settle(fresh); return; }
      if (action === 'retry') {
        // Sync may have completed the old intent. Never turn that progress into a next-stage command.
        settle(fresh);
        if (!draft.preparation) return;
      }
      const original = action === 'retry' ? draft.preparation : null;
      const intendedStage = original?.kind ?? action;
      // A click reviews one checkpoint only. Fresh progress never authorizes the next command.
      if (preparationStage(fresh, accountId) !== intendedStage
        || !samePreparationFacts(fresh, accountId, selectedFacts(reviewed, accountId), original)
        || original && (original.command.accountId !== accountId || original.reviewed.workspaceId !== workspaceId
          || !samePreparationFacts(fresh, accountId, original.reviewed.facts, original)
          || original.reviewed.configuration !== JSON.stringify(reviewedConfig))) {
        throw Error('Held');
      }
      const intentReview = { workspaceId, facts: selectedFacts(fresh, accountId), configuration: JSON.stringify(reviewedConfig) };
      const intent: Preparation = original ?? (action === 'copy'
        ? freeze({ kind: 'copy', reviewed: intentReview, command: { commandId: crypto.randomUUID(), accountId } })
        : freeze({ kind: 'delegate', reviewed: intentReview, command: { commandId: crypto.randomUUID(), workspaceId, accountId,
          expectedAuthorityGeneration: 0, expectedVersion: 1, kind: 'delegate',
          payload: { delegationId: crypto.randomUUID(), approvedAt: new Date().toISOString() } } }));
      if (!isCurrent()) return;
      // Queueing can precede any exception. Explicit retries preserve the complete frozen intent.
      draft.preparation = intent;
      notify(draft);
      const receipt = commandReceiptSchema.parse(await (intent.kind === 'copy'
        ? api.delegation.bootstrap(intent.command) : api.delegation.submit(intent.command)));
      if (!isCurrent()) return;
      if (receipt.commandId !== intent.command.commandId) throw Error('Held');
      if (receipt.status === 'rejected') {
        // Only the schema-valid rejection of this exact command is definitive, not HTTP refusal.
        draft.preparation = null;
        throw Error('Held');
      }
      const canonical = await readFresh();
      if (isCurrent()) settle(canonical);
    } catch {
      if (isCurrent()) draft.preparationFailed = true;
    } finally {
      draft.busy = false;
      notify(draft);
      if (isCurrent()) onRefresh();
    }
  };
  const locked = draft.busy || draft.pending !== null || draft.preparation !== null;
  const canSave = available && !!readyOwner(snapshot, draft.accountId) && !!draft.offer.trim()
    && draft.offer.trim().length <= 4000 && !locked && !draft.saved;
  const linkedIn = draft.channel === 'linkedin';
  return <section className="native-desk__campaign-draft native-desk__composer" aria-label="New call campaign">
    <button type="button" aria-expanded={draft.open} onClick={() => { draft.open = !draft.open; notify(draft); }}>New call campaign</button>
    {draft.open && <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <label>Channel<select value={draft.channel} disabled={locked} onChange={event => { draft.channel = event.target.value === 'linkedin' ? 'linkedin' : 'call'; draft.saved = false; draft.failed = false; notify(draft); }}>
        <option value="call">Manual call</option>
        <option value="linkedin">Manual LinkedIn note</option>
      </select></label>
      <label>Company<select value={draft.accountId} disabled={locked} onChange={event => { draft.accountId = event.target.value; draft.selection++; draft.review = false; draft.saved = false; draft.failed = false; draft.preparationFailed = false; notify(draft); }}>
        <option value="">Select a company</option>
        {snapshot.accounts.map(a => <option key={a.account.id} value={a.account.id}>{a.account.name}</option>)}
      </select></label>
      <label>Meeting offer<textarea value={draft.offer} maxLength={4000} disabled={locked} onChange={event => { draft.offer = event.target.value; draft.saved = false; draft.failed = false; notify(draft); }} /></label>
      <p>{linkedIn ? 'Saves an unapproved LinkedIn campaign draft. This does not enroll accounts, prepare or send a note, or start outreach.'
        : 'Saves an unapproved campaign draft. This does not enroll accounts, activate a campaign, or start outreach.'}</p>
      <p>Explicit preparation, reconciliation and save actions synchronize queued work across the workspace. Synchronization can replay previously queued workspace commands.</p>
      <button type="button" aria-expanded={draft.review} onClick={() => { draft.review = !draft.review; notify(draft); }}>Review worker preparation</button>
      {draft.review && <section aria-label="Worker preparation">
        <AccountIntakeRead api={api} workspaceId={snapshot.workspaceId} accountId={draft.accountId} disabled={locked || !available || !parsed.success || stage === 'held'} scopeKey={guard} />
        <p>Unapproved draft only. Intake and outreach readiness are not verified here.</p>
        <p>Copy sends only the selected saved company record to the worker. Unsent local drafts and this meeting offer are not included. Delegation transfers account ownership only. It does not configure intake, mail or grants, enroll accounts, or start calls or outreach.</p>
        {stage === 'copy' && <button type="button" disabled={locked} onClick={() => { void prepare('copy'); }}>Copy selected company to worker</button>}
        {stage === 'delegate' && <button type="button" disabled={locked} onClick={() => { void prepare('delegate'); }}>Delegate selected company</button>}
        {stage === 'active' && <p role="status">Account worker is active. No copy or delegation is needed. Save the unapproved draft separately.</p>}
        {stage === 'held' && <p role="status">Worker preparation is held. Check selected company, workspace access and pending commands.</p>}
        {(draft.preparation || snapshot.ownerStatus.some(o => o.accountId === draft.accountId && o.pendingCommands.length > 0)) &&
          <p role="status">Preparation or queued work is not confirmed complete. Reconcile existing commands rather than creating a replacement.</p>}
        {draft.preparation && <p>Preparation command: {draft.preparation.command.commandId}</p>}
        {draft.preparation && <button type="button" disabled={draft.busy || !!draft.pending || !available}
          onClick={() => { void prepare('retry'); }}>Retry same preparation</button>}
        {snapshot.ownerStatus.filter(o => o.accountId === draft.accountId).flatMap(o => o.pendingCommands).map((command, i) =>
          <p key={`${command.commandId}-${i}`}>Queued command: {command.commandId}</p>)}
        <button type="button" disabled={draft.busy || !!draft.pending || !available || !draft.accountId}
          onClick={() => { void prepare('reconcile'); }}>Reconcile queued preparation</button>
        {draft.preparationFailed && <p role="status">Worker preparation could not be confirmed. Review current facts or reconcile queued work. No new command was automatically authorized.</p>}
      </section>}
      <button type="submit" disabled={!canSave}>{linkedIn ? 'Save LinkedIn campaign draft' : 'Save call campaign draft'}</button>
      {!available && <p role="status">Campaign draft setup or current workspace read is unavailable. Saving is held.</p>}
      {available && draft.accountId && !readyOwner(snapshot, draft.accountId) && !draft.pending && <p role="status">Saving requires an active account worker with a known execution version and no pending commands.</p>}
      {draft.pending && <><p role="status">Campaign draft pending. Not confirmed saved. Retry the same draft or use queued command reconciliation. This cannot approve, enroll or start outreach.</p>
        <button type="button" disabled={draft.busy || !available} onClick={() => { void save(); }}>Retry same pending draft</button></>}
      {draft.failed && !draft.pending && <p role="status">Campaign draft could not be saved. Check the current workspace and owner status before trying again.</p>}
      {draft.saved && available && <p role="status">Campaign draft saved. Not approved or enrolled.</p>}
    </form>}
  </section>;
}

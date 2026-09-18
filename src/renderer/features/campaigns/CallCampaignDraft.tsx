import { useLayoutEffect, useMemo, useReducer, useRef } from 'react';
import type { CalliePreloadApi } from '../../../shared/preload';
import { dailySnapshotSchema, type DailySnapshot } from '../../../shared/contracts/dailyContract';
import { delegationSyncReportSchema, localDelegationStatusSchema, selectedAccountFreshnessSchema, type SelectedAccountFreshness } from '../../../shared/contracts/ownerCommandContract';
import { commandReceiptSchema } from '../../../shared/contracts/commandReceiptContract';
import { campaignVersionSchema, type CampaignVersion } from '../../../shared/contracts/campaignContract';
import { createCallCampaignDraft, createLinkedInCampaignDraft, type OneCompanyCampaignChannel } from '../../../shared/contracts/callCampaignDraft';
import { captureDailySessionScope } from '../today/dailySessionScope';
import { AccountIntakeRead } from './AccountIntakeRead';
import { TerritoryCallPolicyPanel } from './TerritoryCallPolicyPanel';

type Api = Pick<CalliePreloadApi, 'daily' | 'delegation'>;
type LocalDelegationStatus = Awaited<ReturnType<Api['delegation']['status']>>;
type DraftCommand = Extract<Parameters<Api['delegation']['submit']>[0], { kind: 'campaign-command' }> & {
  payload: { kind: 'campaign.version'; version: CampaignVersion };
};
type Preparation = ({ kind: 'copy'; command: Parameters<Api['delegation']['bootstrap']>[0] }
  | { kind: 'delegate'; command: Extract<Parameters<Api['delegation']['submit']>[0], { kind: 'delegate' }> })
  & { reviewed: { workspaceId: string; facts: string; configuration: string } };
/** One explicit resubmission of the current saved record to the worker that already owns the company.
 * The renderer names only the command and the company; main builds the record. */
type RecordSend = { command: { commandId: string; accountId: string }; reviewed: { workspaceId: string; configuration: string } };
/** The last local comparison of the saved record with the copy the worker applied, for one company. `value: null`
 * means the read failed or this bridge cannot make it; that is never shown as "unknown". */
type FreshnessRead = { accountId: string; value: SelectedAccountFreshness | null };
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
  recordSend: RecordSend | null;
  recordSendFailed: boolean;
  recordRejected: string | null;
  freshness: FreshnessRead | null;
  freshnessReading: string | null;
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
      review: false, preparation: null, preparationFailed: false, recordSend: null, recordSendFailed: false, recordRejected: null,
      freshness: null, freshnessReading: null, selection: 0, listeners: new Set() };
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
/** One honest line per local comparison. A failed or impossible read says so; "unknown" is reserved for a
 * successful comparison that found no applied copy on record. */
function freshnessLine(read: FreshnessRead | null, accountId: string, reading: boolean) {
  if (reading || !read || read.accountId !== accountId) return 'Reading worker copy of saved record…';
  if (read.value === null) return 'Worker copy freshness could not be read.';
  return read.value.state === 'current' ? 'Worker holds the current saved record.'
    : read.value.state === 'stale' ? 'The saved record changed since it was sent to the worker.'
      : 'Worker copy freshness unknown.';
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
  // One explicit synchronization and re-read of the reviewed company under the same configuration. Shared by every
  // preparation click and the record send: a departure from the reviewed facts holds, it never mints a command.
  const readFreshSnapshot = async (reviewed: DailySnapshot, reviewedConfig: LocalDelegationStatus, accountId: string, workspaceId: string, isCurrent: () => boolean) => {
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
  // Local comparison only: no worker call, no queued work, no form lock. The result belongs to the retained draft for
  // this company, so a read that outlives a remount still lands. An older bridge, a failed read or a foreign identity
  // reads as "could not be read", never as "unknown".
  const readFreshness = async (accountId: string, workspaceId: string) => {
    const read = api.delegation.getSelectedAccountFreshness;
    draft.freshnessReading = accountId;
    notify(draft);
    let value: SelectedAccountFreshness | null = null;
    let current = () => draft.accountId === accountId;
    try {
      const assertScope = captureDailySessionScope(api.delegation, workspaceId);
      current = () => { try { assertScope(); return draft.accountId === accountId; } catch { return false; } };
      if (!read) throw Error('Held');
      value = selectedAccountFreshnessSchema.parse(await read({ accountId }));
      if (value.accountId !== accountId) throw Error('Held');
    } catch { value = null; } finally {
      if (draft.freshnessReading === accountId) draft.freshnessReading = null;
      if (current()) draft.freshness = { accountId, value };
      notify(draft);
    }
  };
  const workerCopy = () => draft.freshness && draft.freshness.accountId === draft.accountId ? draft.freshness.value : null;
  // While the panel is open for a worker-owned company the worker-copy line is read locally, once per company, and
  // again only after a send, a reconcile or the explicit re-check. Nothing here reaches the worker.
  useLayoutEffect(() => {
    if (!draft.review || stage !== 'active' || !draft.accountId || draft.freshnessReading !== null
      || (draft.freshness !== null && draft.freshness.accountId === draft.accountId)) return;
    void readFreshness(draft.accountId, snapshot.workspaceId!);
  });
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
      const readFresh = () => readFreshSnapshot(reviewed, reviewedConfig, accountId, workspaceId, () => isCurrent());
      const settle = (fresh: DailySnapshot) => {
        const next = preparationStage(fresh, accountId);
        if (draft.preparation && draft.preparation.command.accountId === accountId
          && draft.preparation.reviewed.workspaceId === fresh.workspaceId
          && (next === 'active' || draft.preparation.kind === 'copy' && next === 'delegate')) {
          draft.preparation = null;
        }
        // A record send the worker no longer holds queued has settled either way; the copy state is re-read explicitly.
        if (draft.recordSend && draft.recordSend.command.accountId === accountId && draft.recordSend.reviewed.workspaceId === fresh.workspaceId
          && !fresh.ownerStatus.some(o => o.accountId === accountId && o.pendingCommands.some(c => c.commandId === draft.recordSend!.command.commandId))) {
          draft.recordSend = null;
          draft.freshness = null;
        }
      };
      const fresh = await readFresh();
      if (!isCurrent()) return;
      if (action === 'reconcile') {
        settle(fresh);
        // The reconcile may have settled a record send; the worker-copy line is re-read locally once it is done.
        if (preparationStage(fresh, accountId) === 'active') await readFreshness(accountId, workspaceId);
        return;
      }
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
  // Explicit local re-read of the worker-copy line. No worker call, no queued work, no form lock.
  const recheckFreshness = () => {
    if (!draft.review || stage !== 'active' || !draft.accountId || draft.freshnessReading !== null || !api.delegation.getSelectedAccountFreshness) return;
    void readFreshness(draft.accountId, snapshot.workspaceId!);
  };
  // The only producer of a record send. One command per click, retained across uncertainty, retried by the same id.
  const sendRecord = async (action: 'send' | 'retry') => {
    const send = api.delegation.refreshSelectedAccount;
    if (!send || draft.busy || !available || !draft.review || !draft.accountId || draft.pending || draft.preparation
      || (action === 'retry' ? !draft.recordSend : draft.recordSend || stage !== 'active' || draft.freshnessReading !== null || workerCopy()?.state === 'current')) return;
    draft.busy = true;
    draft.recordSendFailed = false;
    draft.recordRejected = null;
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
      const original = action === 'retry' ? draft.recordSend : null;
      if (original && (original.command.accountId !== accountId || original.reviewed.workspaceId !== workspaceId
        || original.reviewed.configuration !== JSON.stringify(reviewedConfig))) throw Error('Held');
      if (!original) {
        // A click sends the worker-owned checkpoint it reviewed. A fresh departure holds; it never mints a command.
        const fresh = await readFreshSnapshot(reviewed, reviewedConfig, accountId, workspaceId, () => isCurrent());
        if (!isCurrent()) return;
        if (preparationStage(fresh, accountId) !== 'active') throw Error('Held');
      }
      const intent: RecordSend = original ?? freeze({ command: { commandId: crypto.randomUUID(), accountId },
        reviewed: { workspaceId, configuration: JSON.stringify(reviewedConfig) } });
      if (!isCurrent()) return;
      // Queueing can precede any exception. Explicit retries resend this exact identity, never a replacement.
      draft.recordSend = intent;
      notify(draft);
      const receipt = commandReceiptSchema.parse(await send(intent.command));
      if (!isCurrent()) return;
      if (receipt.commandId !== intent.command.commandId) throw Error('Held');
      if (receipt.status === 'rejected') {
        // Only the schema-valid rejection of this exact command is definitive. Its reason is the worker's own words.
        draft.recordSend = null;
        draft.recordRejected = receipt.reason;
      } else if (receipt.status === 'applied') draft.recordSend = null;
      await readFreshness(accountId, workspaceId);
    } catch {
      if (isCurrent()) draft.recordSendFailed = true;
    } finally {
      draft.busy = false;
      notify(draft);
      if (isCurrent()) onRefresh();
    }
  };
  const locked = draft.busy || draft.pending !== null || draft.preparation !== null || draft.recordSend !== null;
  const canSave = available && !!readyOwner(snapshot, draft.accountId) && !!draft.offer.trim()
    && draft.offer.trim().length <= 4000 && !locked && !draft.saved;
  const linkedIn = draft.channel === 'linkedin';
  // One toggle per exact template shares the form. Reopening the open channel closes it;
  // the other channel is unavailable while a draft for this channel is pending.
  const choose = (channel: OneCompanyCampaignChannel) => {
    if (draft.open && draft.channel === channel) draft.open = false;
    else {
      if (locked && draft.channel !== channel) return;
      draft.open = true;
      if (draft.channel !== channel) { draft.channel = channel; draft.saved = false; draft.failed = false; }
    }
    notify(draft);
  };
  const toggle = (channel: OneCompanyCampaignChannel, label: string) =>
    <button type="button" aria-expanded={draft.open && draft.channel === channel} disabled={locked && draft.channel !== channel} onClick={() => choose(channel)}>{label}</button>;
  // The standing territory policy sits above the manual one-company drafts; the two paths share nothing but the bridge.
  return <><TerritoryCallPolicyPanel api={api} snapshot={snapshot} config={config} readError={readError} />
  <section className="native-desk__campaign-draft native-desk__composer" aria-label="New call campaign">
    <div role="group" aria-label="Channel">{toggle('call', 'New call campaign')} {toggle('linkedin', 'New LinkedIn campaign')}</div>
    {draft.open && <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <label>Company<select value={draft.accountId} disabled={locked} onChange={event => { draft.accountId = event.target.value; draft.selection++; draft.review = false; draft.saved = false; draft.failed = false; draft.preparationFailed = false; draft.freshness = null; draft.recordRejected = null; draft.recordSendFailed = false; notify(draft); }}>
        <option value="">Select a company</option>
        {snapshot.accounts.map(a => <option key={a.account.id} value={a.account.id}>{a.account.name}</option>)}
      </select></label>
      <label>Meeting offer<textarea value={draft.offer} maxLength={4000} disabled={locked} onChange={event => { draft.offer = event.target.value; draft.saved = false; draft.failed = false; notify(draft); }} /></label>
      <p>{linkedIn ? 'Saves an unapproved LinkedIn campaign draft. This does not enroll accounts, prepare or send a note, or start outreach.'
        : 'Saves an unapproved campaign draft. This does not enroll accounts, activate a campaign, or start outreach.'}</p>
      <p>Explicit preparation, reconciliation and save actions synchronize queued work across the workspace. Synchronization can replay previously queued workspace commands.</p>
      <button type="button" aria-expanded={draft.review} onClick={() => { draft.review = !draft.review; notify(draft); }}>Review worker preparation</button>
      {draft.review && <section aria-label="Worker preparation">
        <AccountIntakeRead api={api} workspaceId={snapshot.workspaceId} accountId={draft.accountId} disabled={locked || !available || !parsed.success || stage === 'held'} stage={stage} scopeKey={guard} />
        <p>Unapproved draft only. Intake and outreach readiness are not verified here.</p>
        <p>Copy sends only the selected saved company record to the worker. Unsent local drafts and this meeting offer are not included. Delegation transfers account ownership only. It does not configure intake, mail or grants, enroll accounts, or start calls or outreach.</p>
        {stage === 'copy' && <button type="button" disabled={locked} onClick={() => { void prepare('copy'); }}>Copy selected company to worker</button>}
        {stage === 'delegate' && <button type="button" disabled={locked} onClick={() => { void prepare('delegate'); }}>Delegate selected company</button>}
        {stage === 'active' && <p role="status">Account worker is active. No copy or delegation is needed. Save the unapproved draft separately.</p>}
        {stage === 'active' && <>
          <p role="status">{freshnessLine(draft.freshness, draft.accountId, draft.freshnessReading !== null)}</p>
          <button type="button" disabled={locked || draft.freshnessReading !== null || !api.delegation.getSelectedAccountFreshness} onClick={recheckFreshness}>Check worker copy again</button>
          <button type="button" disabled={locked || draft.freshnessReading !== null || !api.delegation.refreshSelectedAccount || workerCopy()?.state === 'current'} onClick={() => { void sendRecord('send'); }}>Send updated saved record to worker</button>
          <p>Sending resubmits only the current saved company record to the worker that already owns it. It does not change ownership, campaigns, mail or calendar, and it does not send, call or book.</p>
        </>}
        {stage === 'held' && <p role="status">Worker preparation is held. Check selected company, workspace access and pending commands.</p>}
        {(draft.preparation || snapshot.ownerStatus.some(o => o.accountId === draft.accountId && o.pendingCommands.length > 0)) &&
          <p role="status">Preparation or queued work is not confirmed complete. Reconcile existing commands rather than creating a replacement.</p>}
        {draft.preparation && <p>Preparation command: {draft.preparation.command.commandId}</p>}
        {draft.preparation && <button type="button" disabled={draft.busy || !!draft.pending || !available}
          onClick={() => { void prepare('retry'); }}>Retry same preparation</button>}
        {draft.preparation && <p>Retry same preparation resends the exact queued command.</p>}
        {draft.recordSend && <p>Record send command: {draft.recordSend.command.commandId}</p>}
        {draft.recordSend && <button type="button" disabled={draft.busy || !!draft.pending || !available || !api.delegation.refreshSelectedAccount}
          onClick={() => { void sendRecord('retry'); }}>Retry same record send</button>}
        {draft.recordSend && <p>Retry same record send resends the exact queued record under its original command.</p>}
        {snapshot.ownerStatus.filter(o => o.accountId === draft.accountId).flatMap(o => o.pendingCommands).map((command, i) =>
          <p key={`${command.commandId}-${i}`}>Queued command: {command.commandId}</p>)}
        <button type="button" disabled={draft.busy || !!draft.pending || !available || !draft.accountId}
          onClick={() => { void prepare('reconcile'); }}>Reconcile queued preparation</button>
        <p>Reconcile queued preparation asks the worker what it already holds for queued commands and applies the answer.</p>
        {draft.preparationFailed && <p role="status">Worker preparation could not be confirmed. Review current facts or reconcile queued work. No new command was automatically authorized.</p>}
        {draft.recordRejected !== null && <p role="status">The worker rejected the saved record: <span>{draft.recordRejected}</span></p>}
        {draft.recordSendFailed && <p role="status">Sending the saved record could not be confirmed. Retry the same record send or reconcile queued work. No new command was automatically authorized.</p>}
      </section>}
      <button type="submit" disabled={!canSave}>{linkedIn ? 'Save LinkedIn campaign draft' : 'Save call campaign draft'}</button>
      {!available && <p role="status">Campaign draft setup or current workspace read is unavailable. Saving is held.</p>}
      {available && draft.accountId && !readyOwner(snapshot, draft.accountId) && !draft.pending && <p role="status">Saving requires an active account worker with a known execution version and no pending commands.</p>}
      {draft.pending && <><p role="status">Campaign draft pending. Not confirmed saved. Retry the same draft or use queued command reconciliation. This cannot approve, enroll or start outreach.</p>
        <button type="button" disabled={draft.busy || !available} onClick={() => { void save(); }}>Retry same pending draft</button></>}
      {draft.failed && !draft.pending && <p role="status">Campaign draft could not be saved. Check the current workspace and owner status before trying again.</p>}
      {draft.saved && available && <p role="status">Campaign draft saved. Not approved or enrolled.</p>}
    </form>}
  </section></>;
}

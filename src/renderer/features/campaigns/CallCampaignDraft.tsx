import { useLayoutEffect, useMemo, useReducer, useRef } from 'react';
import type { CalliePreloadApi } from '../../../shared/preload';
import { dailySnapshotSchema, type DailySnapshot } from '../../../shared/contracts/dailyContract';
import { delegationSyncReportSchema, localDelegationStatusSchema } from '../../../shared/contracts/ownerCommandContract';
import { commandReceiptSchema } from '../../../shared/contracts/commandReceiptContract';
import { campaignVersionSchema, type CampaignVersion } from '../../../shared/contracts/campaignContract';
import { createCallCampaignDraft } from '../../../shared/contracts/callCampaignDraft';
import { captureDailySessionScope } from '../today/dailySessionScope';

type Api = Pick<CalliePreloadApi, 'daily' | 'delegation'>;
type LocalDelegationStatus = Awaited<ReturnType<Api['delegation']['status']>>;
type DraftCommand = Extract<Parameters<Api['delegation']['submit']>[0], { kind: 'campaign-command' }> & {
  payload: { kind: 'campaign.version'; version: CampaignVersion };
};
type Draft = {
  open: boolean;
  accountId: string;
  offer: string;
  busy: boolean;
  pending: DraftCommand | null;
  saved: boolean;
  failed: boolean;
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
    draft = { open: false, accountId: '', offer: '', busy: false, pending: null, saved: false, failed: false, listeners: new Set() };
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
  if (!snapshot.accounts.some(a => a.account.id === accountId)) return undefined;
  return snapshot.ownerStatus.find(o => o.accountId === accountId && o.authority?.accountId === accountId
    && o.authority.owner === 'worker' && o.authority.state === 'active'
    && o.executionVersion !== null && o.pendingCommands.length === 0);
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
    snapshot.accounts.map(a => a.account), snapshot.ownerStatus]);
  useLayoutEffect(() => {
    lifetime.current++;
    draft.listeners.add(render);
    return () => { lifetime.current++; draft.listeners.delete(render); };
  }, [api.daily, api.delegation, draft, guard]);
  const available = configured(snapshot, config, readError);
  useLayoutEffect(() => {
    if (available && draft.pending && projected(snapshot, draft.pending)) {
      draft.pending = null;
      draft.saved = true;
      draft.failed = false;
      notify(draft);
    }
  }, [snapshot, available, draft]);

  const save = async () => {
    if (draft.busy || draft.saved || !available || (!draft.pending && (!readyOwner(snapshot, draft.accountId)
      || !draft.offer.trim() || draft.offer.trim().length > 4000))) return;
    // This synchronous latch and retained identity precede every await.
    draft.busy = true;
    draft.failed = false;
    notify(draft);
    const generation = lifetime.current;
    const workspaceId = snapshot.workspaceId!;
    const accountId = draft.accountId;
    const offer = draft.offer;
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
          payload: { kind: 'campaign.version', version: createCallCampaignDraft({
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
  const locked = draft.busy || draft.pending !== null;
  const canSave = available && !!readyOwner(snapshot, draft.accountId) && !!draft.offer.trim()
    && draft.offer.trim().length <= 4000 && !locked && !draft.saved;
  return <section className="native-desk__campaign-draft native-desk__composer" aria-label="New call campaign">
    <button type="button" aria-expanded={draft.open} onClick={() => { draft.open = !draft.open; notify(draft); }}>New call campaign</button>
    {draft.open && <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <label>Company<select value={draft.accountId} disabled={locked} onChange={event => { draft.accountId = event.target.value; draft.saved = false; draft.failed = false; notify(draft); }}>
        <option value="">Select a company</option>
        {snapshot.accounts.map(a => <option key={a.account.id} value={a.account.id}>{a.account.name}</option>)}
      </select></label>
      <label>Meeting offer<textarea value={draft.offer} maxLength={4000} disabled={locked} onChange={event => { draft.offer = event.target.value; draft.saved = false; draft.failed = false; notify(draft); }} /></label>
      <p>Saves an unapproved campaign draft. This does not enroll accounts, activate a campaign, or start outreach.</p>
      <button type="submit" disabled={!canSave}>Save call campaign draft</button>
      {!available && <p role="status">Campaign draft setup or current workspace read is unavailable. Saving is held.</p>}
      {available && draft.accountId && !readyOwner(snapshot, draft.accountId) && !draft.pending && <p role="status">Saving requires an active account worker with a known execution version and no pending commands.</p>}
      {draft.pending && <><p role="status">Campaign draft pending. Not confirmed saved. Retry the same draft or use queued command reconciliation. This cannot approve, enroll or start outreach.</p>
        <button type="button" disabled={draft.busy || !available} onClick={() => { void save(); }}>Retry same pending draft</button></>}
      {draft.failed && !draft.pending && <p role="status">Campaign draft could not be saved. Check the current workspace and owner status before trying again.</p>}
      {draft.saved && available && <p role="status">Campaign draft saved. Not approved or enrolled.</p>}
    </form>}
  </section>;
}

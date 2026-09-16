import { useLayoutEffect, useReducer, useRef, useState } from 'react';
import { dailySnapshotSchema, type DailySnapshot } from '../../../shared/contracts/dailyContract';
import { localDelegationStatusSchema } from '../../../shared/contracts/ownerCommandContract';
import { prepareRequestedFollowupSchema, savedRequestedFollowupSchema, type OriginalCallRef, type PrepareRequestedFollowup, type RequestedFollowupDraft } from '../../../shared/contracts/requestedFollowupContract';
import type { GetPhoneHandoffStateRequest } from '../../../shared/contracts/delegatedPhoneStateContract';
import { captureDailySessionScope } from './dailySessionScope';
import { freezePhoneValue, parsePhoneHistory, phoneHistoryScope, phoneOwner, type CompanyPhoneApi, type PhoneConfig } from './companyPhoneSession';

type Retained = { scope: string; busy: boolean; request: PrepareRequestedFollowup | null; draft: RequestedFollowupDraft | null; error: string; listeners: Set<() => void> };
// One unresolved preparation per bridge, not a command journal. Reads recover
// durable drafts before explicit same-ID retry, never a replacement create.
const retained = new WeakMap<CompanyPhoneApi['delegation'], Retained>();
class PreparationHold extends Error {}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function stateFor(api: CompanyPhoneApi['delegation']) {
  let state = retained.get(api);
  if (!state) { state = { scope: '', busy: false, request: null, draft: null, error: '', listeners: new Set() }; retained.set(api, state); }
  return state;
}
export function RequestedEmailPreparation({ api, snapshot, config, selector, originalCall, unavailable = false, onRefresh }: {
  api: CompanyPhoneApi; snapshot: DailySnapshot; config: PhoneConfig | null; selector: GetPhoneHandoffStateRequest;
  originalCall: OriginalCallRef; unavailable?: boolean; onRefresh(): void;
}) {
  const workspaceId = snapshot.workspaceId;
  const scope = JSON.stringify([workspaceId, selector.accountId, originalCall]);
  const state = stateFor(api.delegation);
  const [, render] = useReducer(n => n + 1, 0);
  const [email, setEmail] = useState(state.scope === scope ? state.request?.recipientBinding.email ?? state.draft?.recipient ?? '' : '');
  const account = snapshot.accounts.find(a => a.account.id === selector.accountId);
  const guard = JSON.stringify([scope, selector, account, config, snapshot.ownerStatus.filter(o => o.accountId === selector.accountId), unavailable]);
  const generation = useRef(0), liveGuard = useRef(guard);
  liveGuard.current = guard;
  useLayoutEffect(() => {
    generation.current++;
    state.listeners.add(render);
    return () => { generation.current++; state.listeners.delete(render); };
  }, [state, guard, api.daily, api.delegation]);
  const notify = () => state.listeners.forEach(listener => listener());
  const local = state.scope === scope;
  const uncertain = !!state.request && !state.draft;
  const heldElsewhere = uncertain && !local;
  const saved = local ? state.draft : null;
  const input = prepareRequestedFollowupSchema.safeParse({ accountId: selector.accountId, originalCall,
    recipientBinding: { kind: 'owner_supplied', email: email.trim(), originalCall }, expectedAccountVersion: account?.account.version, mode: 'manual' });
  const readable = !!workspaceId && !!config && phoneHistoryScope(snapshot, config, workspaceId) && !unavailable;
  const active = readable && config?.state === 'active' && config.configuration?.configuration.state === 'active';

  async function run(recoverOnly: boolean) {
    if (!active || !workspaceId || state.busy || heldElsewhere || saved || (!recoverOnly && !input.success)) return;
    const captured = generation.current, binding = guard;
    let checkScope: () => void;
    try { checkScope = captureDailySessionScope(api.delegation, workspaceId); } catch { return; }
    const check = () => { checkScope(); if (captured !== generation.current || liveGuard.current !== binding) throw new PreparationHold('Requested email selection changed.'); };
    const request = local && state.request ? state.request : input.success ? freezePhoneValue({ ...input.data, draftId: crypto.randomUUID() }) : null;
    if (!request) return;
    if (!uncertain) { state.scope = scope; state.error = ''; state.draft = null; state.request = null; }
    state.busy = true; notify();
    try {
      check();
      const fresh = dailySnapshotSchema.parse(await api.daily.get()); check();
      const freshConfig = localDelegationStatusSchema.parse(await api.delegation.status()); check();
      if (!phoneHistoryScope(fresh, freshConfig, workspaceId) || freshConfig.state !== 'active'
        || freshConfig.configuration?.configuration.state !== 'active') throw new PreparationHold('Current owner workspace is unavailable.');
      const freshAccount = fresh.accounts.find(a => a.account.id === selector.accountId);
      const owner = phoneOwner(fresh, selector.accountId);
      if (!freshAccount || freshAccount.account.version !== request.expectedAccountVersion || !same(freshAccount, account)
        || owner.authority?.state !== 'active' || owner.pendingCommands.length) throw new PreparationHold('Account or owner changed. Refresh before preparing.');
      const matches = fresh.answers.filter(a => a.kind === 'requested_followup' && a.accountId === request.accountId
        && (!state.request?.draftId || a.draft.id === state.request.draftId)
        && same(a.draft.originalCall, request.originalCall) && same(a.draft.recipientBinding, request.recipientBinding));
      if (matches.length > 1) throw new PreparationHold('Several saved drafts match. Review Saved draft continuations, do not create another.');
      if (matches[0]?.kind === 'requested_followup') {
        state.scope = scope; state.draft = matches[0].draft; state.error = ''; notify(); onRefresh(); return;
      }
      if (recoverOnly && !state.request?.draftId) throw new PreparationHold('Creation remains unconfirmed. No matching saved draft is visible. Do not create a replacement.');
      const history = parsePhoneHistory(await api.delegation.getPhoneHandoffState(selector), selector, fresh, workspaceId); check();
      if (history.completeness !== 'complete' || !history.completions.some(c => same(c.applied?.originalCall, originalCall))) {
        throw new PreparationHold('The exact applied connected call is no longer available.');
      }
      check();
      state.request = request; notify();
      const result = savedRequestedFollowupSchema.parse(await api.delegation.prepareRequestedFollowup(request));
      check();
      if (result.draft.id !== request.draftId || result.draft.accountId !== request.accountId || result.draft.accountVersion !== request.expectedAccountVersion
        || !same(result.draft.originalCall, request.originalCall) || !same(result.draft.recipientBinding, request.recipientBinding)) {
        throw new PreparationHold('Saved requested draft identity changed.');
      }
      state.draft = result.draft; state.error = ''; notify(); onRefresh();
    } catch (error) {
      // Retain an unresolved sent request even if its component lifetime ended.
      try { check(); state.error = state.request && !state.draft
        ? 'Requested draft creation is unconfirmed. Refresh saved requested drafts to recover or retry the exact same draft.'
        : error instanceof PreparationHold ? error.message : 'Requested draft preparation is unavailable. Refresh the current account and try again.'; } catch { /* No stale publication. */ }
    } finally { state.busy = false; notify(); }
  }
  return <section aria-label="Requested email preparation">
    <h4>Prepare requested email</h4>
    <p>Connected does not mean email was requested. Use this only for information the recipient requested at this email. Draft creation is not approval or sending.</p>
    <p>Preparation checks current owner and mailbox context and may reconcile already queued owner commands. It does not place a call or create an email approval.</p>
    <label>Recipient email<input aria-label="Recipient email" type="email" maxLength={254} value={email}
      readOnly={state.busy || uncertain || !!saved} onChange={event => setEmail(event.target.value)} /></label>
    <button type="button" disabled={!active || state.busy || uncertain || !!saved || !input.success} onClick={() => void run(false)}>Create unsent requested draft</button>
    {uncertain && <p role="status">{heldElsewhere ? 'Another requested draft creation remains unresolved. Return to its original call to recover it.' : 'Requested draft creation is unconfirmed. No replacement will be created.'}</p>}
    {local && uncertain && <p>Refresh checks saved drafts first. If absent, it retries the same draft ID without creating a replacement.</p>}
    {local && uncertain && <button type="button" disabled={!active || state.busy} onClick={() => void run(true)}>Refresh saved requested drafts</button>}
    {local && state.error && <p role="alert">{state.error}</p>}
    {saved && <p>Draft saved for {saved.recipient}. Continue in Today &gt; Saved draft continuations. <a href="#/today">View saved drafts</a></p>}
    {!active && <p>HOLD: current account and owner context are unavailable. Existing saved drafts remain separate from new preparation.</p>}
  </section>;
}

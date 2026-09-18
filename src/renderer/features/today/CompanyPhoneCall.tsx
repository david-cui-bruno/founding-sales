import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { actualAccountCallOutcomes } from '../../../shared/contracts/accountOutboundContract';
import { dailySnapshotSchema, type DailySnapshot } from '../../../shared/contracts/dailyContract';
import { completeManualCommandSchema, delegationSyncReportSchema, localDelegationStatusSchema } from '../../../shared/contracts/ownerCommandContract';
import { delegatedPhoneHandoffResultSchema } from '../../../shared/contracts/delegationContract';
import { delegatedPhoneStateRequestSchema, type GetPhoneHandoffStateRequest, type PhoneHandoffState } from '../../../shared/contracts/delegatedPhoneStateContract';
import { localCompanyDetailSchema } from '../../../shared/contracts/localWorkspaceContract';
import { phoneSetupStatusSchema } from '../../../shared/contracts/phoneSetupContract';
import { commandReceiptSchema } from '../../../shared/contracts/commandReceiptContract';
import { openSettingsSection } from '../../foundation/settingsNavigation';
import { captureDailySessionScope } from './dailySessionScope';
import { RequestedEmailPreparation } from './RequestedEmailPreparation';
import { describeHandoffHold } from './handoffHoldCopy';
import { allowedPhoneReports, companyPhoneSession, describePhoneOutcome, freezePhoneValue, makePhoneReview, notifyPhoneSession, parsePhoneHistory,
  phoneFreshBinding, phoneHistoryScope, phoneOwner, phoneSelection, type CompanyPhoneApi, type PhoneAttempt,
  type PhoneConfig, type PhoneOutcome, type PhoneReport, type PhoneReview } from './companyPhoneSession';
import { localDateSchema } from '../../../shared/contracts/accountCallbackContract';

type Context = { snapshot: DailySnapshot; config: PhoneConfig; history: PhoneHandoffState };
const actualOutcomes: ReadonlySet<string> = new Set(actualAccountCallOutcomes);
function errorText(error: unknown) { return error instanceof Error ? error.message : 'Phone review unavailable.'; }
function attemptLabel(attempt: PhoneAttempt) {
  if (attempt.receipt.status === 'pending') return 'Owner acknowledgment pending. Do not redial.';
  if (attempt.receipt.status === 'rejected') return `Owner rejected this request: ${attempt.receipt.reason ?? 'reason unavailable'}.`;
  if (attempt.handoff?.consumedAt) return 'One-shot handoff consumed. Do not retry. This is not proof of a connected call.';
  if (attempt.handoff && Date.parse(attempt.handoff.value.expiresAt) <= Date.now()) return 'HOLD: prepared handoff expired without a supported local consumption record. No supported reset or completion is available.';
  return 'Handoff prepared, not consumed locally. This is not proof that no call occurred. Reporting and new handoffs are held.';
}

export function CompanyPhoneCall({ api, snapshot, config, accountId, readError = false, newWorkHold = false, onRefresh }: {
  api: CompanyPhoneApi; snapshot: DailySnapshot; config: PhoneConfig | null; accountId: string;
  readError?: boolean; newWorkHold?: boolean; onRefresh(): void;
}) {
  const [enrollmentChoice, setEnrollmentChoice] = useState('');
  const [stepChoice, setStepChoice] = useState('');
  const choices = snapshot.campaigns.flatMap(campaign => campaign.enrollments
    .filter(enrollment => enrollment.accountId === accountId && campaign.version.steps.some(step => step.channel === 'call'))
    .map(enrollment => ({ campaign, enrollment })));
  const enrollmentId = enrollmentChoice || (choices.length === 1 ? choices[0].enrollment.id : '');
  const selection = choices.find(choice => choice.enrollment.id === enrollmentId);
  const steps = selection?.campaign.version.steps.filter(step => step.channel === 'call') ?? [];
  const stepId = stepChoice || (steps.length === 1 ? steps[0].id : '');
  const workspaceId = snapshot.workspaceId;
  const selectorKey = JSON.stringify([workspaceId, accountId, enrollmentId, stepId]);
  const selector = useMemo(() => {
    const parsed = delegatedPhoneStateRequestSchema.safeParse({ accountId, enrollmentId, stepId });
    return parsed.success ? freezePhoneValue(parsed.data) : null;
  }, [accountId, enrollmentId, stepId]);
  const session = useMemo(() => selector && workspaceId ? companyPhoneSession(api, workspaceId, selector) : null,
    [api.daily, api.delegation, workspaceId, selector]);
  const [, render] = useReducer(value => value + 1, 0);
  const [context, setContext] = useState<Context | null>(null);
  const [stale, setStale] = useState(true);
  const [reading, setReading] = useState(false);
  const [notice, setNotice] = useState('');
  const [review, setReview] = useState<PhoneReview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [handoffChoice, setHandoffChoice] = useState('');
  const [outcome, setOutcome] = useState<PhoneOutcome | ''>('');
  const [observedAt, setObservedAt] = useState('');
  const [reportConfirmed, setReportConfirmed] = useState(false);
  const [optOutConfirmed, setOptOutConfirmed] = useState(false);
  const [note, setNote] = useState('');
  const [callbackOn, setCallbackOn] = useState('');
  const [neverCallReason, setNeverCallReason] = useState('');
  const [neverCallReviewed, setNeverCallReviewed] = useState(false);
  const [neverCallConfirmed, setNeverCallConfirmed] = useState(false);
  const lifetime = useRef(0);
  const readSequence = useRef(0);
  const guard = JSON.stringify([selectorKey, snapshot.workflowMode, snapshot.freshness.kind, snapshot.issues,
    snapshot.accounts.find(account => account.account.id === accountId), selection,
    snapshot.ownerStatus.filter(owner => owner.accountId === accountId), config, readError, newWorkHold]);
  const liveGuard = useRef(guard);
  liveGuard.current = guard;
  const validSnapshot = dailySnapshotSchema.safeParse(snapshot);
  const validConfig = localDelegationStatusSchema.safeParse(config);
  const available = !!(workspaceId && selector && session && validSnapshot.success && validConfig.success && !readError
    && phoneHistoryScope(validSnapshot.data, validConfig.data, workspaceId));
  useLayoutEffect(() => {
    lifetime.current++;
    session?.listeners.add(render);
    setReview(null); setConfirmed(false); setReportConfirmed(false); setOptOutConfirmed(false); setStale(true);
    return () => { lifetime.current++; session?.listeners.delete(render); };
  }, [session, guard, api.daily, api.delegation, api.localWorkspace, api.phoneSetup]);
  useLayoutEffect(() => {
    setContext(null); setNotice(''); setHandoffChoice(''); setOutcome(''); setObservedAt('');
    setNote(''); setCallbackOn(''); setNeverCallReason(''); setNeverCallReviewed(false); setNeverCallConfirmed(false);
  }, [selectorKey]);
  // Selection performs only the selected local history read. Setup and owner
  // reconciliation require their own explicit user action.
  useEffect(() => {
    if (!available || !selector || !workspaceId || !validConfig.success) return;
    const epoch = lifetime.current, sequence = ++readSequence.current;
    let alive = true;
    setReading(true);
    void Promise.resolve().then(() => api.delegation.getPhoneHandoffState(selector)).then(raw => {
      if (!alive || epoch !== lifetime.current || sequence !== readSequence.current) return;
      const history = parsePhoneHistory(raw, selector, snapshot, workspaceId);
      setContext({ snapshot, config: validConfig.data, history }); setStale(false);
    }).catch(error => {
      if (alive && epoch === lifetime.current && sequence === readSequence.current) { setStale(true); setNotice(`HOLD: ${errorText(error)}`); }
    }).finally(() => { if (alive && sequence === readSequence.current) setReading(false); });
    return () => { alive = false; };
    // guard contains the complete selected public context, excluding incidental timestamps.
  }, [session, guard, available]);

  function capture(active = false) {
    if (!available || !workspaceId || !selector) throw Error('Matching readable phone workspace is unavailable.');
    const epoch = lifetime.current, captured = guard;
    const assertActive = active ? captureDailySessionScope(api.delegation, workspaceId) : null;
    return () => {
      if (epoch !== lifetime.current || liveGuard.current !== captured) throw Error('Phone selection or workspace changed.');
      assertActive?.();
    };
  }
  async function readContext(check: () => void, selected: GetPhoneHandoffStateRequest): Promise<Context> {
    check();
    const rawDaily = await api.daily.get(); check();
    const fresh = dailySnapshotSchema.parse(rawDaily);
    const rawConfig = await api.delegation.status(); check();
    const configuration = localDelegationStatusSchema.parse(rawConfig);
    if (!workspaceId || !phoneHistoryScope(fresh, configuration, workspaceId)) throw Error('Matching readable phone workspace is unavailable.');
    phoneSelection(fresh, selected);
    const rawHistory = await api.delegation.getPhoneHandoffState(selected); check();
    const history = parsePhoneHistory(rawHistory, selected, fresh, workspaceId);
    return { snapshot: fresh, config: configuration, history };
  }
  async function readReview(check: () => void, selected: GetPhoneHandoffStateRequest) {
    if (!api.localWorkspace || !api.phoneSetup) throw Error('Saved source detail and phone setup inspection are required.');
    const fresh = await readContext(check, selected); check();
    const rawDetail = await api.localWorkspace.getCompany({ accountId }); check();
    const detail = localCompanyDetailSchema.parse(rawDetail);
    const rawSetup = await api.phoneSetup.status(); check();
    const setup = phoneSetupStatusSchema.parse(rawSetup);
    return { ...fresh, detail, setup };
  }
  function acceptContext(next: Context) {
    if (session && next.history.completeness === 'complete') {
      for (const [id, command] of session.reports) {
        const receipt = next.history.completions.find(record => record.command.commandId === command.commandId);
        if (receipt && receipt.receipt.status !== 'pending') session.reports.delete(id);
      }
    }
    setContext(next); setStale(false);
  }
  async function refreshHistory(reconcile: boolean) {
    if (!available || !selector || !session || session.busy) return;
    session.busy = true; notifyPhoneSession(session); readSequence.current++; setReading(false);
    setReview(null); setConfirmed(false); setReportConfirmed(false);
    let check: (() => void) | null = null;
    try {
      check = capture();
      if (reconcile) { const report = await api.delegation.sync(); check(); delegationSyncReportSchema.parse(report); }
      const next = await readContext(check, selector); check(); acceptContext(next);
      setNotice(reconcile ? 'Owner reconciliation checked. Only saved applied evidence below establishes an outcome.' : 'Local phone history refreshed. Remote freshness is unknown.');
      if (reconcile) onRefresh();
    } catch (error) {
      try { check?.(); setStale(true); setNotice(`HOLD: ${errorText(error)}`); } catch { /* Invalid lifetime cannot publish. */ }
    } finally { session.busy = false; notifyPhoneSession(session); }
  }
  async function prepareReview() {
    if (!available || !selector || !workspaceId || !session || session.busy || session.begin || newWorkHold || reading) return;
    session.busy = true; notifyPhoneSession(session); readSequence.current++; setReading(false);
    setReview(null); setConfirmed(false);
    let check: (() => void) | null = null;
    try {
      check = capture(true);
      if (!api.localWorkspace || !api.phoneSetup) throw Error('Saved source detail and phone setup inspection are required.');
      if (config?.state !== 'active' || config.configuration?.configuration.state !== 'active' || phoneOwner(snapshot, accountId).authority?.state !== 'active') throw Error('New handoff requires active local configuration and account authority.');
      const rawSync = await api.delegation.sync(); check();
      const sync = delegationSyncReportSchema.parse(rawSync);
      if (!sync.ownerFresh || sync.gaps !== 0) throw Error('Current owner evidence is unavailable or incomplete.');
      const next = await readReview(check, selector); check(); acceptContext(next);
      const prepared = makePhoneReview(next.snapshot, next.config, selector, next.detail, next.setup, next.history, workspaceId);
      setReview(prepared); setNotice('Ready to request final owner and phone checks. This is not authorization or proof of a call.');
    } catch (error) {
      try { check?.(); setNotice(`HOLD: ${errorText(error)}`); } catch { /* Invalid lifetime cannot publish. */ }
    } finally { session.busy = false; notifyPhoneSession(session); }
  }
  async function begin() {
    if (!available || !selector || !workspaceId || !session || session.busy || session.bridge.beginning || session.begin || !review || !confirmed || newWorkHold) return;
    // Capture the immutable reviewed request and both latches before any await.
    const captured = review;
    session.busy = true; session.bridge.beginning = true; notifyPhoneSession(session);
    readSequence.current++; setReading(false); setConfirmed(false); setReview(null);
    let check: (() => void) | null = null;
    try {
      check = capture(true);
      const next = await readReview(check, selector); check();
      const current = phoneFreshBinding(next.snapshot, next.config, selector, next.detail, next.setup, next.history, workspaceId);
      if (current.binding !== captured.binding) throw Error('Reviewed phone bindings changed. Check owner and review again before confirming.');
      check();
      session.begin = { request: captured.request, result: null };
      notifyPhoneSession(session);
      const raw = await api.delegation.beginPhone(captured.request); check();
      const result = delegatedPhoneHandoffResultSchema.parse(raw);
      session.begin.result = result;
      setNotice(result.status === 'handoff' && result.result.status === 'handoff_accepted'
        ? 'Apple Phone accepted the handoff request. This does not mean connected or completed.'
        : result.status === 'held' ? `${describeHandoffHold(result.reason)}. No automatic retry is available.`
          : result.status === 'pending' ? 'Owner acknowledgment pending. Do not redial.'
            : 'Handoff result unknown or already consumed. Do not redial from this workflow.');
      const refreshed = await readContext(check, selector); check(); acceptContext(refreshed);
    } catch (error) {
      try { check?.(); setStale(true); setNotice(session.begin ? 'Handoff result unknown. Do not redial. Refresh saved phone history.' : `HOLD: ${errorText(error)}`); } catch { /* Retain uncertain request without publishing to another lifetime. */ }
    } finally { session.busy = false; session.bridge.beginning = false; notifyPhoneSession(session); }
  }
  const history = context?.history;
  const complete = history?.completeness === 'complete' ? history : null;
  const consumed = complete?.attempts.filter(attempt => attempt.handoff?.consumedAt != null) ?? [];
  const handoffId = handoffChoice || (consumed.length === 1 ? consumed[0].handoff!.value.handoffId : '');
  const attempt = consumed.find(value => value.handoff!.value.handoffId === handoffId);
  const allowed = complete && attempt ? allowedPhoneReports(complete, attempt) : [];
  const retainedReport = session?.reports.get(handoffId);
  async function reportOutcome() {
    if (!available || !selector || !workspaceId || !session || session.busy || !context || stale || !complete || !attempt?.handoff
      || !reportConfirmed || !outcome || !allowed.includes(outcome) || retainedReport || outcome === 'opt_out' && !optOutConfirmed) return;
    let command: PhoneReport;
    try {
      const owner = phoneOwner(context.snapshot, accountId), original = attempt.handoff;
      const instant = new Date(observedAt).toISOString();
      if (!original.consumedAt || Date.parse(instant) < Date.parse(original.consumedAt) || Date.parse(instant) > Date.now()) throw Error('Observed time must be at or after consumption and not in the future.');
      if (callbackOn) localDateSchema.parse(callbackOn);
      const commandId = crypto.randomUUID();
      command = freezePhoneValue(completeManualCommandSchema.parse({ commandId, workspaceId, accountId: attempt.command.accountId,
        expectedAuthorityGeneration: owner.authority!.generation, expectedVersion: owner.executionVersion, kind: 'complete-manual',
        payload: { handoffId: original.value.handoffId, targetHash: original.value.targetHash,
          outcome: { actionId: original.value.actionId, channel: 'call', outcome, observedAt: instant, evidenceRef: commandId, replyText: note.trim() ? note : null } } }));
    } catch (error) { setNotice(`HOLD: ${errorText(error)}`); return; }
    session.busy = true; notifyPhoneSession(session); readSequence.current++; setReading(false); setReportConfirmed(false);
    let check: (() => void) | null = null;
    try {
      check = capture();
      const next = await readContext(check, selector); check();
      const owner = phoneOwner(next.snapshot, accountId);
      if (owner.authority!.generation !== command.expectedAuthorityGeneration || owner.executionVersion !== command.expectedVersion) throw Error('Local owner envelope changed. Refresh and confirm the observed report again.');
      if (next.history.completeness !== 'complete') throw Error('Complete original phone history is required.');
      const original = next.history.attempts.find(value => value.command.commandId === attempt.command.commandId);
      if (!original?.handoff || JSON.stringify(original.handoff) !== JSON.stringify(attempt.handoff) || !allowedPhoneReports(next.history, original).includes(outcome)) throw Error('Original consumed handoff or reporting evidence changed.');
      if (command.expectedAuthorityGeneration < original.handoff.authorityGeneration) throw Error('Current local generation precedes the original handoff.');
      check(); session.reports.set(handoffId, command); notifyPhoneSession(session);
      const rawReceipt = await api.delegation.submit(command); check();
      const receipt = commandReceiptSchema.parse(rawReceipt);
      if (receipt.commandId !== command.commandId) throw Error('Report receipt identity mismatch.');
      // Saving the promise is a local record bound to this exact report: a retry reaches the same row,
      // and it never dials, sends, books or queues an owner command of its own.
      let callbackNotice = '';
      if (callbackOn && api.delegation.saveCallback) {
        try {
          const saved = await api.delegation.saveCallback({ accountId: command.accountId, dueOn: callbackOn, note: note.trim() ? note : null, sourceCommandId: command.commandId });
          check(); callbackNotice = ` Callback saved for ${saved.dueOn}; this firm leads Today that morning.`;
        } catch (error) { callbackNotice = ` HOLD: the callback was not saved (${errorText(error)}). The report itself is queued.`; }
      } else if (callbackOn) callbackNotice = ' HOLD: this bridge cannot save a callback. The report itself is queued.';
      setNotice(`Human report queued, awaiting owner-applied evidence. No call is created by reporting.${callbackNotice}`);
      const refreshed = await readContext(check, selector); check(); acceptContext(refreshed); onRefresh();
    } catch (error) {
      try { check?.(); setStale(true); setNotice(session.reports.has(handoffId) ? 'Human report result unknown. Its exact command is retained. Reconcile phone history, do not submit a replacement.' : `HOLD: ${errorText(error)}`); } catch { /* Original report stays retained across teardown. */ }
    } finally { session.busy = false; notifyPhoneSession(session); }
  }
  async function neverCall() {
    if (!available || busy || !neverCallReviewed || !neverCallConfirmed || !neverCallReason.trim()) return;
    if (!api.delegation.neverCall) { setNotice('HOLD: this bridge cannot record a never-call decision.'); return; }
    let check: (() => void) | null = null;
    try {
      check = capture();
      // Suppression only. No handoff is prepared, no number is dialed and no outcome is recorded.
      const receipt = await api.delegation.neverCall({ accountId, commandId: crypto.randomUUID(), reason: neverCallReason.trim() });
      check();
      setNeverCallReviewed(false); setNeverCallConfirmed(false); setNeverCallReason('');
      setNotice(`Never call recorded at ${receipt.observedAt}. This firm is suppressed; no call was placed and no outcome was recorded.`);
      onRefresh();
    } catch (error) {
      try { check?.(); setNotice(`HOLD: ${errorText(error)}`); } catch { /* Invalid lifetime cannot publish. */ }
    }
  }
  const busy = !!session?.busy || reading;
  // The call card's "last outcome and note" line: the newest owner-applied human report in this complete local history.
  const lastApplied = complete?.completions
    .filter(record => record.applied !== null)
    .sort((a, b) => b.applied!.outcome.observedAt.localeCompare(a.applied!.outcome.observedAt))[0]?.applied ?? null;
  return <section className="native-desk__call" aria-label="Company phone review">
    <h3>Company phone review</h3>
    <p data-testid="last-outcome">Last outcome: {lastApplied
      ? `${lastApplied.outcome.outcome.replaceAll('_', ' ')} at ${lastApplied.outcome.observedAt}${lastApplied.outcome.replyText ? ` · note: ${lastApplied.outcome.replyText}` : ''}`
      : complete ? 'none recorded for this step' : 'unknown until the saved phone history is read'}</p>
    <p>Nominated for review, not authorized to call. Selection alone never places a call.</p>
    <p><a href="#/settings" onClick={() => openSettingsSection('phone')}>Review phone setup</a>. Phone setup is handoff readiness only, not call permission.</p>
    {!selection || !stepId ? <p className="native-desk__hold">Call handoff unavailable in this account view. Select a saved company enrollment and call step. Review an approved company-only call campaign in <a href="#/campaigns">Campaigns</a>. No person is required for an eligible company phone route.</p> : null}
    <label>Phone enrollment<select style={{ paddingBlock: 0 }} aria-label="Phone enrollment" value={enrollmentId} disabled={busy} onChange={event => { setEnrollmentChoice(event.target.value); setStepChoice(''); }}>
      <option value="">Choose saved enrollment</option>{choices.map(({ enrollment, campaign }) => <option key={`${campaign.version.id}:${enrollment.id}`} value={enrollment.id}>{enrollment.id} · {campaign.version.id} · {enrollment.state}</option>)}
    </select></label>
    <label>Phone step<select style={{ paddingBlock: 0 }} aria-label="Phone step" value={stepId} disabled={busy} onChange={event => setStepChoice(event.target.value)}>
      <option value="">Choose saved call step</option>{steps.map(step => <option key={step.id} value={step.id}>{step.id}</option>)}
    </select></label>
    {!available && <p role="status">HOLD: {selector && workspaceId && !session ? 'Phone session capacity reached. Unresolved work will not be evicted.' : 'A matching readable paired workspace and saved call selection are required.'}</p>}
    <p>Check owner and review call explicitly reconciles already queued owner commands across this workspace. It checks saved source evidence and phone readiness. Final policy, inbound safety and current owner checks still run inside the handoff and may return HOLD.</p>
    <button disabled={!available || busy || !!session?.begin || newWorkHold || !!complete?.attempts.length || history?.completeness === 'incomplete'} onClick={() => void prepareReview()}>Check owner and review call</button>
    {review && <div>
      <h4>Review exact destination and call purpose</h4><p>{review.detail.snapshot.account.name} · {review.target}</p>
      <p>Saved route verification: {review.detail.snapshot.routes.find(route => route.id === review.request.command.payload.routeId)?.verification}. Business phone evidence is not DNC, policy or calling permission.</p>
      <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{review.offer}</pre>
      <p>Enrollment {enrollmentId} · call step {stepId}</p>
      {review.detail.sources.filter(source => review.detail.snapshot.routes.find(route => route.id === review.request.command.payload.routeId)?.evidenceIds.includes(source.id)).map(source => <details key={source.id}><summary>Saved phone evidence: {source.url}</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{source.excerpt}</pre></details>)}
      <p>Final confirmation asks the current owner for one handoff and may open Apple Phone. Prepared or accepted is not connected. A prepared unconsumed hold has no supported reset here.</p>
      <label><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />I confirm the displayed destination and call purpose</label>
      <button disabled={!confirmed || busy || !!session?.begin || !!session?.bridge.beginning || !available} onClick={() => void begin()}>Call with Phone.app</button>
      <button disabled={busy} onClick={() => { setReview(null); setConfirmed(false); }}>Cancel call review</button>
    </div>}
    <h4>Saved phone history</h4>
    <p>Local snapshot. Remote freshness is unknown. Historical access does not grant a new call.</p>
    <button disabled={!available || busy} onClick={() => void refreshHistory(false)}>Refresh phone history</button>
    <p>Reconcile phone history explicitly retries already queued owner commands across this workspace. It does not redial a consumed handoff.</p>
    <button disabled={!available || busy} onClick={() => void refreshHistory(true)}>Reconcile phone history</button>
    {stale && context && <p role="status">HOLD: last-known phone history is stale. It is not action permission.</p>}
    {history?.completeness === 'incomplete' && <p role="status">HOLD: incomplete phone history ({history.issue}). Do not infer an empty history or retry.</p>}
    {complete && complete.attempts.length === 0 && <p>No saved handoff attempt in this complete local history. Remote freshness is unknown.</p>}
    {session?.begin && <p>Retained handoff request {session.begin.request.command.commandId}. No retry or replacement call is available.</p>}
    {complete?.attempts.map(saved => <article key={saved.command.commandId}>
      <h5>Saved request {saved.command.commandId}</h5><p>{attemptLabel(saved)}</p>
      <p>Original route {saved.command.payload.routeId} · version {saved.command.payload.routeVersion} · target hash {saved.command.payload.targetHash}</p>
      {saved.handoff && <p>Handoff {saved.handoff.value.handoffId} · consumed at {saved.handoff.consumedAt ?? 'not recorded'} · expires at {saved.handoff.value.expiresAt}</p>}
      {complete.completions.filter(record => record.prepareCommandId === saved.command.commandId).map(record => <div key={record.command.commandId}><p>
        {record.applied && record.receiptEvent ? `Applied human-reported outcome: ${record.applied.outcome.outcome} at ${record.applied.outcome.observedAt}. ${complete.completions.some(other => other.prepareCommandId === saved.command.commandId && other.applied?.evidence.conflict) ? 'Conflicting evidence. Not an actual-call success.' : actualOutcomes.has(record.applied.outcome.outcome) ? 'Human-reported actual attempt, not a native connected-call observation.' : 'This outcome alone is not an actual call.'}` : record.receipt.status === 'pending' ? 'Human report queued, awaiting owner-applied evidence.' : `Human report rejected: ${record.receipt.reason ?? 'reason unavailable'}.`} Command {record.command.commandId}.
      </p>{record.applied?.originalCall && selector && <RequestedEmailPreparation
        key={JSON.stringify([snapshot.workspaceId, record.command.commandId])} api={api} snapshot={snapshot} config={config}
        selector={selector} originalCall={record.applied.originalCall} unavailable={!available || busy || stale || newWorkHold} onRefresh={onRefresh} />}</div>)}
    </article>)}
    {consumed.length > 0 && <fieldset disabled={!available || busy || stale}>
      <legend>Report an observed phone outcome</legend>
      <label>Consumed handoff<select style={{ paddingBlock: 0 }} aria-label="Consumed handoff" value={handoffId} onChange={event => { setHandoffChoice(event.target.value); setOutcome(''); setObservedAt(''); setReportConfirmed(false); setOptOutConfirmed(false); }}><option value="">Choose original consumed handoff</option>{consumed.map(value => <option key={value.command.commandId} value={value.handoff!.value.handoffId}>{value.handoff!.value.handoffId}</option>)}</select></label>
      <label>Observed phone outcome<select style={{ paddingBlock: 0 }} aria-label="Observed phone outcome" value={outcome} disabled={!allowed.length || !!retainedReport} onChange={event => { setOutcome(event.target.value as PhoneOutcome | ''); setReportConfirmed(false); setOptOutConfirmed(false); }}><option value="">Choose observed outcome</option>{allowed.map(value => <option key={value} value={value}>{describePhoneOutcome(value)}</option>)}</select></label>
      <label>Observed at (local time)<input aria-label="Observed at (local time)" type="datetime-local" step="1" value={observedAt} onChange={event => { setObservedAt(event.target.value); setReportConfirmed(false); }} /></label>
      <p>Enter when you actually observed this outcome, at or after consumption and not in the future. This is a human report, not provider evidence. Saving queues the report without automatic owner reconciliation.</p>
      <label>Note<textarea aria-label="Note" rows={3} maxLength={10000} value={note} onChange={event => { setNote(event.target.value); setReportConfirmed(false); }} /></label>
      <p>Your own words about this call. The note is stored with the report and shown on the card&apos;s last-outcome line. It is never sent anywhere.</p>
      <label>Call back on<input aria-label="Call back on" type="date" value={callbackOn} onChange={event => { setCallbackOn(event.target.value); setReportConfirmed(false); }} /></label>
      <p>A business day in the firm&apos;s own time zone. Saving the promise records it locally and puts this firm first on Today that morning. It never dials, sends or books.</p>
      <label><input type="checkbox" checked={reportConfirmed} onChange={event => setReportConfirmed(event.target.checked)} />I confirm this observed outcome and time</label>
      {outcome === 'opt_out' && <label><input type="checkbox" checked={optOutConfirmed} onChange={event => setOptOutConfirmed(event.target.checked)} />I confirm the explicit opt-out and immediate account suppression</label>}
      <button disabled={!outcome || !observedAt || !reportConfirmed || !!retainedReport || !allowed.includes(outcome) || outcome === 'opt_out' && !optOutConfirmed} onClick={() => void reportOutcome()}>Record phone outcome</button>
      {retainedReport && <p>Exact human report {retainedReport.commandId} is retained. Reconcile its existing command rather than submitting a replacement.</p>}
      {!allowed.length && <p>HOLD: pending, settled or conflicting evidence does not permit a replacement report.</p>}
    </fieldset>}
    <fieldset disabled={!available || busy}>
      <legend>Never call this firm</legend>
      <p>This is not a call outcome and it never dials. It writes the same account suppression the explicit opt-out outcome writes, and nothing else. It cannot be undone from here.</p>
      <label>Why this firm should never be called<textarea aria-label="Why this firm should never be called" rows={2} maxLength={2000} value={neverCallReason}
        onChange={event => { setNeverCallReason(event.target.value); setNeverCallReviewed(false); setNeverCallConfirmed(false); }} /></label>
      <label><input type="checkbox" checked={neverCallReviewed} onChange={event => { setNeverCallReviewed(event.target.checked); setNeverCallConfirmed(false); }} />I have read the reason above and it is about this firm</label>
      <label><input type="checkbox" checked={neverCallConfirmed} disabled={!neverCallReviewed} onChange={event => setNeverCallConfirmed(event.target.checked)} />I confirm permanent suppression of this firm</label>
      <button disabled={!neverCallReason.trim() || !neverCallReviewed || !neverCallConfirmed} onClick={() => void neverCall()}>Never call this firm</button>
    </fieldset>
    {notice && <p role="status">{notice}</p>}
  </section>;
}

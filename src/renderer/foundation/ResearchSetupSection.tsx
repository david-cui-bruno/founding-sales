import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import {
  researchSetupApproveInputSchema, researchSetupReceiptSchema, researchSetupStatusSchema,
  type ResearchSetupApi, type ResearchSetupBlocker, type ResearchSetupStatus,
} from '../../shared/contracts/researchSetupContract';

type Lifetime = { api: ResearchSetupApi; busy: boolean };
type View = { owner: Lifetime | null; status: ResearchSetupStatus | null; fresh: boolean; busy: boolean; uncertain: boolean; message: string };
const emptyView = (owner: Lifetime | null): View => ({ owner, status: null, fresh: false, busy: false, uncertain: false, message: '' });
const labels = {
  regions: 'Residential regions, one per line', terms: 'Targeting terms, one per line', websites: 'Official website URLs, one per line',
  companies: 'Maximum companies (1–50)', pages: 'Maximum pages (1–10)', bytes: 'Maximum bytes (1–1,000,000)',
  discovery: 'Discovery cumulative ceiling (USD)', research: 'Research cumulative ceiling (USD)',
};
type Fields = Record<keyof typeof labels, string>;
const initialFields: Fields = { regions: '', terms: '', websites: '', companies: '', pages: '', bytes: '', discovery: '', research: '' };
const blockers: Record<ResearchSetupBlocker, string> = {
  needs_pairing: 'Needs pairing. Connect your Worker first.', operator_descriptor_missing: 'Needs operator setup: reviewed settings are missing.',
  operator_descriptor_invalid: 'Needs operator setup: reviewed settings are invalid.', operator_descriptor_expired: 'Needs operator setup: review has expired.',
  credential_parameter_missing: 'Needs operator setup: credential parameter is not declared.', legacy_or_orphan_state: 'Existing legacy or orphan policy needs operator reconciliation.',
  descriptor_changed: 'Operator settings changed. Operator reconciliation is required.', budget_corrupt: 'Budget status needs operator reconciliation.',
  state_corrupt: 'Policy status needs operator reconciliation.', unavailable: 'Cloud research status is unavailable.',
  local_pending: 'A request has an unknown outcome.', local_journal_unavailable: 'Local request journal is unavailable. Mutations are blocked.',
};
const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')} USD`;
function money(value: string) {
  if (!/^\d+(?:\.\d{1,6})?$/.test(value)) return NaN;
  const [whole, fraction = ''] = value.split('.');
  const result = Number(whole) * 1_000_000 + Number(fraction.padEnd(6, '0'));
  return Number.isSafeInteger(result) ? result : NaN;
}
const lines = (value: string) => value.split('\n').map(line => line.trim());

/** Status never starts research. All mutations require an explicit operator gesture. */
export function ResearchSetupSection({ api }: { api?: ResearchSetupApi }) {
  const owner = useRef<Lifetime | null>(null);
  const [view, setView] = useState<View>(() => emptyView(null));
  const [fields, setFields] = useState<Fields>(initialFields);
  const [acknowledged, setAcknowledged] = useState(false);
  const update = useCallback((lifetime: Lifetime, patch: Partial<View>) => {
    if (owner.current !== lifetime) return;
    setView(previous => previous.owner === lifetime ? { ...previous, ...patch } : previous);
  }, []);
  const read = useCallback(async (lifetime: Lifetime) => {
    if (owner.current !== lifetime || lifetime.busy) return;
    lifetime.busy = true;
    setAcknowledged(false);
    update(lifetime, { fresh: false, busy: true, message: 'Checking cloud research status…' });
    try {
      const status = researchSetupStatusSchema.parse(await lifetime.api.status());
      update(lifetime, { status, fresh: true, uncertain: !!status.pending || status.blockers.includes('local_pending'), message: '' });
    } catch {
      update(lifetime, { message: 'Cloud research status is unavailable. Refresh to check again. No request was retried.' });
    } finally {
      lifetime.busy = false;
      update(lifetime, { busy: false });
    }
  }, [update]);
  useLayoutEffect(() => {
    const lifetime = api ? { api, busy: false } : null;
    owner.current = lifetime;
    setView(emptyView(lifetime));
    setFields(initialFields);
    setAcknowledged(false);
    if (lifetime) void read(lifetime);
    return () => { if (owner.current === lifetime) owner.current = null; };
  }, [api, read]);

  const current = view.owner?.api === api && owner.current === view.owner;
  const status = current ? view.status : null;
  const remote = status?.remote;
  const descriptor = remote?.descriptor;
  const blocked = [...new Set([...(status?.blockers ?? []), ...(remote?.blockers ?? [])])];
  const pending = !!status?.pending || (current && view.uncertain) || blocked.includes('local_pending');
  const busy = !current || view.busy;
  const descriptorCurrent = !!descriptor && !!remote?.descriptorFingerprint && Date.parse(descriptor.reviewedAt) <= Date.now() && Date.parse(descriptor.expiresAt) > Date.now();
  const selector = remote?.selector;
  const editable = !!api && current && view.fresh && !busy && !pending && !selector;
  const proposal = researchSetupApproveInputSchema.safeParse({ expectedRevision: 0, descriptorFingerprint: remote?.descriptorFingerprint,
    audience: { residential: true, regions: lines(fields.regions), terms: lines(fields.terms) }, permittedSources: lines(fields.websites),
    maxCompanies: Number(fields.companies), maxPages: Number(fields.pages), maxBytes: Number(fields.bytes),
    discoveryCeilingMicros: money(fields.discovery), researchCeilingMicros: money(fields.research), disclosureAcknowledged: true });
  const reservationsFit = proposal.success && !!descriptor && proposal.data.discoveryCeilingMicros >= descriptor.capability.searchCostMicros + descriptor.capability.modelCostMicros && proposal.data.researchCeilingMicros >= descriptor.researchReservationMicros;
  const canApprove = editable && acknowledged && descriptorCurrent && remote?.credentialParameterDeclared && blocked.length === 0 && proposal.success && reservationsFit;
  const pauseBlockers = blocked.filter(blocker => !['operator_descriptor_missing', 'operator_descriptor_invalid', 'operator_descriptor_expired', 'descriptor_changed', 'credential_parameter_missing'].includes(blocker));
  const canState = !!selector && current && view.fresh && !busy && !pending && acknowledged && (selector.state === 'active' ? pauseBlockers.length === 0 : blocked.length === 0 && descriptorCurrent && remote?.credentialParameterDeclared);

  async function mutate(action: 'approve' | 'state' | 'retry' | 'cancel') {
    const lifetime = owner.current;
    if (!lifetime || lifetime.api !== api || lifetime.busy) return;
    if (action === 'approve' && (!canApprove || !proposal.success || !descriptor || Date.parse(descriptor.expiresAt) <= Date.now())) return;
    if (action === 'state' && (!canState || !selector || (selector.state === 'paused' && (!descriptor || Date.parse(descriptor.expiresAt) <= Date.now())))) return;
    if ((action === 'retry' || action === 'cancel') && !pending) return;
    lifetime.busy = true;
    setAcknowledged(false);
    update(lifetime, { busy: true, fresh: false, uncertain: true, message: 'Request outcome pending.' });
    try {
      const raw = action === 'approve' && proposal.success ? await lifetime.api.approve(proposal.data)
        : action === 'state' && selector ? await lifetime.api.setState({ state: selector.state === 'active' ? 'paused' : 'active', expectedRevision: selector.revision, disclosureAcknowledged: true })
        : action === 'cancel' ? await lifetime.api.cancelPending() : await lifetime.api.retry();
      if (owner.current !== lifetime) return;
      const receipt = researchSetupReceiptSchema.parse(raw);
      if ((remote && (receipt.workspaceId !== remote.workspaceId || receipt.pairingId !== remote.pairingId)) ||
          (status?.pending && (receipt.requestId !== status.pending.requestId || receipt.kind !== status.pending.kind)) ||
          (action === 'approve' && receipt.kind !== 'approve') || (action === 'state' && receipt.kind !== 'set-state') ||
          (receipt.status === 'applied' && action === 'approve' && (receipt.revision !== 1 || receipt.state !== 'active')) ||
          (receipt.status === 'applied' && action === 'state' && selector && (receipt.revision !== selector.revision + 1 || receipt.state !== (selector.state === 'active' ? 'paused' : 'active')))) throw new Error('receipt mismatch');
      update(lifetime, { uncertain: false, status: null, message: receipt.status === 'cancelled'
        ? 'Pending request cancelled. Refresh for current policy before another action.'
        : action === 'cancel' ? 'Request was already applied. Cancellation cannot undo applied work. Refresh for current policy.'
          : 'Research policy request applied. Refresh for current policy. This is not proof of provider connectivity or schedule activation.' });
    } catch {
      update(lifetime, { message: 'Request outcome unknown. New edits and commands are blocked. Refresh status, Retry the exact stored request, or Cancel pending request.' });
    } finally {
      lifetime.busy = false;
      update(lifetime, { busy: false });
    }
  }

  return <section className="settings__section settings-google-connections" aria-label="Cloud research">
    <h2 className="settings__section-title">Cloud research</h2>
    <p className="settings__quiet">Bounded residential company research only. This grants no mail or calendar permission and does not activate schedules. Pause cannot recall in-flight work or stop other cloud operations.</p>
    <p>Cumulative ceilings are totals, not top-ups or resets. Reserved-or-spent balances include conservative reservations, not verified invoice spend.</p>
    {!api && <p role="status">Cloud research is unavailable in this app connection.</p>}
    {api && <button type="button" className="settings__action" disabled={busy} onClick={() => { if (owner.current) void read(owner.current); }}>Refresh</button>}
    {current && view.message && <p role="status">{view.message}</p>}
    {blocked.map(blocker => <p key={blocker}>{blockers[blocker]}</p>)}
    {descriptor && <div>
      <h3>Operator-reviewed settings</h3>
      <p>Operator assertions, not live connectivity proof or verified invoice pricing.</p>
      <dl className="settings__counters">
        <div><dt>Model</dt><dd>{descriptor.capability.model}</dd></div>
        <div><dt>Provenance</dt><dd>{descriptor.provenance}</dd></div>
        <div><dt>Reviewed at</dt><dd>{descriptor.reviewedAt}</dd></div>
        <div><dt>Expires at</dt><dd>{descriptor.expiresAt}</dd></div>
        <div><dt>Discovery reservation per job</dt><dd>{usd(descriptor.capability.searchCostMicros + descriptor.capability.modelCostMicros)}</dd></div>
        <div><dt>Research reservation per job</dt><dd>{usd(descriptor.researchReservationMicros)}</dd></div>
      </dl>
      {!descriptorCurrent && <p>Operator review is not current. Approval and resume are blocked.</p>}
    </div>}
    {remote && <p>Credential parameter {remote.credentialParameterDeclared ? 'declared' : 'not declared'}. A declaration does not prove credential or provider access works. Status checked: {remote.checkedAt}.</p>}
    {(['discoveryLedger', 'researchLedger'] as const).map((key) => {
      const ledger = remote?.[key];
      return <p key={key}>{key === 'discoveryLedger' ? 'Discovery' : 'Research'} balance: {ledger ? `cumulative ceiling ${usd(ledger.limitMicros)}, reserved-or-spent ${usd(ledger.reservedOrSpentMicros)}, remaining ${usd(ledger.remainingMicros)}` : 'unavailable, not assumed zero'}.</p>;
    })}
    {remote?.discoveryLedger && remote.researchLedger && <p>Total combined cumulative ceiling: {usd(remote.discoveryLedger.limitMicros + remote.researchLedger.limitMicros)}</p>}
    {selector ? <div>
      <h3>Existing policy (read-only): {selector.state}</h3>
      {selector.research && <>
        <p>Residential regions: {selector.research.audience.regions.join(', ')}. Targeting terms: {selector.research.audience.terms.join(', ')}.</p>
        <p>Official websites: {selector.research.permittedSources.join(', ')}</p>
        <p>Maximum companies: {selector.research.discoveryLimits.maxCompanies}. Maximum pages: {selector.research.researchLimits.maxPages}. Maximum bytes: {selector.research.researchLimits.maxBytes}.</p>
        <p>Policy model: {selector.research.capability.model}. Targeting and cumulative ceilings cannot be edited here.</p>
      </>}
    </div> : <fieldset disabled={!editable}>
      <legend>First-use research policy</legend>
      {(Object.keys(labels) as (keyof Fields)[]).map(key => <label className="settings__row" key={key}>
        {labels[key]}
        {['regions', 'terms', 'websites'].includes(key) ? <textarea aria-label={labels[key]} required rows={3} value={fields[key]}
          onChange={event => { setFields(previous => ({ ...previous, [key]: event.target.value })); setAcknowledged(false); }} />
          : <input aria-label={labels[key]} required value={fields[key]} inputMode="decimal"
            onChange={event => { setFields(previous => ({ ...previous, [key]: event.target.value })); setAcknowledged(false); }} />}
      </label>)}
      <p>Enter positive USD totals with at most six decimal places. Each ceiling must cover the operator reservation. Limits must be whole numbers within the displayed bounds.</p>
      {proposal.success && <p>Total combined cumulative ceiling: {usd(proposal.data.discoveryCeilingMicros + proposal.data.researchCeilingMicros)}</p>}
    </fieldset>}
    <label className="settings__row"><input type="checkbox" checked={acknowledged} disabled={!api || busy || pending || !view.fresh} onChange={event => setAcknowledged(event.target.checked)} /> I have reviewed the targeting, cumulative ceilings, operator assertions and limitations above</label>
    {selector ? <button type="button" className="settings__action" disabled={!canState} onClick={() => void mutate('state')}>{selector.state === 'active' ? 'Pause research' : 'Resume research'}</button>
      : <button type="button" className="settings__action" disabled={!canApprove} onClick={() => void mutate('approve')}>Approve research</button>}
    {pending && <div>
      <p>Pending request has an unknown outcome. Retry sends the exact stored request without changing its inputs. Cancellation cannot undo already applied work.</p>
      <button type="button" className="settings__action" disabled={busy} onClick={() => void mutate('retry')}>Retry exact pending request</button>
      <button type="button" className="settings__action" disabled={busy} onClick={() => void mutate('cancel')}>Cancel pending request</button>
    </div>}
  </section>;
}

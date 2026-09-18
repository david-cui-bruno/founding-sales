import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import {
  researchSetupApproveInputSchema, researchSetupReceiptSchema, researchSetupStatusSchema,
  type ResearchSetupApi, type ResearchSetupBlocker, type ResearchSetupStatus, type ResearchSetupReceipt,
} from '../../shared/contracts/researchSetupContract';

type AppliedStateReceipt = Extract<ResearchSetupReceipt, { status: 'applied' }>;
const appliedConfirmation = 'Research policy request applied. This is not proof of provider connectivity or schedule activation.';
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
type DiscoveryProvider = 'responses_cited' | 'places';
const providerNames: Record<DiscoveryProvider, string> = { responses_cited: 'Cited web search (one company)', places: 'Google Places (territory batches)' };
/** Places takes one page of firms per batch and needs no hand-typed website list; every other field keeps its cited wording. */
const placesLabels: typeof labels = { ...labels, companies: 'Companies per batch (1–20)' };
const fieldKeys = (provider: DiscoveryProvider) => (Object.keys(labels) as (keyof Fields)[]).filter(key => provider !== 'places' || key !== 'websites');
const blockers: Record<ResearchSetupBlocker, string> = {
  needs_pairing: 'Needs pairing. Connect your Worker first.', operator_descriptor_missing: 'Needs operator setup: reviewed settings are missing.',
  operator_descriptor_invalid: 'Needs operator setup: reviewed settings are invalid.', operator_descriptor_expired: 'Needs operator setup: review has expired.',
  credential_parameter_missing: 'Needs operator setup: credential parameter is not declared.', legacy_or_orphan_state: 'Existing legacy or orphan policy needs operator reconciliation.',
  descriptor_changed: 'Operator settings changed. Operator reconciliation is required.', budget_corrupt: 'Budget status needs operator reconciliation.',
  state_corrupt: 'Policy status needs operator reconciliation.', unavailable: 'Cloud research status is unavailable.',
  local_pending: 'A request has an unknown outcome.', local_journal_unavailable: 'Local request journal is unavailable. Mutations are blocked.',
  places_credential_parameter_missing: 'Needs operator setup: the Google Places credential parameter is not declared.', places_cost_missing: 'Needs operator setup: reviewed settings carry no Places cost per call.',
};
const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')} USD`;
function money(value: string) {
  if (!/^\d+(?:\.\d{1,6})?$/.test(value)) return NaN;
  const [whole, fraction = ''] = value.split('.');
  const result = Number(whole) * 1_000_000 + Number(fraction.padEnd(6, '0'));
  return Number.isSafeInteger(result) ? result : NaN;
}
const lines = (value: string) => value.split('\n').map(line => line.trim());
/** Micros back to the decimal USD string the ceiling inputs accept; integer arithmetic only. */
const decimal = (micros: number) => `${Math.floor(micros / 1_000_000)}.${String(micros % 1_000_000).padStart(6, '0')}`.replace(/\.?0+$/, '');
const replaceNote = 'Replacing keeps spent budget and the admission fence; it changes what the worker discovers next.';

/** Status never starts research. All mutations require an explicit operator gesture. */
export function ResearchSetupSection({ api }: { api?: ResearchSetupApi }) {
  const owner = useRef<Lifetime | null>(null);
  /** Which stored policy the replace form was last prefilled from; a same-revision Refresh keeps in-progress edits. */
  const prefilled = useRef<string | null>(null);
  const [view, setView] = useState<View>(() => emptyView(null));
  const [fields, setFields] = useState<Fields>(initialFields);
  const [provider, setProvider] = useState<DiscoveryProvider>('responses_cited');
  const [acknowledged, setAcknowledged] = useState(false);
  const update = useCallback((lifetime: Lifetime, patch: Partial<View>) => {
    if (owner.current !== lifetime) return;
    setView(previous => previous.owner === lifetime ? { ...previous, ...patch } : previous);
  }, []);
  const read = useCallback(async (lifetime: Lifetime, appliedStateReceipt?: AppliedStateReceipt) => {
    if (owner.current !== lifetime || lifetime.busy) return;
    lifetime.busy = true;
    setAcknowledged(false);
    update(lifetime, { fresh: false, busy: true, message: appliedStateReceipt ? `${appliedConfirmation} Checking current policy status…` : 'Checking cloud research status…' });
    try {
      const status = researchSetupStatusSchema.parse(await lifetime.api.status());
      if (owner.current !== lifetime) return;
      if (appliedStateReceipt) {
        const remote = status.remote;
        const selector = remote?.selector;
        if (!remote || !selector || remote.workspaceId !== appliedStateReceipt.workspaceId || remote.pairingId !== appliedStateReceipt.pairingId ||
            selector.workspaceId !== appliedStateReceipt.workspaceId || selector.pairingId !== appliedStateReceipt.pairingId ||
            selector.revision < appliedStateReceipt.revision || (selector.revision === appliedStateReceipt.revision && selector.state !== appliedStateReceipt.state)) {
          throw new Error('follow-up status mismatch');
        }
      }
      const stored = status.remote?.selector;
      if (status.remote && stored?.research) {
        const key = `${status.remote.workspaceId}|${status.remote.pairingId}|${stored.revision}`;
        if (prefilled.current !== key) {
          prefilled.current = key;
          const research = stored.research;
          setProvider(research.discoveryProvider === 'places' ? 'places' : 'responses_cited');
          setFields({ regions: research.audience.regions.join('\n'), terms: research.audience.terms.join('\n'), websites: research.permittedSources.join('\n'),
            companies: String(research.discoveryLimits.maxCompanies), pages: String(research.researchLimits.maxPages), bytes: String(research.researchLimits.maxBytes),
            discovery: status.remote.discoveryLedger ? decimal(status.remote.discoveryLedger.limitMicros) : '', research: status.remote.researchLedger ? decimal(status.remote.researchLedger.limitMicros) : '' });
        }
      }
      update(lifetime, { status, fresh: true, uncertain: !!status.pending || status.blockers.includes('local_pending'), message: appliedStateReceipt ? appliedConfirmation : '' });
    } catch {
      update(lifetime, { message: appliedStateReceipt ? `${appliedConfirmation} Follow-up status could not be verified. Policy and balances remain last observed. Refresh before another command. No request was retried.` : 'Cloud research status is unavailable. Refresh to check again. No request was retried.' });
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
    setProvider('responses_cited');
    prefilled.current = null;
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
  const existing = selector?.research ?? null;
  const editable = !!api && current && view.fresh && !busy && !pending && !selector;
  const replaceable = !!api && current && view.fresh && !busy && !pending && !!existing;
  const formShown = !selector || !!existing;
  // Two providers matter: the stored policy's own (read-only display, pause and resume) and the one selected in the form (the proposal).
  const activeTerritory = existing?.discoveryProvider === 'places';
  const proposalTerritory = provider === 'places';
  const currentLabels = proposalTerritory ? placesLabels : labels;
  // A first-use proposal carries revision 0; a replacement names exactly the stored revision the owner is looking at.
  const proposal = researchSetupApproveInputSchema.safeParse({ expectedRevision: selector?.revision ?? 0, descriptorFingerprint: remote?.descriptorFingerprint,
    audience: { residential: true, regions: lines(fields.regions), terms: lines(fields.terms) }, permittedSources: proposalTerritory ? [] : lines(fields.websites),
    maxCompanies: Number(fields.companies), maxPages: Number(fields.pages), maxBytes: Number(fields.bytes),
    discoveryCeilingMicros: money(fields.discovery), researchCeilingMicros: money(fields.research), disclosureAcknowledged: true, ...(proposalTerritory ? { discoveryProvider: 'places' } : {}) });
  // Places reserves the reviewed cost of one text-search call per batch; the cited provider reserves search plus model per run.
  const discoveryReservation = !descriptor ? null : proposalTerritory ? descriptor.placesSearchCostMicros ?? null : descriptor.capability.searchCostMicros + descriptor.capability.modelCostMicros;
  const reservationsFit = proposal.success && !!descriptor && discoveryReservation !== null && proposal.data.discoveryCeilingMicros >= discoveryReservation && proposal.data.researchCeilingMicros >= descriptor.researchReservationMicros;
  // Places readiness comes from the worker's Places fields; a worker predating them reports none, which means not ready for Places.
  const placesBlockers: ResearchSetupBlocker[] = remote ? [...new Set([...(remote.placesBlockers ?? ['places_credential_parameter_missing' as const]), ...(remote.placesCredentialParameterDeclared === true ? [] : ['places_credential_parameter_missing' as const])])] : [];
  const blockersFor = (places: boolean): ResearchSetupBlocker[] => places ? [...new Set([...blocked.filter(blocker => blocker !== 'credential_parameter_missing'), ...placesBlockers])] : blocked;
  const credentialReadyFor = (places: boolean) => places ? remote?.placesCredentialParameterDeclared === true : remote?.credentialParameterDeclared;
  const activeBlocked = blockersFor(activeTerritory);
  // A changed operator descriptor holds the stored policy (pause, resume, research) but never the replacement that
  // repairs it: the worker's replace transaction rebinds the marker to the current fingerprint carried in the proposal.
  const proposalBlocked = blockersFor(proposalTerritory).filter(blocker => !(existing && blocker === 'descriptor_changed'));
  // Every reason an offered action is held is shown: the stored policy's own gaps and, while a form is offered, the proposal's.
  const shownBlocked = [...new Set([...(selector ? activeBlocked : []), ...(formShown ? proposalBlocked : [])])];
  const placesRelevant = activeTerritory || (formShown && proposalTerritory);
  const proposalReady = acknowledged && descriptorCurrent && credentialReadyFor(proposalTerritory) && proposalBlocked.length === 0 && proposal.success && reservationsFit;
  const canApprove = editable && proposalReady;
  const canReplace = replaceable && proposalReady;
  const pauseBlockers = activeBlocked.filter(blocker => !['operator_descriptor_missing', 'operator_descriptor_invalid', 'operator_descriptor_expired', 'descriptor_changed', 'credential_parameter_missing', 'places_credential_parameter_missing', 'places_cost_missing'].includes(blocker));
  const canState = !!selector && current && view.fresh && !busy && !pending && acknowledged && (selector.state === 'active' ? pauseBlockers.length === 0 : activeBlocked.length === 0 && descriptorCurrent && credentialReadyFor(activeTerritory));

  async function mutate(action: 'approve' | 'replace' | 'state' | 'retry' | 'cancel') {
    const lifetime = owner.current;
    if (!lifetime || lifetime.api !== api || lifetime.busy) return;
    const stale = !descriptor || Date.parse(descriptor.expiresAt) <= Date.now();
    if (action === 'approve' && (!canApprove || !proposal.success || stale)) return;
    if (action === 'replace' && (!canReplace || !proposal.success || !selector || stale)) return;
    if (action === 'state' && (!canState || !selector || (selector.state === 'paused' && stale))) return;
    if ((action === 'retry' || action === 'cancel') && !pending) return;
    lifetime.busy = true;
    setAcknowledged(false);
    update(lifetime, { busy: true, fresh: false, uncertain: true, message: 'Request outcome pending.' });
    let appliedStateReceipt: AppliedStateReceipt | undefined;
    try {
      const raw = (action === 'approve' || action === 'replace') && proposal.success ? await lifetime.api.approve(proposal.data)
        : action === 'state' && selector ? await lifetime.api.setState({ state: selector.state === 'active' ? 'paused' : 'active', expectedRevision: selector.revision, disclosureAcknowledged: true })
        : action === 'cancel' ? await lifetime.api.cancelPending() : await lifetime.api.retry();
      if (owner.current !== lifetime) return;
      const receipt = researchSetupReceiptSchema.parse(raw);
      if ((remote && (receipt.workspaceId !== remote.workspaceId || receipt.pairingId !== remote.pairingId)) ||
          (status?.pending && (receipt.requestId !== status.pending.requestId || receipt.kind !== status.pending.kind)) ||
          ((action === 'approve' || action === 'replace') && receipt.kind !== 'approve') || (action === 'state' && receipt.kind !== 'set-state') ||
          (receipt.status === 'applied' && action === 'approve' && (receipt.revision !== 1 || receipt.state !== 'active')) ||
          (receipt.status === 'applied' && action === 'replace' && (!selector || receipt.revision !== selector.revision + 1 || receipt.state !== 'active')) ||
          (receipt.status === 'applied' && action === 'state' && selector && (receipt.revision !== selector.revision + 1 || receipt.state !== (selector.state === 'active' ? 'paused' : 'active')))) throw new Error('receipt mismatch');
      if (action === 'state' && receipt.status === 'applied') {
        appliedStateReceipt = receipt;
        update(lifetime, { uncertain: false, message: appliedConfirmation });
      } else update(lifetime, { uncertain: false, status: null, message: receipt.status === 'cancelled'
        ? 'Pending request cancelled. Refresh for current policy before another action.'
        : action === 'cancel' ? 'Request was already applied. Cancellation cannot undo applied work. Refresh for current policy.'
          : 'Research policy request applied. Refresh for current policy. This is not proof of provider connectivity or schedule activation.' });
    } catch {
      update(lifetime, { message: 'Request outcome unknown. New edits and commands are blocked. Refresh status, Retry the exact stored request, or Cancel pending request.' });
    } finally {
      lifetime.busy = false;
      // Transfer the same lifetime's lock synchronously, without an enabled-command gap.
      if (appliedStateReceipt && owner.current === lifetime) await read(lifetime, appliedStateReceipt);
      else update(lifetime, { busy: false });
    }
  }

  /** The same targeting form serves first use and replacement; only its legend, its gate and the replacement note differ. */
  const form = (legend: string, disabled: boolean, note?: string) => <fieldset disabled={disabled}>
    <legend>{legend}</legend>
    {note && <p>{note}</p>}
    <label className="settings__row">Discovery provider
      <select aria-label="Discovery provider" value={provider} onChange={event => { setProvider(event.target.value === 'places' ? 'places' : 'responses_cited'); setAcknowledged(false); }}>
        {(Object.keys(providerNames) as DiscoveryProvider[]).map(key => <option key={key} value={key}>{providerNames[key]}</option>)}
      </select>
    </label>
    {fieldKeys(provider).map(key => <label className="settings__row" key={key}>
      {currentLabels[key]}
      {['regions', 'terms', 'websites'].includes(key) ? <textarea aria-label={currentLabels[key]} required rows={3} value={fields[key]}
        onChange={event => { setFields(previous => ({ ...previous, [key]: event.target.value })); setAcknowledged(false); }} />
        : <input aria-label={currentLabels[key]} required value={fields[key]} inputMode="decimal"
          onChange={event => { setFields(previous => ({ ...previous, [key]: event.target.value })); setAcknowledged(false); }} />}
    </label>)}
    <p>Enter positive USD totals with at most six decimal places. Each ceiling must cover the operator reservation. Limits must be whole numbers within the displayed bounds.</p>
    {proposalTerritory && <p>Each Google Places text-search call reserves {discoveryReservation !== null ? usd(discoveryReservation) : 'an amount the operator has not reviewed'} (Enterprise SKU) against the discovery ceiling before it is made. One call returns at most one page of 20 firms for one territory query; firms without a website are counted and skipped. Listed phone numbers come from Google Business Profiles: they describe source verification, not contact permission.</p>}
    {proposal.success && <p>Total combined cumulative ceiling: {usd(proposal.data.discoveryCeilingMicros + proposal.data.researchCeilingMicros)}</p>}
  </fieldset>;

  return <section className="settings__section settings-google-connections" aria-label="Cloud research">
    <h2 className="settings__section-title">Cloud research</h2>
    <p className="settings__quiet">Bounded residential company research only. This grants no mail or calendar permission and does not activate schedules. Pause cannot recall in-flight work or stop other cloud operations.</p>
    <p>Cumulative ceilings are totals, not top-ups or resets. Reserved-or-spent balances include conservative reservations, not verified invoice spend.</p>
    {!api && <p role="status">Cloud research is unavailable in this app connection.</p>}
    {api && <button type="button" className="settings__action" disabled={busy} onClick={() => { if (owner.current) void read(owner.current); }}>Refresh</button>}
    {current && view.message && <p role="status">{view.message}</p>}
    {shownBlocked.map(blocker => <p key={blocker}>{blockers[blocker]}</p>)}
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
        {descriptor.placesSearchCostMicros !== undefined && <div><dt>Places cost per call</dt><dd>{usd(descriptor.placesSearchCostMicros)}</dd></div>}
      </dl>
      {!descriptorCurrent && <p>Operator review is not current. Approval and resume are blocked.</p>}
    </div>}
    {remote && !view.fresh && <p>Policy and balances are last observed (stale), not current status.</p>}
    {remote && <p>Credential parameter {remote.credentialParameterDeclared ? 'declared' : 'not declared'}. A declaration does not prove credential or provider access works. Status checked: {remote.checkedAt}.</p>}
    {remote && placesRelevant && <p>Google Places credential parameter {remote.placesCredentialParameterDeclared === true ? 'declared' : 'not declared'}. A declaration does not prove the key or Places access works.</p>}
    {(['discoveryLedger', 'researchLedger'] as const).map((key) => {
      const ledger = remote?.[key];
      return <p key={key}>{key === 'discoveryLedger' ? 'Discovery' : 'Research'} balance: {ledger ? `cumulative ceiling ${usd(ledger.limitMicros)}, reserved-or-spent ${usd(ledger.reservedOrSpentMicros)}, remaining ${usd(ledger.remainingMicros)}` : 'unavailable, not assumed zero'}.</p>;
    })}
    {remote?.discoveryLedger && remote.researchLedger && <p>Total combined cumulative ceiling: {usd(remote.discoveryLedger.limitMicros + remote.researchLedger.limitMicros)}</p>}
    {selector ? <div>
      <h3>{view.fresh ? 'Existing policy (read-only)' : 'Last observed policy (stale, read-only)'}: {selector.state}</h3>
      {existing && <>
        <p>Residential regions: {existing.audience.regions.join(', ')}. Targeting terms: {existing.audience.terms.join(', ')}.</p>
        {activeTerritory ? <p>Discovery provider: {providerNames.places}. Companies per batch: {existing.discoveryLimits.maxCompanies}.</p>
          : <p>Official websites: {existing.permittedSources.join(', ')}</p>}
        {activeTerritory ? <p>Maximum pages: {existing.researchLimits.maxPages}. Maximum bytes: {existing.researchLimits.maxBytes}.</p>
          : <p>Maximum companies: {existing.discoveryLimits.maxCompanies}. Maximum pages: {existing.researchLimits.maxPages}. Maximum bytes: {existing.researchLimits.maxBytes}.</p>}
        <p>Policy model: {existing.capability.model}. Targeting and cumulative ceilings cannot be edited here.</p>
      </>}
    </div> : form('First-use research policy', !editable)}
    {existing && form('Replace configuration', !replaceable, replaceNote)}
    <label className="settings__row"><input type="checkbox" checked={acknowledged} disabled={!api || busy || pending || !view.fresh} onChange={event => setAcknowledged(event.target.checked)} /> I have reviewed the targeting, cumulative ceilings, operator assertions and limitations above</label>
    {selector ? <>
      <button type="button" className="settings__action" disabled={!canState} onClick={() => void mutate('state')}>{selector.state === 'active' ? 'Pause research' : 'Resume research'}</button>
      {existing && <button type="button" className="settings__action" disabled={!canReplace} onClick={() => void mutate('replace')}>Replace configuration</button>}
    </> : <button type="button" className="settings__action" disabled={!canApprove} onClick={() => void mutate('approve')}>Approve research</button>}
    {pending && <div>
      <p>Pending request has an unknown outcome. Retry sends the exact stored request without changing its inputs. Cancellation cannot undo already applied work.</p>
      <button type="button" className="settings__action" disabled={busy} onClick={() => void mutate('retry')}>Retry exact pending request</button>
      <button type="button" className="settings__action" disabled={busy} onClick={() => void mutate('cancel')}>Cancel pending request</button>
    </div>}
  </section>;
}

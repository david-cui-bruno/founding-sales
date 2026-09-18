import { useLayoutEffect, useMemo, useReducer } from 'react';
import type { CalliePreloadApi } from '../../../shared/preload';
import type { DailySnapshot } from '../../../shared/contracts/dailyContract';
import type { CommandReceipt } from '../../../shared/contracts/commandReceiptContract';
import { DEFAULT_TERRITORY_CALL_POLICY_DEFINITION, territoryCallPolicyStatusSchema, type TerritoryCallPolicyRequest, type TerritoryCallPolicyStatus,
  type TerritoryCallPolicyStep } from '../../../shared/contracts/territoryCallPolicyContract';

type Api = Pick<CalliePreloadApi, 'delegation'>;
type LocalDelegationStatus = Awaited<ReturnType<Api['delegation']['status']>>;
type PendingCommand = Extract<TerritoryCallPolicyRequest, { kind: 'approve' | 'set-state' }>;
type Panel = {
  status: TerritoryCallPolicyStatus | null;
  reading: boolean;
  readFailed: boolean;
  busy: boolean;
  /** The one command awaiting a definitive receipt. A retry resends this exact identity; a new one is never minted for it. */
  pending: PendingCommand | null;
  failed: boolean;
  rejected: string | null;
  acknowledged: boolean;
  receipt: CommandReceipt | null;
  listeners: Set<() => void>;
};
// Retained per bridge and workspace so a pending command survives a remount, exactly as the campaign draft does.
const panels = new WeakMap<Api['delegation'], Map<string | null, Panel>>();
function retainedPanel(api: Api, workspaceId: string | null): Panel {
  let workspaces = panels.get(api.delegation);
  if (!workspaces) panels.set(api.delegation, workspaces = new Map());
  let panel = workspaces.get(workspaceId);
  if (!panel) {
    panel = { status: null, reading: false, readFailed: false, busy: false, pending: null, failed: false, rejected: null, acknowledged: false, receipt: null, listeners: new Set() };
    workspaces.set(workspaceId, panel);
  }
  return panel;
}
function notify(panel: Panel) { panel.listeners.forEach(listener => listener()); }
function configured(snapshot: DailySnapshot, config: LocalDelegationStatus | null, readError: boolean) {
  return !readError && snapshot.workspaceId !== null && config?.workspaceId === snapshot.workspaceId && config.state === 'active'
    && config.endpoint !== null && config.configuration?.configuration.state === 'active';
}
export const territoryPolicyCopy = {
  region: 'Territory call policy',
  details: 'Sequence, caps, objective and audience',
  read: 'Read policy state',
  unread: 'Policy state not read yet. Read it before approving, pausing or resuming.',
  none: 'No territory call policy is approved. New firms the worker prepares are not enrolled.',
  bridge: 'Territory call policy is not available on this bridge.',
  held: 'Territory call policy actions are held until the workspace and worker configuration are current.',
  disclosure: 'I understand that approving authorizes the worker to enroll every firm the Places discovery creates in this workspace on this call sequence, with no per-firm step. Nothing dials, sends or books.',
  approve: 'Approve territory call policy',
  pause: 'Pause new enrollments',
  resume: 'Resume new enrollments',
  retry: 'Retry same policy command',
  pending: 'Policy command pending. Not confirmed applied. Retry the same command; a replacement is never minted automatically.',
  failed: 'The policy command could not be confirmed. Read the policy state or retry the same command.',
  readFailed: 'The policy state could not be read from the worker.',
  emailHold: 'held: mailbox not connected',
} as const;
function stepLine(step: TerritoryCallPolicyStep) {
  const channel = step.channel === 'call' ? 'Call' : `Email ${step.templateKey ?? ''}`.trim();
  return `Day ${step.dayOffset} · ${channel}${step.channel === 'email' ? ` · ${territoryPolicyCopy.emailHold}` : ''}`;
}
export function stateLine(status: TerritoryCallPolicyStatus | null): string {
  if (!status) return territoryPolicyCopy.unread;
  const policy = status.policy;
  if (!policy) return territoryPolicyCopy.none;
  if (policy.state === 'active') return `Active · revision ${policy.revision} · approved ${policy.approvedAt} as revision ${policy.approvedRevision}. The worker enrolls every firm it prepares.`;
  return `Paused · revision ${policy.revision}. New firms are not enrolled; existing enrollments keep their state.`;
}
export function receiptLine(receipt: CommandReceipt): string {
  return `Receipt: ${receipt.status} · revision ${receipt.aggregateVersion}${receipt.reason ? ` · ${receipt.reason}` : ''}`;
}

/** The one standing territory call policy (design D1, D13): its sequence, caps, objective and audience are shown from the
 * fixed default; its state is read live from the worker on request. Approving is the single hold, behind a disclosure;
 * it is revision-tracked, pausable and resumable. The panel never reads or writes by itself and nothing here dials. */
export function TerritoryCallPolicyPanel({ api, snapshot, config, readError }: { api: Api; snapshot: DailySnapshot; config: LocalDelegationStatus | null; readError: boolean }) {
  const panel = useMemo(() => retainedPanel(api, snapshot.workspaceId), [api.delegation, snapshot.workspaceId]);
  const [, render] = useReducer(n => n + 1, 0);
  useLayoutEffect(() => { panel.listeners.add(render); return () => { panel.listeners.delete(render); }; }, [panel]);
  const bridge = api.delegation.territoryPolicy;
  const ready = configured(snapshot, config, readError);
  const available = ready && typeof bridge === 'function';
  const definition = panel.status?.definition ?? DEFAULT_TERRITORY_CALL_POLICY_DEFINITION;
  const workspaceId = snapshot.workspaceId;
  const settle = (status: TerritoryCallPolicyStatus) => {
    if (status.workspaceId !== workspaceId) throw Error('Held');
    panel.status = status;
  };
  const read = async () => {
    if (!available || !bridge || panel.reading || panel.busy) return;
    panel.reading = true; panel.readFailed = false; notify(panel);
    try { settle(territoryCallPolicyStatusSchema.parse(await bridge({ kind: 'read' }))); }
    catch { panel.readFailed = true; }
    finally { panel.reading = false; notify(panel); }
  };
  const command = async (request: PendingCommand) => {
    if (!available || !bridge || panel.busy || panel.reading) return;
    // The identity is retained before any await; an uncertain reply keeps it for an explicit retry.
    panel.busy = true; panel.failed = false; panel.rejected = null; panel.pending = request; notify(panel);
    try {
      const status = territoryCallPolicyStatusSchema.parse(await bridge(request));
      const receipt = status.receipt;
      if (!receipt || receipt.commandId !== request.commandId) throw Error('Held');
      settle(status);
      panel.receipt = receipt;
      // Only the schema-valid receipt of this exact command is definitive, applied or rejected.
      panel.pending = null;
      if (receipt.status === 'rejected') panel.rejected = receipt.reason;
      if (receipt.status === 'applied') panel.acknowledged = false;
    } catch { panel.failed = true; }
    finally { panel.busy = false; notify(panel); }
  };
  const approve = () => {
    if (!panel.status || panel.status.policy !== null || !panel.acknowledged || panel.pending) return;
    void command(Object.freeze({ kind: 'approve', commandId: crypto.randomUUID(), expectedRevision: 0 }));
  };
  const setState = (state: 'active' | 'paused') => {
    const policy = panel.status?.policy;
    if (!policy || policy.state === state || panel.pending) return;
    void command(Object.freeze({ kind: 'set-state', commandId: crypto.randomUUID(), expectedRevision: policy.revision, state }));
  };
  const locked = panel.busy || panel.reading || panel.pending !== null;
  const policy = panel.status?.policy ?? null;
  // Without a paired, active workspace nothing here can be approved: one line, so the surface keeps its geometry.
  if (!ready) return <p role="status" className="native-desk__territory-policy-hold">{territoryPolicyCopy.region}: {territoryPolicyCopy.held}</p>;
  // Compact by default: the standing definition folds away, the live state and the one hold stay in view.
  return <section className="native-desk__composer native-desk__territory-policy" aria-label={territoryPolicyCopy.region}>
    <h2>{territoryPolicyCopy.region}</h2>
    <details>
      <summary>{territoryPolicyCopy.details}</summary>
      <p>Audience: every firm the Places discovery creates in this workspace.</p>
      <p>Objective: {definition.objective}.</p>
      <p>Offer: {definition.offer}</p>
      <h3>Sequence</h3>
      <ol>{definition.sequence.map((step, index) => <li key={index}>{stepLine(step)}</li>)}</ol>
      <h3>Caps</h3>
      <p>{definition.caps.callsPerFirm} calls and {definition.caps.emailsPerFirm} emails per firm. {definition.caps.newFirmsPerDay} new firms a day, applied when Today builds its list; enrollment is never refused by it.</p>
      <p>Approving is the one hold. Every firm the worker prepares afterwards receives worker authority, one derived single-firm campaign version and an active enrollment on its listed business phone, with no per-firm step. Email steps stay held until the mailbox is connected. Nothing dials, sends or books.</p>
    </details>
    {!bridge || !available ? <p role="status">{territoryPolicyCopy.bridge}</p> : <>
      <p role="status">{stateLine(panel.status)}</p>
      <button type="button" disabled={locked} onClick={() => { void read(); }}>{territoryPolicyCopy.read}</button>
      {panel.readFailed && <p role="status">{territoryPolicyCopy.readFailed}</p>}
      {panel.status && policy === null && !panel.pending && <>
        <label className="native-desk__check"><input type="checkbox" checked={panel.acknowledged} disabled={locked} onChange={event => { panel.acknowledged = event.target.checked; notify(panel); }} />{territoryPolicyCopy.disclosure}</label>
        <button type="button" disabled={locked || !panel.acknowledged} onClick={approve}>{territoryPolicyCopy.approve}</button>
      </>}
      {policy?.state === 'active' && <button type="button" disabled={locked} onClick={() => setState('paused')}>{territoryPolicyCopy.pause}</button>}
      {policy?.state === 'paused' && <button type="button" disabled={locked} onClick={() => setState('active')}>{territoryPolicyCopy.resume}</button>}
      {panel.receipt && <p role="status">{receiptLine(panel.receipt)}</p>}
      {panel.rejected !== null && <p role="status">The worker rejected the policy command: <span>{panel.rejected}</span></p>}
      {panel.pending && <>
        <p role="status">{territoryPolicyCopy.pending}</p>
        <p>Policy command: {panel.pending.commandId}</p>
        <button type="button" disabled={panel.busy || panel.reading} onClick={() => { void command(panel.pending!); }}>{territoryPolicyCopy.retry}</button>
      </>}
      {panel.failed && !panel.pending && <p role="status">{territoryPolicyCopy.failed}</p>}
    </>}
  </section>;
}

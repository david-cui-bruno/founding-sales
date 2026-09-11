import { useEffect, useRef, useState } from 'react';
import { localWorkflowReceiptSchema, localWorkspaceSnapshotSchema, type LocalWorkflowTransition, type LocalWorkspaceApi, type LocalWorkspaceSnapshot } from '../../shared/contracts/localWorkspaceContract';

/** The command exists only for this mounted view. Reopening recovers main's receipt. */
export function WorkflowSection({ api }: { api?: LocalWorkspaceApi }) {
  const [state, setState] = useState<{ api?: LocalWorkspaceApi; snapshot: LocalWorkspaceSnapshot | null; error: boolean; uncertain: boolean; pending: boolean }>({ api, snapshot: null, error: false, uncertain: false, pending: true });
  const [acknowledged, setAcknowledged] = useState(false);
  const command = useRef<LocalWorkflowTransition | null>(null);
  const generation = useRef(0);
  const busy = useRef(false);
  const read = async () => {
    if (!api || busy.current) return;
    const request = generation.current;
    busy.current = true;
    setState(s => ({ ...s, pending: true }));
    try {
      const snapshot = localWorkspaceSnapshotSchema.parse(await api.get());
      if (request === generation.current) setState(s => ({ ...s, api, snapshot, error: false, pending: false }));
    } catch {
      if (request === generation.current) setState(s => ({ ...s, api, error: true, pending: false }));
    } finally { if (request === generation.current) busy.current = false; }
  };
  useEffect(() => {
    generation.current++;
    command.current = null;
    busy.current = false;
    setAcknowledged(false);
    setState({ api, snapshot: null, error: !api, uncertain: false, pending: !!api });
    void read();
    return () => { generation.current++; };
    // A new API is a new database lifecycle, never a retry of the old request.
  }, [api]);
  const current = state.api === api ? state : null;
  const snapshot = current?.snapshot;
  const receipt = !current?.error && snapshot?.transitionReceipt;
  const submit = async () => {
    if (!api || busy.current || current?.error || !snapshot || snapshot.workflowMode !== 'legacy' || !acknowledged) return;
    command.current ??= Object.freeze({ commandId: crypto.randomUUID(), expectedMode: 'legacy' as const, manifestId: crypto.randomUUID() });
    const exact = command.current;
    const request = generation.current;
    busy.current = true;
    setState(s => ({ ...s, pending: true }));
    try {
      const applied = localWorkflowReceiptSchema.parse(await api.transition(exact));
      if (applied.commandId !== exact.commandId || applied.manifestId !== exact.manifestId) throw Error('Receipt identity mismatch');
      if (request !== generation.current) return;
      setState(s => ({ ...s, pending: false, uncertain: false, snapshot: { ...snapshot, workflowMode: 'meeting_first', transitionReceipt: applied } }));
      window.dispatchEvent(new Event('callie:workflow-changed'));
    } catch {
      if (request === generation.current) setState(s => ({ ...s, pending: false, uncertain: true }));
    } finally { if (request === generation.current) busy.current = false; }
  };
  return <section aria-label="Local workflow">
    <h3>Local workflow</h3>
    <p>Switch this local workspace to Native Desk. Existing commitments and history remain available. Superseded automatic legacy acquisition stops. This does not pair an account, grant authority, start a worker, research, call, send or book anything.</p>
    {current?.error ? <p role="alert">Workflow status unavailable. Check status before continuing.</p>
      : receipt ? <><p role="status">Native Desk is active.</p><p>Transition receipt: {receipt.manifestId} · revision {receipt.revision}</p></>
      : snapshot?.workflowMode === 'meeting_first' ? <p role="status">Native Desk mode is recorded, but its transition receipt is unavailable. Check status. No new transition can be submitted.</p>
      : !snapshot ? <p role="status">Checking local workflow…</p> : null}
    {current?.uncertain && !receipt && <p role="status">Transition result is unknown. Check status or retry the same transition after status is available.</p>}
    {snapshot?.workflowMode === 'legacy' && !receipt && !current?.error && <>
      <label><input type="checkbox" checked={acknowledged} disabled={current?.pending || !!command.current} onChange={event => setAcknowledged(event.target.checked)} />I understand this is a one-way local change</label>
      <button disabled={!acknowledged || current?.pending} onClick={() => void submit()}>{command.current ? 'Retry same transition' : 'Switch to Native Desk'}</button>
    </>}
    <button disabled={!api || current?.pending} onClick={() => void read()}>Check status</button>
  </section>;
}

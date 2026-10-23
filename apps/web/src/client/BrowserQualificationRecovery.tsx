import { useEffect, useRef, useState, type JSX } from 'react';
import type { BrowserClient } from './BrowserClient.ts';
import type { PendingQualification } from './QualificationPending.ts';
import { dispatchQualification } from './QualificationDispatch.ts';

/** Survives inventory page/filter changes and reload without replaying or retaining evidence text. */
export function BrowserQualificationRecovery({ client }: { client: BrowserClient }): JSX.Element | null {
  const [held, setHeld] = useState<PendingQualification | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false), operation = useRef<symbol | null>(null);
  useEffect(() => {
    mounted.current = true;
    operation.current = null; setBusy(false); setHeld(null); setNotice('');
    let epoch = client.epoch;
    const update = (): void => {
      if (epoch !== client.epoch || client.current?.status !== 'signed_in') {
        epoch = client.epoch; operation.current = null; setHeld(null); setNotice(''); setBusy(false);
      }
      try { setHeld(client.qualification.read()); }
      catch { setHeld(null); setNotice('Qualification custody unavailable. No new qualification command can be dispatched.'); }
    };
    update(); const unsubscribe = client.subscribe(update);
    return () => { mounted.current = false; operation.current = null; unsubscribe(); };
  }, [client]);
  const reconcile = async (): Promise<void> => {
    if (operation.current !== null || held === null || held.receipt !== undefined) return;
    const epoch = client.epoch, token = Symbol('qualification-recovery');
    operation.current = token; setBusy(true); setNotice('');
    const current = (): boolean => mounted.current && operation.current === token && client.isCurrent(epoch);
    try {
      const message = await dispatchQualification(client, held, current);
      if (current()) setNotice(message);
    } catch { if (current()) setNotice('No definite response. Keep this exact command identity. No automatic retry or replacement command.'); }
    finally { if (current()) { operation.current = null; setBusy(false); } }
  };
  if (held === null && !notice) return null;
  return <section aria-label="Qualification command custody">
    {held === null ? null : <>
      <p>{held.receipt === undefined ? 'Unresolved' : 'Confirmed'} qualification {held.command.kind} command {held.command.payload.commandId}. Candidate {held.command.payload.candidateId} revision {held.command.payload.expectedRevision}.</p>
      {held.command.kind === 'admit' ? <p>Reviewed run {held.command.payload.qualificationRunId}.</p> : null}
      {held.receipt?.kind === 'request' ? <p>Recorded qualification run {held.receipt.result.runId}. Read current evidence explicitly.</p> : null}
      {held.receipt?.kind === 'admit' ? <p>Admitted exact Firm {held.receipt.result.firmId}. Route {held.receipt.result.routeId}. No contact or sending authority.</p> : null}
      {held.receipt?.kind === 'refused' ? <p>Command definitively refused. No admission or qualification success is implied.</p> : null}
      {held.receipt === undefined ? <button type="button" disabled={busy} onClick={() => { void reconcile(); }}>Reconcile exact qualification command</button> : null}
    </>}
    {notice ? <p role="status">{notice}</p> : null}
  </section>;
}

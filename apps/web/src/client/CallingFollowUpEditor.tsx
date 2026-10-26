import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { callingFollowUpContentSchema, type CallingFollowUpMetadata, type CallingFollowUpView } from '@fss/contracts';
import { type BrowserClient } from './BrowserClient.ts';
import { type CallingFollowUpDispatch, type CallingFollowUpOutcome } from './CallingFollowUpDispatch.ts';
import { type CallingFollowUpAttempt } from './CallingFollowUpPending.ts';

type Selection = Pick<CallingFollowUpMetadata, 'draftId' | 'revision'>;
export function CallingFollowUpEditor({ client, dispatch, selection, onCurrent, onBack }: {
  client: BrowserClient; dispatch: CallingFollowUpDispatch; selection: Selection;
  onCurrent: (value: CallingFollowUpMetadata) => void; onBack: () => void;
}): JSX.Element {
  const { draftId, revision } = selection;
  const [view, setView] = useState<CallingFollowUpView | null>(null);
  const [subject, setSubject] = useState(''), [body, setBody] = useState('');
  const [busy, setBusy] = useState(false), [blocked, setBlocked] = useState(false);
  const [pending, setPending] = useState<CallingFollowUpAttempt | null>(null);
  const [notice, setNotice] = useState('Reading current private follow-up…');
  const [confirmWithdrawal, setConfirmWithdrawal] = useState(false);
  const owner = useRef(0), locked = useRef(false), live = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null), publish = useRef(onCurrent);
  publish.current = onCurrent;
  const clear = (): void => { setView(null); setSubject(''); setBody(''); setConfirmWithdrawal(false); };
  const syncPending = useCallback((): void => {
    try { setPending(dispatch.custody.read(draftId)); }
    catch { setBlocked(true); setNotice('Save custody unavailable. No replacement save is allowed.'); }
  }, [dispatch, draftId]);
  const run = useCallback(async (work: (current: () => boolean) => Promise<void>): Promise<void> => {
    if (locked.current || client.current?.status !== 'signed_in') return;
    const mine = ++owner.current, epoch = client.epoch;
    const current = (): boolean => live.current && owner.current === mine && client.isCurrent(epoch) && client.current?.status === 'signed_in';
    locked.current = true; setBusy(true); setNotice('');
    try { await work(current); }
    catch { if (current()) { clear(); setNotice('Current follow-up unavailable or outcome unknown. Private text cleared. Refresh metadata to reopen. No automatic replay.'); } }
    finally { if (current()) { locked.current = false; setBusy(false); syncPending(); } }
  }, [client, syncPending]);
  const show = useCallback((value: CallingFollowUpView): void => {
    setView(value); setConfirmWithdrawal(false);
    setSubject(value.availability === 'available' ? value.content.subject : '');
    setBody(value.availability === 'available' ? value.content.body : '');
    publish.current({ draftId: value.draftId, revision: value.revision, source: value.source,
      availability: value.availability, createdAt: value.createdAt, updatedAt: value.updatedAt });
  }, []);
  useEffect(() => {
    live.current = true; locked.current = false; setBlocked(false); clear(); syncPending();
    let epoch = client.epoch;
    const unsubscribe = client.subscribe(() => {
      if (epoch !== client.epoch || client.current?.status !== 'signed_in') {
        epoch = client.epoch; owner.current += 1; locked.current = false; clear(); setBusy(false); setPending(null); setBlocked(false);
      } else syncPending();
    });
    void run(async current => {
      const value = await dispatch.read({ draftId, revision }, current);
      if (current()) { show(value); setNotice(value.availability === 'available' ? 'Current private follow-up opened. Unsaved edits stay in memory.' : 'Follow-up withdrawn or source unavailable. No private text restored.'); }
    });
    heading.current?.focus();
    return () => { live.current = false; owner.current += 1; locked.current = false; unsubscribe(); };
  }, [client, dispatch, draftId, revision, run, show, syncPending]);
  const finish = async (result: CallingFollowUpOutcome, current: () => boolean): Promise<void> => {
    if (!current()) return;
    clear();
    if (result.state === 'unknown') { setNotice('Save outcome UNKNOWN. Exact command retained. Use receipt-only recovery, never a replacement save.'); return; }
    if (result.state === 'refused') { setNotice('Save refused. Refresh metadata and reopen the current revision. No overwrite or automatic retry.'); return; }
    setNotice('Historical save accepted. Reading current private revision…');
    const fresh = await dispatch.read({ draftId: result.draftId, revision: result.revision }, current);
    if (!current()) return;
    show(fresh);
    setNotice(fresh.availability === 'available' ? `Private follow-up saved for review at revision ${fresh.revision}. Not scheduled or sent.` : 'Historical save accepted. Follow-up withdrawn or current content unavailable.');
  };
  const save = (withdraw: boolean): void => {
    if (view?.availability !== 'available' || blocked || pending !== null) return;
    const parsed = callingFollowUpContentSchema.safeParse({ subject, body });
    if (!withdraw && !parsed.success) { setNotice('Enter a nonblank subject up to 160 characters and body up to 4000 characters within their byte limits.'); return; }
    const input = withdraw ? { operation: 'withdraw' as const, draftId, expectedRevision: view.revision }
      : { operation: 'update' as const, draftId, expectedRevision: view.revision, subject, body };
    void run(async current => {
      clear();
      const result = await dispatch.save(input, current);
      await finish(result, current);
    });
  };
  if (client.current?.status !== 'signed_in') return <></>;
  return <div className="email-follow-up-editor" aria-label="Private follow-up editor" role="region" aria-busy={busy}>
    <button className="email-follow-up-back" onClick={onBack}>Back to follow-ups</button>
    <h3 ref={heading} tabIndex={-1}>Private promised email</h3>
    <p>Saved for review only. Recipient unresolved. Not scheduled, approved for sending or sent.</p>
    <p role="status">{notice}</p>
    <small>Draft {draftId}{view ? ` · Revision ${view.revision} · ${view.availability}` : ''}</small>
    {pending ? <aside aria-label="Unresolved follow-up save"><p>Unresolved {pending.operation} command {pending.commandId}. Refresh never resends private text.</p>
      <button disabled={busy || blocked} onClick={() => { void run(async current => {
        clear(); const result = await dispatch.reconcile(pending, current); await finish(result, current);
      }); }}>Check same follow-up receipt</button></aside> : null}
    {view?.availability === 'available' ? <>
      <details><summary>Exact saved source</summary><p>{view.source.kind === 'candidate' ? `Candidate ${view.source.candidateId} revision ${view.source.candidateRevision}, manual attempt ${view.source.attemptId}. Not a canonical Firm call.` : `Firm ${view.source.firmId}, call log ${view.source.callLogId}.`}</p></details>
      <label>Follow-up subject<input aria-label="Follow-up subject" maxLength={160} value={subject} disabled={busy || blocked || pending !== null} onChange={event => { setSubject(event.target.value); setConfirmWithdrawal(false); }} /></label>
      <label>Follow-up body<textarea aria-label="Follow-up body" maxLength={4000} value={body} disabled={busy || blocked || pending !== null} onChange={event => { setBody(event.target.value); setConfirmWithdrawal(false); }} /></label>
      <small>No recipient is inferred. Private call notes are not inserted. Edits are unsaved until explicit Save.</small>
      <div className="email-composer-actions"><button disabled={busy || blocked || pending !== null} onClick={() => { save(false); }}>Save private follow-up</button>
        <button disabled={busy || blocked || pending !== null} onClick={() => { setConfirmWithdrawal(true); }}>Withdraw private follow-up</button></div>
      {confirmWithdrawal ? <div role="group" aria-label="Confirm private withdrawal"><p>Withdrawal permanently removes this saved subject and body. This draft cannot be restarted.</p>
        <button disabled={busy || blocked || pending !== null} onClick={() => { save(true); }}>Confirm permanent withdrawal</button>
        <button onClick={() => { setConfirmWithdrawal(false); }}>Keep saved follow-up</button></div> : null}
    </> : null}
  </div>;
}

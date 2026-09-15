import { useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import type { DailyAnswer } from '../../../shared/contracts/dailyContract';
import type { AccountReplyDraft } from '../../../shared/contracts/mailThreadContract';
import { SavedReplyConversation } from './SavedReplyConversation';
import { ordinaryReplySession, type OrdinaryReplyApi } from './ordinaryReplySession';

type Reply = Extract<DailyAnswer, { kind: 'reply' }>;
const held = 'Reply approval held: an exact permission binding is unavailable here. Saving is not approval or sending.';
function Editor({ api, workspaceId, draft, stale, actionHold }: {
  api: OrdinaryReplyApi; workspaceId: string; draft: AccountReplyDraft; stale: boolean; actionHold?: string;
}) {
  const session = ordinaryReplySession(api, workspaceId, draft, stale);
  const state = useSyncExternalStore(session.subscribe, session.snapshot);
  const subject = useRef<HTMLInputElement>(null), body = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => { session.setActionHold(actionHold); session.ingest(draft, stale); }, [session, draft, stale, actionHold]);
  useLayoutEffect(() => {
    const focus = session.focus;
    if (state.visible && focus) { const el = focus.field === 'subject' ? subject.current : body.current; el?.focus(); el?.setSelectionRange(focus.start, focus.end); }
  }, [session, state.visible]);
  const remember = (field: 'subject' | 'body', el: HTMLInputElement | HTMLTextAreaElement) => {
    session.focus = { field, start: el.selectionStart ?? 0, end: el.selectionEnd ?? 0 };
  };
  const available = session.available() && !actionHold;
  return <>
    <p>To {state.draft.recipient}</p>
    {state.visible ? <div className="native-desk__composer">
      <p className="native-desk__recipient">From {state.draft.sender}</p>
      <label>Subject<input ref={subject} aria-label="Reply subject" maxLength={240} value={state.subject}
        onSelect={e => remember('subject', e.currentTarget)} onChange={e => session.edit('subject', e.target.value)} /></label>
      <label>Message<textarea ref={body} aria-label="Reply body" maxLength={20000} value={state.body}
        onSelect={e => remember('body', e.currentTarget)} onChange={e => session.edit('body', e.target.value)} /></label>
      <div className="native-desk__actions">
        <button type="button" disabled={!available || state.stale || state.scopeHeld || state.conflict || !!state.pending || !session.dirty()} onClick={() => void session.save()}>Save edits</button>
        <button type="button" onClick={() => session.close()}>Close editor</button>
      </div>
    </div> : <>
      <h4>{state.draft.subject}</h4><pre>{state.draft.body}</pre>
      <button type="button" onClick={() => session.open()}>Edit saved reply</button>
    </>}
    <p>{session.dirty() ? 'Unsaved text retained in this session.' : `Saved reply revision ${state.draft.revision}.`}</p>
    {state.pending && <button type="button" disabled={!available || state.stale || state.scopeHeld} onClick={() => void session.retry()}>Retry same save</button>}
    <button type="button" disabled={!available} onClick={() => void session.reconcile()}>Reconcile saved reply</button>
    {(state.stale || stale) && <p>Saved reply is stale. New saves are held. Historical reconciliation is not permission.</p>}
    {actionHold && <p>{actionHold}</p>}
    {state.error && <p role="alert">{state.error}</p>}
    {state.incoming && <details open><summary>Saved version needs review</summary>
      <p>Saved recipient: {state.incoming.draft.recipient}</p><p>{state.incoming.draft.subject}</p><pre>{state.incoming.draft.body}</pre>
      <button type="button" disabled={state.busy} onClick={() => session.useSaved()}>Use saved version and discard displayed edits</button>
      {state.pending && <p>This changes displayed text only. The original save remains unresolved.</p>}
    </details>}
  </>;
}
export function OrdinaryReplyEditor({ item, api, workspaceId, actionHold, accountDetails }: {
  item: Reply; api: OrdinaryReplyApi; workspaceId: string; actionHold?: string; accountDetails?: ReactNode;
}) {
  return <section><h3>Saved reply</h3><SavedReplyConversation thread={item.thread} /><h4>Saved reply draft</h4>
    {item.draft ? <Editor api={api} workspaceId={workspaceId} draft={item.draft} stale={item.stale} actionHold={actionHold} /> : <p>No saved reply draft.</p>}
    <p role="status">{item.stale ? 'Thread or context changed. ' : ''}{held}</p>
    <details><summary>Company details</summary>{accountDetails}</details>
  </section>;
}

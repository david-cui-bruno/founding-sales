import { useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { DailyAnswer } from '../../../shared/contracts/dailyContract';
import type { AccountReplyDraft } from '../../../shared/contracts/mailThreadContract';
import type { CalliePreloadApi } from '../../../shared/preload';
import type { ReplyApprovalStatus, ReplyFirstDraftGeneration } from '../../../shared/contracts/replyFirstDraftContract';
import { SavedReplyConversation } from './SavedReplyConversation';
import { ordinaryReplySession, type OrdinaryReplyApi } from './ordinaryReplySession';

type Reply = Extract<DailyAnswer, { kind: 'reply' }>;
const held = 'Reply approval held: an exact permission binding is unavailable here. Saving is not approval or sending.';

/** D9: the first draft is written in main with the founder's own key, and approving is the only
 * thing that sends. Every method is optional so an older bridge simply shows the manual editor. */
export type ReplyApprovalApi = Partial<Pick<CalliePreloadApi['delegation'], 'admitReplyFirstDraft' | 'approveReply' | 'submitApprovedReply'>>;

export const REPLY_FIRST_DRAFT_STATES: Readonly<Record<ReplyFirstDraftGeneration, string>> = Object.freeze({
  model: 'First draft written on this Mac. Read every line: it is a draft, not an answer.',
  edited: 'Your own edits are the newest revision. Writing a new first draft would replace them.',
  model_unconfigured: 'No OpenAI key is saved, so no first draft was written. Settings → Connections → OpenAI API key; the editor below still works by hand.',
});
/** One confirmation, naming the recipient and the mailbox the reply leaves from. */
export function replyApprovalConfirmation(draft: Pick<AccountReplyDraft, 'recipient' | 'sender'>): string {
  return `Send this reply to ${draft.recipient} from ${draft.sender}. Approving is the only thing that sends it.`;
}
export const REPLY_RECEIPT_STATES: Readonly<Record<ReplyApprovalStatus['state'], string>> = Object.freeze({
  held: 'Held: nothing was queued, so nothing can be sent.',
  approved: 'Approved and recorded. Nothing has been sent yet.',
  pending: 'Sent to the worker. Waiting for its receipt.',
  applied: 'The worker applied the send.',
  rejected: 'The worker refused this send.',
});

type ApprovalState = { status: ReplyApprovalStatus | null; busy: boolean; error: string | null };

function FirstDraftControls({ api, draft, stale, available, session }: {
  api: ReplyApprovalApi; draft: AccountReplyDraft; stale: boolean; available: boolean;
  session: { reconcile(): Promise<void> };
}) {
  const admit = api.admitReplyFirstDraft;
  const [state, setState] = useState<{ generation: ReplyFirstDraftGeneration | null; busy: boolean; error: string | null }>({ generation: null, busy: false, error: null });
  if (!admit) return null;
  const write = async () => {
    setState({ generation: null, busy: true, error: null });
    try {
      // A regenerate is a new admit bound to the same thread identity, never a rebase.
      const result = await admit({ accountId: draft.accountId, draftId: draft.id, expectedRevision: draft.revision,
        expectedThreadRevision: draft.threadRevision, expectedContextRevision: draft.contextRevision });
      setState({ generation: result.state, busy: false, error: null });
      if (result.state === 'model') await session.reconcile();
    } catch {
      setState({ generation: null, busy: false, error: 'No first draft was written. Nothing changed; the editor below still works by hand.' });
    }
  };
  const generation = state.generation ?? (draft.generation === 'model' ? 'model' : 'edited');
  return <div className="native-desk__first-draft">
    <p>{REPLY_FIRST_DRAFT_STATES[generation]}</p>
    <button type="button" disabled={!available || stale || state.busy} onClick={() => void write()}>Write a first draft</button>
    {draft.body.length > 0 && <p>Writing again replaces the saved text with a new draft of the same reply, at the next revision.</p>}
    {state.error && <p role="alert">{state.error}</p>}
  </div>;
}

function ApproveControls({ api, draft, stale, available, dirty }: {
  api: ReplyApprovalApi; draft: AccountReplyDraft; stale: boolean; available: boolean; dirty: boolean;
}) {
  const approve = api.approveReply, submit = api.submitApprovedReply;
  const [confirmed, setConfirmed] = useState(false);
  const [state, setState] = useState<ApprovalState>({ status: null, busy: false, error: null });
  // Identity is fixed for this draft revision, so a retry after a lost reply reuses the same ids.
  const identity = useRef<{ approvalId: string; commandId: string; intentCommandId: string; actionId: string; submitCommandId: string; revision: number } | null>(null);
  if (!approve || !submit) return null;
  if (identity.current?.revision !== draft.revision) {
    const approvalId = `reply-approval-${draft.id}-${draft.revision}`;
    identity.current = { approvalId, commandId: crypto.randomUUID(), intentCommandId: crypto.randomUUID(),
      actionId: `reply-action-${draft.id}-${draft.revision}`, submitCommandId: crypto.randomUUID(), revision: draft.revision };
  }
  const ids = identity.current;
  const send = async () => {
    setState(current => ({ ...current, busy: true, error: null }));
    try {
      const approved = await approve({ accountId: draft.accountId, draftId: draft.id, approvalId: ids.approvalId,
        commandId: ids.commandId, intentCommandId: ids.intentCommandId, actionId: ids.actionId,
        expectedRevision: draft.revision, statement: 'ongoing_correspondence' });
      if (approved.state === 'held') { setState({ status: approved, busy: false, error: null }); return; }
      const submitted = await submit({ accountId: draft.accountId, approvalId: ids.approvalId, commandId: ids.submitCommandId });
      setState({ status: submitted, busy: false, error: null });
    } catch {
      setState(current => ({ ...current, busy: false,
        error: 'The approval could not be completed. Nothing was sent. The same approval can be retried; it never becomes a second send.' }));
    }
  };
  const status = state.status;
  return <div className="native-desk__approval">
    <h5>Approve and send</h5>
    <label><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />
      {replyApprovalConfirmation(draft)}</label>
    <button type="button" disabled={!confirmed || !available || stale || dirty || state.busy || status?.state === 'applied' || status?.state === 'pending'}
      onClick={() => void send()}>Approve and send</button>
    {dirty && <p>Save your edits first: approval binds the saved revision, not the text on screen.</p>}
    {status && <p role="status">{REPLY_RECEIPT_STATES[status.state]}
      {status.reason !== null && ` Reason: ${status.reason}.`}
      {status.state !== 'held' && ` Approved revision ${status.draftRevision}.`}</p>}
    {state.error && <p role="alert">{state.error}</p>}
  </div>;
}

function Editor({ api, workspaceId, draft, stale, actionHold }: {
  api: OrdinaryReplyApi & ReplyApprovalApi; workspaceId: string; draft: AccountReplyDraft; stale: boolean; actionHold?: string;
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
    <FirstDraftControls api={api} draft={state.draft} stale={state.stale || stale} available={available} session={session} />
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
    <ApproveControls api={api} draft={state.draft} stale={state.stale || stale} available={available} dirty={session.dirty()} />
  </>;
}
export function OrdinaryReplyEditor({ item, api, workspaceId, actionHold, accountDetails }: {
  item: Reply; api: OrdinaryReplyApi & ReplyApprovalApi; workspaceId: string; actionHold?: string; accountDetails?: ReactNode;
}) {
  return <section><h3>Saved reply</h3><SavedReplyConversation thread={item.thread} />
    <h4>Saved reply draft</h4>
    {item.draft ? <Editor api={api} workspaceId={workspaceId} draft={item.draft} stale={item.stale} actionHold={actionHold} /> : <p>No saved reply draft.</p>}
    <p role="status">{item.stale ? 'Thread or context changed. ' : ''}{held}</p>
    <details><summary>Company details</summary>{accountDetails}</details>
  </section>;
}

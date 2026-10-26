import { useEffect, useRef, useState, type JSX } from 'react';
import { humanReplyPreviewResultSchema, type HumanReplyPreview, type ReplyDraftContext } from '@fss/contracts';
import { type BrowserClient } from './BrowserClient.ts';
import { type ReplyAttempt, replyFactRefs } from './ReplyAttempt.ts';
import './workspaceEmail.css';

/** Private, mounted-only scratch. Never pass this to pending-command custody. */
export interface ReplyScratch { text: string; basis: string }
const scratchBasis = (value: ReplyDraftContext): string => JSON.stringify([
  value.messageId, value.sourceRevision, value.authorUserId, value.mailboxId,
  value.authorizationRevision, value.envelope, replyFactRefs(value),
]);

export function BrowserReplyComposer({ client, attempts, messageId, initialScratch, onScratchChange, loadOnMount = false }: {
  client: BrowserClient; attempts: ReplyAttempt; messageId: string;
  initialScratch?: ReplyScratch | undefined; onScratchChange?: (value: ReplyScratch | null) => void; loadOnMount?: boolean;
}): JSX.Element {
  const [context, setContext] = useState<ReplyDraftContext | null>(null);
  const [text, setText] = useState('');
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [preview, setPreview] = useState<HumanReplyPreview | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(attempts.pending(messageId));
  const startingScratch = useRef({ messageId, value: initialScratch });
  if (startingScratch.current.messageId !== messageId) startingScratch.current = { messageId, value: initialScratch };
  const scratch = useRef(initialScratch);
  const publishScratch = useRef(onScratchChange);
  publishScratch.current = onScratchChange;
  const draftRevision = useRef(0);
  const owner = useRef(0), locked = useRef(false), mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    owner.current += 1; locked.current = false;
    setContext(null); setText(''); setSuggestion(null); setPreview(null); setNotice(''); setBusy(false);
    setPending(attempts.pending(messageId));
    scratch.current = startingScratch.current.value;
    let epoch = client.epoch;
    const unsubscribe = client.subscribe(() => {
      if (epoch !== client.epoch || client.current?.status !== 'signed_in') {
        epoch = client.epoch; owner.current += 1; locked.current = false;
        scratch.current = undefined; startingScratch.current.value = undefined;
        setContext(null); setText(''); setSuggestion(null); setPreview(null); setNotice(''); setBusy(false);
      }
      setPending(attempts.pending(messageId));
    });
    return () => { mounted.current = false; owner.current += 1; locked.current = false; unsubscribe(); };
  }, [client, attempts, messageId]);
  const forgetScratch = (): void => { scratch.current = undefined; publishScratch.current?.(null); };
  const editDraft = (value: string): void => {
    draftRevision.current += 1; setText(value); setPreview(null);
    if (context !== null) {
      const next = { text: value, basis: scratchBasis(context) };
      scratch.current = next; publishScratch.current?.(next);
    }
  };
  const run = async (work: (current: () => boolean) => Promise<void>): Promise<void> => {
    if (locked.current) return;
    const mine = ++owner.current, epoch = client.epoch;
    const current = (): boolean => mounted.current && mine === owner.current && client.isCurrent(epoch);
    locked.current = true; setBusy(true); setNotice(''); setPreview(null);
    try { await work(current); }
    catch {
      if (current()) { forgetScratch(); setContext(null); setText(''); setSuggestion(null); setNotice('Current source or operation unavailable. Retained attempt identity is unchanged. No automatic retry. Refresh current context to compose manually.'); }
    } finally {
      if (current()) { locked.current = false; setBusy(false); setPending(attempts.pending(messageId)); }
    }
  };
  const load = (): void => { void run(async current => {
    setContext(null); setText(''); setSuggestion(null);
    const value = await attempts.context(messageId);
    if (current()) {
      setContext(value);
      if (scratch.current?.basis === scratchBasis(value)) setText(scratch.current.text);
      else if (scratch.current) { forgetScratch(); setNotice('Conversation or approved facts changed. Previous scratch was cleared. Compose from current context.'); }
    }
  }); };
  const requestSuggestion = (sameAttempt: boolean): void => {
    if (context === null) return;
    const base = context;
    void run(async current => {
      const receipt = await attempts.requestSuggestion(base, sameAttempt, current);
      if (!current()) return;
      if (receipt.status === 'refused' && !['generation_already_attempted', 'generation_outcome_unknown', 'generation_unavailable', 'generation_held', 'generation_over_budget', 'input_over_budget', 'token_count_unavailable', 'generation_invalid', 'generation_invalid_facts', 'generation_unsupported_claim'].includes(receipt.reason)) {
        forgetScratch(); setContext(null); setText(''); setSuggestion(null); setNotice('Current source or selected facts are unavailable. Attempt identity remains retained. Refresh current context.'); return;
      }
      if (sameAttempt || receipt.replayed) {
        setNotice('Same attempt checked. No suggestion was recovered. The attempt remains retained, with no replacement paid request. Compose manually.');
      } else if (receipt.status === 'accepted' && receipt.result.ok) {
        const value = receipt.result.value;
        if (value.sourceRevision !== base.sourceRevision || JSON.stringify(value.factRefs) !== JSON.stringify(replyFactRefs(base))) {
          forgetScratch(); setContext(null); setText(''); setSuggestion(null); setNotice('Suggestion does not match current source and approved facts. Refresh current context.'); return;
        }
        setSuggestion(value.text); setNotice(`Suggestion only. Final human review required. ${value.reviewNotes.join(' ')}`);
      } else {
        setNotice('Suggestion unavailable under current controls. No suggestion recovered and no replacement attempt will be started. You can compose manually.');
      }
    });
  };
  const review = (): void => {
    if (context === null || !text.trim()) return;
    const base = context, draft = text, revision = draftRevision.current;
    void run(async current => {
      const fresh = await attempts.context(messageId);
      if (!current()) return;
      if (fresh.sourceRevision !== base.sourceRevision || JSON.stringify(fresh.envelope) !== JSON.stringify(base.envelope)
        || JSON.stringify(replyFactRefs(fresh)) !== JSON.stringify(replyFactRefs(base))) {
        forgetScratch(); setContext(null); setText(''); setSuggestion(null); setNotice('Conversation or approved facts changed. Refresh current context before composing.'); return;
      }
      const result = await client.request('/replies/composer/preview', humanReplyPreviewResultSchema, {
        messageId, text: draft, factRefs: replyFactRefs(fresh), envelope: fresh.envelope,
      });
      if (!current() || draftRevision.current !== revision) return;
      if (result.ok && result.value.sourceRevision === fresh.sourceRevision && JSON.stringify(result.value.envelope) === JSON.stringify(fresh.envelope)) {
        setContext(fresh); setPreview(result.value);
      } else { forgetScratch(); setContext(null); setText(''); setSuggestion(null); setNotice('Current preview unavailable. Refresh current context.'); }
    });
  };
  const loadCurrent = useRef(load);
  loadCurrent.current = load;
  useEffect(() => { if (loadOnMount) loadCurrent.current(); }, [client, attempts, messageId, loadOnMount]);
  return <section aria-label="Reply composer" className="email-composition" aria-busy={busy}>
    <div className="email-history" tabIndex={0} role="region" aria-label="Available message history">
    <div className="email-context-toolbar"><button disabled={busy} onClick={load}>Refresh current reply context</button>{busy ? <span role="status">Loading current context or review…</span> : null}</div>
    {notice ? <p role="status">{notice}</p> : null}
    {pending ? <aside aria-label="Retained reply attempt"><details><summary>Reply attempt retained</summary><p>Attempt {pending.commandId} retained. Reload does not recover a suggestion or dispatch generation. No implicit retry or replacement.</p></details></aside> : null}
    {context ? <>
      <details key={`${context.sourceRevision}:prior`} className="email-originals"><summary>Prior conversation context · {context.priorContext.length} available passages</summary>
        <p>Available captured context only. Dates and participants not supplied by this context are unknown; this is not a complete mailbox history.</p>
        {context.priorContext.length === 0 ? <p>No prior context available.</p> : context.priorContext.map((item, index) => <article key={index}><h4>{item.direction === 'outgoing' ? 'Outgoing' : 'Incoming'} captured passage {index + 1}</h4><pre>{item.text}</pre></article>)}</details>
      <article className="email-current-original"><h4>{context.subject}</h4><p>From: {context.senderAddress}</p><h4>Current original message</h4><pre>{context.messageText}</pre></article>
      <details key={`${context.sourceRevision}:facts`}><summary>Recipients and approved facts</summary><h4>Current default recipients</h4><p>To: {context.envelope.to.join(', ')}</p><p>Cc: {context.envelope.cc.join(', ') || 'None'}</p>
        <h4>Selected approved facts</h4>{context.facts.length === 0 ? <p>No approved facts selected. Do not invent facts or booking links.</p> : context.facts.map(fact => <p key={fact.id}>{fact.text} (version {fact.version})</p>)}</details>
      {suggestion ? <aside aria-label="Reply suggestion"><h4>Suggestion · review before use</h4><pre>{suggestion}</pre><button disabled={busy} onClick={() => { editDraft(suggestion); setSuggestion(null); }}>Use suggestion in draft</button></aside> : null}
      {preview ? <article aria-label="Final reply preview"><h4>Final review only, not sent</h4><p>{preview.subject}</p><p>To: {preview.envelope.to.join(', ')}</p><p>Cc: {preview.envelope.cc.join(', ') || 'None'}</p><pre>{preview.body}</pre><p>No send action is available.</p></article> : null}
    </> : <p>Load current authorized context to compose. Private drafts are not restored after reload.</p>}
    </div>
    {context ? <div className="email-anchored-composer"><label>Reply draft<textarea aria-label="Reply draft" maxLength={12000} value={text} onChange={event => { editDraft(event.target.value); }} /></label>
      <div className="email-composer-actions"><button disabled={busy || !text.trim()} onClick={review}>Preview exact reply</button>
        <button disabled={busy || pending !== null} onClick={() => { requestSuggestion(false); }}>Generate suggestion</button>
        {pending?.messageId === messageId ? <button disabled={busy} onClick={() => { requestSuggestion(true); }}>Check same reply attempt</button> : null}</div>
      <small>Final human review required. Preview is not sending permission. Private scratch clears on refresh, source change or leaving Email.</small>
    </div> : null}
  </section>;
}

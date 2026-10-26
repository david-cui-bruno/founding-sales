import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { type CallingFollowUpMetadata } from '@fss/contracts';
import { type EmailWorkspaceProps } from './workspaceNavigation.ts';
import { CallingFollowUpPending, type CallingFollowUpAttempt } from './CallingFollowUpPending.ts';
import { CallingFollowUpDispatch } from './CallingFollowUpDispatch.ts';
import { CallingFollowUpEditor } from './CallingFollowUpEditor.tsx';

type Selection = Pick<CallingFollowUpMetadata, 'draftId' | 'revision'>;
/** Metadata-only bounded navigation. Private content belongs to one exact editor. */
export function BrowserCallingFollowUps({ client, selectedFollowUpDraftId, onFollowUpDraftSelectionChange }: EmailWorkspaceProps): JSX.Element {
  const custody = useMemo(() => new CallingFollowUpPending(client), [client]);
  const dispatch = useMemo(() => new CallingFollowUpDispatch(client, custody), [client, custody]);
  const [page, setPage] = useState<CallingFollowUpMetadata[]>([]), [next, setNext] = useState<string | null>(null);
  const [pending, setPending] = useState<CallingFollowUpAttempt[]>([]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const owner = useRef(0), mounted = useRef(false), listHeading = useRef<HTMLHeadingElement>(null);
  const requested = useRef(selectedFollowUpDraftId), notify = useRef(onFollowUpDraftSelectionChange);
  const loaded = useRef(page); loaded.current = page;
  requested.current = selectedFollowUpDraftId; notify.current = onFollowUpDraftSelectionChange;
  const syncPending = (): void => {
    try { setPending(custody.all()); } catch { setPending([]); setNotice('Follow-up custody unavailable. Saves remain fail-closed.'); }
  };
  const load = async (afterId?: string): Promise<void> => {
    const mine = ++owner.current, epoch = client.epoch;
    const current = (): boolean => mounted.current && owner.current === mine && client.isCurrent(epoch) && client.current?.status === 'signed_in';
    setSelection(null); setPage([]); setNext(null); setBusy(true); setNotice(''); syncPending();
    try {
      const result = await dispatch.list(afterId, current);
      if (!current()) return;
      setPage(result.drafts); setNext(result.nextAfterId);
      const exact = result.drafts.find(value => value.draftId === requested.current);
      if (exact) setSelection({ draftId: exact.draftId, revision: exact.revision });
      else if (requested.current) setNotice('Requested draft is not on this loaded page. Continue with Next page or use its unresolved receipt. No revision is guessed.');
    } catch { if (current()) setNotice('Current follow-up metadata unavailable. No private text retained.'); }
    finally { if (current()) { setBusy(false); syncPending(); } }
  };
  const loader = useRef(load); loader.current = load;
  useEffect(() => {
    mounted.current = true;
    let epoch = client.epoch;
    const unsubscribe = client.subscribe(() => {
      if (client.epoch !== epoch || client.current?.status !== 'signed_in') {
        epoch = client.epoch; owner.current += 1; setPage([]); setNext(null); setSelection(null); setPending([]); setBusy(false); setNotice('');
      }
    });
    void loader.current();
    return () => { mounted.current = false; owner.current += 1; unsubscribe(); custody.dispose(); };
  }, [client, custody]);
  useEffect(() => {
    if (!selectedFollowUpDraftId) return;
    const exact = loaded.current.find(value => value.draftId === selectedFollowUpDraftId);
    if (exact) setSelection(previous => previous?.draftId === exact.draftId ? previous : { draftId: exact.draftId, revision: exact.revision });
  }, [selectedFollowUpDraftId]);
  const select = (value: Selection): void => { setSelection(value); notify.current?.(value.draftId); };
  if (client.current?.status !== 'signed_in') return <></>;
  return <div className={`email-follow-ups${selection ? ' email-follow-up-selected' : ''}`}>
    <header><h2 ref={listHeading} tabIndex={-1}>Calling follow-ups</h2><p>Private promised emails saved for review. No recipient resolved and no scheduled send. Metadata pages contain at most 20 drafts.</p>
      <button disabled={busy} onClick={() => { void load(); }}>Refresh follow-ups</button></header>
    <p role="status">{notice}</p>
    <div className="email-follow-up-layout"><div className="email-follow-up-list" aria-label="Follow-up metadata">
      {page.length === 0 && !busy ? <p>No drafts on this loaded page.</p> : null}
      {page.map(value => <button key={value.draftId} aria-pressed={selection?.draftId === value.draftId} onClick={() => { select(value); }}>
        <strong>Draft {value.draftId}</strong><span>{value.source.kind === 'candidate' ? 'Candidate attempt' : 'Firm call'} · Revision {value.revision} · {value.availability}</span><small>Updated {value.updatedAt}</small>
      </button>)}
      {next ? <button disabled={busy} onClick={() => { void load(next); }}>Next follow-ups page</button> : null}
      {pending.length ? <aside aria-label="Unresolved follow-up commands"><h3>Unresolved commands</h3><p>Opaque identities only. Opening these never replays a save.</p>{pending.map(value => <button key={value.commandId} onClick={() => { select({ draftId: value.draftId, revision: value.expectedRevision }); }}>Recover draft {value.draftId}</button>)}</aside> : null}
    </div><div className="email-follow-up-detail">{selection ? <CallingFollowUpEditor key={selection.draftId} client={client} dispatch={dispatch} selection={selection}
      onCurrent={value => { setPage(previous => previous.map(item => item.draftId === value.draftId ? value : item)); syncPending(); }}
      onBack={() => { setSelection(null); notify.current?.(null); syncPending(); listHeading.current?.focus(); }} /> : <p>Select an exact saved revision to read its available subject and body. No invented message history.</p>}</div></div>
  </div>;
}

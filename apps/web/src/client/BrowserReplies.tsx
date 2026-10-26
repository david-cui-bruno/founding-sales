import { useEffect, useRef, useState, type JSX } from 'react';
import { replyListResponseSchema, type ReplyCardDto } from '@fss/contracts';
import { type BrowserClient } from './BrowserClient.ts';
import { BrowserReplyComposer, type ReplyScratch } from './BrowserReplyComposer.tsx';
import { ReplyAttempt } from './ReplyAttempt.ts';
import './workspaceEmail.css';

export function BrowserReplies({ client }: { client: BrowserClient }): JSX.Element {
  const [attempts] = useState(() => new ReplyAttempt(client));
  const [cards, setCards] = useState<ReplyCardDto[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState('Refresh to load current replies.');
  const [busy, setBusy] = useState(false);
  const [epoch, setEpoch] = useState(client.epoch);
  // Private scratch is mounted memory only. Reopening requires fresh matching source context.
  const drafts = useRef(new Map<string, ReplyScratch>());
  const heading = useRef<HTMLHeadingElement>(null), search = useRef<HTMLInputElement>(null);
  const returningToList = useRef(false);
  const owner = useRef(0), locked = useRef(false), mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const privateDrafts = drafts.current;
    let generation = client.epoch;
    const unsubscribe = client.subscribe(() => {
      if (generation !== client.epoch || client.current?.status !== 'signed_in') {
        generation = client.epoch; owner.current += 1; locked.current = false;
        drafts.current.clear(); setQuery('');
        setCards([]); setSelected(null); setBusy(false); setNotice('Refresh to load current replies.');
      }
      setEpoch(client.epoch);
    });
    return () => { mounted.current = false; owner.current += 1; privateDrafts.clear(); unsubscribe(); attempts.dispose(); };
  }, [attempts, client]);
  useEffect(() => {
    if (selected !== null) heading.current?.focus();
    else if (returningToList.current) { returningToList.current = false; search.current?.focus(); }
  }, [selected]);
  const refresh = async (): Promise<void> => {
    if (locked.current) return;
    const mine = ++owner.current, generation = client.epoch;
    const current = (): boolean => mounted.current && owner.current === mine && client.isCurrent(generation);
    locked.current = true; setBusy(true); setCards([]); setSelected(null); drafts.current.clear(); setNotice('Loading current replies…');
    try {
      const result = await client.request('/replies', replyListResponseSchema, {});
      if (current()) { setCards(result.cards); setNotice(result.cards.length === 0 ? 'No current replies available.' : ''); }
    } catch { if (current()) setNotice('Current replies unavailable. No automatic retry.'); }
    finally { if (current()) { locked.current = false; setBusy(false); } }
  };
  if (client.current?.status !== 'signed_in') return <></>;
  const term = query.trim().toLocaleLowerCase();
  const matches = cards.filter(card => [card.firmName, card.contactName, card.from, card.subject, card.body?.text].some(value => value?.toLocaleLowerCase().includes(term)));
  const card = cards.find(value => value.messageId === selected);
  return <section aria-label="Replies" className="email-replies">
    <div className="email-toolbar"><div><h2>Replies</h2><p>Personal replies stay with you. No sending is available here.</p></div>
      <button disabled={busy} onClick={() => { void refresh(); }}>Refresh replies</button></div>
    {notice ? <p role="status">{notice}</p> : null}
    <div className={`email-inbox${card ? ' email-show-thread' : ''}`} aria-busy={busy}>
      <aside className="email-list" aria-label="Email conversations">
        <div className="email-search"><label>Search loaded replies<input ref={search} type="search" value={query} onChange={event => { setQuery(event.target.value); }} /></label>
          <small>Searches names, subjects and available excerpts in these {cards.length} loaded replies, not your mailbox or full history.</small></div>
        <ul className="email-rows">{matches.map(value => <li key={value.messageId}><button aria-label={`${value.firmName}: ${value.subject ?? 'No subject'}`} aria-pressed={selected === value.messageId} onClick={() => { setSelected(value.messageId); }}>
          <strong>{value.contactName ?? value.from ?? value.firmName}</strong><span>{value.firmName}</span>
          <span>{value.subject ?? 'No subject'}</span><time dateTime={value.receivedAt}>{new Date(value.receivedAt).toLocaleDateString()}</time>
          <span className="email-excerpt">{value.body?.text ?? 'Open current original context'}{value.body?.truncated ? ' (excerpt truncated)' : ''}</span>
        </button></li>)}</ul>
        {cards.length > 0 && matches.length === 0 ? <p role="status">No loaded replies match. Try another name or subject.</p> : null}
      </aside>
      <section className="email-thread" aria-label="Selected email conversation">
        {card ? <><header className="email-thread-heading"><button className="email-back" onClick={() => { returningToList.current = true; setSelected(null); }}>Back to conversations</button>
          <h3 ref={heading} tabIndex={-1}>{card.contactName ?? card.firmName}</h3><p>{card.firmName} · {card.subject ?? 'No subject'}</p></header>
          <BrowserReplyComposer key={`${epoch}:${card.messageId}`} client={client} attempts={attempts} messageId={card.messageId}
            initialScratch={drafts.current.get(card.messageId)} onScratchChange={value => {
              if (!client.isCurrent(epoch)) return;
              if (value === null) drafts.current.delete(card.messageId); else drafts.current.set(card.messageId, value);
            }} /></> : <div className="email-empty"><h3>Select a conversation</h3><p>Open a loaded reply to read available originals and compose privately. No prior history is inferred.</p></div>}
      </section>
    </div>
  </section>;
}

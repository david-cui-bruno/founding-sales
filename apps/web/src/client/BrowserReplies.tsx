import { useEffect, useRef, useState, type JSX } from 'react';
import { replyListResponseSchema, type ReplyCardDto } from '@fss/contracts';
import { type BrowserClient } from './BrowserClient.ts';
import { BrowserReplyComposer } from './BrowserReplyComposer.tsx';
import { ReplyAttempt } from './ReplyAttempt.ts';

export function BrowserReplies({ client }: { client: BrowserClient }): JSX.Element {
  const [attempts] = useState(() => new ReplyAttempt(client));
  const [cards, setCards] = useState<ReplyCardDto[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [epoch, setEpoch] = useState(client.epoch);
  const owner = useRef(0), locked = useRef(false), mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    let generation = client.epoch;
    const unsubscribe = client.subscribe(() => {
      if (generation !== client.epoch || client.current?.status !== 'signed_in') {
        generation = client.epoch; owner.current += 1; locked.current = false;
        setCards([]); setSelected(null); setBusy(false); setNotice('');
      }
      setEpoch(client.epoch);
    });
    return () => { mounted.current = false; owner.current += 1; unsubscribe(); attempts.dispose(); };
  }, [attempts, client]);
  const refresh = async (): Promise<void> => {
    if (locked.current) return;
    const mine = ++owner.current, generation = client.epoch;
    const current = (): boolean => mounted.current && owner.current === mine && client.isCurrent(generation);
    locked.current = true; setBusy(true); setCards([]); setSelected(null); setNotice('');
    try {
      const result = await client.request('/replies', replyListResponseSchema, {});
      if (current()) { setCards(result.cards); setNotice(result.cards.length === 0 ? 'No current replies available.' : 'Select a reply to review current original context.'); }
    } catch { if (current()) setNotice('Current replies unavailable. No automatic retry.'); }
    finally { if (current()) { locked.current = false; setBusy(false); } }
  };
  if (client.current?.status !== 'signed_in') return <></>;
  return <section aria-label="Replies"><h2>Replies</h2>
    <p>Review current conversations, prepare a suggestion or compose manually. Nothing is sent from this browser workspace.</p>
    <button disabled={busy} onClick={() => { void refresh(); }}>Refresh replies</button>
    {notice ? <p role="status">{notice}</p> : null}
    <ul>{cards.map(card => <li key={card.messageId}><button disabled={busy} aria-pressed={selected === card.messageId} onClick={() => { setSelected(card.messageId); }}>{card.firmName}: {card.subject ?? 'No subject'}</button></li>)}</ul>
    {selected ? <BrowserReplyComposer key={`${epoch}:${selected}`} client={client} attempts={attempts} messageId={selected} /> : null}
  </section>;
}

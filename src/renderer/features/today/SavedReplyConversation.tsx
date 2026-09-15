import { useId, type CSSProperties } from 'react';
import type { MailMessage, ThreadProjection } from '../../../shared/contracts/mailThreadContract';

const muted: CSSProperties = { color: 'var(--text-muted)', fontSize: 12 };
const messageText: CSSProperties = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', font: 'inherit', lineHeight: 1.6 };
const warning: CSSProperties = { ...muted, color: 'var(--warning)', borderLeft: '3px solid var(--warning)', paddingLeft: 12 };
const dateFormat = new Intl.DateTimeFormat(undefined, {
  year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit',
  timeZone: 'UTC', timeZoneName: 'short',
});
function SavedDate({ date }: { date: string }) {
  return <time dateTime={date}>{dateFormat.format(new Date(date))}</time>;
}
function SavedMessage({ message }: { message: MailMessage }) {
  // The saved model contains addresses, not verified display names or permissions.
  // Render text nodes only: HTML source, URLs and entities never become active markup.
  const plain = message.bodyParts.filter(part => part.mimeType === 'text/plain' && part.text.length > 0);
  const parts = plain.length ? plain : message.bodyParts.filter(part => part.mimeType === 'text/html' && part.text.length > 0);
  return (
    <div style={{ overflowWrap: 'anywhere', minWidth: 0, margin: '12px 0' }}>
      <dl style={{ display: 'grid', gridTemplateColumns: '54px minmax(0, 1fr)', gap: '3px 10px', fontSize: 12 }}>
        <dt style={muted}>From</dt><dd style={{ margin: 0 }}>{message.from.join(', ')}</dd>
        <dt style={muted}>To</dt><dd style={{ margin: 0 }}>{message.to.join(', ') || 'No recipients saved'}</dd>
        <dt style={muted}>Cc</dt><dd style={{ margin: 0 }}>{message.cc.join(', ') || 'None saved'}</dd>
        <dt style={muted}>Date</dt><dd style={{ margin: 0 }}><SavedDate date={message.date} /></dd>
        <dt style={muted}>Subject</dt><dd style={{ margin: 0 }}>{message.subject || 'No subject saved'}</dd>
      </dl>
      {!plain.length && parts.length > 0 && <p style={muted}>HTML-only message: escaped source shown below, not rendered.</p>}
      {parts.length ? parts.map((part, index) => <pre key={index} style={messageText}>{part.text}</pre>) : <p style={muted}>No body text was saved for this message.</p>}
      {message.bodyParts.some(part => part.truncated) && <p style={warning}>At least one saved body part is truncated. Only the saved portion is available.</p>}
    </div>
  );
}

/** Read-only rendering of the supplied saved projection. No loading or mutation. */
export function SavedReplyConversation({ thread }: { thread: ThreadProjection }) {
  const headingId = useId();
  // Contract permits up to 200 messages and does not promise chronological order.
  // Sort a copy; equal timestamps retain their saved order through stable sort.
  const messages = [...thread.thread.messages].sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  const [latest, ...earlier] = messages;
  return (
    <section aria-labelledby={headingId} style={{ minWidth: 0, overflowWrap: 'anywhere', borderBottom: '1px solid var(--line)', paddingBottom: 12, marginBottom: 16 }}>
      <h4 id={headingId}>Saved conversation</h4>
      <p style={muted}>{messages.length} saved {messages.length === 1 ? 'message' : 'messages'}. This snapshot may be incomplete. Remote freshness is unknown.</p>
      {latest && <details key={latest.id} open>
        <summary style={muted}>Latest saved message · {latest.from.join(', ')} · <SavedDate date={latest.date} /></summary>
        <SavedMessage message={latest} />
      </details>}
      {earlier.length ? <details key={`earlier:${latest.id}`}>
        <summary style={muted}>Earlier saved messages ({earlier.length})</summary>
        {earlier.map(message => <div key={message.id} style={{ borderTop: '1px solid var(--line)', paddingTop: 4 }}><SavedMessage message={message} /></div>)}
      </details> : <p style={muted}>No earlier messages in this saved snapshot.</p>}
    </section>
  );
}

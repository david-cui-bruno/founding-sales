import { useState } from 'react';
import { Button } from '../../components/Button';

export type OutboundComposerProps = {
  channel: 'text' | 'email';
  recipientLabel: string;
  onClose(): void;
};

/** Plain-text, unsent and memory-only. Unmounting discards the draft. */
export function OutboundComposer({ channel, recipientLabel, onClose }: OutboundComposerProps) {
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  return (
    <section className="outbound-composer" aria-label={`Unsent ${channel} draft`}>
      <h3>Unsent {channel} draft</h3>
      <p>{recipientLabel}</p>
      {channel === 'email' && <label>Subject<input value={subject} onChange={(event) => setSubject(event.target.value)} /></label>}
      <label>Message<textarea rows={5} value={body} onChange={(event) => setBody(event.target.value)} /></label>
      <p>{channel === 'text' ? 'Messages sending not yet enabled.' : 'Gmail not connected.'}</p>
      <p>This draft is not saved and will be discarded when closed.</p>
      <Button disabled>Send</Button>{' '}
      <Button variant="quiet" onClick={onClose}>Close draft</Button>
    </section>
  );
}

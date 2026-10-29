import { useLayoutEffect, useRef, useState, type JSX } from 'react';
import { candidateAuthorityReadSchema, candidateAuthorityViewSchema, type CandidateAuthorityView } from '@fss/contracts';
import type { BrowserClient } from './BrowserClient.ts';

/** Explicit, memory-only metadata observation. Positive evidence never grants authority. */
export function BrowserCandidateAuthority({ client, candidateId, expectedRevision }: {
  client: BrowserClient; candidateId: string; expectedRevision: number;
}): JSX.Element {
  const [view, setView] = useState<CandidateAuthorityView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const operation = useRef<symbol | null>(null);
  const mounted = useRef(false);
  const binding = useRef({ client, candidateId, expectedRevision });
  binding.current = { client, candidateId, expectedRevision };
  // An asynchronously inserted row is already interactive before passive effects.
  // Install its lifecycle fence before that first explicit authority read.
  useLayoutEffect(() => {
    mounted.current = true;
    let epoch = client.epoch;
    const clear = (): void => {
      operation.current = null; setView(null); setError(''); setBusy(false);
    };
    clear();
    const unsubscribe = client.subscribe(() => {
      if (epoch !== client.epoch || client.current?.status !== 'signed_in') {
        epoch = client.epoch; clear();
      }
    });
    return () => { mounted.current = false; operation.current = null; unsubscribe(); };
  }, [client, candidateId, expectedRevision]);
  const read = async (): Promise<void> => {
    if (operation.current !== null) return;
    setView(null); setError('');
    const epoch = client.epoch;
    if (!client.isCurrent(epoch) || client.current?.status !== 'signed_in') return;
    const input = candidateAuthorityReadSchema.safeParse({ candidateId, expectedRevision });
    if (!input.success) { setError('Source authority request unavailable. No automatic retry.'); return; }
    const token = Symbol('candidate-authority');
    operation.current = token; setBusy(true);
    const current = (): boolean => mounted.current && operation.current === token
      && binding.current.client === client && binding.current.candidateId === candidateId
      && binding.current.expectedRevision === expectedRevision && client.isCurrent(epoch)
      && client.current?.status === 'signed_in';
    try {
      const answer = await client.request('/sourcing/candidates/authority/read', candidateAuthorityViewSchema, input.data, () => {
        if (!current()) throw new Error('Superseded source authority read');
      });
      if (!current()) return;
      if (answer.candidateId !== candidateId || answer.candidateRevision !== expectedRevision) throw new Error('Unbound source authority response');
      setView(answer);
    } catch {
      if (current()) setError('Source authority read unavailable or refused. This is not evidence of absence. No automatic retry.');
    } finally {
      if (current()) { operation.current = null; setBusy(false); }
    }
  };
  return <section aria-label="Candidate source authority">
    <button type="button" disabled={busy} onClick={() => { void read(); }}>Read source authority</button>
    {busy ? <p role="status">Reading source authority.</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {view === null ? null : <div>
      <p>{view.source.status === 'matched' ? `Source matched ${view.source.kind} · Attempt ID ${view.source.attemptId}` : 'Source unavailable'}</p>
      <p>Owner {view.owner}</p><p>Research enabled {String(view.researchEnabled)}</p>
      <p>Holds {view.holds}</p><p>Checked at {view.checkedAt}</p>
      <p>Authority not_granted. These observations grant no provider, qualification, contact, publication or spending authority.</p>
    </div>}
  </section>;
}

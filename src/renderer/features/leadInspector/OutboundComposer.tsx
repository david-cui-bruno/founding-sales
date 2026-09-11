import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { LocalEmailAuthorityRead, OutreachApi, OutreachStatus } from '../../../shared/contracts/outreachContract';
import { localEmailAuthorityReadSchema, outreachStatusSchema } from '../../../shared/contracts/outreachContract';
import { Button } from '../../components/Button';
import { emailDraftSession } from './emailDraftSession';

export type OutboundComposerProps = {
  channel: 'text' | 'email'; recipientLabel: string; onClose(): void;
  api?: OutreachApi; personId?: string; contactMethodId?: string; disabled?: boolean;
  sendBlockedReason?: string | null;
};

export function openConnections() {
  try { window.sessionStorage.setItem('callie.settings.section', 'connections'); } catch { /* The Settings tab remains available. */ }
  window.dispatchEvent(new Event('callie:open-connections'));
}

/** Email is durable through main. Text retains its explicitly unsent local editor. */
export function OutboundComposer(props: OutboundComposerProps) {
  if (props.channel === 'email' && props.api !== undefined && props.personId !== undefined && props.contactMethodId !== undefined) {
    return <EmailComposer key={`${props.personId}:${props.contactMethodId}`} api={props.api} personId={props.personId}
      contactMethodId={props.contactMethodId} recipientLabel={props.recipientLabel} onClose={props.onClose} disabled={props.disabled}
      sendBlockedReason={props.sendBlockedReason} />;
  }
  return <LocalComposer {...props} />;
}
function EmailComposer({ api, personId, contactMethodId, recipientLabel, onClose, disabled = false, sendBlockedReason = null }: {
  api: OutreachApi; personId: string; contactMethodId: string; recipientLabel: string; onClose(): void; disabled?: boolean;
  sendBlockedReason?: string | null;
}) {
  const session = emailDraftSession(api, personId, contactMethodId);
  const value = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
  const draft = value.draft;
  const generation = useRef(0);
  const [observation, setObservation] = useState<{
    api: OutreachApi; personId: string; contactMethodId: string; draftId: string; revision: number;
    generation: number; setup: OutreachStatus | null; authority: LocalEmailAuthorityRead | null;
  } | null>(null);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    void session.open();
    return () => { active.current = false; void session.flush().catch((): undefined => undefined); };
  }, [session]);
  useEffect(() => {
    let mounted = true;
    const refresh = () => {
      // Each real observation invalidates both prior reads, even for the same tuple.
      const requestGeneration = ++generation.current;
      setObservation(null);
      const snapshot = session.snapshot();
      const saved = snapshot.draft;
      // Explicit open owns loading/flush. Observation never opens or saves a draft.
      if (snapshot.loading || saved === null) return;
      const binding = { api, personId, contactMethodId, draftId: saved.id, revision: saved.revision, generation: requestGeneration };
      const current = () => {
        const latest = session.snapshot();
        return mounted && generation.current === requestGeneration && !latest.loading
          && latest.draft?.id === binding.draftId && latest.draft.revision === binding.revision
          && latest.draft.personId === personId && latest.draft.contactMethodId === contactMethodId;
      };
      setObservation({ ...binding, setup: null, authority: null });
      // Separate settlements: a failure is a current hold, not a retained ready value.
      void Promise.resolve().then(() => api.status()).then(result => {
        const parsed = outreachStatusSchema.safeParse(result);
        if (current()) setObservation(previous => previous?.generation === requestGeneration
          ? { ...previous, setup: parsed.success ? parsed.data : null } : previous);
      }).catch(() => {
        if (current()) setObservation(previous => previous?.generation === requestGeneration
          ? { ...previous, setup: null } : previous);
      });
      void Promise.resolve().then(() => api.inspectLocalAuthority({ draftId: saved.id, expectedRevision: saved.revision })).then(result => {
        const parsed = localEmailAuthorityReadSchema.safeParse(result);
        const read = parsed.success ? parsed.data : null;
        const matches = read !== null && read.draftId === saved.id && read.expectedRevision === saved.revision
          && read.personId === personId && read.contactMethodId === contactMethodId;
        if (current()) setObservation(previous => previous?.generation === requestGeneration
          ? { ...previous, authority: matches ? read : null } : previous);
      }).catch(() => {
        if (current()) setObservation(previous => previous?.generation === requestGeneration
          ? { ...previous, authority: null } : previous);
      });
    };
    refresh();
    window.addEventListener('focus', refresh);
    window.addEventListener('hashchange', refresh);
    return () => {
      mounted = false;
      ++generation.current;
      window.removeEventListener('focus', refresh);
      window.removeEventListener('hashchange', refresh);
    };
  }, [api, personId, contactMethodId, session, draft?.id, draft?.revision, value.loading]);
  const observationCurrent = observation !== null && observation.api === api && observation.personId === personId
    && observation.contactMethodId === contactMethodId && observation.draftId === draft?.id
    && observation.revision === draft?.revision && observation.generation === generation.current && !value.loading;
  const setup = observationCurrent ? observation.setup : null;
  const authority = observationCurrent ? observation.authority : null;
  const authorityAllowed = authority?.state === 'allowed';
  const editable = !disabled && !value.loading && !value.busy && draft?.status === 'draft';
  const configuredFooter = setup === null ? '' : `${setup.senderName}\n${setup.postalAddress}\nTo stop these emails, reply "stop".`;
  const senderEmail = draft?.senderEmail === undefined ? setup?.accountEmail : draft.senderEmail;
  const footer = draft?.footer ?? configuredFooter;
  const identityCurrent = senderEmail === setup?.accountEmail && footer === configuredFooter;
  const ready = setup?.gmail === 'ready' && !!setup.accountEmail && !!setup.senderName.trim() && !!setup.postalAddress.trim() && identityCurrent;
  const recipientCurrent = draft?.recipient === recipientLabel;
  const flush = () => { void session.flush().catch((): undefined => undefined); };
  return <section className="outbound-composer" aria-label="Unsent email draft">
    <h3>Email</h3>
    <p>To: <strong>{draft?.recipient ?? recipientLabel}</strong></p>
    {value.loading && <p role="status">Opening saved draft…</p>}
    {draft !== null && !recipientCurrent && <p role="alert">This contact changed. Close and reopen the current email contact before sending.</p>}
    <label>Subject<input maxLength={240} value={value.subject} disabled={!editable} onChange={event => session.edit('subject', event.target.value)} onBlur={flush} /></label>
    <label>Message<textarea rows={7} maxLength={20000} value={value.body} disabled={!editable} onChange={event => session.edit('body', event.target.value)} onBlur={flush} /></label>
    {setup?.model !== 'ready' && <p>AI drafting is not configured or available. Your own edits can still be saved.</p>}
    {!ready && <p>Sending requires Gmail, sender identity and a postal address in <a href="#/settings" onClick={() => { flush(); openConnections(); }}>Settings → Connections</a>.</p>}
    {setup !== null && draft !== null && !identityCurrent && <p role="alert">Sender settings changed. Close and reopen this draft to review the current send identity before sending.</p>}
    {setup !== null && <section className="outbound-composer__preview" aria-label="Send identity and footer preview">
      <p>From: <strong>{senderEmail ?? 'No Gmail account connected'}</strong></p>
      <p>Included below your message:</p><pre>{footer}</pre>
    </section>}
    {disabled && <p role="alert">Outreach is disabled for this person.</p>}
    {sendBlockedReason !== null && <p role="status">{sendBlockedReason}</p>}
    {!authorityAllowed && <p role="status">Local account send authority is not established. Saving your draft remains available.</p>}
    <div className="outbound-composer__actions">
      <Button disabled={!editable || value.conflict || !ready || !authorityAllowed || !recipientCurrent || sendBlockedReason !== null || !value.body.trim() || !value.subject.trim()} onClick={() => { if (sendBlockedReason === null && authorityAllowed && observation?.generation === generation.current) void session.send(); }}>Send</Button>
      <Button variant="quiet" disabled={!editable} onClick={() => { void session.saveDisplayedEdits().catch((): undefined => undefined); }}>{value.conflict ? 'Save my displayed edits' : 'Save draft'}</Button>
      {setup?.model === 'ready' && <Button variant="quiet" disabled={!editable || value.conflict} onClick={() => { void session.generate(); }}>Generate draft</Button>}
      <Button variant="quiet" disabled={value.busy} onClick={() => { void session.flush().then(() => { if (active.current) onClose(); }, (): undefined => undefined); }}>Close draft</Button>
      {value.error !== null && !value.conflict && <Button variant="quiet" disabled={value.busy || value.loading} onClick={() => { void session.open(); }}>Reload saved draft</Button>}
    </div>
    {/* Blur starts saving during pointer-down. Feedback must not move the
        action targets before pointer-up, including when saved notices clear. */}
    {draft?.generation === 'model' && <p className="outbound-composer__hint">AI-assisted draft. Review the facts and wording before sending.</p>}
    {value.error !== null && <p role="alert">{value.error}</p>}
    {value.conflict && draft !== null && <details><summary>Compare saved version</summary><h4>{draft.subject}</h4><pre>{draft.body}</pre></details>}
    {value.saving && <p role="status">Saving edits…</p>}
    {draft?.status === 'unknown' && <p role="status">Send result unknown. Check Gmail’s Sent folder before any further outreach. Do not resend this draft.</p>}
    {draft?.status === 'sending' && <p role="status">Send pending. Do not resend.</p>}
    {draft?.status === 'sent' && <p role="status">Accepted by Gmail. This does not confirm delivery or a reply.</p>}
    {draft?.notice && <p role="status">{draft.notice}</p>}
  </section>;
}
function LocalComposer({ channel, recipientLabel, onClose }: OutboundComposerProps) {
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  return <section className="outbound-composer" aria-label={`Unsent ${channel} draft`}>
    <h3>Unsent {channel} draft</h3><p>{recipientLabel}</p>
    {channel === 'email' && <label>Subject<input value={subject} onChange={event => setSubject(event.target.value)} /></label>}
    <label>Message<textarea rows={5} value={body} onChange={event => setBody(event.target.value)} /></label>
    <p>{channel === 'text' ? 'Messages sending not yet enabled.' : 'Gmail not connected.'}</p>
    <p>This draft is not saved and will be discarded when closed.</p>
    <Button disabled>Send</Button>{' '}<Button variant="quiet" onClick={onClose}>Close draft</Button>
  </section>;
}

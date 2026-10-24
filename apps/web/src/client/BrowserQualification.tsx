import { useEffect, useRef, useState, type JSX } from 'react';
import { qualificationReadSchema, qualificationViewSchema } from '@fss/contracts';
import type { z } from 'zod';
import type { BrowserClient } from './BrowserClient.ts';
import { canReviewQualification } from './QualificationPending.ts';
import { dispatchQualification } from './QualificationDispatch.ts';
import { CapturedQualificationOriginals } from './CapturedQualificationOriginals.tsx';
import {BrowserRetainedRecovery} from './BrowserRetainedRecovery.tsx';
type QualificationView = z.infer<typeof qualificationViewSchema>;

export function QualificationEvidenceLink({ url }: { url: string }): JSX.Element {
  let href: string | undefined;
  try { const parsed = new URL(url); if (['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password) href = parsed.href; } catch { /* Retained references do not trigger fetches. */ }
  return href === undefined ? <span>{url}</span> : <a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{url}</a>;
}

/** Ordinary candidate evidence, explicit existing request and human-reviewed admission only. */
export function BrowserQualification({ client, candidateId, expectedRevision }: {
  client: BrowserClient; candidateId: string; expectedRevision: number;
}): JSX.Element {
  const [view, setView] = useState<QualificationView | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const operation = useRef<symbol | null>(null), mounted = useRef(false);
  const binding = useRef({ client, candidateId, expectedRevision });
  binding.current = { client, candidateId, expectedRevision };
  useEffect(() => {
    mounted.current = true;
    let epoch = client.epoch;
    const update = (): void => {
      if (epoch !== client.epoch || client.current?.status !== 'signed_in') {
        epoch = client.epoch; operation.current = null; setView(null); setNotice(''); setBusy(false);
      }
      try { const held = client.qualification.read(); setBlocked(held !== null && held.receipt === undefined); }
      catch { setBlocked(true); }
    };
    operation.current = null; setBusy(false); setView(null); setNotice(''); update();
    const unsubscribe = client.subscribe(update);
    return () => { mounted.current = false; operation.current = null; unsubscribe(); };
  }, [client, candidateId, expectedRevision]);
  const run = async (kind: 'read' | 'request' | 'admit'): Promise<void> => {
    if (operation.current !== null) return;
    const epoch = client.epoch;
    if (!client.isCurrent(epoch) || client.current?.status !== 'signed_in' || client.current.role !== 'admin') return;
    const token = Symbol('qualification'); operation.current = token; setBusy(true); setNotice('');
    const current = (): boolean => mounted.current && operation.current === token && client.isCurrent(epoch)
      && binding.current.client === client && binding.current.candidateId === candidateId && binding.current.expectedRevision === expectedRevision;
    const read = async (): Promise<QualificationView | null> => {
      const input = qualificationReadSchema.parse({ candidateId });
      const answer = await client.request('/sourcing/qualification/read', qualificationViewSchema.nullable(), input, () => {
        if (!current()) throw new Error('Qualification binding changed');
      });
      if (!current()) throw new Error('Qualification superseded');
      if (answer !== null && (answer.candidateId !== candidateId || (answer.currentCandidateRevision??answer.candidateRevision) !== expectedRevision)) throw new Error('Qualification candidate changed');
      return answer;
    };
    try {
      if (kind === 'read') { setView(null); const answer = await read(); if (current()) { setView(answer); if (answer === null) setNotice('No retained qualification returned. Not evidence of global absence.'); } return; }
      let runId: string | undefined;
      if (kind === 'admit') {
        const reviewed = view;
        setView(null);
        // Never act on the displayed historical run after an await. Recheck the latest exact run.
        const fresh = await read();
        if (fresh === null || !canReviewQualification(fresh, candidateId, expectedRevision) || fresh.runId !== reviewed?.runId || JSON.stringify(fresh) !== JSON.stringify(reviewed)) {
          throw new Error('Latest evidence requires another explicit read and review');
        }
        runId = fresh.runId;
      }
      if (!current()) return;
      const held = kind === 'request'
        ? client.qualification.prepare({ kind, candidateId, expectedRevision })
        : client.qualification.prepare({ kind, candidateId, expectedRevision, qualificationRunId: runId! });
      setView(null);
      const message = await dispatchQualification(client, held, current);
      if (current()) setNotice(message);
    } catch {
      if (current()) setNotice('Qualification unavailable or refused. Read fresh evidence before acting. Uncertain commands remain retained for explicit same-ID reconciliation. No automatic retry.');
    } finally { if (current()) { operation.current = null; setBusy(false); } }
  };
  const admin = client.current?.status === 'signed_in' && client.current.role === 'admin';
  const waiting = view?.status === 'pending' || view?.status === 'running';
  return <section aria-label="Candidate qualification">
    <h5>Qualification evidence</h5>
    <p>Existing qualification policy only. Admission records a Firm and route, not consent, contact or sending authority.</p>
    <button type="button" disabled={busy || !admin} onClick={() => { void run('read'); }}>Read qualification</button>
    <button type="button" disabled={busy || blocked || waiting || !admin || view?.recovery!==undefined} onClick={() => { void run('request'); }}>Request qualification</button>
    {canReviewQualification(view, candidateId, expectedRevision) ? <button type="button" disabled={busy || blocked || !admin} onClick={() => { void run('admit'); }}>Admit reviewed qualification</button> : null}
    {busy ? <p role="status">Qualification operation in progress.</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {view === null ? null : <div>
      <p>Candidate {view.candidateId} revision {view.candidateRevision} · Latest run {view.runId} · Status {view.status}</p>
      <p>Requested {view.requestedAt} · Deadline {view.deadlineAt}</p>
      {view.recovery?<p>Retained-only acquisition fence. Human decision {view.recovery.decisionId}. Original run {view.recovery.originalRunId}. Current candidate revision {view.currentCandidateRevision}. Interpretation {view.interpretationOrigin}. No automatic acquisition or publication.</p>:null}
      <BrowserRetainedRecovery key={`${candidateId}:${expectedRevision}:${view.runId}:${view.recovery?.decisionId??'none'}`} client={client} view={view} revision={expectedRevision} blocked={blocked||busy||!admin} onSaved={message=>{setView(null);setNotice(message);}} />
      {view.reason ? <p>Reason {view.reason}</p> : null}{view.admissionReason ? <p>Admission reason {view.admissionReason}</p> : null}
      {view.verdict === null ? <p>No current verdict.</p> : <><p>Verdict {view.verdict.decision} · Rank {view.verdict.rank} · Policy {view.verdict.policyVersion}</p>
        {view.verdict.reasons.map(reason => <p key={reason}>Evidence reason {reason}</p>)}
        {view.verdict.unknowns.map(unknown => <p key={unknown}>Unknown {unknown}</p>)}</>}
      {view.observations.map(source => <div key={source.id}>
        <QualificationEvidenceLink url={source.url} /><p>Retrieved {source.retrievedAt} · Published {source.publishedAt ?? 'unknown'} · First party {String(source.firstParty)} · Truncated {String(source.truncated)}</p>
        {view.facts.filter(fact => fact.observationId === source.id).map((fact, index) => <blockquote key={index}>{fact.kind}: {fact.value}</blockquote>)}
        <CapturedQualificationOriginals key={`${candidateId}:${expectedRevision}:${view.runId}:${source.id}`} source={source} />
      </div>)}
      {view.openingQuestion ? <p>Preparation question {view.openingQuestion}</p> : null}
      {view.admission ? <p>Admitted exact Firm {view.admission.firmId}. Route {view.admission.routeId}. No contact or sending authority.</p> : null}
    </div>}
  </section>;
}

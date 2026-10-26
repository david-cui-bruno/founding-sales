import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { z } from 'zod';
import { qualifiedResearchSelectionSchema, qualifiedResearchListSchema, qualifiedResearchFirmSchema, todayActionsV4ResponseSchema, todayActionOpenV4ResponseSchema,
  type QualifiedResearchCandidate, type QualifiedResearchFirm, type QualifiedResearchSelection, type TodayActionV4 } from '@fss/contracts';
import { Button } from '../../../desktop/src/renderer/ui/button.tsx';
import { BrowserBoundaryError, type BrowserClient } from './BrowserClient.ts';
import { AutomaticResearchProof } from './AutomaticResearchProof.tsx';
import type { AutomaticResearchFirm } from '@fss/contracts';

const citationHref = (url: string): string | undefined => {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && !parsed.username && !parsed.password ? parsed.href : undefined;
  } catch { return undefined; }
};
const receipt = z.strictObject({ status: z.literal('accepted'), replayed: z.boolean(), result: qualifiedResearchFirmSchema });
const sameSelection = (a: QualifiedResearchFirm, held: { selection: QualifiedResearchSelection }): boolean =>
  JSON.stringify(a.selection) === JSON.stringify(held.selection);

export function ResearchProof({ proof }: { proof: QualifiedResearchFirm }): JSX.Element {
  return <section aria-label="Current research proof" className="prospects-proof space-y-3 rounded-md border p-4"><p className="prospects-eyebrow">Qualified retained research</p><h3 tabIndex={-1}>{proof.firmName}</h3>
    <p>{proof.locality}, {proof.region} · <a href={citationHref(proof.website)} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{proof.website}</a></p>
    <p>Discovery preparation question: {proof.question}</p>
    <p>Channel authority not granted. Maintenance need not established. Email fit: {proof.emailFit}, not sending permission.</p>
    <details><summary>Source passages and exact research lineage</summary>
    <p>Firm {proof.firmId}</p><p>Candidate {proof.selection.candidateId} revision {proof.selection.candidateRevision} · Run {proof.selection.runId}</p>
    <p>Discovery {proof.selection.discoveryCandidateId} revision {proof.selection.discoveryRevision} · Promotion {proof.promotionId}</p>
    <p>Source {proof.source.provider} · Release {proof.source.release} · Record {proof.source.recordId}</p>
    <p>Evidence fingerprint {proof.evidenceFingerprint}</p>
    <p>Valid until {proof.validUntil} · Policy {proof.policyVersion} · Assigned owner {proof.ownerUserId}</p>
    {proof.citations.map(citation => <article key={`${citation.kind}:${citation.observationId}:${citation.blockId}`}><h4>{citation.kind.replaceAll('_', ' ')}</h4>
      <blockquote>{citation.quote}</blockquote><a href={citationHref(citation.url)} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{citation.url}</a>
      <p>Retrieved {citation.retrievedAt} · Observation {citation.observationId} · Block {citation.blockId} · Hash {citation.contentHash}</p></article>)}
    </details><p>Review only. No contact, enrollment or send action is available.</p>
  </section>;
}

/** A current-proof queue and one explicit noncontact command, not a second command engine. */
export function BrowserResearchQueue({ client, workspace = false }: { client: BrowserClient; workspace?: boolean }): JSX.Element {
  const inFlight = useRef<{ epoch: number; token: symbol } | null>(null);
  const mounted = useRef(false);
  const detail = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const observedEpoch = useRef(client.epoch);
  const [actions, setActions] = useState<TodayActionV4[] | null>(null);
  const [candidates, setCandidates] = useState<QualifiedResearchCandidate[]>([]);
  const [afterId, setAfterId] = useState<string | null>(null);
  const [pending, setPending] = useState(client.pendingResearch());
  const [proof, setProof] = useState<QualifiedResearchFirm | null>(null);
  const [automaticProof, setAutomaticProof] = useState<AutomaticResearchFirm | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (workspace && (proof !== null || automaticProof !== null)) detail.current?.querySelector<HTMLElement>('h3')?.focus();
  }, [workspace, proof, automaticProof]);
  useEffect(() => {
    mounted.current = true;
    observedEpoch.current = client.epoch;
    setActions(null); setCandidates([]); setAfterId(null); setProof(null); setAutomaticProof(null);
    setPending(client.pendingResearch()); setBusy(false); setNotice('');
    const unsubscribe = client.subscribe(() => {
    setPending(client.pendingResearch());
    if (observedEpoch.current !== client.epoch || client.current?.status !== 'signed_in') {
      observedEpoch.current = client.epoch;
      inFlight.current = null;
      setActions(null); setCandidates([]); setAfterId(null); setProof(null); setAutomaticProof(null); setPending(null); setBusy(false); setNotice('');
    }
    });
    return () => { mounted.current = false; inFlight.current = null; unsubscribe(); };
  }, [client]);
  const operationGuard = useCallback((epoch: number): (() => boolean) => {
    const held = inFlight.current;
    return () => mounted.current && held !== null && inFlight.current === held && client.isCurrent(epoch);
  }, [client]);
  const run = useCallback(async (work: (epoch: number) => Promise<void>): Promise<void> => {
    const epoch = client.epoch;
    if (!mounted.current || !client.isCurrent(epoch) || client.current?.status !== 'signed_in') return;
    if (inFlight.current?.epoch === epoch) return;
    const operation = { epoch, token: Symbol('research-operation') };
    inFlight.current = operation;
    const active = operationGuard(epoch);
    setBusy(true); setProof(null); setAutomaticProof(null); setNotice('');
    try { await work(epoch); }
    catch { if (active()) { setPending(client.pendingResearch()); setNotice('Request unavailable or refused. This is not an empty result. A failed read does not prove creation absent. No automatic retry.'); } }
    finally {
      if (inFlight.current === operation) {
        inFlight.current = null;
        if (mounted.current && client.isCurrent(epoch)) setBusy(false);
      }
    }
  }, [client, operationGuard]);
  const loadQueue = useCallback(async (epoch: number): Promise<void> => {
    const active = operationGuard(epoch);
    setActions(null);
    const answer = await client.request('/today/actions/v4', todayActionsV4ResponseSchema, undefined, () => { if (!active()) throw new BrowserBoundaryError('refused'); });
    if (active()) setActions(answer.actions);
  }, [client, operationGuard]);
  useEffect(() => { void run(loadQueue); }, [loadQueue, run]); // One initial read, never a mutation replay.
  const loadCandidates = async (epoch: number, more = false): Promise<void> => {
    const active = operationGuard(epoch);
    if (!more) { setCandidates([]); setAfterId(null); }
    const answer = await client.request('/sourcing/research-firms/list', qualifiedResearchListSchema, more && afterId !== null ? { afterId } : {}, () => { if (!active()) throw new BrowserBoundaryError('refused'); });
    if (active()) { setCandidates(previous => more ? [...previous, ...answer.candidates] : answer.candidates); setAfterId(answer.nextAfterId); }
  };
  const create = async (epoch: number, candidate?: QualifiedResearchCandidate): Promise<void> => {
    const active = operationGuard(epoch);
    const held = candidate === undefined ? client.pendingResearch() : client.prepareResearch(candidate.selection);
    if (held === null || held.createdFirmId !== undefined) throw new BrowserBoundaryError('refused');
    setPending(held);
    const answer = await client.request('/sourcing/research-firms/create', receipt, { ...held.selection, commandId: held.commandId }, () => { if (!active()) throw new BrowserBoundaryError('refused'); client.retainResearch(held); });
    if (!active()) return;
    if (!sameSelection(answer.result, held)) throw new BrowserBoundaryError('invalid_response');
    const confirmed = { ...held, createdFirmId: answer.result.firmId };
    client.retainResearch(confirmed); setPending(confirmed);
    // Receipt rehydrates proof, but current read remains an independent authority check.
    const current = await client.request('/sourcing/research-firms/read', qualifiedResearchFirmSchema, { firmId: confirmed.createdFirmId }, () => { if (!active()) throw new BrowserBoundaryError('refused'); });
    if (!active()) return;
    if (current.firmId !== confirmed.createdFirmId || !sameSelection(current, held)) throw new BrowserBoundaryError('invalid_response');
    setProof(current); setNotice('Research Firm confirmed. Open its Today action to revalidate current proof.');
    const queue = await client.request('/today/actions/v4', todayActionsV4ResponseSchema, undefined, () => { if (!active()) throw new BrowserBoundaryError('refused'); });
    if (active()) setActions(queue.actions);
  };
  const readConfirmed = async (epoch: number): Promise<void> => {
    const active = operationGuard(epoch);
    const held = client.pendingResearch();
    if (held?.createdFirmId === undefined) throw new BrowserBoundaryError('refused');
    const current = await client.request('/sourcing/research-firms/read', qualifiedResearchFirmSchema, { firmId: held.createdFirmId }, () => { if (!active()) throw new BrowserBoundaryError('refused'); });
    if (!active()) return;
    if (current.firmId !== held.createdFirmId || !sameSelection(current, held)) throw new BrowserBoundaryError('invalid_response');
    setProof(current);
  };
  const open = async (epoch: number, action: TodayActionV4): Promise<void> => {
    const active = operationGuard(epoch);
    if (action.target.kind !== 'qualified_research' && action.target.kind !== 'automatic_research') throw new BrowserBoundaryError('refused');
    const answer = await client.request('/today/actions/open/v4', todayActionOpenV4ResponseSchema, { actionId: action.actionId, target: action.target }, () => { if (!active()) throw new BrowserBoundaryError('refused'); });
    if (!active()) return;
    if (answer.target === null || JSON.stringify(answer.target) !== JSON.stringify(action.target)) throw new BrowserBoundaryError('invalid_response');
    if (action.target.kind === 'automatic_research') {
      if (answer.research !== null || answer.automaticResearch === null
        || JSON.stringify(answer.automaticResearch.target) !== JSON.stringify(action.target)) throw new BrowserBoundaryError('invalid_response');
      setAutomaticProof(answer.automaticResearch);
      return;
    }
    if (answer.automaticResearch !== null || answer.research === null
      || answer.research.promotionId !== action.target.promotionId || answer.research.firmId !== action.target.firmId || answer.research.evidenceFingerprint !== action.target.evidenceFingerprint
      || !sameSelection(answer.research, { selection: qualifiedResearchSelectionSchema.parse({ discoveryCandidateId: action.target.discoveryCandidateId, discoveryRevision: action.target.discoveryRevision, candidateId: action.target.candidateId, candidateRevision: action.target.candidateRevision, runId: action.target.runId }) })) throw new BrowserBoundaryError('invalid_response');
    setProof(answer.research);
  };
  const prepared = actions?.filter(action => action.target.kind === 'qualified_research' || action.target.kind === 'automatic_research');
  const hasDetail = workspace && (proof !== null || automaticProof !== null);
  const candidatesView = <section aria-label="Research candidates"><h3>Research candidates</h3><p>Only current ready, unambiguous retained candidates are listed. Creating a research Firm grants no channel authority.</p>
    <Button disabled={busy} onClick={() => { void run(epoch => loadCandidates(epoch)); }}>Load research candidates</Button>
    {candidates.map(candidate => <article key={candidate.selection.discoveryCandidateId} className="prospects-candidate"><h4>{candidate.firmName}</h4><p>{candidate.locality}, {candidate.region} · <a href={citationHref(candidate.website)} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{candidate.website}</a></p>
      <details><summary>Exact source context</summary><p>Source {candidate.source.provider} · Release {candidate.source.release} · Record {candidate.source.recordId}</p><p>Candidate {candidate.selection.candidateId} revision {candidate.selection.candidateRevision} · Run {candidate.selection.runId}</p>
        {candidate.citations.map(citation => <article key={`${citation.kind}:${citation.observationId}:${citation.blockId}`}><h4>{citation.kind.replaceAll('_', ' ')}</h4><blockquote>{citation.quote}</blockquote><a href={citationHref(citation.url)} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{citation.url}</a><p>Retrieved {citation.retrievedAt}</p></article>)}
      </details>
      <Button disabled={busy || pending !== null} onClick={() => { void run(epoch => create(epoch, candidate)); }}>Create research Firm</Button></article>)}
    {afterId !== null ? <Button disabled={busy} onClick={() => { void run(epoch => loadCandidates(epoch, true)); }}>More research candidates</Button> : null}
    {pending !== null ? <div><p>{pending.createdFirmId === undefined ? 'Unresolved research request' : 'Confirmed research request'} {pending.commandId}. Candidate {pending.selection.candidateId}, revision {pending.selection.candidateRevision}.</p>
      {pending.createdFirmId === undefined ? <Button disabled={busy} onClick={() => { void run(epoch => create(epoch)); }}>Retry exact research command</Button> : <div><p>Created Firm {pending.createdFirmId}. Review its current Today action. No new command was generated.</p><Button disabled={busy} onClick={() => { void run(readConfirmed); }}>Read current research Firm</Button></div>}</div> : null}
  </section>;
  return <div className={workspace ? 'prospects-research' : 'space-y-4'}>
    {hasDetail ? <div ref={detail} className="prospects-detail"><button onClick={() => { setProof(null); setAutomaticProof(null); requestAnimationFrame(() => list.current?.focus()); }}>← Back to prepared research</button>
      {automaticProof !== null ? <AutomaticResearchProof proof={automaticProof} /> : null}{proof !== null ? <ResearchProof proof={proof} /> : null}
    </div> : <><section aria-label={workspace ? 'Prepared source-backed supply' : 'Action queue'} className="prospects-supply" ref={list} tabIndex={-1}>
    <div className="prospects-supply-heading"><div><h3>{workspace ? 'Prepared research' : 'Action queue'}</h3>
    {workspace ? <p>{prepared === undefined ? 'Current supply has not been read.' : `${prepared.length} source-backed research items in this read`} · Not a callable count.</p> : null}</div>
    <Button disabled={busy} onClick={() => { void run(loadQueue); }}>Refresh action queue</Button>
    </div>
    {(workspace ? prepared?.length : actions?.length) === 0 ? <p>{workspace ? 'No prepared research returned. Retained review and source inventory are separate.' : 'No current actions.'}</p> : null}
    {(workspace ? prepared : actions)?.map(action => <article key={action.actionId} className="prospects-supply-row"><div><h4>{action.subject}</h4>
      {action.target.kind === 'qualified_research' || action.target.kind === 'automatic_research' ? <p>{action.target.kind === 'automatic_research' ? 'Automatic source-backed publication' : 'Qualified retained research'} · Open for exact source context.</p> : null}</div>
      {action.target.kind === 'qualified_research' || action.target.kind === 'automatic_research' ? <Button disabled={busy} onClick={() => { void run(epoch => open(epoch, action)); }}>Review current research</Button>
        : <p>This action is unsupported in this browser. Use the existing supported client. No action was performed.</p>}</article>)}
    {workspace ? <p className="prospects-authority">Prepared context, not contact permission. Maintenance need and phone ownership are not established.</p> : null}
  </section>
  {workspace ? <details className="prospects-secondary" open={pending !== null || undefined}><summary>Qualified selection and existing research requests</summary>{candidatesView}</details> : candidatesView}
  {!workspace && automaticProof !== null ? <AutomaticResearchProof proof={automaticProof} /> : null}{!workspace && proof !== null ? <ResearchProof proof={proof} /> : null}</>}
  {busy && workspace ? <p role="status">Reading current research or resolving the exact request.</p> : null}{notice ? <p role="status">{notice}</p> : null}</div>;
}

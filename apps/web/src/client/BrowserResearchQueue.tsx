import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { z } from 'zod';
import { qualifiedResearchSelectionSchema, qualifiedResearchListSchema, qualifiedResearchFirmSchema, todayActionsV3ResponseSchema, todayActionOpenV3ResponseSchema,
  type QualifiedResearchCandidate, type QualifiedResearchFirm, type QualifiedResearchSelection, type TodayActionV3 } from '@fss/contracts';
import { Button } from '../../../desktop/src/renderer/ui/button.tsx';
import { BrowserBoundaryError, type BrowserClient } from './BrowserClient.ts';


const citationHref = (url: string): string | undefined => {
  const parsed = new URL(url);
  return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : undefined;
};
const receipt = z.strictObject({ status: z.literal('accepted'), replayed: z.boolean(), result: qualifiedResearchFirmSchema });
const sameSelection = (a: QualifiedResearchFirm, held: { selection: QualifiedResearchSelection }): boolean =>
  JSON.stringify(a.selection) === JSON.stringify(held.selection);

export function ResearchProof({ proof }: { proof: QualifiedResearchFirm }): JSX.Element {
  return <section aria-label="Current research proof" className="space-y-3 rounded-md border p-4"><h3>Current research proof</h3>
    <p>{proof.firmName} · Firm {proof.firmId}</p><p>Candidate {proof.selection.candidateId} revision {proof.selection.candidateRevision} · Run {proof.selection.runId}</p>
    <p>Discovery {proof.selection.discoveryCandidateId} revision {proof.selection.discoveryRevision} · Promotion {proof.promotionId}</p>
    <p>Evidence fingerprint {proof.evidenceFingerprint}</p>
    <p>Channel authority not granted. Maintenance need not established. Email fit: {proof.emailFit}, not sending permission.</p>
    {proof.citations.map(citation => <article key={`${citation.kind}:${citation.observationId}:${citation.blockId}`}><h4>{citation.kind.replaceAll('_', ' ')}</h4>
      <blockquote>{citation.quote}</blockquote><a href={citationHref(citation.url)} target="_blank" rel="noreferrer">{citation.url}</a>
      <p>Retrieved {citation.retrievedAt} · Observation {citation.observationId} · Block {citation.blockId} · Hash {citation.contentHash}</p></article>)}
    <p>Discovery preparation question: {proof.question}</p><p>Review only. No contact, enrollment or send action is available.</p>
  </section>;
}

/** A current-proof queue and one explicit noncontact command, not a second command engine. */
export function BrowserResearchQueue({ client }: { client: BrowserClient }): JSX.Element {
  const inFlight = useRef(false);
  const [actions, setActions] = useState<TodayActionV3[] | null>(null);
  const [candidates, setCandidates] = useState<QualifiedResearchCandidate[]>([]);
  const [afterId, setAfterId] = useState<string | null>(null);
  const [pending, setPending] = useState(client.pendingResearch());
  const [proof, setProof] = useState<QualifiedResearchFirm | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => client.subscribe(() => {
    setPending(client.pendingResearch());
    if (client.current?.status !== 'signed_in') { setActions(null); setCandidates([]); setProof(null); setPending(null); setBusy(false); }
  }), [client]);
  const run = useCallback(async (work: (epoch: number) => Promise<void>): Promise<void> => {
    if (inFlight.current) return;
    const epoch = client.epoch;
    if (!client.isCurrent(epoch)) return;
    inFlight.current = true;
    setBusy(true); setProof(null); setNotice('');
    try { await work(epoch); }
    catch { if (client.isCurrent(epoch)) { setPending(client.pendingResearch()); setNotice('Request unavailable or refused. A failed read does not prove creation absent. No automatic retry.'); } }
    finally { inFlight.current = false; if (client.isCurrent(epoch)) setBusy(false); }
  }, [client]);
  const loadQueue = useCallback(async (epoch: number): Promise<void> => {
    const answer = await client.request('/today/actions/v3', todayActionsV3ResponseSchema);
    if (client.isCurrent(epoch)) setActions(answer.actions);
  }, [client]);
  useEffect(() => { void run(loadQueue); }, [loadQueue, run]); // One initial read, never a mutation replay.
  const loadCandidates = async (epoch: number, more = false): Promise<void> => {
    const answer = await client.request('/sourcing/research-firms/list', qualifiedResearchListSchema, more && afterId !== null ? { afterId } : {});
    if (client.isCurrent(epoch)) { setCandidates(previous => more ? [...previous, ...answer.candidates] : answer.candidates); setAfterId(answer.nextAfterId); }
  };
  const create = async (epoch: number, candidate?: QualifiedResearchCandidate): Promise<void> => {
    const held = candidate === undefined ? client.pendingResearch() : client.prepareResearch(candidate.selection);
    if (held === null || held.createdFirmId !== undefined) throw new BrowserBoundaryError('refused');
    setPending(held);
    const answer = await client.request('/sourcing/research-firms/create', receipt, { ...held.selection, commandId: held.commandId }, () => { client.retainResearch(held); });
    if (!client.isCurrent(epoch)) return;
    if (!sameSelection(answer.result, held)) throw new BrowserBoundaryError('invalid_response');
    const confirmed = { ...held, createdFirmId: answer.result.firmId };
    client.retainResearch(confirmed); setPending(confirmed);
    // Receipt rehydrates proof, but current read remains an independent authority check.
    const current = await client.request('/sourcing/research-firms/read', qualifiedResearchFirmSchema, { firmId: confirmed.createdFirmId });
    if (!client.isCurrent(epoch)) return;
    if (current.firmId !== confirmed.createdFirmId || !sameSelection(current, held)) throw new BrowserBoundaryError('invalid_response');
    setProof(current); setNotice('Research Firm confirmed. Open its Today action to revalidate current proof.');
    const queue = await client.request('/today/actions/v3', todayActionsV3ResponseSchema);
    if (client.isCurrent(epoch)) setActions(queue.actions);
  };
  const readConfirmed = async (epoch: number): Promise<void> => {
    const held = client.pendingResearch();
    if (held?.createdFirmId === undefined) throw new BrowserBoundaryError('refused');
    const current = await client.request('/sourcing/research-firms/read', qualifiedResearchFirmSchema, { firmId: held.createdFirmId });
    if (!client.isCurrent(epoch)) return;
    if (current.firmId !== held.createdFirmId || !sameSelection(current, held)) throw new BrowserBoundaryError('invalid_response');
    setProof(current);
  };
  const open = async (epoch: number, action: TodayActionV3): Promise<void> => {
    if (action.target.kind !== 'qualified_research') throw new BrowserBoundaryError('refused');
    const answer = await client.request('/today/actions/open/v3', todayActionOpenV3ResponseSchema, { actionId: action.actionId, target: action.target });
    if (!client.isCurrent(epoch)) return;
    if (answer.target === null || answer.research === null || JSON.stringify(answer.target) !== JSON.stringify(action.target)
      || answer.research.promotionId !== action.target.promotionId || answer.research.firmId !== action.target.firmId || answer.research.evidenceFingerprint !== action.target.evidenceFingerprint
      || !sameSelection(answer.research, { selection: qualifiedResearchSelectionSchema.parse({ discoveryCandidateId: action.target.discoveryCandidateId, discoveryRevision: action.target.discoveryRevision, candidateId: action.target.candidateId, candidateRevision: action.target.candidateRevision, runId: action.target.runId }) })) throw new BrowserBoundaryError('invalid_response');
    setProof(answer.research);
  };
  return <div className="space-y-4"><section aria-label="Action queue"><h3>Action queue</h3>
    <Button disabled={busy} onClick={() => { void run(loadQueue); }}>Refresh action queue</Button>
    {actions?.length === 0 ? <p>No current actions.</p> : null}
    {actions?.map(action => <article key={action.actionId} className="rounded-md border p-3"><h4>{action.subject}</h4>
      {action.target.kind === 'qualified_research' ? <><p>Review current source-qualified research. No outreach authority.</p><Button disabled={busy} onClick={() => { void run(epoch => open(epoch, action)); }}>Review current research</Button></>
        : <p>This action is unsupported in this browser. Use the existing supported client. No action was performed.</p>}</article>)}
  </section><section aria-label="Research candidates"><h3>Research candidates</h3><p>Only current ready, unambiguous retained candidates are listed. Creating a research Firm grants no channel authority.</p>
    <Button disabled={busy} onClick={() => { void run(epoch => loadCandidates(epoch)); }}>Load research candidates</Button>
    {candidates.map(candidate => <article key={candidate.selection.discoveryCandidateId}><h4>{candidate.firmName}</h4><p>{candidate.locality}, {candidate.region} · {candidate.website}</p>
      <Button disabled={busy || pending !== null} onClick={() => { void run(epoch => create(epoch, candidate)); }}>Create research Firm</Button></article>)}
    {afterId !== null ? <Button disabled={busy} onClick={() => { void run(epoch => loadCandidates(epoch, true)); }}>More research candidates</Button> : null}
    {pending !== null ? <div><p>{pending.createdFirmId === undefined ? 'Unresolved research request' : 'Confirmed research request'} {pending.commandId}. Candidate {pending.selection.candidateId}, revision {pending.selection.candidateRevision}.</p>
      {pending.createdFirmId === undefined ? <Button disabled={busy} onClick={() => { void run(epoch => create(epoch)); }}>Retry exact research command</Button> : <div><p>Created Firm {pending.createdFirmId}. Review its current Today action. No new command was generated.</p><Button disabled={busy} onClick={() => { void run(readConfirmed); }}>Read current research Firm</Button></div>}</div> : null}
  </section>{notice ? <p role="status">{notice}</p> : null}{proof !== null ? <ResearchProof proof={proof} /> : null}</div>;
}

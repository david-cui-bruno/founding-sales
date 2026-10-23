import { useEffect, useRef, useState, type JSX } from 'react';
import { candidateListInputSchema, candidateListSchema, candidateStatusSchema, type SourcingCandidate } from '@fss/contracts';
import type { z } from 'zod';
import { BrowserCandidateAuthority } from './BrowserCandidateAuthority.tsx';
import { BrowserQualification } from './BrowserQualification.tsx';
import { BrowserQualificationRecovery } from './BrowserQualificationRecovery.tsx';
import type { BrowserClient } from './BrowserClient.ts';

type Page = z.infer<typeof candidateListSchema>;
const PAGE_SIZE = 50;
const MAX_OFFSET = 1_000_000;

function Reference({ url }: { url: string }): JSX.Element {
  let href: string | undefined;
  try {
    const parsed = new URL(url);
    if (['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password) href = parsed.href;
  } catch { /* A retained reference is never a fetch instruction. */ }
  return href === undefined ? <span>{url}</span> : <a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{url}</a>;
}

function Observation({ candidate, client }: { candidate: SourcingCandidate; client: BrowserClient }): JSX.Element {
  const check = candidate.sourceCheck;
  return <article className="rounded-md border p-3" aria-label={`Candidate ${candidate.id}`}>
    <h4>{candidate.firmName}</h4>
    <p>Candidate ID {candidate.id} · Revision {candidate.revision} · Status {candidate.status}</p>
    <p>Locality {candidate.locality} · Region {candidate.region}</p>
    <p>Website <Reference url={candidate.website} /></p>
    <p>Source <Reference url={candidate.sourceUrl} /></p>
    <p>Observed on {candidate.observedOn} · Prepared by {candidate.preparedBy} · Retained at {candidate.createdAt}</p>
    <p>Observed signal {candidate.signal}</p><blockquote>{candidate.evidence}</blockquote>
    {check === null ? null : <section aria-label="Retained source-check observation">
      <p>Source-check observation {check.state} · Requested at {check.requestedAt} · Checked at {check.checkedAt ?? 'not recorded'}</p>
      <p>Check ID {check.checkId} · Job ID {check.jobId} · Reason {check.reason ?? 'not recorded'}</p>
      {check.lastSuccess === null ? null : <><p>Last retained source observation <Reference url={check.lastSuccess.url} /> · Retrieved at {check.lastSuccess.retrievedAt}</p>
        <p>Content hash {check.lastSuccess.contentHash} · Quote matched {String(check.lastSuccess.quoteMatched)} · First party {String(check.lastSuccess.firstParty)} · Truncated {String(check.lastSuccess.truncated)}</p>
        <blockquote>{check.lastSuccess.excerpt}</blockquote></>}
    </section>}
    {candidate.nextSourceCheckAt === null ? null : <p>Recorded next source-check time {candidate.nextSourceCheckAt}, not a check performed here.</p>}
    <BrowserCandidateAuthority client={client} candidateId={candidate.id} expectedRevision={candidate.revision} />
    <BrowserQualification client={client} candidateId={candidate.id} expectedRevision={candidate.revision} />
  </article>;
}

/** Explicit bounded ordinary inventory reads only. Private pages never leave component memory. */
export function BrowserCandidateInventory({ client }: { client: BrowserClient }): JSX.Element {
  const [status, setStatus] = useState<z.infer<typeof candidateStatusSchema>>('needs_review');
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<Page | null>(null);
  const [readAt, setReadAt] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const operation = useRef<symbol | null>(null);
  const observedEpoch = useRef(client.epoch);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const clear = (): void => {
      operation.current = null;
      setPage(null); setReadAt(''); setError(''); setBusy(false); setOffset(0);
    };
    clear();
    observedEpoch.current = client.epoch;
    const unsubscribe = client.subscribe(() => {
      if (observedEpoch.current !== client.epoch || client.current?.status !== 'signed_in') {
        observedEpoch.current = client.epoch;
        clear();
      }
    });
    return () => { mounted.current = false; operation.current = null; unsubscribe(); };
  }, [client]);
  const changeStatus = (value: string): void => {
    const parsed = candidateStatusSchema.safeParse(value);
    operation.current = null;
    setPage(null); setError(''); setReadAt(''); setBusy(false); setOffset(0);
    if (parsed.success) setStatus(parsed.data);
  };
  const load = async (nextOffset: number): Promise<void> => {
    if (operation.current !== null) return;
    const epoch = client.epoch;
    setPage(null); setError(''); setReadAt('');
    if (!client.isCurrent(epoch) || client.current?.status !== 'signed_in') return;
    const input = candidateListInputSchema.safeParse({ status, offset: nextOffset });
    if (!input.success) { setError('Inventory request unavailable. No automatic retry.'); return; }
    const token = Symbol('candidate-inventory');
    operation.current = token;
    setOffset(nextOffset); setBusy(true);
    const current = (): boolean => mounted.current && operation.current === token && client.isCurrent(epoch);
    try {
      const answer = await client.request('/sourcing/candidates/list', candidateListSchema, input.data, () => {
        if (!current()) throw new Error('Superseded inventory read');
      });
      if (current()) { setPage(answer); setReadAt(new Date().toISOString()); }
    } catch {
      if (current()) { setPage(null); setReadAt(''); setError('Inventory read unavailable or refused. This is not an empty result. No automatic retry.'); }
    } finally {
      if (current()) { operation.current = null; setBusy(false); }
    }
  };
  return <section aria-label="Ordinary sourcing inventory" className="space-y-4">
    <h3>Ordinary sourcing inventory</h3>
    <BrowserQualificationRecovery client={client} />
    <p>Retained ordinary observations, not the ready-qualified research selection. An empty qualified selection does not mean ordinary inventory is absent.</p>
    <p>For an automatic owner, needs_review may contain only identity-review cases, not all unqualified inventory. These observations establish no current qualification, eligibility, consent, contact or sending authority.</p>
    <label>Inventory status <select value={status} onChange={event => { changeStatus(event.target.value); }}>
      <option value="needs_review">needs_review</option><option value="kept">kept</option><option value="dismissed">dismissed</option>
    </select></label>
    <button type="button" disabled={busy} onClick={() => { void load(offset); }}>Load ordinary inventory</button>
    <p>Status {status} · Offset {offset} · At most 50 observations per page. Pages replace the previous page.</p>
    <button type="button" disabled={busy || offset === 0} onClick={() => { void load(Math.max(0, offset - PAGE_SIZE)); }}>Previous inventory page</button>
    <button type="button" disabled={busy || page?.hasMore !== true || offset > MAX_OFFSET - PAGE_SIZE} onClick={() => { void load(offset + PAGE_SIZE); }}>Next inventory page</button>
    {busy ? <p role="status">Loading ordinary inventory.</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {page === null ? null : <div>
      <p>Inventory page read at {readAt}. Retained observations are dated evidence, not current authority.</p>
      {page.candidates.length === 0 ? <p>No observations returned for this status and page. Other statuses or pages may contain inventory.</p> : null}
      {page.candidates.map(candidate => <Observation key={`${candidate.id}:${candidate.revision}`} candidate={candidate} client={client} />)}
      {page.qualificationWaitReason == null ? null : <p>Qualification wait observation at page read {readAt}: {page.qualificationWaitReason}</p>}
      {page.discovery == null ? null : <section aria-label="Retained discovery metadata">
        <p>Discovery metadata observed at page read {readAt}: enabled {String(page.discovery.enabled)} · Halted {String(page.discovery.halted)} · Recorded next run {page.discovery.nextRunAt}</p>
        <p>Last result {page.discovery.lastResult ?? 'not recorded'} · Daily remaining {page.discovery.dailyRemaining} · Monthly remaining {page.discovery.monthlyRemaining}. Not execution or spending authority.</p>
      </section>}
    </div>}
  </section>;
}

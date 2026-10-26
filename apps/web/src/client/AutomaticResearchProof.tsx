import type { JSX } from 'react';
import type { AutomaticResearchFirm } from '@fss/contracts';

const citationHref = (url: string): string | undefined => {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && !parsed.username && !parsed.password ? parsed.href : undefined;
  } catch { return undefined; }
};

/** Retained proof is research context, never permission to contact the Firm. */
export function AutomaticResearchProof({ proof }: { proof: AutomaticResearchFirm }): JSX.Element {
  const target = proof.target;
  return <section aria-label="Current automatic research proof" className="prospects-proof space-y-3 rounded-md border p-4">
    <p className="prospects-eyebrow">Source-backed research</p><h3 tabIndex={-1}>{proof.firmName}</h3>
    <p>{proof.locality}, {proof.region} · <a href={citationHref(proof.website)} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{proof.website}</a></p>
    <p>Discovery preparation question: {proof.question}</p>
    <p>Email fit: {proof.emailFit}, not channel permission. Channel authority not granted. Maintenance need not established.</p>
    <p>Source {proof.source.kind} · Attempt {proof.source.attemptId} · <a href={citationHref(proof.source.sourceUrl)} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{proof.source.sourceUrl}</a></p>
    <details><summary>Source passages and exact research lineage</summary>
      {proof.citations.map(citation => <article key={`${citation.kind}:${citation.observationId}:${citation.blockId}`}><h4>{citation.kind.replaceAll('_', ' ')}</h4>
        <blockquote>{citation.quote}</blockquote><a href={citationHref(citation.url)} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{citation.url}</a>
        <p>Retrieved {citation.retrievedAt} · Observation {citation.observationId} · Block {citation.blockId} · Hash {citation.contentHash}</p></article>)}
      <p>Firm {target.firmId}</p>
      <p>Publication {target.publicationId} revision {target.publicationRevision}</p>
      <p>Candidate {target.candidateId} revision {target.candidateRevision} · Run {target.runId}</p>
      <p>Evidence fingerprint {target.evidenceFingerprint}</p>
      <p>Assigned owner {proof.ownerUserId} · Policy {proof.policyVersion} · Native policy {proof.nativePolicyVersion}</p>
      <p>Checked {proof.checkedAt} · Valid until {proof.validUntil}</p>
    </details>
    <p>Review only. Prepare a discovery conversation. No contact, enrollment or send action is available.</p>
  </section>;
}

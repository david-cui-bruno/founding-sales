import type { JSX } from 'react';
import type { AutomaticResearchFirm } from '@fss/contracts';

const citationHref = (url: string): string | undefined => {
  const parsed = new URL(url);
  return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : undefined;
};

/** Retained proof is research context, never permission to contact the Firm. */
export function AutomaticResearchProof({ proof }: { proof: AutomaticResearchFirm }): JSX.Element {
  const target = proof.target;
  return <section aria-label="Current automatic research proof" className="space-y-3 rounded-md border p-4"><h3>Current automatic research proof</h3>
    <p>{proof.firmName} · Firm {target.firmId}</p>
    <p>{proof.locality}, {proof.region} · <a href={citationHref(proof.website)} target="_blank" rel="noreferrer">{proof.website}</a></p>
    <p>Publication {target.publicationId} revision {target.publicationRevision}</p>
    <p>Candidate {target.candidateId} revision {target.candidateRevision} · Run {target.runId}</p>
    <p>Evidence fingerprint {target.evidenceFingerprint}</p>
    <p>Source {proof.source.kind} · Attempt {proof.source.attemptId} · <a href={citationHref(proof.source.sourceUrl)} target="_blank" rel="noreferrer">{proof.source.sourceUrl}</a></p>
    <p>Assigned owner {proof.ownerUserId} · Policy {proof.policyVersion} · Native policy {proof.nativePolicyVersion}</p>
    <p>Checked {proof.checkedAt} · Valid until {proof.validUntil}</p>
    <p>Email fit: {proof.emailFit}, not channel permission. Channel authority not granted. Maintenance need not established.</p>
    {proof.citations.map(citation => <article key={`${citation.kind}:${citation.observationId}:${citation.blockId}`}><h4>{citation.kind.replaceAll('_', ' ')}</h4>
      <blockquote>{citation.quote}</blockquote><a href={citationHref(citation.url)} target="_blank" rel="noreferrer">{citation.url}</a>
      <p>Retrieved {citation.retrievedAt} · Observation {citation.observationId} · Block {citation.blockId} · Hash {citation.contentHash}</p></article>)}
    <p>Discovery preparation question: {proof.question}</p><p>Review only. Prepare a discovery conversation. No contact, enrollment or send action is available.</p>
  </section>;
}

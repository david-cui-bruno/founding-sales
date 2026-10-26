import type {JSX} from 'react';
import type {ManualProspect} from '@fss/contracts';
type Evidence=ManualProspect['phoneEvidence'];
const explanations={
 unattached_label_content:'Unattached label content: the retained phone label has content outside the supported literal attachment grammar.',
 unsupported_literal:'Unsupported literal: an attached literal cannot be normalized by the existing phone rules.',
 ambiguous_context:'Ambiguous context: the retained label or surrounding context prevents selecting this literal as a business phone.',
} as const;
/** Locations explain a refusal only. They are not endpoints or acquisition controls. */
export function PhoneRefusalDiagnostics({evidence}:{evidence:Evidence}):JSX.Element|null{
 const diagnostics=evidence?.state==='conflicting'?evidence.diagnostics:undefined;
 if(!diagnostics)return null;
 return <section aria-label="Retained phone refusal explanations">
  <p>Retained refusal explanation, not evidence of competing numbers. No number is selected. Review the exact retained location below, not a fresh page.</p>
  {diagnostics.truncated?<p>Additional refusal locations were omitted. This is not a complete explanation.</p>:null}
  <ul>{diagnostics.entries.map((entry,index)=><li key={`${entry.runId}:${entry.observationId}:${entry.blockId}:${entry.labelStart}:${entry.reason}:${index}`}>
   <p>{explanations[entry.reason]}</p>
   <p>Label {entry.label} · UTF-16 [{entry.labelStart}, {entry.labelEnd})</p>
   <p>Retained source: {entry.url}</p>
   <p>Source retrieved: <time dateTime={entry.retrievedAt}>{entry.retrievedAt}</time>. Not a fresh check.</p>
   <p>Run {entry.runId} · Observation {entry.observationId} · Block {entry.blockId} · Parser {entry.parser}</p>
   <p>Captured content hash {entry.contentHash} · Retained blocks hash {entry.relevantTextHash}. Block hashing does not verify an unavailable whole page.</p>
  </li>)}</ul>
 </section>;
}

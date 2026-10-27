import type {JSX} from 'react';
import type {ManualProspect} from '@fss/contracts';
import {useCurrentPhoneEvidence} from './useCurrentPhoneEvidence.ts';
import {PhoneRefusalDiagnostics} from './PhoneRefusalDiagnostics.tsx';

type PhoneEvidence = ManualProspect['phoneEvidence'];
function summary(evidence:PhoneEvidence):string{
 if(evidence?.state==='observed')return `Phone ${evidence.value} · observed, not call-ready`;
 if(evidence?.state==='absent')return 'Phone absent · retained source explicitly declares absent';
 if(evidence?.state==='conflicting')return 'Phone conflicting · no number selected';
 return 'Phone unknown · not extracted';
}
function safeSource(value:string):string|null{
 try{const url=new URL(value);if(['http:','https:'].includes(url.protocol)&&!url.username&&!url.password)return url.href;}catch{/* Retained references are not executable. */}
 return null;
}
/** Retained endpoint evidence only, never phone ownership, identity or permission. */
export function RetainedPhoneEvidence({evidence:retained,compact=false}:{evidence:PhoneEvidence;compact?:boolean}):JSX.Element{
 const evidence=useCurrentPhoneEvidence(retained);
 if(compact)return <span>{summary(evidence)}</span>;
 const sources=evidence?.state==='observed'||evidence?.state==='conflicting'?evidence.sources:[];
 return <div aria-label="Retained phone evidence">
  <p>{summary(evidence)}</p>
  <p>Phone type unknown. Ownership and reachability are not verified. This evidence is not call permission.</p>
  <details><summary>Phone-specific sources and coverage</summary>
   {evidence?.state==='not_extracted'||evidence?.state==='conflicting'?<p>Phone evidence: {evidence.reason.replaceAll('_',' ')}. Missing data is not explicit absence.</p>:null}
   {evidence?.coverage?<p>Retained phone scan: {evidence.coverage.state} · {evidence.coverage.observations} observations · {evidence.coverage.blocks} blocks · {evidence.coverage.parser}. Coverage is limited to permitted retained inputs, not the whole business.</p>:null}
   {evidence?.state==='conflicting'&&sources.length?<p>Retained alternatives are for manual source review only. No winner is selected. Unresolved evidence remains unknown for automatic selection, and source restrictions and contact permission still apply.</p>:null}
   <PhoneRefusalDiagnostics evidence={evidence}/>
   {sources.length?<ul aria-label="Phone-specific sources">{sources.map((source,index)=>{
    const href=safeSource(source.url);
    return <li key={`${source.runId}:${source.observationId}:${source.blockId}:${index}`}>
     {'method' in source?<p>Source label: {source.label}. A retained label is not verified phone type or Person identity.</p>:<p>Phone type unknown · retained business_phone fact, not literal extraction.</p>}
     {'method' in source?<>
      <p>Retained literal: {source.literal}</p>
      {source.normalizedValue?(evidence?.state==='conflicting'?<p>Supported normalized alternative: {source.normalizedValue}. Not selected or verified.</p>:<p>Normalized retained value: {source.normalizedValue}. Formatting, not verification.</p>):<p>Unsupported or ambiguous literal. No normalized alternative.</p>}
     </>:null}
     <p>{href?<a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{source.url}</a>:<span>Source URL unavailable or unsafe.</span>}</p>
     <p>Source retrieved: <time dateTime={source.retrievedAt}>{source.retrievedAt}</time>. Not a fresh check or phone verification.</p>
     <p>Run {source.runId} · Observation {source.observationId} · Block {source.blockId}</p>
     {'method' in source?<p>Normalization basis: {source.normalizationBasis.replaceAll('_',' ')}. Default US is a formatting assumption, not verified location.</p>:null}
    </li>;
   })}</ul>:<p>No selected phone-specific sources available.</p>}
  </details>
 </div>;
}

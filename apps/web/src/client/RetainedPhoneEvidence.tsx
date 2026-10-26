import {useEffect,useState,type JSX} from 'react';
import type {ManualProspect} from '@fss/contracts';

type PhoneEvidence = ManualProspect['phoneEvidence'];
function discoveryExpiry(evidence:PhoneEvidence):number{
 const sources=evidence?.state==='observed'||evidence?.state==='conflicting'?evidence.sources:[];
 return Math.min(...sources.flatMap(source=>{
  if(!('method' in source)||source.authority.kind!=='phone_discovery')return [];
  const expiry=Date.parse(source.authority.expiresAt);return Number.isFinite(expiry)?[expiry]:[];
 }));
}
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
 const expiry=discoveryExpiry(retained),[,renderExpiry]=useState(0);
 // Local erasure only. Discovery authority is at most seven days, never renewed here.
 useEffect(()=>{
  const remaining=expiry-Date.now();if(!Number.isFinite(expiry)||remaining<=0)return;
  const timer=setTimeout(()=>renderExpiry(version=>version+1),remaining);
  return()=>clearTimeout(timer);
 },[expiry]);
 // Losing any dependency clears the entire enrichment, not just its expired sources.
 const evidence=expiry<=Date.now()?undefined:retained;
 if(compact)return <span>{summary(evidence)}</span>;
 const sources=evidence?.state==='observed'||evidence?.state==='conflicting'?evidence.sources:[];
 return <div aria-label="Retained phone evidence">
  <p>{summary(evidence)}</p>
  <p>Phone type unknown. Ownership and reachability are not verified. This evidence is not call permission.</p>
  <details><summary>Phone-specific sources and coverage</summary>
   {evidence?.state==='not_extracted'||evidence?.state==='conflicting'?<p>Phone evidence: {evidence.reason.replaceAll('_',' ')}. Missing data is not explicit absence.</p>:null}
   {evidence?.coverage?<p>Retained phone scan: {evidence.coverage.state} · {evidence.coverage.observations} observations · {evidence.coverage.blocks} blocks · {evidence.coverage.parser}. Coverage is limited to permitted retained inputs, not the whole business.</p>:null}
   {sources.length?<ul aria-label="Phone-specific sources">{sources.map((source,index)=>{
    const href=safeSource(source.url);
    return <li key={`${source.runId}:${source.observationId}:${source.blockId}:${index}`}>
     {'method' in source?<p>Source label: {source.label}. A retained label is not verified phone type or Person identity.</p>:<p>Phone type unknown · retained business_phone fact, not literal extraction.</p>}
     <p>{href?<a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{source.url}</a>:<span>Source URL unavailable or unsafe.</span>}</p>
     <p>Source retrieved: <time dateTime={source.retrievedAt}>{source.retrievedAt}</time>. Not a fresh check or phone verification.</p>
     <p>Run {source.runId} · Observation {source.observationId} · Block {source.blockId}</p>
     {'method' in source?<p>Normalization basis: {source.normalizationBasis.replaceAll('_',' ')}. Default US is a formatting assumption, not verified location.</p>:null}
    </li>;
   })}</ul>:<p>No selected phone-specific sources available.</p>}
  </details>
 </div>;
}

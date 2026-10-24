import type {JSX} from 'react';
import type {ManualProspect} from '@fss/contracts';
function Reference({url,label}:{url:string|null;label:string}):JSX.Element{
 let href:string|undefined;
 try{if(url){const parsed=new URL(url);if(['https:','http:'].includes(parsed.protocol)&&!parsed.username&&!parsed.password)href=parsed.href;}}catch{/* Retained text is not executable. */}
 return href?<a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{label}</a>:<span>{label}</span>;
}
function phoneLabel(p:ManualProspect):string{
 const evidence=p.phoneEvidence;
 if(evidence?.state==='observed')return `Phone ${evidence.value} · observed, not call-ready`;
 if(evidence?.state==='absent')return 'Phone absent · retained source explicitly declares absent';
 if(evidence?.state==='conflicting')return 'Phone conflicting · no number selected';
 return 'Phone unknown · not extracted';
}
export function ManualProspectCard({prospect:p,disabled,feedback}:{prospect:ManualProspect;disabled:boolean;feedback:(state:'kept'|'skipped'|'wrong_number')=>void}):JSX.Element{
 const label=p.presentation?.label??p.observedName,kind=p.presentation?.kind.replaceAll('_',' ')??'unresolved';
 const phone=p.phoneEvidence;
 return <article aria-label={`Manual prospect ${p.candidateId}`} className="manual-prospect-row">
  <div className="manual-prospect-overview">
   <div className="manual-prospect-identity"><h4>{label}</h4><p>{kind} · UNVERIFIED</p></div>
   <p>Apparent area {p.locality??'unknown'}, {p.region??'unknown'}</p>
   <p className="manual-prospect-phone">{phoneLabel(p)}</p>
   <p>Manual state {p.state.replaceAll('_',' ')} · Revision {p.revision}</p>
   <div className="manual-prospect-actions" role="group" aria-label="Feedback for this exact observation">
    <button disabled={disabled} onClick={()=>{feedback('kept');}}>Keep</button>
    <button disabled={disabled} onClick={()=>{feedback('skipped');}}>Skip</button>
    <button disabled={disabled} onClick={()=>{feedback('wrong_number');}}>Wrong number</button>
   </div>
  </div>
  <details><summary>Observed name, sources and details</summary>
   <p>Original observed name: {p.observedName}</p>
   <p>Suggested label basis: {p.presentation?.basis.replaceAll('_',' ')??'retained name'} · {p.presentation?.reason??'Legacy retained observation, identity unresolved.'}</p>
   <p>Website <Reference url={p.website} label={p.website??'unknown'}/></p>
   <p>Retained at {p.retainedAt} · Possible duplicate observations {p.possibleDuplicateCount}, not verified unique Firms.</p>
   <p>Exact candidate {p.candidateId}, revision {p.revision}. Feedback applies only to this observation, not possible duplicates.</p>
   <ul>{p.sources.map((source,i)=><li key={i}>Source <Reference url={source.url} label={source.label}/> · Observed at {source.observedAt??'unknown'}</li>)}</ul>
   <ul aria-label="Source licenses and notices">{p.sourceNotices.map((notice,i)=><li key={i}><Reference url={notice.url} label={notice.label}/></li>)}</ul>
   {phone?.state==='not_extracted'?<p>Phone evidence: {phone.reason.replaceAll('_',' ')}. Missing data is not explicit absence.</p>:null}
   {phone?.state==='conflicting'?<p>Phone evidence: {phone.reason.replaceAll('_',' ')}</p>:null}
   {phone?.state==='observed'||phone?.state==='conflicting'?<ul aria-label="Retained phone provenance">{phone.sources.map((source,i)=><li key={i}><Reference url={source.url} label={source.url}/> · Retrieved {source.retrievedAt} · Run {source.runId} · Observation {source.observationId} · Block {source.blockId}</li>)}</ul>:null}
   <p>{p.unknowns.join(' · ')}</p>
   <p>Reversible manual feedback only. No CRM creation, qualification, source correction, DNC clearance or contact permission.</p>
  </details>
 </article>;
}

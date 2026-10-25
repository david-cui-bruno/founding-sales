import type {JSX} from 'react';
import type {ManualProspect} from '@fss/contracts';
import {manualPhoneLabel,manualProspectLabel,manualProspectSite} from './manualProspectPresentation.ts';
function Reference({url,label}:{url:string|null;label:string}):JSX.Element{
 let href:string|undefined;
 try{if(url){const parsed=new URL(url);if(['https:','http:'].includes(parsed.protocol)&&!parsed.username&&!parsed.password)href=parsed.href;}}catch{/* Retained text is not executable. */}
 return href?<a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{label}</a>:<span>{label}</span>;
}
export function ManualProspectCard({prospect:p,disabled,feedback,activity}:{prospect:ManualProspect;disabled:boolean;feedback:(state:'kept'|'skipped'|'wrong_number')=>void;activity?:()=>void}):JSX.Element{
 const label=manualProspectLabel(p),kind=p.presentation?.kind.replaceAll('_',' ')??'unresolved';
 const phone=p.phoneEvidence;
 const site=manualProspectSite(p);
 return <article aria-label={`Manual prospect ${p.candidateId}`} className="manual-prospect-row">
  <div className="manual-prospect-overview">
   <div className="manual-inspector-top"><span className="manual-eyebrow">Selected prospect</span><span className={`manual-state manual-state-${p.state}`}>{p.state.replaceAll('_',' ')}</span></div>
   <div className="manual-prospect-identity"><h3 tabIndex={-1}>{label}</h3><p>{kind} · UNVERIFIED</p><p>Site {site?<Reference url={p.website} label={site}/>:'unknown'}</p></div>
   <p>Apparent area {p.locality??'unknown'}, {p.region??'unknown'}</p>
   <div className="manual-prospect-phone"><span className="manual-eyebrow">Retained phone evidence</span><p>{manualPhoneLabel(p)}</p><p>Ownership and reachability are not verified. Unknown phones remain reviewable.</p>{p.state==='wrong_number'?<p className="manual-wrong-note">Manual flag: wrong number. Original phone evidence is unchanged.</p>:null}</div>
   <p>Manual state {p.state.replaceAll('_',' ')} · Revision {p.revision}</p>
   <div className="manual-prospect-actions" role="group" aria-label="Feedback for this exact observation">
    <button disabled={disabled} onClick={()=>{feedback('kept');}}>Keep</button>
    <button disabled={disabled} onClick={()=>{feedback('skipped');}}>Skip</button>
    <button disabled={disabled} onClick={()=>{feedback('wrong_number');}}>Wrong number</button>
    {activity?<button disabled={disabled} onClick={activity}>Open private manual activity</button>:null}
   </div>
   <p className="manual-decision-note">Reversible review of this exact observation only. No phone verification, source correction or contact permission.</p>
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
   {phone?.coverage?<p>Retained phone scan: {phone.coverage.state} · {phone.coverage.observations} observations · {phone.coverage.blocks} blocks · {phone.coverage.parser}. Coverage is limited to permitted retained inputs, not the whole business.</p>:null}
   {phone?.state==='observed'||phone?.state==='conflicting'?<ul aria-label="Retained phone provenance">{phone.sources.map((source,i)=><li key={i}><Reference url={source.url} label={source.url}/> · Retrieved {source.retrievedAt} · Run {source.runId} · Observation {source.observationId} · Block {source.blockId}
    {'method' in source?<>
     <p>Retained original literal: {source.literal} · UTF-16 span [{source.start}, {source.end}) · Label {source.label} [{source.labelStart}, {source.labelEnd})</p>
     <p>Normalization: {source.normalizationBasis.replaceAll('_',' ')} · {source.normalizedValue??'unsupported, no endpoint selected'} · {source.normalization}. Default US is a formatting assumption, not verified location.</p>
     <p>Captured content hash {source.contentHash} · Retained blocks hash {source.relevantTextHash}. Block hashing does not verify an unavailable whole page.</p>
     <p>Authority: {source.authority.kind.replaceAll('_',' ')} · {JSON.stringify(source.authority)} · Origin: {source.lineage.kind.replaceAll('_',' ')} · {JSON.stringify(source.lineage)}</p>
    </>:<p>Retained business_phone fact, not retrospective literal extraction.</p>}
   </li>)}</ul>:null}
   <p>{p.unknowns.join(' · ')}</p>
   <p>Reversible manual feedback only. No CRM creation, qualification, source correction, DNC clearance or contact permission.</p>
  </details>
 </article>;
}

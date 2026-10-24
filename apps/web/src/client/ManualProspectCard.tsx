import type {JSX} from 'react';
import type {ManualProspect} from '@fss/contracts';
function Reference({url,label}:{url:string|null;label:string}):JSX.Element{
 let href:string|undefined;
 try{if(url){const parsed=new URL(url);if(['https:','http:'].includes(parsed.protocol)&&!parsed.username&&!parsed.password)href=parsed.href;}}catch{/* Retained text is not executable. */}
 return href?<a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{label}</a>:<span>{label}</span>;
}
export function ManualProspectCard({prospect:p,disabled,feedback}:{prospect:ManualProspect;disabled:boolean;feedback:(state:'kept'|'skipped'|'wrong_number')=>void}):JSX.Element{
 return <article aria-label={`Manual prospect ${p.candidateId}`} className="space-y-2 rounded-md border p-3">
  <h4>{p.observedName}</h4><p>UNVERIFIED · Manual state {p.state.replaceAll('_',' ')} · Revision {p.revision}</p>
  <p>Apparent area {p.locality??'unknown'}, {p.region??'unknown'}</p>
  <p>Website <Reference url={p.website} label={p.website??'unknown'}/></p>
  <p>Phone {p.observedPhone??'unknown'} · {p.phoneBasis.replaceAll('_',' ')}</p>
  <p>Retained at {p.retainedAt} · Possible duplicate observations {p.possibleDuplicateCount}, not verified unique Firms.</p>
  <ul>{p.sources.map((source,i)=><li key={i}>Source <Reference url={source.url} label={source.label}/> · Observed at {source.observedAt??'unknown'}</li>)}</ul>
  <ul aria-label="Source licenses and notices">{p.sourceNotices.map((notice,i)=><li key={i}><Reference url={notice.url} label={notice.label}/></li>)}</ul>
  <p>{p.unknowns.join(' · ')}</p>
  <button disabled={disabled} onClick={()=>{feedback('kept');}}>Keep</button>
  <button disabled={disabled} onClick={()=>{feedback('skipped');}}>Skip</button>
  <button disabled={disabled} onClick={()=>{feedback('wrong_number');}}>Wrong number</button>
  <p>Reversible manual feedback only. No CRM creation, qualification, source correction, DNC clearance or contact permission.</p>
 </article>;
}

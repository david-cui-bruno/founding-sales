import {useCallback,useEffect,useRef,useState,type JSX,type RefObject} from 'react';
import {preparedProspectListResponseSchema,preparedProspectReadResponseSchema,type PreparedProspectBrief,type PreparedProspectSummary,type PreparedProspectTarget} from '@fss/contracts';
import type {z} from 'zod';
import {BrowserBoundaryError,type BrowserClient} from './BrowserClient.ts';
import {groupAdjacentPreparedRecords} from './preparedResearchGroups.ts';
import './preparedProspects.css';

type Page=Extract<z.infer<typeof preparedProspectListResponseSchema>,{prospects:unknown}> & {offset:number};
type Operation={epoch:number;token:symbol};
const current=(value:{validUntil:string|null})=>value.validUntil===null||Date.parse(value.validUntil)>Date.now();
const targetMatches=(left:PreparedProspectTarget,right:PreparedProspectTarget)=>left.candidateId===right.candidateId&&left.candidateRevision===right.candidateRevision&&left.runId===right.runId;
const sourceHref=(value:string)=>{try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password?url.href:undefined;}catch{return undefined;}};
const dateLabel=(value:string)=>new Date(value).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'});
const sections=[['business','Business context'],['location','Office and service markets'],['workflow','Operations and workflow'],['person','People mentioned in sources'],['contact','Published contact context'],['contrary','Conflicting or contrary context']] as const;
const refusalMessage=(reason:string)=>reason==='view_changed'?'The company list changed. Refresh companies to start from the first page.':reason==='source_expired'?'Research evidence expired. Refresh companies to read current sources.':'This company or its source changed. Refresh companies to read current research.';

function SourceNotices({notices}:{notices:PreparedProspectSummary['sourceNotices']}):JSX.Element|null{
 if(!notices.length)return null;
 return <details><summary>Source notices</summary><ul>{notices.map((notice,index)=><li key={index}>{notice.url&&sourceHref(notice.url)?<a href={sourceHref(notice.url)} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{notice.label}</a>:notice.label}</li>)}</ul></details>;
}

function ResearchRecord({row,busy,onOpen}:{row:PreparedProspectSummary;busy:boolean;onOpen:(row:PreparedProspectSummary)=>Promise<void>}):JSX.Element {
 return <><div><span className="prepared-company-state">{row.state==='prepared'?'Prepared brief':'Needs research'}</span><h3>{row.displayName}</h3>
  <p className="prepared-company-note">Discovery label; company identity is unverified.</p>
  {row.website&&sourceHref(row.website)?<p className="prepared-company-source">Website: <a href={sourceHref(row.website)} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{row.website}</a></p>:null}
  <p>{row.summary}</p>{row.unknowns.length?<p className="prepared-company-note">Still unknown: {row.unknowns.slice(0,2).join(' · ')}</p>:null}<SourceNotices notices={row.sourceNotices}/>
 </div><button type="button" disabled={busy} aria-label={`Open company brief for ${row.displayName}`} onClick={()=>{void onOpen(row);}}>Open company brief</button></>;
}

function CompanyBrief({brief,heading}:{brief:PreparedProspectBrief;heading:RefObject<HTMLHeadingElement|null>}):JSX.Element {
 return <article className="prepared-company" aria-label="Prepared company brief">
  <header className="prepared-company-heading"><span className="prepared-company-state">{brief.state==='prepared'?'Prepared brief':'Needs research'}</span>
   <h2 ref={heading} tabIndex={-1}>{brief.displayName}</h2><p className="prepared-company-note">Discovery label; company identity is unverified.</p><p>{brief.summary}</p>
   {brief.website&&sourceHref(brief.website)?<p className="prepared-company-source">Website: <a href={sourceHref(brief.website)} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{brief.website}</a></p>:null}
  </header>
  {sections.map(([kind,label])=>{
   const passages=brief.passages.filter(p=>p.kind===kind);
   if(!passages.length)return null;
   return <section key={kind} className="prepared-company-passages" aria-label={label}><h3>{label}</h3>
    {passages.map((passage,index)=><figure key={`${passage.observationId}:${passage.blockId}:${index}`}>
     <blockquote>{passage.quote}</blockquote><figcaption>Captured {dateLabel(passage.retrievedAt)} · <a href={sourceHref(passage.url)} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{passage.url}</a>{passage.sourceCoverage==='partial_page'?<> · <span>Partial page</span></>:null}</figcaption>
    </figure>)}
   </section>;
  })}
  {!brief.passages.length?<p>No usable retained company passages are available in this read. This item needs further research.</p>:null}
  <section className="prepared-company-next" aria-label="Next research action"><h3>Next research action</h3><p>{brief.nextAction}</p>
   <p className="prepared-company-note">Research context only. No permission to call or email; buying authority, current route ownership and maintenance need are not established.</p></section>
  {brief.unknowns.length?<section aria-label="What remains unknown"><h3>What remains unknown</h3><ul>{brief.unknowns.map(item=><li key={item}>{item}</li>)}</ul></section>:null}
  <p className="prepared-company-note">{brief.coverage==='partial_retained_pages'?'Intact retained passages are shown, but source coverage is incomplete. Omitted content may contain qualifications or contrary context; missing fields and current business conditions remain unknown.':brief.coverage==='complete_retained_pages'?'Supported by the complete retained pages shown here; other pages and current business conditions may be unknown.':'No usable retained pages support a company brief in this read.'}</p>
  <SourceNotices notices={brief.sourceNotices}/>
  <details><summary>Discovery hints</summary><dl><dt>Search label</dt><dd>{brief.discoveryLabel}</dd><dt>Search location</dt><dd>{[brief.targetingLocality,brief.targetingRegion].filter(Boolean).join(', ')||'Unknown'}</dd></dl>
   <p>The search label and location are discovery hints. They do not confirm the business name, office location or service market.</p></details>
  <details><summary>Source and record details</summary><p>Read {dateLabel(brief.checkedAt)}{brief.validUntil?` · Evidence valid until ${dateLabel(brief.validUntil)}`:''}</p>
   <p>Candidate {brief.target.candidateId} · Revision {brief.target.candidateRevision} · Run {brief.target.runId??'not available'}</p>
   <ul>{brief.passages.map((passage,index)=><li key={`${passage.observationId}:${passage.blockId}:${index}`}>{passage.kind}: observation {passage.observationId}, block {passage.blockId} · {passage.url}</li>)}</ul>
  </details>
 </article>;
}

/** One bounded candidate page and one exact retained read. No command custody or provider work. */
export function PreparedProspects({client}:{client:BrowserClient}):JSX.Element {
 const mounted=useRef(false),operation=useRef<Operation|null>(null),listHeading=useRef<HTMLHeadingElement>(null),detailHeading=useRef<HTMLHeadingElement>(null),returnFocus=useRef(false);
 const [page,setPage]=useState<Page|null>(null),[brief,setBrief]=useState<PreparedProspectBrief|null>(null),[busy,setBusy]=useState<'list'|'detail'|null>(null),[notice,setNotice]=useState('');
 const renderEpoch=client.epoch;
 const permitted=()=>client.current?.status==='signed_in'&&client.current.role==='admin';
 const active=useCallback((held:Operation)=>mounted.current&&operation.current===held&&client.isCurrent(held.epoch)&&client.current?.status==='signed_in'&&client.current.role==='admin',[client]);
 const clear=useCallback(()=>{operation.current=null;setPage(null);setBrief(null);setBusy(null);},[]);
 const readPage=useCallback(async(offset:number,viewRevision?:string)=>{
  if(!mounted.current||client.current?.status!=='signed_in'||client.current.role!=='admin'||!client.isCurrent(client.epoch)||operation.current)return;
  const held={epoch:client.epoch,token:Symbol('prepared-list')};operation.current=held;setBusy('list');setNotice('');setPage(null);setBrief(null);
  try{
   const answer=await client.request('/sourcing/prepared-prospects/list',preparedProspectListResponseSchema,{offset,...(viewRevision?{viewRevision}:{})},()=>{if(!active(held))throw new BrowserBoundaryError('refused');});
   if(!active(held))return;
   if('error' in answer){setNotice(refusalMessage(answer.error));return;}
   if(answer.prospects.some(row=>!current(row))){setNotice(refusalMessage('source_expired'));return;}
   setPage({...answer,offset});
  }catch{if(active(held))setNotice('Company research could not be read. Refresh companies to try a current read.');}
  finally{if(operation.current===held){operation.current=null;if(mounted.current)setBusy(null);}}
 },[active,client]);
 const open=async(summary:PreparedProspectSummary)=>{
  if(!permitted()||!mounted.current||operation.current||!client.isCurrent(renderEpoch))return;
  if(!current(summary)){clear();setNotice(refusalMessage('source_expired'));return;}
  const held={epoch:renderEpoch,token:Symbol('prepared-detail')};operation.current=held;setBusy('detail');setBrief(null);setNotice('');
  try{
   const answer=await client.request('/sourcing/prepared-prospects/read',preparedProspectReadResponseSchema,summary.target,()=>{if(!active(held))throw new BrowserBoundaryError('refused');});
   if(!active(held))return;
   if('error' in answer){setPage(null);setNotice(refusalMessage(answer.error));return;}
   if(!targetMatches(answer.target,summary.target)){setPage(null);setNotice('The selected company changed. Refresh companies to read current research.');return;}
   if(!current(answer)){setPage(null);setNotice(refusalMessage('source_expired'));return;}
   setBrief(answer);
  }catch{if(active(held)){setPage(null);setNotice('This company could not be read. Refresh companies to read current research.');}}
  finally{if(operation.current===held){operation.current=null;if(mounted.current)setBusy(null);}}
 };
 useEffect(()=>{
  mounted.current=true;clear();setNotice('');let epoch=client.epoch;
  const unsubscribe=client.subscribe(()=>{if(epoch!==client.epoch||client.current?.status!=='signed_in'||client.current.role!=='admin'){epoch=client.epoch;clear();setNotice('');}});
  void readPage(0);
  return()=>{mounted.current=false;operation.current=null;unsubscribe();};
 },[clear,client,readPage]);
 useEffect(()=>{
  if(brief)detailHeading.current?.focus();
  else if(returnFocus.current&&busy!=='detail'){returnFocus.current=false;listHeading.current?.focus();}
 },[brief,busy]);
 useEffect(()=>{
  const deadlines=[...(page?.prospects??[]),...(brief?[brief]:[])].flatMap(row=>row.validUntil?[Date.parse(row.validUntil)]:[]);
  if(!deadlines.length)return;
  const expires=Math.min(...deadlines);
  const timer=setTimeout(()=>{clear();setNotice(refusalMessage('source_expired'));},Math.min(2_147_483_647,Math.max(0,expires-Date.now())));
  return()=>clearTimeout(timer);
 },[brief,clear,page]);
 if(!permitted())return <p role="status">Prepared company research requires current administrator access.</p>;
 const showingDetail=brief!==null||busy==='detail';
 const prepared=page?.prospects.filter(row=>row.state==='prepared').length??0,needsResearch=(page?.prospects.length??0)-prepared;
 return <section className="prepared-companies" aria-label="Prepared company research" aria-busy={busy!==null}>
  {showingDetail?<div className="prepared-company-detail"><button type="button" onClick={()=>{operation.current=null;returnFocus.current=true;setBrief(null);setBusy(null);setNotice('');}}>Back to companies</button>
   {brief?<CompanyBrief brief={brief} heading={detailHeading}/>:<p role="status">Opening company brief…</p>}
  </div>:<div className="prepared-companies-surface">
   <div className="prepared-companies-toolbar"><div><h2 ref={listHeading} tabIndex={-1}>Prepared companies</h2><p>Retained business evidence, useful context and what to research next.</p></div>
    <button type="button" disabled={busy!==null} onClick={()=>{void readPage(0);}}>Refresh companies</button></div>
   {busy==='list'?<div className="prepared-companies-loading" role="status">Reading current companies…</div>:null}
   {page?<><p className="prepared-company-note">{prepared} prepared · {needsResearch} need research on this page. This is research supply, not a contact-ready count.</p>
    {page.prospects.length?<ul className="prepared-companies-list">{groupAdjacentPreparedRecords(page.prospects).map(records=>records.length===1?<li key={records[0]!.target.candidateId}><ResearchRecord row={records[0]!} busy={busy!==null} onOpen={open}/></li>:<li key={records[0]!.target.candidateId} className="prepared-company-group"><div role="group" aria-label="Records with the same website">
     <p className="prepared-company-note"><strong>Records with the same website</strong> · {records.length} records</p><p className="prepared-company-note">These records have the same exact website and location hints. Original labels remain separate; identities are not merged or confirmed.</p>
     <ul className="prepared-matching-records">{records.map(row=><li key={row.target.candidateId}><ResearchRecord row={row} busy={busy!==null} onOpen={open}/></li>)}</ul>
    </div></li>)}</ul>
     :<p>No permitted company research was returned. Retained review and source inventory remain available for further research.</p>}
    <nav className="prepared-companies-pagination" aria-label="Company list pages"><button type="button" disabled={busy!==null||page.offset===0} onClick={()=>{void readPage(Math.max(0,page.offset-50),page.viewRevision);}}>Previous companies</button>
     <span>Page {Math.floor(page.offset/50)+1} · Up to 50 companies</span><button type="button" disabled={busy!==null||!page.hasMore||page.offset>=1_000_000} onClick={()=>{void readPage(page.offset+50,page.viewRevision);}}>Next companies</button></nav>
   </>:null}
   <p className="prepared-company-note">Unknown email, phone, buyer or buying intent can remain unknown. Opening a brief does not create a Firm or authorize outreach.</p>
  </div>}
  {notice?<p role="status" className="prepared-companies-notice">{notice}</p>:null}
 </section>;
}

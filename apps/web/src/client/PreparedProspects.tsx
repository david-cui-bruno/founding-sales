import {useCallback,useEffect,useRef,useState,type JSX,type RefObject} from 'react';
import {manualProspectListInputSchema,preparedProspectListResponseSchema,preparedProspectReadResponseSchema,type PreparedProspectBrief,type PreparedProspectCallable,type PreparedProspectSummary,type PreparedProspectTarget} from '@fss/contracts';
import type {z} from 'zod';
import {BrowserBoundaryError,type BrowserClient} from './BrowserClient.ts';
import {groupAdjacentPreparedRecords} from './preparedResearchGroups.ts';
import type {CallingSelection, WorkspaceScreenProps} from './workspaceNavigation.ts';
import './preparedProspects.css';
import { useWorkspaceNavigation } from './WorkspaceNavigationGuard.tsx';

type Order='priority'|'callable';
type Page=Extract<z.infer<typeof preparedProspectListResponseSchema>,{prospects:unknown}> & {offset:number;order:Order};
/** ADR0034: the server orders the callable view across all pages (best rank first, one company per host) from an advisory rank;
 * every row shown was re-projected for this read, so a row that is no longer callable is left out. */
const callableCompanies=(rows:readonly PreparedProspectSummary[])=>rows.filter(row=>row.callable.state==='callable');
type Operation={epoch:number;token:symbol};
const current=(value:{validUntil:string|null})=>value.validUntil===null||Date.parse(value.validUntil)>Date.now();
const targetMatches=(left:PreparedProspectTarget,right:PreparedProspectTarget)=>left.candidateId===right.candidateId&&left.candidateRevision===right.candidateRevision&&left.runId===right.runId;
const sourceHref=(value:string)=>{try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password?url.href:undefined;}catch{return undefined;}};
const dateLabel=(value:string)=>new Date(value).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'});
const sections=[['business','Business context'],['location','Office and service markets'],['workflow','Operations and workflow'],['person','People mentioned in sources'],['contact','Published contact context'],['contrary','Conflicting or contrary context']] as const;
const refusalMessage=(reason:string)=>reason==='view_changed'?'The company list changed. Refresh companies to start from the first page.':reason==='source_expired'?'Research evidence expired. Refresh companies to read current sources.':'This company or its source changed. Refresh companies to read current research.';

function SourceNotices({notices}:{notices:PreparedProspectSummary['sourceNotices']}):JSX.Element|null{
 if(!notices.length)return null;
 return <section className="prepared-source-notices" aria-label="Source notices"><h4>Source notices</h4><ul>{notices.map((notice,index)=><li key={index}>{notice.url&&sourceHref(notice.url)?<a href={sourceHref(notice.url)} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{notice.label}</a>:notice.label}</li>)}</ul></section>;
}

/** Research readiness only (ADR0034): a published phone is text, never a dial link or contact permission. */
function CallableFacts({callable}:{callable:PreparedProspectCallable}):JSX.Element|null{
 if(callable.state!=='callable')return null;
 return <><span className="prepared-company-state prepared-company-callable">Callable</span>
  <p className="prepared-company-callable-facts">Published phone: {callable.phone}{callable.person?<> · Person in sources: {callable.person}</>:null}{callable.residential?<> · Residential context observed</>:null}{callable.software?<> · AppFolio or Buildium named in sources</>:null}{callable.businessContext?null:<> · No property-management wording found</>}</p></>;
}

function ResearchRecord({row,busy,onOpen}:{row:PreparedProspectSummary;busy:boolean;onOpen:(row:PreparedProspectSummary)=>Promise<void>}):JSX.Element {
 return <><button className="workspace-work-row" type="button" disabled={busy} aria-label={`Open company brief for ${row.displayName}`} onClick={()=>{void onOpen(row);}}>
  <span className="workspace-work-row-content"><strong>{row.displayName}</strong>
   <span>{[row.targetingLocality,row.targetingRegion].filter(Boolean).join(', ')||'Location unknown'}</span>
   <small>{row.callable.state==='callable'?'Callable research':row.state==='prepared'?'Prepared brief':'Needs research'} · Unverified identity</small>
   {row.namedPerson?<small>Ask for {row.namedPerson.name.split(' ')[0]} — {row.namedPerson.title}</small>:null}
  </span>
 </button><SourceNotices notices={row.sourceNotices}/></>;
}

function CompanyBrief({brief,heading,section='sources'}:{brief:PreparedProspectBrief;heading:RefObject<HTMLHeadingElement|null>;section?:'brief'|'sources'}):JSX.Element {
 const callable=brief.policyVersion==='prepared-prospect-v2'?brief.callable:null;
 const [diagnostics,setDiagnostics]=useState(false);
 return <article className="prepared-company" aria-label="Prepared company brief">
  <header className="prepared-company-heading"><span className="prepared-company-state">{brief.state==='prepared'?'Prepared brief':'Needs research'}</span> {callable?<CallableFacts callable={callable}/>:null}
   <h2 ref={heading} tabIndex={-1}>{brief.displayName}</h2><p className="prepared-company-note">Discovery label; company identity is unverified.</p><p>{brief.summary}</p>
   {brief.website&&sourceHref(brief.website)?<p className="prepared-company-source">Website: <a href={sourceHref(brief.website)} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{brief.website}</a></p>:null}
  </header>
  {section==='sources'?sections.map(([kind,label])=>{
   const passages=brief.passages.filter(p=>p.kind===kind);
   if(!passages.length)return null;
   return <section key={kind} className="prepared-company-passages" aria-label={label}><h3>{label}</h3>
    {passages.map((passage,index)=><figure key={`${passage.observationId}:${passage.blockId}:${index}`}>
     <blockquote>{passage.quote}</blockquote><figcaption>Captured {dateLabel(passage.retrievedAt)} · <a href={sourceHref(passage.url)} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{passage.url}</a>{passage.sourceCoverage==='partial_page'?<> · <span>Partial page</span></>:null}</figcaption>
    </figure>)}
   </section>;
  }):null}
  {section==='sources'&&!brief.passages.length?<p>No usable retained company passages are available in this read. This item needs further research.</p>:null}
  <section className="prepared-company-next" aria-label="Next research action"><h3>Next research action</h3><p>{brief.nextAction}</p>
   <p className="prepared-company-note">Research context only. No permission to call or email; buying authority, current route ownership and maintenance need are not established.</p></section>
  {brief.unknowns.length?<section aria-label="What remains unknown"><h3>What remains unknown</h3><ul>{brief.unknowns.map(item=><li key={item}>{item}</li>)}</ul></section>:null}
  <p className="prepared-company-note">{brief.coverage==='partial_retained_pages'?'Intact retained passages are shown, but source coverage is incomplete. Omitted content may contain qualifications or contrary context; missing fields and current business conditions remain unknown.':brief.coverage==='complete_retained_pages'?'Supported by the complete retained pages shown here; other pages and current business conditions may be unknown.':'No usable retained pages support a company brief in this read.'}</p>
  <SourceNotices notices={brief.sourceNotices}/>
  {section==='sources'?<><section className="prepared-discovery-context" aria-label="Discovery hints"><h3>Discovery context</h3>
   <p>{brief.discoveryLabel} · {[brief.targetingLocality,brief.targetingRegion].filter(Boolean).join(', ')||'Unknown location'}</p>
   <p className="prepared-company-note">These discovery hints do not confirm the business name, office location or service market.</p>
  </section>
  <button type="button" className="workspace-secondary" onClick={()=>setDiagnostics(true)}>Source diagnostics</button></>:null}
  {diagnostics?<SourceDiagnostics brief={brief} onClose={()=>setDiagnostics(false)}/>:null}
 </article>;
}

function SourceDiagnostics({brief,onClose}:{brief:PreparedProspectBrief;onClose:()=>void}):JSX.Element {
 const dialog=useRef<HTMLDialogElement>(null);
 useEffect(()=>{const current=dialog.current;current?.showModal();return()=>current?.close();},[]);
 return <dialog ref={dialog} className="workspace-source-diagnostics" aria-label="Source diagnostics" onCancel={event=>{event.preventDefault();onClose();}}>
  <header><h2>Source diagnostics</h2><button type="button" onClick={onClose}>Close</button></header>
  <p>Read {dateLabel(brief.checkedAt)}{brief.validUntil?` · Evidence valid until ${dateLabel(brief.validUntil)}`:''}</p>
  <dl><dt>Candidate</dt><dd>{brief.target.candidateId}</dd><dt>Revision</dt><dd>{brief.target.candidateRevision}</dd><dt>Run</dt><dd>{brief.target.runId??'Not available'}</dd></dl>
  <ul>{brief.passages.map((passage,index)=><li key={`${passage.observationId}:${passage.blockId}:${index}`}>{passage.kind}: observation {passage.observationId}, block {passage.blockId} · {passage.url}</li>)}</ul>
 </dialog>;
}

/** One bounded candidate page and one exact retained read. No command custody or provider work. */
export function usePreparedProspects({client,selection,enabled=true,onOpenCalling}:{client:BrowserClient;selection:CallingSelection|null;enabled?:boolean;onOpenCalling?:WorkspaceScreenProps['onOpenCalling']}) {
 const mounted=useRef(false),operation=useRef<Operation|null>(null),listHeading=useRef<HTMLHeadingElement>(null),detailHeading=useRef<HTMLHeadingElement>(null),returnFocus=useRef(false);
 const [page,setPage]=useState<Page|null>(null),[brief,setBrief]=useState<PreparedProspectBrief|null>(null),[busy,setBusy]=useState<'list'|'detail'|null>(null),[notice,setNotice]=useState(''),[order,setOrder]=useState<Order>('priority');
 const renderEpoch=client.epoch;
 const canLeave=useWorkspaceNavigation();
 const permitted=()=>client.current?.status==='signed_in'&&client.current.role==='admin';
 const active=useCallback((held:Operation)=>mounted.current&&operation.current===held&&client.isCurrent(held.epoch)&&client.current?.status==='signed_in'&&client.current.role==='admin',[client]);
 const clear=useCallback(()=>{operation.current=null;setPage(null);setBrief(null);setBusy(null);},[]);
 const readPage=useCallback(async(offset:number,viewRevision:string|undefined,view:Order)=>{
  if(!mounted.current||client.current?.status!=='signed_in'||client.current.role!=='admin'||!client.isCurrent(client.epoch)||operation.current)return null;
  const held={epoch:client.epoch,token:Symbol('prepared-list')};operation.current=held;setBusy('list');setNotice('');setPage(null);setBrief(null);
  try{
   const answer=await client.request('/sourcing/prepared-prospects/list',preparedProspectListResponseSchema,{offset,...(viewRevision?{viewRevision}:{}),...(view==='callable'?{order:view}:{})},()=>{if(!active(held))throw new BrowserBoundaryError('refused');});
   if(!active(held))return null;
   if('error' in answer){setNotice(refusalMessage(answer.error));return null;}
   if(answer.prospects.some(row=>!current(row))){setNotice(refusalMessage('source_expired'));return null;}
   setPage({...answer,offset,order:view});
   return answer.prospects;
  }catch{if(active(held))setNotice('Company research could not be read. Refresh companies to try a current read.');return null;}
  finally{if(operation.current===held){operation.current=null;if(mounted.current)setBusy(null);}}
 },[active,client]);
 const open=async(summary:PreparedProspectSummary)=>{
  if(!enabled||!permitted()||!mounted.current||operation.current||!client.isCurrent(renderEpoch)||!canLeave())return;
  if(!current(summary)){clear();setNotice(refusalMessage('source_expired'));return;}
  const held={epoch:renderEpoch,token:Symbol('prepared-detail')};operation.current=held;setBusy('detail');setBrief(null);setNotice('');
  const {candidateId,candidateRevision}=summary.target;
  onOpenCalling?.({kind:'candidate',candidateId,expectedCandidateRevision:candidateRevision,prospectPage:manualProspectListInputSchema.parse({state:'all',offset:0,candidateId,expectedRevision:candidateRevision})});
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
  mounted.current=enabled;clear();setNotice('');let epoch=client.epoch;
  if(!enabled)return;
  const unsubscribe=client.subscribe(()=>{if(epoch!==client.epoch||client.current?.status!=='signed_in'||client.current.role!=='admin'){epoch=client.epoch;clear();setNotice('');}});
  setOrder('priority');void readPage(0,undefined,'priority');
  return()=>{mounted.current=false;operation.current=null;unsubscribe();};
 },[clear,client,enabled,readPage]);
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
 const back=():void=>{operation.current=null;returnFocus.current=true;setBrief(null);setBusy(null);setNotice('');};
 const prepared=page?.prospects.filter(row=>row.state==='prepared').length??0,needsResearch=(page?.prospects.length??0)-prepared;
 // Research rows stay intact in the normal view; the callable view counts companies, not records.
 const callableToday=page?.order==='callable',rows=page?(callableToday?callableCompanies(page.prospects):page.prospects):[];
 const chooseOrder=(next:Order)=>{if(busy!==null)return;setOrder(next);void readPage(0,undefined,next);};
 const position=selection?.kind==='candidate'?rows.findIndex(row=>row.target.candidateId===selection.candidateId&&row.target.candidateRevision===selection.expectedCandidateRevision):-1;
 const canAdvance=selection!==null&&busy===null&&(position+1<rows.length||!!page?.hasMore&&page.offset<1_000_000);
 const advance=async():Promise<void>=>{
  if(!canAdvance||!page)return;
  const next=rows[position+1];
  if(next){await open(next);return;}
  const answer=await readPage(page.offset+50,page.viewRevision,page.order);
  const first=(page.order==='callable'&&answer?callableCompanies(answer):answer)?.[0];
  if(first)await open(first);
 };
 if(!enabled)return {list:null,detail:null,overview:null,target:null,back,busy:false,advance,canAdvance:false};
 if(!permitted())return {list:<p role="status">Prepared company research requires current administrator access.</p>,detail:null,overview:null,target:null,back,busy:false,advance,canAdvance:false};
 const list=<section className="prepared-companies" aria-label="Prepared company research" aria-busy={busy!==null}>
   <div className="prepared-companies-toolbar workspace-list-head"><div><h2 ref={listHeading} tabIndex={-1}>Prepared companies</h2><p>Source-backed research. Identity remains unverified.</p></div>
    <div className="prepared-companies-actions"><button type="button" aria-pressed={order==='callable'} disabled={busy!==null} onClick={()=>chooseOrder(order==='callable'?'priority':'callable')}>Callable today</button>
     <button type="button" disabled={busy!==null} onClick={()=>{void readPage(0,undefined,order);}}>Refresh companies</button></div></div>
   {busy==='list'?<div className="prepared-companies-loading" role="status">Reading current companies…</div>:null}
   {page?<>{callableToday?<p className="prepared-company-note">{rows.length} callable {rows.length===1?'company':'companies'} on this page, best first across all pages and one per website host. Ordered by residential context, a named person, AppFolio or Buildium named, then property-management wording, then newest; ranks refresh in the background. Callable means a company's own retained pages publish a US phone with no conflicting context; it is research readiness, not permission to call.</p>
     :<p className="prepared-company-note">{prepared} prepared · {needsResearch} need research on this page. This is research supply, not a contact-ready count.</p>}
    {rows.length?<ul className="prepared-companies-list">{groupAdjacentPreparedRecords(rows).map(records=>records.length===1?<li key={records[0]!.target.candidateId}><ResearchRecord row={records[0]!} busy={busy!==null} onOpen={open}/></li>:<li key={records[0]!.target.candidateId} className="prepared-company-group"><div role="group" aria-label="Records with the same website">
     <p className="prepared-company-note"><strong>Records with the same website</strong> · {records.length} records</p><p className="prepared-company-note">These records have the same exact website and location hints. Original labels remain separate; identities are not merged or confirmed.</p>
     <ul className="prepared-matching-records">{records.map(row=><li key={row.target.candidateId}><ResearchRecord row={row} busy={busy!==null} onOpen={open}/></li>)}</ul>
    </div></li>)}</ul>
     :<p>{callableToday?'No ranked callable companies. Ranks refresh in the background, so try again shortly.':'No permitted company research was returned. Retained review and source inventory remain available for further research.'}</p>}
    <nav className="prepared-companies-pagination" aria-label="Company list pages"><button type="button" disabled={busy!==null||page.offset===0} onClick={()=>{void readPage(Math.max(0,page.offset-50),page.viewRevision,page.order);}}>Previous companies</button>
     <span>Page {Math.floor(page.offset/50)+1} · Up to 50 {callableToday?'ranked companies':'companies'}</span><button type="button" disabled={busy!==null||!page.hasMore||page.offset>=1_000_000} onClick={()=>{void readPage(page.offset+50,page.viewRevision,page.order);}}>Next companies</button></nav>
   </>:null}
   <p className="prepared-company-note">Unknown email, phone, buyer or buying intent can remain unknown. Opening a brief does not create a Firm or authorize outreach.</p>
  {notice?<p role="status" className="prepared-companies-notice">{notice}</p>:null}
 </section>;
 const detail=brief?<CompanyBrief brief={brief} heading={detailHeading}/>:busy==='detail'?<p role="status">Opening company brief…</p>:null;
 const overview=brief?<CompanyBrief brief={brief} heading={detailHeading} section="brief"/>:null;
 return {list,detail,overview,target:brief?.target??null,back,busy:busy!==null,advance,canAdvance};
}

import {Learning} from './Learning.tsx';
import {navigate} from '../routes.ts';
import {QualificationPanel} from './QualificationPanel.tsx';
import {useCallback,useEffect,useRef,type JSX} from 'react';
import {candidateInputSchema,type SourcingCandidate} from '@fss/contracts';
import type {OperationInput,OperationOutput} from '../../shared/operations.ts';
import {operations} from '../app/bridges.ts';
import {Button} from '../ui/button.tsx';
import {Input} from '../ui/input.tsx';
import {noDefiniteAnswer} from '../today/afterCallModel.ts';
import {useCandidateMemory,type Pending} from './memory.ts';
export interface CandidatePorts {
  list(input:OperationInput<'sourcing.list'>):Promise<OperationOutput<'sourcing.list'>>;
  save(input:OperationInput<'sourcing.save'>):Promise<OperationOutput<'sourcing.save'>>;
  review(input:OperationInput<'sourcing.review'>):Promise<OperationOutput<'sourcing.review'>>;
  check(input:OperationInput<'sourcing.check'>):Promise<OperationOutput<'sourcing.check'>>;
  remove(input:OperationInput<'sourcing.delete'>):Promise<OperationOutput<'sourcing.delete'>>;
}
function api(){const bridge=operations();if(!bridge)throw new Error('unavailable');return bridge;}
const defaultPorts:CandidatePorts={check:async input=>api().command('sourcing.check',input),list:async input=>api().read('sourcing.list',input),save:async input=>api().command('sourcing.save',input),review:async input=>api().command('sourcing.review',input),remove:async input=>api().command('sourcing.delete',input)};
const signals:Record<SourcingCandidate['signal'],string>={explicit_help:'Asking for help',responsibility_overlap:'Manager handles maintenance too',coordination_hiring:'Hiring a coordinator',manual_handoff:'Manual handoffs',growth:'Expansion',tool_gap:'Gap in their current tools',fit_only:'Potential fit · need unknown'};
const statuses:Record<SourcingCandidate['status'],string>={needs_review:'Needs review',kept:'Kept for research',dismissed:'Dismissed'};
export function Candidates({ports=defaultPorts,enabled=true}:{ports?:CandidatePorts;enabled?:boolean}):JSX.Element {
  const {memory:m,touch}=useCandidateMemory(),portsRef=useRef(ports);portsRef.current=ports;
  const load=useCallback(async()=>{
    const generation=++m.generation,filter={...m.filter};m.loading=true;m.failed=false;touch();
    try {
      const answer=await portsRef.current.list(filter);if(generation!==m.generation)return;
      m.view=answer.view;m.failed=answer.view===null;
    } catch {if(generation===m.generation){m.view=null;m.failed=true;}}
    finally {if(generation===m.generation){m.loading=false;touch();}}
  },[m,touch]);
  useEffect(()=>{void load();},[load]);
  const perform=async(pending:Pending)=>{
    if(m.busy||!enabled)return;
    m.pending=pending;m.busy=true;m.message=null;++m.generation;m.loading=false;touch();
    try {
      const answer=pending.kind==='check'?await portsRef.current.check(pending.input):pending.kind==='save'?await portsRef.current.save(pending.input):pending.kind==='review'?await portsRef.current.review(pending.input):await portsRef.current.remove(pending.input);
      if(answer.result!==null){
        m.pending=null;m.deleteId=null;
        if(pending.kind==='save'){
          m.draft={region:'TX',signal:'fit_only'};m.adding=false;
          m.message='duplicate' in answer.result && answer.result.duplicate?'This candidate was already saved. Existing evidence and review were kept.':'Candidate saved for review.';
        }else m.message=pending.kind==='check'?'Source check queued. Refresh candidates to see the result.':pending.kind==='remove'?'Candidate draft deleted.':'Research choice saved.';
        m.filter.offset=0;
        await load();
      }else if(noDefiniteAnswer(answer.reason)){m.message='No definite answer. Retry the same action.';}
      else {m.pending=null;m.message=answer.reason==='research_disabled'?'Research is disabled in Settings.':answer.reason==='research_held'?'Research is on hold.':answer.reason==='daily_firm_ceiling'?'Today’s research allowance is used up. Try tomorrow.':answer.reason==='source_not_permitted'?'This source cannot be fetched under the current research rules.':answer.reason==='check_in_progress'?'A source check is already queued. Refresh for its result.':answer.reason==='candidate_changed'?'This candidate changed elsewhere. Refresh before choosing again.':'The action was refused. Your draft is kept.';}
    }catch{m.message='No definite answer. Retry the same action.';}
    finally{m.busy=false;touch();}
  };
  const save=()=>{
    if(m.pending!==null||m.busy||!enabled)return;
    const parsed=candidateInputSchema.safeParse(m.draft);
    if(!parsed.success){m.message='Complete the candidate fields with public HTTPS links and a dated source.';touch();return;}
    if(parsed.data.observedOn>new Date().toISOString().slice(0,10)){m.message='Observed on cannot be in the future.';touch();return;}
    void perform({kind:'save',input:{...parsed.data,commandId:crypto.randomUUID()}});
  };
  const review=(candidate:SourcingCandidate,status:SourcingCandidate['status'])=>{
    if(m.pending!==null)return;
    void perform({kind:'review',input:{id:candidate.id,expectedRevision:candidate.revision,status,commandId:crypto.randomUUID()}});
  };
  const changeFilter=(status:SourcingCandidate['status'],offset=0)=>{m.filter={status,offset};m.view=null;m.deleteId=null;void load();};
  const blocked=!enabled||m.busy||m.pending!==null;
  const field=(key:string,label:string,type='text',maxLength=500)=><label key={key} className="grid gap-1 text-sm">{label}<Input type={type} maxLength={maxLength} value={m.draft[key]??''} disabled={blocked} onChange={e=>{m.draft[key]=e.target.value;touch();}}/></label>;
  const tabs=<div className="flex gap-2" aria-label="Sourcing views"><Button variant={m.tab==='candidates'?'outline':'quiet'} onClick={()=>{m.tab='candidates';touch();}}>Candidates</Button><Button variant={m.tab==='results'?'outline':'quiet'} onClick={()=>{m.tab='results';touch();}}>Results</Button></div>;
  if(m.tab==='results')return <section className="space-y-5">{tabs}<Learning enabled={enabled}/></section>;
  return <section className="space-y-5" aria-label="Candidate review">{tabs}
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-medium">Candidate review</h2><p className="text-sm text-muted-foreground">Research prospects before adding them to your call queue. Keeping starts weekly source checks while research is enabled.</p></div><Button variant="outline" disabled={blocked} aria-expanded={m.adding} onClick={()=>{m.adding=!m.adding;touch();}}>Add candidate</Button></div>
    {m.view?.discovery?<p className="text-sm text-muted-foreground">Discovery {m.view.discovery.halted?'needs attention':m.view.discovery.enabled?'enabled':'paused'} · next scheduled {m.view.discovery.nextRunAt.slice(0,10)} · {m.view.discovery.dailyRemaining} searches left today, {m.view.discovery.monthlyRemaining} this month. Last result: {m.view.discovery.lastResult??'not run'}. Research holds and settings also apply.</p>:null}
    {m.view?.qualificationWaitReason?<p role="status" className="text-sm text-muted-foreground">{m.view.qualificationWaitReason==='daily_firm_ceiling'?'Waiting for research budget':m.view.qualificationWaitReason==='research_disabled'?'Qualification waits while research is paused.':'Qualification waits while research is on hold.'}</p>:null}
    {m.message?<p role="status" className="text-sm">{m.message}</p>:null}
    {m.pending!==null?<Button disabled={m.busy||!enabled} onClick={()=>{if(m.pending)void perform(m.pending);}}>Retry action</Button>:null}
    {m.adding?<form className="space-y-3 rounded-lg border border-border p-4" onSubmit={e=>{e.preventDefault();save();}}>
      <div className="grid gap-3 sm:grid-cols-2">{field('firmName','Firm name','text',300)}{field('website','Website','url')}{field('locality','City','text',120)}
      <label className="grid gap-1 text-sm">State<select className="rounded-md border border-input bg-background p-2" disabled={blocked} value={m.draft['region']} onChange={e=>{m.draft['region']=e.target.value;touch();}}><option value="TX">Texas</option><option value="RI">Rhode Island</option><option value="MA">Massachusetts</option></select></label></div>
      <label className="grid gap-1 text-sm">Research signal<select className="rounded-md border border-input bg-background p-2" disabled={blocked} value={m.draft['signal']} onChange={e=>{m.draft['signal']=e.target.value;touch();}}>{Object.entries(signals).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
      <label className="grid gap-1 text-sm">Evidence<textarea className="min-h-24 rounded-md border border-input bg-background p-2" maxLength={2000} disabled={blocked} value={m.draft['evidence']??''} onChange={e=>{m.draft['evidence']=e.target.value;touch();}}/></label>
      <div className="grid gap-3 sm:grid-cols-2">{field('sourceUrl','Source URL','url')}{field('observedOn','Observed on','date',10)}{field('preparedBy','Prepared by','text',200)}</div>
      <Button type="submit" disabled={blocked}>Save candidate</Button>
    </form>:null}
    <div className="flex flex-wrap gap-2" aria-label="Candidate filters">{Object.entries(statuses).map(([status,label])=><Button key={status} size="sm" variant={m.filter.status===status?'outline':'quiet'} aria-pressed={m.filter.status===status} disabled={blocked} onClick={()=>changeFilter(status as SourcingCandidate['status'])}>{label}</Button>)}<Button size="sm" variant="quiet" disabled={m.loading||m.busy} onClick={()=>void load()}>Refresh candidates</Button></div>
    {m.failed?<div role="alert"><p>Candidates could not load. Your saved research has not been cleared.</p><Button variant="outline" onClick={()=>void load()}>Retry loading</Button></div>:m.loading&&m.view===null?<p role="status">Loading candidates…</p>:null}
    {m.view!==null?<><ul className="divide-y divide-border">{m.view.candidates.map(candidate=><li key={candidate.id} className="space-y-3 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2"><h3 className="font-medium">{candidate.firmName}</h3><span className="text-sm text-muted-foreground">{candidate.discoveryQuery?'Search area: ':''}{candidate.locality}, {candidate.region}</span></div>
      <p className="text-sm">{signals[candidate.signal]}</p>{candidate.discoveryQuery?<p className="text-sm text-muted-foreground">Search result · name and location unverified. {candidate.discoveryKnownDomain?'Website domain already appears in your CRM; check for an existing firm. ':''}Query: {candidate.discoveryQuery}</p>:null}<p className="whitespace-pre-wrap break-words text-sm">{candidate.evidence}</p>
      <p className="text-xs text-muted-foreground">Prepared research · not verified by Callie · observed {candidate.observedOn} · {candidate.preparedBy}</p>
      <div className="flex gap-4 text-sm"><a className="underline underline-offset-4" href={candidate.sourceUrl} target="_blank" rel="noreferrer">Source evidence</a><a className="underline underline-offset-4" href={candidate.website} target="_blank" rel="noreferrer">Firm website</a></div>
      <QualificationPanel onOpenFirm={firmId=>navigate({name:'firm',firmId})} candidateId={candidate.id} revision={candidate.revision} enabled={!blocked&&candidate.status!=='dismissed'}/>
      {candidate.status==='kept'?<p className="text-xs text-muted-foreground">Weekly source monitoring · next due {candidate.nextSourceCheckAt?.slice(0,10)??'when research is available'}. Returning to review or dismissing stops monitoring. Checks wait for research settings and allowance.</p>:null}
      {candidate.sourceCheck?<div className="space-y-2 rounded-md border border-border p-3 text-sm">
        <p>{candidate.sourceCheck.state==='pending'?'Source check queued':candidate.sourceCheck.state==='checked'?'Source checked':candidate.sourceCheck.lastSuccess?'Source check unavailable · previous evidence retained':'Source check unavailable'}</p>
        <p className="text-xs text-muted-foreground">Requested {candidate.sourceCheck.requestedAt.slice(0,10)}{candidate.sourceCheck.checkedAt?` · checked ${candidate.sourceCheck.checkedAt.slice(0,10)}`:''}</p>
        {candidate.sourceCheck.lastSuccess?<><p className="whitespace-pre-wrap break-words">{candidate.sourceCheck.lastSuccess.excerpt}</p><p className="text-xs text-muted-foreground">Snapshot from {candidate.sourceCheck.lastSuccess.retrievedAt.slice(0,10)} · {candidate.sourceCheck.lastSuccess.firstParty?'Same website':'External source'} · {candidate.sourceCheck.lastSuccess.quoteMatched?'Saved text found':'Saved text not matched'}{candidate.sourceCheck.lastSuccess.truncated?' · excerpt limited':''}</p><a className="underline" href={candidate.sourceCheck.lastSuccess.url} target="_blank" rel="noreferrer">Checked source</a></>:null}
        <p className="text-xs text-muted-foreground">A source check does not confirm unmet need, firm identity or buying intent.</p>
      </div>:null}
      <div className="flex flex-wrap gap-2">{candidate.status!=='dismissed'?<Button variant="outline" size="sm" disabled={blocked} onClick={()=>void perform({kind:'check',input:{id:candidate.id,expectedRevision:candidate.revision,commandId:crypto.randomUUID()}})}>Check source</Button>:null}{candidate.status!=='kept'?<Button variant="outline" size="sm" disabled={blocked} onClick={()=>review(candidate,'kept')}>Keep for research</Button>:null}{candidate.status!=='dismissed'?<Button variant="quiet" size="sm" disabled={blocked} onClick={()=>review(candidate,'dismissed')}>Dismiss</Button>:null}{candidate.status!=='needs_review'?<Button variant="quiet" size="sm" disabled={blocked} onClick={()=>review(candidate,'needs_review')}>Return to review</Button>:null}<Button variant="quiet" size="sm" disabled={blocked} onClick={()=>{m.deleteId=candidate.id;touch();}}>Delete draft</Button></div>
      {m.deleteId===candidate.id?<div className="flex items-center gap-2"><span className="text-sm">Remove this candidate and its evidence?</span><Button variant="outline" size="sm" disabled={blocked} onClick={()=>void perform({kind:'remove',input:{id:candidate.id,expectedRevision:candidate.revision,commandId:crypto.randomUUID()}})}>Confirm delete</Button><Button variant="quiet" size="sm" disabled={blocked} onClick={()=>{m.deleteId=null;touch();}}>Cancel</Button></div>:null}
    </li>)}</ul>{m.view.candidates.length===0?<p className="text-sm text-muted-foreground">No candidates in this view.</p>:null}<div className="flex gap-2"><Button variant="quiet" disabled={blocked||m.loading||m.filter.offset===0} onClick={()=>changeFilter(m.filter.status,Math.max(0,m.filter.offset-50))}>Previous page</Button><Button variant="quiet" disabled={blocked||m.loading||!m.view.hasMore} onClick={()=>changeFilter(m.filter.status,m.filter.offset+50)}>Next page</Button></div></>:null}
  </section>;
}

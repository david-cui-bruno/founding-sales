import {useCallback,useRef,type JSX} from 'react';
import type {OperationInput,OperationOutput} from '../../shared/operations.ts';
import {operations} from '../app/bridges.ts';
import {Button} from '../ui/button.tsx';
import {noDefiniteAnswer} from '../today/afterCallModel.ts';
import {useCandidateMemory,type EvidencePending} from './memory.ts';
export interface QualificationPorts {
 read(input:OperationInput<'sourcing.qualification'>):Promise<OperationOutput<'sourcing.qualification'>>;
 qualify(input:OperationInput<'sourcing.qualify'>):Promise<OperationOutput<'sourcing.qualify'>>;
 admit(input:OperationInput<'sourcing.admit'>):Promise<OperationOutput<'sourcing.admit'>>;
 feedback(input:OperationInput<'sourcing.feedback'>):Promise<OperationOutput<'sourcing.feedback'>>;
}
function api(){const value=operations();if(!value)throw new Error('unavailable');return value;}
const defaults:QualificationPorts={read:async i=>api().read('sourcing.qualification',i),qualify:async i=>api().command('sourcing.qualify',i),admit:async i=>api().command('sourcing.admit',i),feedback:async i=>api().command('sourcing.feedback',i)};
const explanations:Record<string,string>={maintenance_need_unconfirmed:'Maintenance need is not confirmed',business_phone_unresolved:'A published business phone is missing',firm_identity_unsupported:'Firm identity needs review',firm_identity_unresolved:'Firm identity needs review',residential_fit_unknown:'Residential management fit is not confirmed',target_geography_unsupported:'Service area needs confirmation',evidence_needs_refresh:'Evidence needs refreshing',source_incomplete_or_unverified:'Sources are incomplete or unverified',help_date_unknown:'Help request date unknown',help_needs_revalidation:'Help request needs revalidation',need_evidence_conflicts:'Sources disagree about maintenance needs',job_date_unknown:'Job publication date unknown',growth_date_unknown:'Growth announcement date unknown',event_needs_revalidation:'Event needs revalidation',calling_state_not_enabled:'Enable this calling state in Settings',sourcing_owner_required:'Choose a sourcing owner before automatic admission',identity_review_required:'Firm identity was marked incorrect',wrong_firm:'Firm identity was marked incorrect',candidate_changed:'Candidate changed; refresh the evidence',daily_firm_ceiling:'Waiting for research budget',research_disabled:'Research is paused',research_held:'Research is on hold',source_unavailable:'The source could not be checked',credit_route_unavailable:'Credit-covered model processing is unavailable'};
const explain=(code:string)=>explanations[code]??code.replaceAll('_',' ');
const reviewable=new Set(['maintenance_need_unconfirmed','help_date_unknown','help_needs_revalidation','need_evidence_conflicts','job_date_unknown','growth_date_unknown','event_needs_revalidation']);
export function QualificationPanel({candidateId,revision,enabled=true,ports=defaults,onOpenFirm}:{candidateId:string;revision:number;enabled?:boolean;ports?:QualificationPorts;onOpenFirm?:(id:string)=>void}):JSX.Element {
 const {memory,touch}=useCandidateMemory(),ref=useRef(ports);ref.current=ports;
 let entry=memory.evidence.get(candidateId);if(!entry){entry={open:false,busy:false,loading:false,view:null,message:null,pending:null,generation:0};memory.evidence.set(candidateId,entry);}const m=entry;
 const load=useCallback(async()=>{
  const generation=++m.generation;m.loading=true;touch();
  try{const answer=await ref.current.read({candidateId});if(generation!==m.generation)return;m.view=answer.view;m.message=answer.reason&&answer.reason!=='not_found'?explain(answer.reason):null;}
  catch{if(generation===m.generation){m.view=null;m.message='Evidence could not load. Try refreshing.';}}
  finally{if(generation===m.generation){m.loading=false;touch();}}
 },[candidateId,m,touch]);
 const perform=async(pending:EvidencePending)=>{
  if(m.busy||!enabled)return;m.pending=pending;m.busy=true;m.message=null;touch();
  try{
   const answer=pending.kind==='qualify'?await ref.current.qualify(pending.input):pending.kind==='admit'?await ref.current.admit(pending.input):await ref.current.feedback(pending.input);
   if(answer.result){m.pending=null;await load();m.message=pending.kind==='qualify'?'Checking evidence. Refresh to see the result.':pending.kind==='admit'?'Added to the call queue.':'Feedback saved.';}
   else if(noDefiniteAnswer(answer.reason))m.message='No definite answer. Retry the same action.';
   else {m.pending=null;m.view=null;m.message=explain(answer.reason??'action_refused');}
  }catch{m.message='No definite answer. Retry the same action.';}
  finally{m.busy=false;touch();}
 };
 const v=m.view,current=v?.candidateRevision===revision,blocked=!enabled||m.busy||m.pending!==null;
 const canAdmit=current&&v?.verdict&&['review','eligible'].includes(v.status)&&!v.admission&&v.verdict.unknowns.every(code=>reviewable.has(code));
 const title=!v?'Not checked':v.status==='unavailable'?'Evidence unavailable':!current?'Evidence needs refreshing':v.status==='pending'||v.status==='running'?'Checking evidence':v.admission?'Ready for calls':'Needs review';
 return <div className="space-y-3">
  <Button size="sm" variant="quiet" aria-expanded={m.open} onClick={()=>{m.open=!m.open;touch();if(m.open&&!m.view&&!m.pending)void load();}}>Evidence and call readiness</Button>
  {m.open?<div className="space-y-3 rounded-lg border border-border p-4 text-sm">
   <div className="flex items-center justify-between gap-3"><p className="font-medium">{title}</p><Button size="sm" variant="quiet" disabled={m.loading||m.busy} onClick={()=>void load()}>Refresh evidence</Button></div>
   {m.loading?<p role="status">Loading evidence…</p>:null}
   {m.message?<p role="status">{m.message}</p>:null}
   {v?.reason?<p>{explain(v.reason)}</p>:null}{v?.admissionReason?<p>{explain(v.admissionReason)}</p>:null}
   {v&&current&&v.verdict?<>
    <p>{v.verdict.rank==='help_request'?'Explicit maintenance help request':v.verdict.rank==='operational_burden'?'Published maintenance workload problem':v.verdict.rank==='investigation'?'Coordination role worth investigating':'Potential residential management fit'}</p>
    <p className="text-muted-foreground">{v.verdict.rank==='help_request'?'A dated help request supports timing.':'Timing unknown'}</p>
    {v.openingQuestion?<p>{v.openingQuestion}</p>:null}
    <details><summary className="cursor-pointer">Sources and unknowns</summary><div className="mt-3 space-y-3">
     {v.verdict.unknowns.map(code=><p key={code}>{explain(code)}</p>)}
     {v.observations.map(source=><div key={source.id}><a className="underline" href={source.url} target="_blank" rel="noreferrer">{new URL(source.url).hostname}</a><p className="text-xs text-muted-foreground">Checked {source.retrievedAt.slice(0,10)} · {source.publishedAt?`Published ${source.publishedAt.slice(0,10)}`:'Publication date unknown'}</p>{v.facts.filter(f=>f.observationId===source.id).map((fact,index)=><blockquote key={index} className="mt-2 whitespace-pre-wrap break-words border-l-2 border-border pl-3">{fact.value}</blockquote>)}</div>)}
    </div></details>
   </>:null}
   {v?.history.length?<details><summary>Previous evidence · historical</summary>{v.history.map(run=><div key={run.runId}>{run.observations.map(source=><p key={source.id}><a href={source.url} target="_blank" rel="noreferrer">{source.url}</a> · checked {source.retrievedAt.slice(0,10)}</p>)}</div>)}</details>:null}
   <div className="flex flex-wrap gap-2">
    <Button size="sm" variant="outline" disabled={blocked||v?.status==='pending'||v?.status==='running'} onClick={()=>void perform({kind:'qualify',input:{candidateId,expectedRevision:revision,commandId:crypto.randomUUID()}})}>Check qualification</Button>
    {canAdmit?<Button size="sm" disabled={blocked} onClick={()=>void perform({kind:'admit',input:{candidateId,expectedRevision:revision,qualificationRunId:v.runId,mode:'reviewed',commandId:crypto.randomUUID()}})}>Add to call queue</Button>:null}
    {v?.admission&&onOpenFirm?<Button size="sm" variant="outline" onClick={()=>onOpenFirm(v.admission!.firmId)}>Open firm</Button>:null}
   </div>
   {v&&current?<details><summary className="cursor-pointer">Correct this research</summary><div className="mt-2 flex flex-wrap gap-2">{([['wrong_firm','Wrong firm'],['already_covered','Already covered'],['real_pain','Real maintenance pain'],['not_relevant','Not relevant']] as const).map(([code,label])=><Button key={code} size="sm" variant="quiet" disabled={blocked} onClick={()=>void perform({kind:'feedback',input:{candidateId,qualificationRunId:v.runId,code,commandId:crypto.randomUUID()}})}>{label}</Button>)}</div></details>:null}
   {m.pending?<Button size="sm" disabled={m.busy||!enabled} onClick={()=>{if(m.pending)void perform(m.pending);}}>Retry evidence action</Button>:null}
  </div>:null}
 </div>;
}

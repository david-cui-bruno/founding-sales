import {useCallback,useEffect,useRef,useState} from 'react';
import type {LearningReport} from '@fss/contracts';
import {operations} from '../app/bridges.ts';
import {navigate} from '../routes.ts';
import {Button} from '../ui/button.tsx';
import {QualificationPanel} from './QualificationPanel.tsx';
import {AutomaticEmailResults} from './AutomaticEmailResults.tsx';
import {Targeting} from './Targeting.tsx';
import type {OperationInput,OperationOutput} from '../../shared/operations.ts';
type Read=(input:OperationInput<'sourcing.learning'>)=>Promise<OperationOutput<'sourcing.learning'>>;
const defaultRead:Read=async input=>{const api=operations();if(!api)throw new Error('unavailable');return api.read('sourcing.learning',input);};
const label=(s:string)=>s.replaceAll('_',' ');
const ratio=(n:number,d:number)=>d?`${n} / ${d} (${Math.round(100*n/d)}%)`:'Unavailable — no denominator';
export function Learning({read=defaultRead,enabled=true}:{read?:Read;enabled?:boolean}){
 const [view,setView]=useState<LearningReport|null>(null),[failed,setFailed]=useState(false),[busy,setBusy]=useState(false),[sources,setSources]=useState(false);
 const epoch=useRef(0);
 const load=useCallback(async()=>{const e=++epoch.current;setBusy(true);setFailed(false);try{const now=new Date(),input={from:new Date(now.getTime()-30*86400000).toISOString(),to:now.toISOString(),asOf:now.toISOString()};const result=await read(input);if(e!==epoch.current)return;setView(result.view);setFailed(result.view===null);}catch{if(e===epoch.current)setFailed(true);}finally{if(e===epoch.current)setBusy(false);}},[read]);
 useEffect(()=>{const guard=epoch;void load();return()=>{guard.current++;};},[load]);
 return <section className="space-y-5" aria-label="Sourcing results">
  <div className="flex justify-between gap-3"><h2 className="text-lg font-medium">Sourcing results</h2><Button variant="quiet" disabled={busy} onClick={()=>void load()}>Refresh results</Button></div>
  <p className="text-sm text-muted-foreground">Contacted cohorts cover firms first contacted in the last 30 days. Counts use current accepted outcomes through the observation date; corrections can change earlier results.</p>
  {failed?<div role="alert"><p>Results are unavailable. This does not mean there were no conversations.</p><Button onClick={()=>void load()}>Retry results</Button></div>:busy&&!view?<p role="status">Loading results…</p>:null}
  {view&&!failed?<>
   <p className="text-sm">Observed through {new Date(view.asOf).toLocaleDateString()} · {new Date(view.from).toLocaleDateString()} to {new Date(view.to).toLocaleDateString()}</p>
   <div className="rounded-lg border border-border p-4 space-y-2"><h3 className="font-medium">All candidate coverage</h3><p>{view.coverage.candidates} candidates found</p><p className="text-sm text-muted-foreground">{view.coverage.qualified} marked eligible at last check · {view.coverage.admitted} admitted · {view.coverage.unavailable} unavailable</p><p className="text-sm text-muted-foreground">{view.search.attempts} search dispatches · {view.search.creditsReserved} search credits reserved once per request, shared across its results. Candidate coverage includes manual staging; discovery yield is separated below.</p></div>
   {view.automation?<AutomaticEmailResults view={view.automation}/>:<p className="text-sm text-muted-foreground">Automatic email results are unavailable in this report.</p>}
   {view.cohorts.length===0?<p>No contacted firms in this interval yet. Conversion rates are unavailable.</p>:<div className="space-y-4">{view.cohorts.map(c=><article key={`${c.acquisition}:${c.hypothesis}:${c.policyVersion}`} className="rounded-lg border border-border p-4 space-y-3">
    <h3 className="font-medium capitalize">{label(c.hypothesis)} · {label(c.acquisition)}</h3>
    <p className="text-xs text-muted-foreground">Policy {c.policyVersion}</p>
    <p>{c.contacted} contacted firms · {c.reached} reached · {c.confirmedPain} confirmed maintenance need</p><p>{c.booked} booked · {c.held} attended · {c.qualified} qualified · {c.won} won</p>
    <p className="text-sm text-muted-foreground">{c.unreached} not reached · {c.unknownQualification} with unknown demo qualification</p>
    <p className="text-sm">{c.email?`${c.email.sent} emails sent · ${c.email.genuineReplies} genuine replies · ${c.email.positiveReplies} confirmed positive · ${c.email.bounces} bounces · ${c.email.deferrals} asked for later`:null}</p>
    <p className="text-sm">Held qualified demos per contacted firm: {ratio(c.qualified,c.contacted)}<br/>Calls with confirmed need per answered call: {ratio(c.interactions.confirmedPainCalls,c.interactions.answeredCalls)}</p>
    <p className="text-sm text-muted-foreground">Research: ${(c.researchGrossCents/100).toFixed(2)} gross · ${(c.researchCashCents/100).toFixed(2)} cash under recorded provider funding. Search usage is shown separately above.</p>
   </article>)}</div>}
   <div><h3 className="font-medium">Time to observe results</h3><p className="text-sm text-muted-foreground">{view.maturity.map(b=>`${b.ageBand}: ${b.firms} firms`).join(' · ')}</p><p className="text-sm text-muted-foreground">Recent firms have had less time to respond. These counts do not establish which signal is better.</p></div>
   <Button variant="quiet" aria-expanded={sources} onClick={()=>setSources(!sources)}>Source evidence and feedback</Button>
   {sources?<ul className="space-y-4">{view.firms.map(f=><li key={f.firmId} className="rounded-lg border border-border p-4"><Button variant="quiet" onClick={()=>navigate({name:'firm',firmId:f.firmId})}>{f.firmName}</Button><p className="text-sm">{label(f.acquisition)} · first contacted {f.firstContactedAt.slice(0,10)}</p>{f.candidateId&&f.candidateRevision!==null?<QualificationPanel candidateId={f.candidateId} revision={f.candidateRevision} enabled={enabled}/>:<p className="text-sm text-muted-foreground">No current source evidence is linked.</p>}</li>)}</ul>:null}
   <Targeting enabled={enabled}/>
  </>:null}
 </section>;
}

import {useState} from 'react';
import type {ExperimentContent,TargetingPolicy,LearningReport} from '@fss/contracts';
import {Experiments,type ExperimentProps} from './Experiments.tsx';
import {useSessionEpoch} from '../app/drafts.tsx';
import {Button} from '../ui/button.tsx';
export interface ExperimentCatalog {policy:TargetingPolicy;templates:{id:string;name:string;subject:string;body:string}[];sequences:{id:string;label:string}[]}
/** Human-authored suggestions from an attributed report; no automated causal inference. */
type WorkspaceProps={report:LearningReport;catalog:ExperimentCatalog;ports:Omit<ExperimentProps,'proposal'|'approvedSequences'>};
const keys=new WeakMap<object,number>();let nextKey=0;
export function ExperimentsWorkspace(props:WorkspaceProps){const epoch=useSessionEpoch();let key=0;if(epoch){key=keys.get(epoch)??++nextKey;keys.set(epoch,key);}return <WorkspaceSession key={key} {...props}/>;}
function WorkspaceSession({report,catalog,ports}:WorkspaceProps){
 const [kind,setKind]=useState<'discovery_query'|'email_wording'>('discovery_query'),[base,setBase]=useState(''),[proposal,setProposal]=useState<ExperimentContent|null>(null);
 const prepare=()=>{const q=catalog.policy.queries.find(q=>q.id===base),t=catalog.templates.find(t=>t.id===base);if(kind==='discovery_query'&&!q||kind==='email_wording'&&!t)return;
 setProposal({change:kind==='discovery_query'&&q?{kind,basePolicyVersion:catalog.policy.version,queryId:q.id,query:q.query}:{kind:'email_wording',baseTemplateVersionId:t!.id,subject:t!.subject,body:t!.body},interval:{from:report.from,to:report.to,asOf:report.asOf},rationale:'Review a bounded change using the attributed results below.',counterexamples:['Recent cohorts may not have had enough time to respond.'],uncertainty:'Counts do not establish causation. Raw provider results and duplicate denominators are unavailable.',successMeasures:[kind==='discovery_query'?'Compare retained unique URLs and supported prospects, preserving unavailable counts.':'Compare genuine replies per exact-version new enrollment after sufficient observation.']});};
 return <section aria-label="Learning experiments"><h3>Learning experiments</h3><p>Create a reviewable suggestion from current attributed results. No change is applied while preparing it.</p>
 <label>Experiment kind<select aria-label="Experiment kind" value={kind} onChange={e=>{setKind(e.target.value==='email_wording'?'email_wording':'discovery_query');setBase('');setProposal(null);}}><option value="discovery_query">Discovery query wording</option><option value="email_wording">Email wording</option></select></label>
 <label>Existing approved scope<select aria-label="Existing approved scope" value={base} onChange={e=>{setBase(e.target.value);setProposal(null);}}><option value="">Select a current query or approved template</option>{(kind==='discovery_query'?catalog.policy.queries.map(q=>({id:q.id,label:`${q.locality}: ${q.query}`})):catalog.templates.map(t=>({id:t.id,label:t.name}))).map(x=><option key={x.id} value={x.id}>{x.label}</option>)}</select></label>
 <Button disabled={!base} onClick={prepare}>Prepare suggestion for review</Button>
 {proposal?<Experiments key={`${kind}:${base}`} {...ports} proposal={proposal} approvedSequences={catalog.sequences}/>:null}
 </section>;
}

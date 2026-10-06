import {targetingProposalSchema,targetingRanks,type TargetingQuery} from '@fss/contracts';
import {useRef} from 'react';
import type {OperationInput,OperationOutput} from '../../shared/operations.ts';
import {operations} from '../app/bridges.ts';
import {Button} from '../ui/button.tsx';
import {Input} from '../ui/input.tsx';
import {noDefiniteAnswer} from '../today/afterCallModel.ts';
import {useCandidateMemory} from './memory.ts';
export interface TargetingPorts {
 read():Promise<OperationOutput<'sourcing.targeting'>>;
 save(input:OperationInput<'sourcing.proposeTargeting'>):Promise<OperationOutput<'sourcing.proposeTargeting'>>;
 apply(input:OperationInput<'sourcing.applyTargeting'>):Promise<OperationOutput<'sourcing.applyTargeting'>>;
}
type Draft=Omit<OperationInput<'sourcing.proposeTargeting'>,'commandId'>;
type Pending={kind:'save';input:OperationInput<'sourcing.proposeTargeting'>}|{kind:'apply';input:OperationInput<'sourcing.applyTargeting'>};
export interface TargetingMemory {open:boolean;view:OperationOutput<'sourcing.targeting'>['view'];draft:Draft|null;pending:Pending|null;busy:boolean;message:string|null;generation:number}
function api(){const value=operations();if(!value)throw new Error('unavailable');return value;}
const defaults:TargetingPorts={read:()=>api().read('sourcing.targeting',{}),save:i=>api().command('sourcing.proposeTargeting',i),apply:i=>api().command('sourcing.applyTargeting',i)};
export function Targeting({enabled,ports=defaults}:{enabled:boolean;ports?:TargetingPorts}){
 const {memory,touch}=useCandidateMemory(),m=memory.targeting,ref=useRef(ports);ref.current=ports;
 const load=async()=>{const e=++m.generation;try{const answer=await ref.current.read();if(e!==m.generation)return;m.view=answer.view;if(!answer.view)m.message='Targeting is unavailable. Your draft is kept.';else if(!m.draft)m.draft={basePolicyVersion:answer.view.policy.version,queryChanges:answer.view.policy.queries.map(q=>({...q})),rankOrder:[...targetingRanks].sort((a,b)=>answer.view!.policy.rankOrder.indexOf(a)-answer.view!.policy.rankOrder.indexOf(b)),evidenceIds:[],rationale:''};}catch{m.message='Targeting is unavailable. Your draft is kept.';}touch();};
 const perform=async(p:Pending)=>{if(m.busy)return;m.pending=p;m.busy=true;touch();try{const result=p.kind==='save'?await ref.current.save(p.input):await ref.current.apply(p.input);if(result.result){m.pending=null;if(p.kind==='save')m.draft=null;m.message=p.kind==='save'?'Proposal saved. Review it below before applying.':'Targeting approved for future work.';await load();}else if(noDefiniteAnswer(result.reason)){m.message='No definite answer. Retry the same action.';}else{m.pending=null;m.message=result.reason==='policy_changed'?'The active policy changed. Refresh and compare before making a new proposal.':'The change was refused. Your draft is kept.';}}catch{m.message='No definite answer. Retry the same action.';}finally{m.busy=false;touch();}};
 const blocked=!enabled||m.busy||m.pending!==null;
 const update=(index:number,key:keyof TargetingQuery,value:string)=>{const q=m.draft?.queryChanges[index];if(!q)return;if(key==='region'){if(value==='TX'||value==='RI'||value==='MA')q.region=value;}else q[key]=value;touch();};
 return <section className="space-y-3 border-t border-border pt-4"><Button variant="quiet" aria-expanded={m.open} onClick={()=>{m.open=!m.open;touch();if(m.open)void load();}}>Review targeting</Button>
 {m.open?<><p className="text-sm text-muted-foreground">Compare evidence before changing search terms. Saving creates a proposal; applying changes future searches and new-lead order. Callbacks, limits and admission requirements stay in force.</p>
 {m.message?<p role="status">{m.message}</p>:null}
 {m.pending?<Button disabled={m.busy||!enabled} onClick={()=>{if(m.pending)void perform(m.pending);}}>Retry targeting action</Button>:null}
 <Button variant="quiet" disabled={m.busy} onClick={()=>void load()}>Refresh targeting</Button>
 {m.view?.canEdit&&m.draft?<form className="space-y-3" onSubmit={e=>{e.preventDefault();if(blocked||!m.draft)return;const parsed=targetingProposalSchema.safeParse(m.draft);if(!parsed.success){m.message='Use unique query IDs, complete location fields, and a reason for this change.';touch();return;}void perform({kind:'save',input:{...parsed.data,commandId:crypto.randomUUID()}});}}>
 {m.draft.basePolicyVersion!==m.view.policy.version?<div role="alert"><p>This draft uses an older policy. Compare the active searches below with your draft.</p><ul>{m.view.policy.queries.map(q=><li key={q.id}>{q.id}: {q.query} — {q.locality}, {q.region}</li>)}</ul><Button type="button" disabled={blocked} onClick={()=>{m.draft!.basePolicyVersion=m.view!.policy.version;touch();}}>Keep my draft against the current policy</Button></div>:null}
 <details><summary className="cursor-pointer text-sm">Search terms and locations</summary><div className="space-y-3 pt-3">{m.draft.queryChanges.map((q,i)=><fieldset key={i} className="grid gap-2 rounded-md border border-border p-3"><legend className="text-sm">Search {i+1}</legend>{(['id','query','locality'] as const).map(k=><label key={k} className="text-sm">{k==='query'?'Search terms':k==='id'?'Query ID':'City'}<Input value={q[k]} disabled={blocked} onChange={e=>update(i,k,e.target.value)}/></label>)}<label className="text-sm">State<select value={q.region} disabled={blocked} onChange={e=>update(i,'region',e.target.value)}>{['TX','RI','MA'].map(r=><option key={r}>{r}</option>)}</select></label></fieldset>)}<Button type="button" variant="quiet" disabled={blocked||m.draft.queryChanges.length>=30} onClick={()=>{m.draft!.queryChanges.push({id:`query-${m.draft!.queryChanges.length+1}`,query:'',locality:'',region:'TX'});touch();}}>Add search</Button></div></details>
 <label className="grid gap-1 text-sm">Reason for change<textarea className="rounded-md border border-input p-2 bg-background" maxLength={2000} value={m.draft.rationale} disabled={blocked} onChange={e=>{m.draft!.rationale=e.target.value;touch();}}/></label>
 <div className="text-sm">New-lead priority{m.draft.rankOrder.map((rank,index)=><div key={rank} className="flex items-center gap-2">{index+1}. {rank.replaceAll('_',' ')}<Button type="button" size="sm" variant="quiet" disabled={blocked||index===0} onClick={()=>{const a=m.draft!.rankOrder;[a[index-1],a[index]]=[a[index]!,a[index-1]!];touch();}}>Move up</Button></div>)}</div>
 <Button type="submit" disabled={blocked||m.draft.basePolicyVersion!==m.view.policy.version}>Save proposal</Button>
 </form>:null}
 {m.view?.proposals.filter(p=>!p.appliedVersion).map(p=><article key={p.id} className="space-y-2 rounded-md border border-border p-3"><h3 className="font-medium">Pending proposal</h3><p>{p.changes.rationale}</p><details><summary>Review exact changes</summary><ul>{p.changes.queryChanges.map(q=><li key={q.id}>{q.query} — {q.locality}, {q.region} ({q.id})</li>)}</ul><p>Priority: {p.changes.rankOrder.join(' → ')}</p><p>Base policy: {p.changes.basePolicyVersion}</p></details><Button disabled={blocked||p.changes.basePolicyVersion!==m.view?.policy.version} onClick={()=>void perform({kind:'apply',input:{id:p.id,expectedRevision:p.revision,commandId:crypto.randomUUID()}})}>Apply this proposal</Button></article>)}
 </>:null}</section>;
}

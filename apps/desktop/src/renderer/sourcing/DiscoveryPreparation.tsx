import {useEffect,useRef,useState,type JSX} from 'react';
import {candidateInputSchema,discoveryCandidatePayloadSchema,type discoveryIntakeCandidateSchema} from '@fss/contracts';
import type {z} from 'zod';
import type {OperationInput,OperationOutput} from '../../shared/operations.ts';
import {operations} from '../app/bridges.ts';
import {useSessionEpoch} from '../app/drafts.tsx';
import {Button} from '../ui/button.tsx';
import {Input} from '../ui/input.tsx';
import {noDefiniteAnswer} from '../today/afterCallModel.ts';
import {DiscoveryResearchDraft} from './DiscoveryResearchDraft.tsx';

export type DiscoveryPreparationRead=(input:OperationInput<'sourcing.discoveryPreparationRead'>)=>Promise<OperationOutput<'sourcing.discoveryPreparationRead'>>;
const preparationRead:DiscoveryPreparationRead=async input=>{const bridge=operations();return bridge?bridge.read('sourcing.discoveryPreparationRead',input):{view:null,reason:'unavailable'};};
export type DiscoveryPrepare=(input:OperationInput<'sourcing.discoveryPrepare'>)=>Promise<OperationOutput<'sourcing.discoveryPrepare'>>;
export const discoveryPrepare:DiscoveryPrepare=async input=>{
 const bridge=operations();return bridge?bridge.command('sourcing.discoveryPrepare',input):{result:null,reason:'unavailable'};
};
type Raw=z.infer<typeof discoveryIntakeCandidateSchema>;
/** Known raw identity is displayed and prefilled verbatim, never inferred from a URL
 * or nearby locality. Seed entry is an explicit human interpretation, not proof. */
export function DiscoveryPreparation({candidate,enabled,prepare=discoveryPrepare,read=preparationRead,onPrepared}:{candidate:Raw;enabled:boolean;prepare?:DiscoveryPrepare;read?:DiscoveryPreparationRead;onPrepared?:()=>void}):JSX.Element {
 const epoch=useSessionEpoch(),currentEpoch=useRef(epoch);currentEpoch.current=epoch;
 const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState<string|null>(null);
 const [draft,setDraft]=useState({signal:'fit_only',evidence:'',sourceUrl:'',observedOn:'',preparedBy:''});
 const [pending,setPending]=useState<OperationInput<'sourcing.discoveryPrepare'>|null>(null);
 const [result,setResult]=useState<OperationOutput<'sourcing.discoveryPrepare'>['result']>(null);
 const active=useRef(true);useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
 const row=discoveryCandidatePayloadSchema.parse(candidate.payload).row;
 const supported=candidate.status!=='dismissed'&&candidateInputSchema.pick({firmName:true,website:true,locality:true,region:true}).safeParse({firmName:row.firmName,website:row.website,locality:row.locality,region:row.region}).success;
 const perform=async(input:OperationInput<'sourcing.discoveryPrepare'>)=>{
  if(busy||!enabled)return;setBusy(true);setPending(input);setMessage(null);
  try{
   const answer=await prepare(input);if(!active.current||currentEpoch.current!==epoch)return;
   if(answer.result){setPending(null);setResult(answer.result);setMessage('Prepared for normal source review. Fit and identity remain unverified. No research, admission or outreach was started.');onPrepared?.();}
   else if(noDefiniteAnswer(answer.reason))setMessage('No definite answer. Retry the same preparation command.');
   else{setPending(null);setMessage(answer.reason==='candidate_changed'?'Raw observation changed. Refresh before preparing again.':'Preparation refused. Check exact known context and source. Your evidence draft is kept.');}
  }catch{if(active.current&&currentEpoch.current===epoch)setMessage('No definite answer. Retry the same preparation command.');}
  finally{if(active.current&&currentEpoch.current===epoch)setBusy(false);}
 };
 const readExisting=async()=>{
  if(busy||!enabled)return;setBusy(true);setMessage(null);
  try{const answer=await read({candidateId:candidate.id});if(!active.current||currentEpoch.current!==epoch)return;if(answer.view)setResult(answer.view);else{setResult(null);setMessage('No current preparation is available. Verify source and revision before preparing.');}}
  catch{if(active.current&&currentEpoch.current===epoch)setMessage('Preparation could not load.');}
  finally{if(active.current&&currentEpoch.current===epoch)setBusy(false);}
 };
 const submit=()=>{
  const parsed=candidateInputSchema.safeParse({firmName:row.firmName,website:row.website,locality:row.locality,region:row.region,...draft});
  if(!parsed.success){setMessage('Enter a public HTTPS source, exact observed evidence, observation date, preparer and signal. Unknown raw context cannot be filled by inference.');return;}
  const {provider,release,recordId}=row.source;
  void perform({discoveryCandidateId:candidate.id,expectedRevision:candidate.revision,source:{provider,release,recordId},candidate:parsed.data,commandId:crypto.randomUUID()});
 };
 if(!supported)return <p className="text-xs text-muted-foreground">Preparation unavailable: an exact public HTTPS website, known city and TX, RI or MA context are required. Unknowns are not inferred. Raw discovery remains retained.</p>;
 const blocked=!enabled||busy||pending!==null;
 return <div className="space-y-2">
  <Button variant="outline" size="sm" disabled={!enabled||busy} onClick={()=>setOpen(value=>!value)}>Prepare for source review</Button>
  <Button variant="quiet" size="sm" disabled={blocked} onClick={()=>void readExisting()}>Read current preparation</Button>
  {open?<form className="space-y-2 rounded border border-border p-3" onSubmit={event=>{event.preventDefault();if(!blocked)submit();}}>
   <p>Confirm exact retained context: {row.firmName} · {row.website} · {row.locality}, {row.region}. These source fields are not verified identity or fit.</p>
   <p>Enter only the minimal retained public-business seed. A pasted paragraph does not become a native observation or authorize contact.</p>
   <label>Research signal<select aria-label="Preparation research signal" disabled={blocked} value={draft.signal} onChange={event=>setDraft(value=>({...value,signal:event.target.value}))}>{Object.entries({fit_only:'Potential fit, unverified',explicit_help:'Explicit help request',responsibility_overlap:'Responsibility overlap',coordination_hiring:'Coordination hiring',manual_handoff:'Manual handoff',growth:'Growth',tool_gap:'Tool gap'}).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
   <label className="grid gap-1">Retained seed evidence<textarea maxLength={2000} disabled={blocked} value={draft.evidence} onChange={event=>setDraft(value=>({...value,evidence:event.target.value}))}/></label>
   {(['sourceUrl','observedOn','preparedBy'] as const).map(key=><label className="grid gap-1" key={key}>{key==='sourceUrl'?'Seed source URL':key==='observedOn'?'Seed observed on':'Seed prepared by'}<Input type={key==='observedOn'?'date':key==='sourceUrl'?'url':'text'} maxLength={key==='preparedBy'?200:500} disabled={blocked} value={draft[key]} onChange={event=>setDraft(value=>({...value,[key]:event.target.value}))}/></label>)}
   <Button type="submit" disabled={blocked}>Confirm preparation only</Button>
  </form>:null}
  {message?<p role="status">{message}</p>:null}
  {pending?<Button disabled={busy||!enabled} onClick={()=>void perform(pending)}>Retry same preparation</Button>:null}
  {result?<><p>Normal candidate: {result.qualificationCandidateId}. Continue in Candidate review with source checking and qualification. Calling and email permission remain separate and unverified.</p><DiscoveryResearchDraft prepared={result} name={row.firmName} website={row.website!} enabled={enabled&&!busy}/></>:null}
 </div>;
}

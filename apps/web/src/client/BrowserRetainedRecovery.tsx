import {useEffect,useRef,useState,type JSX} from 'react';
import {qualificationFactSchema,qualificationViewSchema,type retainedCitationSelectionSchema} from '@fss/contracts';
import type {z} from 'zod';
import type {BrowserClient} from './BrowserClient.ts';
import {dispatchQualification} from './QualificationDispatch.ts';

type Citation=z.infer<typeof retainedCitationSelectionSchema>;
type QualificationView=z.infer<typeof qualificationViewSchema>;
/** Private text never leaves React memory. Commands contain original references and offsets only. */
export function BrowserRetainedRecovery({client,view,revision,blocked,onSaved}:{client:BrowserClient;view:QualificationView;revision:number;blocked:boolean;onSaved:(message:string)=>void}):JSX.Element|null{
 const [observationId,setObservationId]=useState(''),[blockId,setBlockId]=useState(''),[name,setName]=useState('');
 const [kind,setKind]=useState<Citation['kind']>('firm_identity'),[selections,setSelections]=useState<Citation[]>([]);
 const [confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
 const alive=useRef(true),operation=useRef<symbol|null>(null);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;operation.current=null;};},[]);
 const source=view.observations.find(s=>s.id===observationId),block=source?.blocks.find(b=>b.id===blockId);
 const citation=source&&block?{observationId:source.id,blockId:block.id,contentHash:source.contentHash,relevantTextHash:source.relevantTextHash}:null;
 const identityOnly=view.recovery===undefined;
 if(view.admission||view.interpretationOrigin==='human_retained'||view.status!=='unavailable'||view.reason!=='invalid_evidence'&&view.reason!=='candidate_changed')return null;
 const submit=async():Promise<void>=>{
  if(operation.current||blocked||!confirmed)return;
  const epoch=client.epoch,token=Symbol('retained-review');operation.current=token;setBusy(true);setNotice('');
  const current=()=>alive.current&&operation.current===token&&client.isCurrent(epoch);
  try{
   const fresh=await client.request('/sourcing/qualification/read',qualificationViewSchema.nullable(),{candidateId:view.candidateId},()=>{if(!current())throw Error('Review changed');});
   if(!current()||fresh===null||JSON.stringify(fresh)!==JSON.stringify(view)||(fresh.currentCandidateRevision??fresh.candidateRevision)!==revision)throw Error('Review changed');
   let held;
   if(identityOnly){
    if(!citation||!block||name!==name.trim()||name.length<2)throw Error('Choose a literal identity');
    const start=block.text.indexOf(name);if(start<0||block.text.indexOf(name,start+1)>=0)throw Error('Choose an unambiguous literal span');
    held=client.qualification.prepare({kind:'identity',candidateId:view.candidateId,expectedRevision:revision,qualificationRunId:view.runId,...citation,nameStart:start,nameEnd:start+name.length,decision:'confirm_literal_trade_name',acknowledged:'identity_only_not_qualification'});
   }else{
    held=client.qualification.prepare({kind:'interpret',candidateId:view.candidateId,expectedRevision:revision,decisionId:view.recovery!.decisionId,qualificationRunId:view.recovery!.originalRunId,selections,acknowledged:'new_retained_interpretation_not_original_model_result'});
   }
   const message=await dispatchQualification(client,held,current);
   if(current())onSaved(`${message} Refresh inventory if candidate revision changed, then explicitly read qualification again.`);
  }catch{if(current())setNotice('Recovery unavailable, changed or refused. An uncertain command remains in custody for explicit same-ID reconciliation. No acquisition or automatic retry.');}
  finally{if(current()){operation.current=null;setBusy(false);}}
 };
 return <section aria-label="Retained qualification recovery">
  <h5>{identityOnly?'Review literal retained trade-name':'New retained-only human interpretation'}</h5>
  <p>Original rejection remains unchanged. No source fetch, model, automatic qualification, admission or contact authority. Review all original context for competing identity or contradictory evidence. If unresolved, do not confirm.</p>
  <fieldset disabled={busy||blocked}>
  <label>Retained observation<select aria-label="Recovery observation" value={observationId} onChange={event=>{setObservationId(event.target.value);setBlockId('');setName('');setConfirmed(false);}}><option value="">Choose observation</option>{view.observations.map(s=><option key={s.id} value={s.id}>{s.id}</option>)}</select></label>
  <label>Original block<select aria-label="Recovery block" value={blockId} onChange={event=>{setBlockId(event.target.value);setName('');setConfirmed(false);}}><option value="">Choose original block</option>{source?.blocks.map(b=><option key={b.id} value={b.id}>{b.id}</option>)}</select></label>
  {block?<pre aria-label="Selected recovery original">{block.text}</pre>:null}
  {identityOnly?<label>Exact literal trade-name<input aria-label="Literal retained trade-name" value={name} maxLength={300} onChange={event=>{setName(event.target.value);setConfirmed(false);}} /></label>:<>
   <label>Citation role<select aria-label="Recovery citation role" value={kind} onChange={event=>setKind(qualificationFactSchema.shape.kind.parse(event.target.value))}>{qualificationFactSchema.shape.kind.options.map(value=><option key={value} value={value}>{value}</option>)}</select></label>
   <button type="button" disabled={!citation||selections.length>=30||busy} onClick={()=>{if(citation&&!selections.some(s=>s.kind===kind&&s.observationId===citation.observationId&&s.blockId===citation.blockId)){setSelections([...selections,{...citation,kind}]);setConfirmed(false);}}}>Add retained citation</button>
   <ul>{selections.map((s,index)=><li key={`${s.kind}:${s.observationId}:${s.blockId}`}>{s.kind} · {s.observationId} · {s.blockId}<button type="button" disabled={busy} onClick={()=>{setSelections(selections.filter((_,i)=>i!==index));setConfirmed(false);}}>Remove citation {index+1}</button></li>)}</ul>
  </>}
  <label><input type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)} />{identityOnly?'I reviewed original context and confirm only this literal trade-name, not legal identity or qualification. No unresolved or conflicting identity.':'I reviewed all original context and these full-block citation roles as a new human interpretation, not the rejected model result.'}</label>
  <button type="button" disabled={busy||blocked||!confirmed||(identityOnly?!citation||!name:selections.length===0)} onClick={()=>{void submit();}}>{identityOnly?'Record identity-only decision':'Interpret retained citations'}</button>
  <button type="button" disabled={busy} onClick={()=>{setConfirmed(false);setSelections([]);setName('');setNotice('Unresolved or conflicting evidence remains unconfirmed. No decision or interpretation dispatched.');}}>Keep unresolved</button>
  </fieldset>
  {notice?<p role="status">{notice}</p>:null}
 </section>;
}

import {useCallback,useEffect,useRef,useState,type JSX} from 'react';
import {type ManualProspect,type ProspectPriorityReview as Review,prospectPrioritySaveInputSchema} from '@fss/contracts';
import type {BrowserClient} from './BrowserClient.ts';
import {dispatchPriority,reconcilePriority} from './ProspectPriorityDispatch.ts';
import {PRIORITY_PENDING_KEY,type PriorityPayload,type PriorityPending} from './ProspectPriorityCustody.ts';
function ReviewedSource({url}:{url:string}):JSX.Element{
 let href:string|undefined;try{const parsed=new URL(url);if(['https:','http:'].includes(parsed.protocol)&&!parsed.username&&!parsed.password)href=parsed.href;}catch{/* Retained text never becomes executable. */}
 return href?<a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Reviewed source</a>:<span>Source unavailable</span>;
}
const labels={evidence_supported:'Supported reasons to prioritize',ordinary:'Ordinary prospect · intent unknown',wrong_fit:'Recorded fit concern'};
const nextActions={review_fit:'Review residential-management fit',research_person:'Research the appropriate person',research_route:'Research a supported business contact route',review_contact_readiness:'Review current contact readiness',review_wrong_fit:'Review the recorded fit concern'};
const reasons={human_fit:'Residential-management fit',human_value:'Potential operating value',human_timing:'Current timing evidence',human_wrong_fit:'Fit concern'};
const basisLabels={hypothesis:'Hypothesis',source_supported:'Supported by reviewed source (your assessment)',directly_confirmed:'Directly confirmed (your report)'};
const roleLabels={workflow_owner:'Workflow responsibility',budget_approver:'Budget approval',advocate:'Internal advocacy',implementation:'Implementation participation'};
export function PrioritySummary({review,compact=false}:{review:Review;compact?:boolean}):JSX.Element{
 return <div className={compact?'prospect-priority-summary compact':'prospect-priority-summary'}><strong>{labels[review.band]}</strong><p>{nextActions[review.nextAction]}</p>{!compact?<>
  <dl className="prospect-priority-dimensions"><div><dt>Fit</dt><dd>{review.fit==='positive'?'Positive human assessment':review.fit==='negative'?'Human-recorded concern':'Unknown'}</dd></div><div><dt>Potential value</dt><dd>{review.value==='positive'?'Positive human assessment':'Unknown'}</dd></div><div><dt>Timing</dt><dd>{review.timing==='positive'?'Positive human assessment':'Unknown'}</dd></div></dl>
  {review.reasons.length?<ul>{review.reasons.map(reason=><li key={reason.code}>{reasons[reason.code]} · human assessment recorded {new Date(reason.decidedAt).toLocaleString()} · <ReviewedSource url={reason.sourceUrl}/></li>)}</ul>:<p>No positive buying evidence has been recorded. This prospect stays available.</p>}
  <p>Buying roles: {review.roleState==='unknown'?'unknown; research the appropriate person.':review.roles.map(role=>`${review.roleCandidates.find(person=>person.personId===role.personId)?.personName??'Supported Person'}: ${roleLabels[role.role]} — ${basisLabels[role.basis]}`).join(', ')}</p>
  <p>{review.lastConsideredAt?`Last deliberately considered ${new Date(review.lastConsideredAt).toLocaleString()}`:'Not yet deliberately considered'} · {review.consideredCount} recorded consideration{review.consideredCount===1?'':'s'}</p>
 </>:null}</div>;
}
export function ProspectPriorityReview({client,prospect,review,isScopeCurrent,onChanged}:{client:BrowserClient;prospect:ManualProspect;review:Review;isScopeCurrent:()=>boolean;onChanged:()=>void}):JSX.Element{
 const [fit,setFit]=useState(review.fit),[value,setValue]=useState(review.value),[timing,setTiming]=useState(review.timing),[source,setSource]=useState(review.reasons[0]?.sourceUrl??prospect.sources.find(s=>s.url)?.url??'');
 const [roles,setRoles]=useState(review.roles),[rolePerson,setRolePerson]=useState(''),[roleKind,setRoleKind]=useState<Review['roles'][number]['role']>('workflow_owner'),[roleBasis,setRoleBasis]=useState<Review['roles'][number]['basis']>('hypothesis');
 const [busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[pending,setPending]=useState<PriorityPending|null>(null),[broken,setBroken]=useState(false);
 const mounted=useRef(false),operation=useRef<symbol|null>(null);
 const refreshPending=useCallback(():void=>{try{setPending(client.priority.read());}catch{setBroken(true);}},[client]);
 useEffect(()=>{
  mounted.current=true;const epoch=client.epoch;
  const changed=():void=>{if(!client.isCurrent(epoch)||client.current?.status!=='signed_in'){operation.current=null;setPending(null);setBusy(false);setNotice('');}else refreshPending();};
  refreshPending();const unsubscribe=client.subscribe(changed);
  const storage=(event:StorageEvent):void=>{if(event.key===PRIORITY_PENDING_KEY)refreshPending();};globalThis.addEventListener('storage',storage);
  return()=>{mounted.current=false;operation.current=null;unsubscribe();globalThis.removeEventListener('storage',storage);};
 },[client,refreshPending]);
 const run=(work:(current:()=>boolean)=>Promise<void>):void=>{
  if(operation.current!==null||busy||broken||!isScopeCurrent())return;
  const token=Symbol('priority'),epoch=client.epoch;operation.current=token;setBusy(true);setNotice('');
  const current=():boolean=>mounted.current&&operation.current===token&&isScopeCurrent()&&client.isCurrent(epoch)&&client.current?.status==='signed_in'&&client.current.role==='admin';
  void client.priority.exclusive(async()=>{if(current())await work(current);})
   .catch(()=>{if(current())setNotice('Priority review unavailable or outcome UNKNOWN. Reconcile the exact pending receipt before recording another decision.');})
   .finally(()=>{if(current()){refreshPending();operation.current=null;setBusy(false);}});
 };
 const save=(payload:PriorityPayload):void=>run(async current=>{const result=await dispatchPriority(client,payload,current);if(current()){if(result.accepted){setNotice('Review saved.');onChanged();}else setNotice('Priority decision was refused. Nothing new was recorded. Refresh current priority before trying again.');}});
 const reconcile=():void=>run(async current=>{const held=client.priority.read();if(!held)throw Error('No pending priority command');const result=await reconcilePriority(client,held,current);if(current()){setNotice(result==='unknown'?'Outcome remains UNKNOWN. The exact command stays held.':`Priority receipt ${result}.`);if(result==='accepted')onChanged();}});
 const blocked=busy||broken||pending!==null;
 const binding={candidateId:prospect.candidateId,expectedCandidateRevision:prospect.revision,expectedAssessmentRevision:review.assessmentRevision};
 return <section className="prospect-priority-review" aria-label="Prospect priority review"><h4>Why work this prospect next?</h4><PrioritySummary review={review}/>
  <p>Priority guides attention. Qualification and contact authority remain separate.</p>
  {notice?<p role="status">{notice}</p>:null}{notice.includes('was refused')?<button disabled={busy} onClick={()=>{if(isScopeCurrent())onChanged();}}>Refresh current priority</button>:null}{broken?<p role="alert">Priority command storage unavailable. Recording is blocked.</p>:null}
  {pending?<div role="status"><p>A priority decision has an unresolved receipt. No assessment text is stored in the browser.</p><button disabled={busy||broken} onClick={reconcile}>Reconcile exact priority receipt</button></div>:null}
  <div className="prospect-priority-actions"><button disabled={blocked} onClick={()=>save({operation:'consider',input:{...binding,disposition:'considered'}})}>Mark considered</button><button disabled={blocked} onClick={()=>save({operation:'consider',input:{...binding,disposition:'selected'}})}>Select for research</button></div>
  <details><summary>Review priority</summary><form onSubmit={event=>{event.preventDefault();if(blocked||!isScopeCurrent())return;const input=prospectPrioritySaveInputSchema.safeParse({...binding,fit,value,timing,sourceUrl:source,roles});if(!input.success){setNotice('Choose a current retained source for this assessment.');return;}save({operation:'save',input:input.data});}}>
   <p>Record your judgment after reviewing the source. A positive timing assessment requires actual current evidence; missing signals stay unknown.</p>
   <div className="prospect-priority-fields"><label>Residential-management fit<select value={fit} disabled={blocked} onChange={event=>setFit(event.target.value as typeof fit)}><option value="unknown">Unknown</option><option value="positive">Positive fit</option><option value="negative">Fit concern</option></select></label><label>Potential operating value<select value={value} disabled={blocked} onChange={event=>setValue(event.target.value as typeof value)}><option value="unknown">Unknown</option><option value="positive">Supported potential value</option></select></label><label>Current timing evidence<select value={timing} disabled={blocked} onChange={event=>setTiming(event.target.value as typeof timing)}><option value="unknown">Unknown</option><option value="positive">Supported timing reason</option></select></label><label>Reviewed retained source<select value={source} disabled={blocked} onChange={event=>setSource(event.target.value)}><option value="">Choose a source</option>{[...new Set(prospect.sources.flatMap(s=>s.url?[s.url]:[]))].map(url=><option value={url} key={url}>{url}</option>)}</select></label></div>
   <fieldset disabled={blocked}><legend>Buying-role hypotheses</legend><p>Use an existing supported Person association. A title or affiliation alone supports only a hypothesis. Choose a stronger basis only when the reviewed source supports that responsibility or you directly confirmed it.</p>
   {roles.length?<ul>{roles.map((role,index)=><li key={`${role.relationshipId}:${role.role}`}>{review.roleCandidates.find(person=>person.personId===role.personId)?.personName??'Existing Person'} · {roleLabels[role.role]} · {basisLabels[role.basis]} <button type="button" onClick={()=>setRoles(rows=>rows.filter((_,i)=>i!==index))}>Remove role</button></li>)}</ul>:<p>No buying role recorded.</p>}
   {review.roleCandidates.length?<div className="prospect-priority-fields"><label>Supported Person<select value={rolePerson} onChange={event=>setRolePerson(event.target.value)}><option value="">Choose a Person</option>{review.roleCandidates.map(person=><option key={person.relationshipId} value={person.relationshipId}>{person.personName}</option>)}</select></label><label>Buying responsibility<select value={roleKind} onChange={event=>setRoleKind(event.target.value as typeof roleKind)}>{Object.entries(roleLabels).map(([role,label])=><option key={role} value={role}>{label}</option>)}</select></label><label>Role evidence basis<select value={roleBasis} onChange={event=>setRoleBasis(event.target.value as typeof roleBasis)}>{Object.entries(basisLabels).map(([basis,label])=><option key={basis} value={basis}>{label}</option>)}</select></label><button type="button" disabled={!rolePerson||roles.length>=8} onClick={()=>{const person=review.roleCandidates.find(row=>row.relationshipId===rolePerson);if(person&&!roles.some(role=>role.relationshipId===person.relationshipId&&role.role===roleKind))setRoles(rows=>[...rows,{personId:person.personId,relationshipId:person.relationshipId,relationshipRevision:person.relationshipRevision,role:roleKind,basis:roleBasis}]);}}>Add buying role</button></div>:<p>No current supported Person association is available. Research the appropriate person before adding a buying role.</p>}
   {review.roleCandidatesHasMore?<p>Additional supported People exist. Review the Firm's People before selecting another association.</p>:null}</fieldset>
   <p>Existing teams and around-the-clock service can support potential value; they do not establish buying intent.</p>
   <button disabled={blocked||source===''} type="submit">Save priority assessment</button>
  </form></details>
 </section>;
}

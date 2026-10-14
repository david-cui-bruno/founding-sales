import {useCallback,useLayoutEffect,useRef,useState,type JSX} from 'react';
import type {BookingInterpretationSource,BookingInterpretationView} from '@fss/contracts';
import {Button} from '../ui/button.tsx';
export interface BookingInterpretationPorts {
 request(input:{source:BookingInterpretationSource;priorSources:BookingInterpretationSource[];commandId:string}):Promise<BookingInterpretationView>;
 read(input:{requestId:string}):Promise<BookingInterpretationView>;
}
export interface BookingInterpretationProps {ports:BookingInterpretationPorts;source:BookingInterpretationSource;privacyKey:string;sourceVersion:number;enabled:boolean;priorChoices?:BookingInterpretationSource[]}
export function BookingInterpretation({ports,source,privacyKey,sourceVersion,enabled,priorChoices=[]}:BookingInterpretationProps):JSX.Element {
 const [view,setView]=useState<BookingInterpretationView|null>(null),[requestId,setRequestId]=useState<string|null>(null),[priorId,setPriorId]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [pending,setPending]=useState<Parameters<BookingInterpretationPorts['request']>[0]|null>(null);
 const epoch=useRef(0);
 const invalidate=useCallback(()=>++epoch.current,[]);
 useLayoutEffect(()=>{invalidate();setView(null);setRequestId(null);setPending(null);setPriorId('');setBusy(false);setError('');return()=>{invalidate();};},[ports,source.sourceId,source.sourceRevision,source.contentHash,privacyKey,sourceVersion,enabled,invalidate]);
 async function refresh(id:string){
  const ticket=++epoch.current;setView(null);setBusy(true);setError('');
  try{const next=await ports.read({requestId:id});if(ticket===epoch.current)setView(next);}
  catch{if(ticket===epoch.current)setError('Current booking outcome unavailable. Private proposals have been cleared.');}
  finally{if(ticket===epoch.current)setBusy(false);}
 }
 async function request(){
  if(!enabled||busy||requestId!==null)return;
  const ticket=++epoch.current;setView(null);setBusy(true);setError('');
  const prior=priorChoices.find(choice=>choice.sourceId===priorId);
  const command=pending??{source,priorSources:prior===undefined?[]:[prior],commandId:crypto.randomUUID()};setPending(command);
  try{const queued=await ports.request(command);if(ticket!==epoch.current)return;setRequestId(queued.requestId);setPending(null);const next=await ports.read({requestId:queued.requestId});if(ticket===epoch.current)setView(next);}
  catch{if(ticket===epoch.current)setError('Booking request status or current outcome is unknown. Private proposals have been cleared. Retry reuses the same request, or refresh a known outcome.');}
  finally{if(ticket===epoch.current)setBusy(false);}
 }
 const outcome=enabled?view?.outcome:null;
 return <section aria-label="Booking interpretation">
  <h4>Booking interpretation</h4><p>Proposals only. This cannot send a message or create an appointment.</p>
  <p>Uses only the selected original and an optional earlier offered source under separate current booking-purpose consent. Missing consent, route or funding stays unavailable.</p>
  {priorChoices.length>0?<label>Earlier offered source (optional)<select disabled={!enabled||busy||pending!==null} value={priorId} onChange={event=>{epoch.current++;setView(null);setRequestId(null);setPending(null);setPriorId(event.target.value);}}><option value="">None</option>{priorChoices.slice(0,100).map(choice=><option key={choice.sourceId} value={choice.sourceId}>{choice.sourceId} revision {choice.sourceRevision}</option>)}</select><span> The server rechecks the original Sent proof, thread and account. An unrelated source is refused.</span></label>:null}
  <Button disabled={!enabled||busy||requestId!==null} onClick={()=>void request()}>{pending?'Retry booking request':'Interpret booking request'}</Button>
  {requestId&&enabled?<Button disabled={busy} onClick={()=>void refresh(requestId)}>Refresh booking outcome</Button>:null}
  {!enabled?<p>Booking interpretation unavailable.</p>:null}{busy?<p role="status">Reading current booking outcome…</p>:null}{error?<p role="alert">{error}</p>:null}
  {enabled&&view?<><p>Interpretation state: {view.state.replaceAll('_',' ')}</p>{view.reason?<p>{view.reason.replaceAll('_',' ')}</p>:null}
   {view.provenance?<section aria-label="Booking original provenance"><p>Original participant: {view.provenance.participant??'Unknown'}</p><p>Original date: {view.provenance.rawSenderDate??view.provenance.occurredAt}</p><p>Original source: {view.provenance.source.sourceId}, revision {view.provenance.source.sourceRevision}, account generation {view.provenance.generation}</p></section>:null}
   {outcome?.kind==='approved_link'?<><p>Approved-link proposal: {outcome.bookingUrl}</p><p>Generic interest is not agreement to a slot.</p></>:null}
   {outcome?.kind==='slot_proposal'?<><p>Slot proposal: {outcome.slot.localDate} at {outcome.slot.localTime} {outcome.slot.timeZone}</p><p>Original attendee address: {outcome.attendeeAddress}</p><p>Requires current attendee Route, fresh free/busy and a separate guarded create. Availability is not established here.</p></>:null}
   {outcome?.kind==='clarification'?<p>Clarification needed. Check participant, meeting, date, time, zone and agreement in the original.</p>:null}
   {outcome?.kind==='stop'?<p>Stop: {outcome.reason.replaceAll('_',' ')}. No scheduling proposal.</p>:null}
   {outcome&&'schedulingPaused' in outcome&&outcome.schedulingPaused?<p>Scheduling paused for David.</p>:null}
   {outcome&&'handoff' in outcome&&outcome.handoff?<section aria-label="David handoff"><h5>David handoff</h5><p>{outcome.handoff.action.replaceAll('_',' ')} for owner {outcome.handoff.ownerUserId}</p><blockquote>{outcome.handoff.evidence.quote}</blockquote><p>Original source {outcome.handoff.evidence.sourceId}. No substantive answer has been generated or sent.</p></section>:null}
   {view.financial?<p>Model accounting: {view.financial.state}. Maximum reserved {view.financial.reservedCents} cents; settled or conservatively estimated {view.financial.settledCents} cents. Unknown acceptance is not silently retried.</p>:null}
  </>:null}
  <p>Actual model quality and native workflow acceptance remain unverified. LinkedIn intake is unavailable.</p>
 </section>;
}

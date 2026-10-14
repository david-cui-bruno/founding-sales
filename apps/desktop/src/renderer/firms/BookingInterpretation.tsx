import {useCallback,useLayoutEffect,useRef,useState,type JSX} from 'react';
import type {BookingInterpretationSource,BookingInterpretationView} from '@fss/contracts';
import {BookingConversation,type BookingConversationPorts} from './BookingConversation.tsx';
import {Button} from '../ui/button.tsx';
export interface BookingInterpretationPorts {
 request(input:{source:BookingInterpretationSource;priorSources:BookingInterpretationSource[]}):Promise<BookingInterpretationView>;
 read(input:{requestId:string}):Promise<BookingInterpretationView>;
}
export interface BookingInterpretationProps {conversationPorts?:BookingConversationPorts;ports:BookingInterpretationPorts;source:BookingInterpretationSource;privacyKey:string;sourceVersion:number;enabled:boolean;priorChoices?:BookingInterpretationSource[]}
export function BookingInterpretation({ports,conversationPorts,source,privacyKey,sourceVersion,enabled,priorChoices=[]}:BookingInterpretationProps):JSX.Element {
 const [view,setView]=useState<BookingInterpretationView|null>(null),[requestId,setRequestId]=useState<string|null>(null),[priorId,setPriorId]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const epoch=useRef(0);
 const invalidate=useCallback(()=>++epoch.current,[]);
 useLayoutEffect(()=>{invalidate();setView(null);setRequestId(null);setPriorId('');setBusy(false);setError('');return()=>{invalidate();};},[ports,source.sourceId,source.sourceRevision,source.contentHash,privacyKey,sourceVersion,enabled,invalidate]);
 async function refresh(id:string){
  const ticket=++epoch.current;setView(null);setBusy(true);setError('');
  try{const next=await ports.read({requestId:id});if(ticket===epoch.current)setView(next);}
  catch{if(ticket===epoch.current)setError('Current booking outcome unavailable. Private proposals have been cleared.');}
  finally{if(ticket===epoch.current)setBusy(false);}
 }
 async function request(){
  if(!enabled||busy)return;
  const ticket=++epoch.current;setView(null);setRequestId(null);setBusy(true);setError('');
  const prior=priorChoices.find(choice=>choice.sourceId===priorId);
  try{const queued=await ports.request({source,priorSources:prior===undefined?[]:[prior]});if(ticket!==epoch.current)return;setRequestId(queued.requestId);const next=await ports.read({requestId:queued.requestId});if(ticket===epoch.current)setView(next);}
  catch{if(ticket===epoch.current)setError('Booking request or current outcome unavailable. Private proposals have been cleared.');}
  finally{if(ticket===epoch.current)setBusy(false);}
 }
 const outcome=enabled?view?.outcome:null;
 return <section aria-label="Booking interpretation">
  <h4>Booking interpretation</h4><p>Proposals only. This cannot send a message or create an appointment.</p>
  <p>Uses only the selected original and an optional earlier offered source under separate current booking-purpose consent. Missing consent, route or funding stays unavailable.</p>
  {priorChoices.length>0?<label>Earlier offered source (optional)<select disabled={!enabled||busy} value={priorId} onChange={event=>{epoch.current++;setView(null);setRequestId(null);setPriorId(event.target.value);}}><option value="">None</option>{priorChoices.slice(0,100).map(choice=><option key={choice.sourceId} value={choice.sourceId}>{choice.sourceId} revision {choice.sourceRevision}</option>)}</select><span> The server rechecks the original Sent proof, thread and account. An unrelated source is refused.</span></label>:null}
  <Button disabled={!enabled||busy} onClick={()=>void request()}>Interpret booking request</Button>
  {requestId&&enabled?<Button disabled={busy} onClick={()=>void refresh(requestId)}>Refresh booking outcome</Button>:null}
  {!enabled?<p>Booking interpretation unavailable.</p>:null}{busy?<p role="status">Reading current booking outcome…</p>:null}{error?<p role="alert">{error}</p>:null}
  {enabled&&view?<><p>Interpretation state: {view.state.replaceAll('_',' ')}</p>{view.reason?<p>{view.reason.replaceAll('_',' ')}</p>:null}
   {view.provenance?<section aria-label="Booking original provenance"><p>Original participant: {view.provenance.participant??'Unknown'}</p><p>Original date: {view.provenance.rawSenderDate??view.provenance.occurredAt}</p><p>Original source: {view.provenance.source.sourceId}, revision {view.provenance.source.sourceRevision}, account generation {view.provenance.generation}</p></section>:null}
   {outcome?.kind==='approved_link'?<><p>Approved-link proposal: {outcome.bookingUrl}</p><p>Generic interest is not agreement to a slot.</p></>:null}
   {outcome?.kind==='slot_proposal'?<><p>Slot proposal: {outcome.slot.localDate} at {outcome.slot.localTime} {outcome.slot.timeZone}</p><p>Original attendee address: {outcome.attendeeAddress}</p><p>Requires current attendee Route, fresh free/busy and a separate guarded create. Availability is not established here.</p></>:null}
   {outcome?.kind==='change_proposal'?<><p>Attendee-requested {outcome.action} proposal. This is not permission or provider acceptance.</p>{outcome.action==='reschedule'?<p>Requested slot: {outcome.slot.localDate} at {outcome.slot.localTime} {outcome.slot.timeZone}</p>:null}<p>Requires the current attendee Route, a unique current booking and guarded change. An ambiguous target is handed to David.</p></>:null}
   {outcome?.kind==='clarification'?<p>Clarification needed. Check participant, meeting, date, time, zone and agreement in the original.</p>:null}
   {outcome?.kind==='stop'?<p>Stop: {outcome.reason.replaceAll('_',' ')}. No scheduling proposal.</p>:null}
   {outcome&&'schedulingPaused' in outcome&&outcome.schedulingPaused?<p>Scheduling paused for David.</p>:null}
   {outcome&&'handoff' in outcome&&outcome.handoff?<section aria-label="David handoff"><h5>David handoff</h5><p>{outcome.handoff.action.replaceAll('_',' ')} for owner {outcome.handoff.ownerUserId}</p><blockquote>{outcome.handoff.evidence.quote}</blockquote><p>Original source {outcome.handoff.evidence.sourceId}. No substantive answer has been generated or sent.</p></section>:null}
   {conversationPorts&&view.state==='complete'&&outcome?<BookingConversation key={view.requestId} ports={conversationPorts} interpretation={view} privacyKey={privacyKey} sourceVersion={sourceVersion} enabled={enabled}/>:null}
   {view.financial?<p>Model accounting: {view.financial.state}. Maximum reserved {view.financial.reservedCents} cents; settled or conservatively estimated {view.financial.settledCents} cents. Unknown acceptance is not silently retried.</p>:null}
  </>:null}
  <p>Actual model quality and native workflow acceptance remain unverified. LinkedIn intake is unavailable.</p>
 </section>;
}

import {useCallback,useLayoutEffect,useRef,useState,type JSX} from 'react';
import type {BookingConversationView,BookingInterpretationView,BookingMessageView} from '@fss/contracts';
import type {OperationInput} from '../../shared/operations.ts';
import {Button} from '../ui/button.tsx';
export interface BookingConversationPorts {
 policy():Promise<{revision:number;status:'saved'|'disabled'|'revoked'}|null>;
 request(input:OperationInput<'meetings.bookingConversationRequest'>):Promise<BookingConversationView>;
 read(input:OperationInput<'meetings.bookingConversationRead'>):Promise<BookingConversationView>;
 event(input:OperationInput<'meetings.bookingConversationEvent'>):Promise<BookingConversationView>;
 messageRequest(input:OperationInput<'meetings.bookingMessageRequest'>):Promise<BookingMessageView>;
 messageRead(input:OperationInput<'meetings.bookingMessageRead'>):Promise<BookingMessageView>;
}
export interface BookingConversationProps {ports:BookingConversationPorts;interpretation:BookingInterpretationView;privacyKey:string;sourceVersion:number;enabled:boolean}
export function BookingConversation({ports,interpretation,privacyKey,sourceVersion,enabled}:BookingConversationProps):JSX.Element {
 const [view,setView]=useState<BookingConversationView|null>(null),[id,setId]=useState<string|null>(null),[message,setMessage]=useState<BookingMessageView|null>(null),[messageId,setMessageId]=useState<string|null>(null),[admissionAttempted,setAdmissionAttempted]=useState(false),[messageAttempted,setMessageAttempted]=useState(false),[eventUncertain,setEventUncertain]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const epoch=useRef(0);
 const invalidate=useCallback(()=>++epoch.current,[]);
 useLayoutEffect(()=>{invalidate();setView(null);setId(null);setMessage(null);setMessageId(null);setAdmissionAttempted(false);setMessageAttempted(false);setEventUncertain(false);setBusy(false);setError('');return()=>{invalidate();};},[ports,interpretation,privacyKey,sourceVersion,enabled,invalidate]);
 const available=enabled&&interpretation.state==='complete'&&interpretation.outcome!==null;
 async function run(work:(current:()=>boolean)=>Promise<void>){
  if(!available||busy)return;
  const ticket=++epoch.current,current=()=>ticket===epoch.current;
  setView(null);setMessage(null);setBusy(true);setError('');
  try{await work(current);}catch{if(current())setError('Current booking conversation unavailable. Private outcomes have been cleared. Inspect before any further action.');}
  finally{if(current())setBusy(false);}
 }
 async function read(conversationId:string,current:()=>boolean){const next=await ports.read({conversationId});if(current()){if(next.conversationId!==conversationId||next.interpretationRequestId!==interpretation.requestId)throw Error('changed');setView(next);}}
 function admit(){void run(async current=>{
  const policy=await ports.policy();if(!current())return;
  if(policy===null||policy.revision<1||policy.status!=='saved')throw Error('policy_unavailable');
  setAdmissionAttempted(true);
  const queued=await ports.request({interpretationRequestId:interpretation.requestId,expectedPolicyRevision:policy.revision});if(!current())return;
  setId(queued.conversationId);await read(queued.conversationId,current);
 });}
 function event(event:OperationInput<'meetings.bookingConversationEvent'>['event']){if(view===null)return;const prior=view;void run(async current=>{setEventUncertain(true);await ports.event({conversationId:prior.conversationId,expectedPolicyRevision:prior.policyRevision,event});if(!current())return;setEventUncertain(false);await read(prior.conversationId,current);});}
 function requestMessage(){if(view===null)return;const prior=view;void run(async current=>{setMessageAttempted(true);const queued=await ports.messageRequest({conversationId:prior.conversationId,kind:'approved_link'});if(!current())return;setMessageId(queued.messageId);const next=await ports.messageRead({messageId:queued.messageId});if(!current())return;if(next.conversationId!==prior.conversationId||next.messageId!==queued.messageId)throw Error('changed');await read(prior.conversationId,current);if(current())setMessage(next);});}
 const mutable=!eventUncertain&&view!==null&&!['unknown','stale','pending','booking_pending'].includes(view.state)&&view.booking?.state!=='unknown'&&view.change?.state!=='unknown'&&(!messageAttempted||(message!==null&&['sent','held','unavailable'].includes(message.state)));
 return <section aria-label="Booking conversation"><h5>Standing booking conversation</h5>
  <p>Booking-only standing policy, not a human-confirmed appointment or per-message approval. David retains substantive sales replies.</p>
  <p>Live booking automation held: enabled:false. Controlled source support is not provider, sender or model acceptance.</p>
  {available&&id===null&&!admissionAttempted?<Button disabled={busy} onClick={admit}>Manage booking conversation</Button>:null}
  {available&&id!==null?<Button disabled={busy} onClick={()=>void run(current=>read(id,current))}>Inspect current booking conversation</Button>:null}
  {busy?<p role="status">Reading current booking conversation…</p>:null}{error?<p role="alert">{error}</p>:null}
  {available&&view?<><p>Conversation state: {view.state.replaceAll('_',' ')}</p>{view.reason?<p>{view.reason.replaceAll('_',' ')}</p>:null}
   <p>Booking-only nudges: {view.nudgeCount} of 2. Manual nudges count toward this total.</p>
   <p>{view.nudgesStoppedAt?`Nudges stopped at ${view.nudgesStoppedAt}.`:'Any reply, booking, refusal or opt-out stops nudges. Two unanswered nudges hand back to David.'}</p>
   {view.handoff?<section aria-label="Durable David handoff"><h5>Durable David handoff</h5><p>{view.handoff.action.replaceAll('_',' ')} for owner {view.handoff.ownerUserId}</p>{view.handoff.evidence?<><blockquote>{view.handoff.evidence.quote}</blockquote><p>Original source {view.handoff.evidence.sourceId}</p></>:null}<p>This workflow does not send substantive sales answers.</p></section>:null}
   {view.booking?<section aria-label="Booking receipt"><p>Booking receipt: {view.booking.state}. {view.booking.reason}</p><p>Submission {view.booking.submissionId}</p>{view.booking.meetingId?<p>Meeting {view.booking.meetingId}</p>:null}<p>Provider booking {view.booking.providerBookingUid??'not established'}</p></section>:null}
   {view.change?<section aria-label="Booking change receipt"><p>Booking {view.change.action}: {view.change.state}. {view.change.reason}</p><p>Submission {view.change.submissionId}, target booking {view.change.targetBookingUid}</p><p>Reminder state: {view.change.reminderState}</p></section>:null}
   {!mutable?<p>Current acceptance is pending, stale or unknown. Inspect current state, never replay an uncertain action.</p>:null}
   {mutable?<><Button disabled={busy||view.nudgeCount>=2||view.nudgesStoppedAt!==null||view.state!=='awaiting_time'} onClick={()=>event('manual_nudge')}>Record manual booking nudge</Button><Button disabled={busy} onClick={()=>event('reply')}>Record reply and stop nudges</Button><Button disabled={busy} onClick={()=>event('refusal')}>Record refusal</Button><Button disabled={busy} onClick={()=>event('opt_out')}>Record opt-out</Button>
    {['booked','rescheduled'].includes(view.state)&&view.explicitNoShowAt===null?<Button disabled={busy} onClick={()=>event('confirm_no_show')}>David: confirm no-show</Button>:null}
    {view.state==='awaiting_time'&&view.outcome?.kind==='approved_link'&&messageId===null&&!messageAttempted?<Button disabled={busy} onClick={requestMessage}>Request approved booking link</Button>:null}</>:null}
   <p>{view.explicitNoShowAt?`David confirmed no-show at ${view.explicitNoShowAt}.`:'No-show is unknown without David’s explicit confirmation. Elapsed time is not attendance evidence.'} Rebooking message used: {view.noShowRebookingUsed?'yes':'no'}.</p>
   {view.limitations.map((value,index)=><p key={index}>{value.replaceAll('_',' ')}</p>)}
  </>:null}
  {available&&messageId?<Button disabled={busy} onClick={()=>void run(async current=>{const next=await ports.messageRead({messageId});if(!current())return;if(next.messageId!==messageId||next.conversationId!==id)throw Error('changed');if(id!==null)await read(id,current);if(current())setMessage(next);})}>Inspect current booking message</Button>:null}
  {available&&message?<section aria-label="Booking message receipt"><p>Booking message: {message.state.replaceAll('_',' ')}</p>{message.reason?<p>{message.reason.replaceAll('_',' ')}</p>:null}<p>Sent at: {message.sentAt??'not established'}</p>{message.limitations.map((value,index)=><p key={index}>{value.replaceAll('_',' ')}</p>)}</section>:null}
 </section>;
}

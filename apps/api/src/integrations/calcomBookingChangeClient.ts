import type {BookingChangeCall,BookingChangeProvider,BookingChangeTarget,BookingChangeObservation} from '@fss/domain/meetings/bookingChangeProvider.ts';
import {calcomBookingCreateClient,type CalcomBookingCreateHttp} from './calcomBookingCreateClient.ts';
export interface CalcomReminderTransitionEvidence {
 readonly accountId:number;readonly eventTypeId:number;readonly submissionId:string;
 readonly previousUid:string;readonly bookingUid:string;readonly transition:'replaced'|'stopped';
 readonly observedAt:string;readonly reference:string;
}
export interface CalcomBookingChangeOptions {
 readonly apiKey:string;readonly http?:CalcomBookingCreateHttp;
 /** Existing provider-owned reminder readback, not configuration, Enable or a Callie sender. Missing proof stays unknown. */
 readonly readReminderTransition?:(call:BookingChangeCall,bookingUid:string)=>Promise<CalcomReminderTransitionEvidence|null>;
}
const record=(value:unknown):Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value)?value as Record<string,unknown>:{};
const instant=(value:unknown):string|null=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
const uid=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/u.test(value);
const reasonOf=(call:BookingChangeCall)=>`Attendee requested ${call.action} [callie:${call.submissionId}]`;
/** Official regular-booking v2 transport, explicitly composed only. No retry or conflict bypass. */
export function calcomBookingChangeClient(options:CalcomBookingChangeOptions):BookingChangeProvider {
 const http=options.http??fetch,existing=calcomBookingCreateClient(options);
 const request=async(bookingUid:string,suffix='',body?:object)=>{
  if(!uid(bookingUid))throw new Error('provider_target_unsupported');
  const response=await http(`https://api.cal.com/v2/bookings/${bookingUid}${suffix}`,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${options.apiKey}`,accept:'application/json','cal-api-version':'2026-02-25',...(body===undefined?{}:{'content-type':'application/json'})},redirect:'error',signal:AbortSignal.timeout(10_000),...(body===undefined?{}:{body:JSON.stringify(body)})});
  if(response.status!==200&&response.status!==201)throw new Error('provider_acceptance_unknown');
  const envelope=record(await boundedJson(response));if(envelope['status']!=='success'||Array.isArray(envelope['data']))throw new Error('provider_invalid_response');return record(envelope['data']);
 };
 const parse=(row:Record<string,unknown>,call:BookingChangeCall):BookingChangeTarget|null=>{
  const hosts=Array.isArray(row['hosts'])?row['hosts'].map(record):[],attendees=Array.isArray(row['attendees'])?row['attendees'].map(record):[];
  const start=instant(row['start']),end=instant(row['end']),updatedAt=instant(row['updatedAt']);
  if(!uid(row['uid'])||!Number.isSafeInteger(row['id'])||Number(row['id'])<=0||row['eventTypeId']!==call.eventTypeId||hosts.length!==1||hosts[0]?.['id']!==call.accountId||String(hosts[0]?.['email']).toLowerCase()!==call.organizerEmail.toLowerCase()||attendees.length!==1||String(attendees[0]?.['email']).toLowerCase()!==call.attendeeEmail||Array.isArray(row['guests'])&&row['guests'].length!==0||row['recurringEventId']!=null||row['seats']!=null||start===null||end===null||Date.parse(end)-Date.parse(start)!==20*60_000||updatedAt===null)return null;
  return {uid:row['uid'],id:Number(row['id']),accountId:call.accountId,eventTypeId:call.eventTypeId,organizerEmail:call.organizerEmail,attendeeEmail:call.attendeeEmail,startsAt:start,endsAt:end,updatedAt,status:row['status']==='accepted'?'accepted':row['status']==='cancelled'?'cancelled':'unsupported'};
 };
 const inspect=async(call:BookingChangeCall):Promise<BookingChangeObservation>=>{
  try{
   const original=await request(call.bookingUid),oldBooking=parse(original,call);
   if(oldBooking===null||oldBooking.uid!==call.bookingUid||oldBooking.startsAt!==instant(call.originalStartsAt)||oldBooking.endsAt!==instant(call.originalEndsAt))return {state:'unknown',reason:'provider_evidence_mismatch'};
   const row=call.action==='reschedule'&&uid(original['rescheduledToUid'])?await request(original['rescheduledToUid']):original;
   const booking=parse(row,call),expectedReminder=call.action==='cancel'?'stopped':'replaced';
   if(booking===null||call.action==='cancel'&&(booking.uid!==call.bookingUid||booking.status!=='cancelled'||row['cancellationReason']!==reasonOf(call))||call.action==='reschedule'&&(oldBooking.status!=='cancelled'||booking.status!=='accepted'||booking.uid===call.bookingUid||row['rescheduledFromUid']!==call.bookingUid||row['reschedulingReason']!==reasonOf(call)||booking.startsAt!==instant(call.startsAt)))return {state:'unknown',reason:'provider_evidence_mismatch'};
   const proof=await options.readReminderTransition?.(call,booking.uid).catch(()=>null);
   if(!proof||proof.accountId!==call.accountId||proof.eventTypeId!==call.eventTypeId||proof.submissionId!==call.submissionId||proof.previousUid!==call.bookingUid||proof.bookingUid!==booking.uid||proof.transition!==expectedReminder||!proof.reference||instant(proof.observedAt)===null||Date.parse(proof.observedAt)<Date.parse(booking.updatedAt))return {state:'accepted',booking:{...booking,submissionId:call.submissionId,previousUid:call.bookingUid,action:call.action,reminderState:'unverified'}};
   return {state:'accepted',booking:{...booking,submissionId:call.submissionId,previousUid:call.bookingUid,action:call.action,reminderState:expectedReminder}};
  }catch{return {state:'unknown',reason:'provider_inspection_unavailable'};}
 };
 return {availability:input=>existing.availability(input),async readTarget(call){try{const row=await request(call.bookingUid),booking=parse(row,call);return booking?.uid===call.bookingUid?booking:null;}catch{return null;}},async change(call){
  try{await request(call.bookingUid,call.action==='cancel'?'/cancel':'/reschedule',call.action==='cancel'?{cancellationReason:reasonOf(call)}:{start:call.startsAt,lengthInMinutes:20,rescheduleWithSameHost:true,reschedulingReason:reasonOf(call)});}catch{return {state:'unknown',reason:'provider_acceptance_unknown'};}
  return inspect(call);
 },inspect};
}
async function boundedJson(response:Response):Promise<unknown>{
 const limit=128*1024;if(Number(response.headers.get('content-length')??'0')>limit||response.body===null)throw new Error('provider_invalid_response');
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let total=0;
 try{for(;;){const part=await reader.read();if(part.done)break;total+=part.value.byteLength;if(total>limit)throw new Error('provider_invalid_response');chunks.push(part.value);}}finally{await reader.cancel().catch(()=>undefined);}
 return JSON.parse(Buffer.concat(chunks,total).toString('utf8')) as unknown;
}

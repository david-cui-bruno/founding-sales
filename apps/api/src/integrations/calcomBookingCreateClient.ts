import type {BookingCreateCall,BookingCreateEvidence,BookingCreateObservation,BookingCreateProvider} from '@fss/domain/meetings/bookingCreateProvider.ts';
export type CalcomBookingCreateHttp=(url:string,init:RequestInit)=>Promise<Response>;
const record=(value:unknown):Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value)?value as Record<string,unknown>:{};
const instant=(value:unknown):string|null=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
const positive=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0;
/** Current official regular-booking contract. No retry, conflict bypass, fallback or provider idempotency assertion. */
export function calcomBookingCreateClient(options:{apiKey:string;http?:CalcomBookingCreateHttp}):BookingCreateProvider {
 const http=options.http??fetch;
 return {async availability(input){
  if(input.calendars.length===0||input.calendars.length>20)return {available:false,reason:'availability_unknown'};
  const start=Date.parse(input.startsAt),end=start+20*60_000,bufferEnd=end+10*60_000;
  const read=async(url:URL,version?:string)=>{const response=await http(url.toString(),{method:'GET',headers:{authorization:`Bearer ${options.apiKey}`,accept:'application/json',...(version?{'cal-api-version':version}:{})},redirect:'error',signal:AbortSignal.timeout(10_000)});if(response.status!==200)throw new Error('availability_unknown');const body=record(await boundedJson(response));if(body['status']!=='success')throw new Error('availability_unknown');return body['data'];};
  try{
   const slots=new URL('/v2/slots','https://api.cal.com');
   slots.searchParams.set('eventTypeId',String(input.eventTypeId));slots.searchParams.set('start',new Date(start).toISOString());slots.searchParams.set('end',new Date(bufferEnd).toISOString());slots.searchParams.set('timeZone','UTC');slots.searchParams.set('format','range');
   const data=record(await read(slots,'2024-09-04')),values=Object.values(data);
   if(values.some(value=>!Array.isArray(value)))throw new Error('availability_unknown');
   const offered=values.flatMap(value=>value as unknown[]).map(record);
   if(!offered.some(slot=>Date.parse(String(slot['start']))===start&&Date.parse(String(slot['end']))===end))return {available:false,reason:'slot_unavailable'};
   const busy=new URL('/v2/calendars/busy-times','https://api.cal.com');busy.searchParams.set('dateFrom',new Date(start).toISOString().slice(0,10));busy.searchParams.set('dateTo',new Date(bufferEnd).toISOString().slice(0,10));busy.searchParams.set('timeZone','UTC');
   for(const calendar of input.calendars){if(!positive(calendar.credentialId)||!calendar.externalId)throw new Error('availability_unknown');busy.searchParams.append('calendar',`${calendar.credentialId},${calendar.externalId}`);}
   const conflicts=await read(busy);if(!Array.isArray(conflicts)||conflicts.length>2000)throw new Error('availability_unknown');
   for(const item of conflicts){const row=record(item),from=instant(row['start']),to=instant(row['end']);if(from===null||to===null||Date.parse(to)<Date.parse(from))throw new Error('availability_unknown');if(Date.parse(from)<bufferEnd&&Date.parse(to)>start)return {available:false,reason:'slot_unavailable'};}
   return {available:true,reason:null};
  }catch{return {available:false,reason:'availability_unknown'};}
 },async create(input){
  let response:Response;
  try{response=await http('https://api.cal.com/v2/bookings',{method:'POST',headers:{authorization:`Bearer ${options.apiKey}`,accept:'application/json','content-type':'application/json','cal-api-version':'2026-02-25'},redirect:'error',signal:AbortSignal.timeout(10_000),body:JSON.stringify({start:input.startsAt,eventTypeId:input.eventTypeId,attendee:input.attendee,metadata:{callieSubmissionId:input.submissionId},leadEnrichmentOptOut:true})});}
  catch{return {state:'unknown',reason:'provider_acceptance_unknown'};}
  if([400,401,403,404,409,422].includes(response.status))return {state:'failed',reason:'provider_refused'};
  if(response.status!==201)return {state:'unknown',reason:'provider_acceptance_unknown'};
  try{
   const envelope=record(await boundedJson(response));
   if(envelope['status']!=='success')return {state:'unknown',reason:'provider_invalid_response'};
   return parseBookingObservation(envelope['data'],input);
  }catch{return {state:'unknown',reason:'provider_invalid_response'};}
 }};
}
async function boundedJson(response:Response):Promise<unknown>{
 const limit=128*1024;
 if(Number(response.headers.get('content-length')??'0')>limit||response.body===null)throw new Error('provider_invalid_response');
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let total=0;
 try{for(;;){const part=await reader.read();if(part.done)break;total+=part.value.byteLength;if(total>limit)throw new Error('provider_invalid_response');chunks.push(part.value);}}
 finally{await reader.cancel().catch(()=>undefined);}
 return JSON.parse(Buffer.concat(chunks,total).toString('utf8')) as unknown;
}
function parseBookingObservation(value:unknown,input:BookingCreateCall):BookingCreateObservation {
 const row=record(value),hosts=Array.isArray(row['hosts'])?row['hosts'].map(record):[],attendees=Array.isArray(row['attendees'])?row['attendees'].map(record):[];
 const start=instant(row['start']),end=instant(row['end']),updated=instant(row['updatedAt']);
 if(typeof row['uid']!=='string'||! /^[A-Za-z0-9_-]{1,128}$/u.test(row['uid'])||!positive(row['id'])||row['eventTypeId']!==input.eventTypeId||hosts.length!==1||hosts[0]?.['id']!==input.accountId||hosts[0]?.['email']!==input.organizerEmail||attendees.length!==1||attendees[0]?.['email']!==input.attendee.email||record(row['metadata'])['callieSubmissionId']!==input.submissionId||start!==instant(input.startsAt)||end===null||Date.parse(end)-Date.parse(start??'')!==20*60_000||updated===null||!['accepted','pending'].includes(String(row['status'])))return {state:'unknown',reason:'provider_evidence_mismatch'};
 const booking:BookingCreateEvidence={uid:row['uid'],id:row['id'],eventTypeId:input.eventTypeId,accountId:input.accountId,organizerEmail:input.organizerEmail,attendeeEmail:input.attendee.email,startsAt:start!,endsAt:end,updatedAt:updated,submissionId:input.submissionId};
 return {state:row['status']==='accepted'?'accepted':'pending',booking};
}

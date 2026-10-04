import type { CalcomDemoBooking, CalcomDemoClient } from '@fss/domain/meetings/autoRecordingTypes.ts';
import { attendeeAddressOf } from '@fss/domain/meetings/attendee.ts';
import { zoomMeetingIdOfUrl } from '@fss/domain/meetings/bookingDetails.ts';
import { boundedProviderRequest, readFailure, record, type ProviderHttp } from '../providers/boundedHttp.ts';
function parseBooking(value:unknown,uid:string):CalcomDemoBooking|null {
  const b=record(value),e=record(b['eventType']);const hosts=b['hosts'],attendees=b['attendees'];
  if(b['uid']!==uid||b['status']!=='accepted'||!Array.isArray(hosts)||hosts.length!==1||!Array.isArray(attendees)||attendees.length!==1||
    !Number.isSafeInteger(b['eventTypeId'])||Number(b['eventTypeId'])<=0||('id' in e&&e['id']!==b['eventTypeId']))return null;
  const hostEmail=attendeeAddressOf(record(hosts[0])['email']),attendeeEmail=attendeeAddressOf(record(attendees[0])['email']);
  if(!hostEmail||!attendeeEmail||typeof b['start']!=='string'||typeof b['end']!=='string')return null;
  const start=Date.parse(b['start']),end=Date.parse(b['end']),duration=(end-start)/60000;
  if(!Number.isFinite(start)||!Number.isFinite(end)||duration<=0||!Number.isInteger(duration)||('duration' in b&&b['duration']!==duration))return null;
  for(const field of ['recurringBookingUid','recurringEventId','recurringEvent','seats','seatUid','rescheduledToUid'])if(b[field]!==undefined&&b[field]!==null&&b[field]!==false)return null;
  if(Array.isArray(b['guests'])&&b['guests'].length>0)return null;
  const locations=[b['location'],b['meetingUrl'],record(b['metadata'])['videoCallUrl']].filter(v=>v!==null&&v!==undefined&&v!=='integrations:zoom');
  const ids=locations.map(zoomMeetingIdOfUrl);const zoomMeetingId=ids[0];
  if(!zoomMeetingId||ids.some(id=>id!==zoomMeetingId))return null;
  return {uid,status:'accepted',eventTypeId:Number(b['eventTypeId']),hostEmail,attendeeEmail,startsAt:new Date(start).toISOString(),endsAt:new Date(end).toISOString(),zoomMeetingId,successorUid:null,recurring:false,seated:false};
}
export function calcomDemoClient(options:{apiKey:string;http?:ProviderHttp}):CalcomDemoClient {
  const http=options.http??fetch;
  return {async readBooking(uid,signal){
    const refused={kind:'refused' as const,code:'booking_mismatch',retryAfterMs:null};
    if(!/^[a-zA-Z0-9_-]{1,200}$/u.test(uid))return refused;
    try {
      const result=await boundedProviderRequest(http,`https://api.cal.com/v2/bookings/${uid}`,{method:'GET',headers:{authorization:`Bearer ${options.apiKey}`,'cal-api-version':'2026-02-25'}},signal,10000);
      if(result.status!==200)return readFailure(result.status,result.retryAfterMs);
      const body=record(result.body);const value=body['status']==='success'?parseBooking(body['data'],uid):null;
      return value===null?refused:{kind:'ok',value};
    }catch{return {kind:'retry',code:'provider_unreachable',retryAfterMs:null};}
  }};
}

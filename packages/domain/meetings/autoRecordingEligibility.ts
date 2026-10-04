import { createHash } from 'node:crypto';
import type { MeetingAutoRecordingSetting, RecordingSetupReason } from '@fss/contracts';
import { attendeeAddressOf } from './attendee.ts';
import type { CalcomDemoBooking, RecordingSetupTarget, ZoomMeetingSnapshot } from './autoRecordingTypes.ts';
export function recordingSetupTargetHash(t:RecordingSetupTarget):string {
  return createHash('sha256').update(JSON.stringify([t.workspaceId,t.meetingId,t.firmId,t.contactId,t.bookingUid,t.zoomMeetingId,t.attendeeEmail,t.organizerEmail,t.startsAt,t.endsAt,t.settingsVersion])).digest('hex');
}
export function recordingSetupEligibility(input:{target:RecordingSetupTarget;setting:MeetingAutoRecordingSetting;booking:CalcomDemoBooking;zoom:ZoomMeetingSnapshot;at:string;reusedZoomId:boolean}):{ok:true;action:'observe'|'set_local'}|{ok:false;reason:RecordingSetupReason} {
  const {target:t,setting:s,booking:b,zoom:z}=input;
  const no=(reason:RecordingSetupReason)=>({ok:false as const,reason});
  if(!s.enabled) return no('disabled');
  if(!s.hostEmail || !s.calcomEventTypeId) return no('unconfigured');
  if(!t.firmId || !attendeeAddressOf(t.attendeeEmail) || !attendeeAddressOf(t.organizerEmail)) return no('unmatched');
  const start=Date.parse(t.startsAt),end=Date.parse(t.endsAt),now=Date.parse(input.at),minutes=(end-start)/60000;
  if(!Number.isFinite(now)||!Number.isFinite(start)||!Number.isFinite(end)||start<=now||minutes<=0||!Number.isInteger(minutes)) return no('not_future');
  if(input.reusedZoomId) return no('zoom_mismatch');
  if(!t.bookingUid || !/^\d{9,11}$/u.test(t.zoomMeetingId) || b.uid!==t.bookingUid || b.status!=='accepted' || b.successorUid!==null || b.recurring || b.seated ||
    b.eventTypeId!==s.calcomEventTypeId || b.hostEmail!==s.hostEmail || t.organizerEmail!==s.hostEmail || b.attendeeEmail!==t.attendeeEmail ||
    b.zoomMeetingId!==t.zoomMeetingId || Date.parse(b.startsAt)!==start || Date.parse(b.endsAt)!==end) return no('booking_mismatch');
  if(z.type!==2 || z.usePmi!==false) return no('unsupported_meeting');
  if(z.id!==t.zoomMeetingId || z.hostEmail!==s.hostEmail || !Number.isFinite(Date.parse(z.startsAt)) || Math.abs(Date.parse(z.startsAt)-start)>60000 || z.durationMinutes!==minutes) return no('zoom_mismatch');
  if(z.autoRecording==='local') return {ok:true,action:'observe'};
  return z.autoRecording==='none'?{ok:true,action:'set_local'}:no('unsupported_recording_mode');
}

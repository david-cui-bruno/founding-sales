export interface RecordingSetupTarget {
  readonly workspaceId:string; readonly meetingId:string; readonly firmId:string; readonly contactId:string|null;
  readonly bookingUid:string; readonly zoomMeetingId:string; readonly attendeeEmail:string; readonly organizerEmail:string;
  readonly startsAt:string; readonly endsAt:string; readonly settingsVersion:number;
}
export interface CalcomDemoBooking {
  readonly uid:string; readonly status:string; readonly eventTypeId:number; readonly hostEmail:string; readonly attendeeEmail:string;
  readonly startsAt:string; readonly endsAt:string; readonly zoomMeetingId:string; readonly successorUid:string|null;
  readonly recurring:boolean; readonly seated:boolean;
}
export interface ZoomMeetingSnapshot {
  readonly id:string; readonly hostEmail:string; readonly type:number; readonly usePmi:boolean|null;
  readonly startsAt:string; readonly durationMinutes:number; readonly autoRecording:string;
}
export type ProviderRead<T> = {kind:'ok';value:T}|{kind:'retry'|'refused';code:string;retryAfterMs:number|null};
export type ZoomWriteResult = {kind:'acknowledged'|'refused'|'unknown';code:string|null;retryAfterMs:number|null};
export interface CalcomDemoClient { readBooking(uid:string,signal:AbortSignal):Promise<ProviderRead<CalcomDemoBooking>> }
export interface ZoomMeetingsClient {
  readMeeting(id:string,signal:AbortSignal):Promise<ProviderRead<ZoomMeetingSnapshot>>;
  setLocalAutoRecording(id:string,signal:AbortSignal):Promise<ZoomWriteResult>;
}

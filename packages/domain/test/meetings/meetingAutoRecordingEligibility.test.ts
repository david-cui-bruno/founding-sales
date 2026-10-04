import { describe, expect, it } from 'vitest';
import { recordingSetupEligibility, recordingSetupTargetHash } from '../../meetings/autoRecordingEligibility.ts';
import type { RecordingSetupTarget, CalcomDemoBooking, ZoomMeetingSnapshot } from '../../meetings/autoRecordingTypes.ts';
const target: RecordingSetupTarget = {workspaceId:'10000000-0000-4000-8000-000000000001',meetingId:'10000000-0000-4000-8000-000000000002',firmId:'10000000-0000-4000-8000-000000000003',contactId:null,bookingUid:'demo-1',zoomMeetingId:'12345678901',attendeeEmail:'pm@example.com',organizerEmail:'host@example.com',startsAt:'2026-10-05T15:00:00.000Z',endsAt:'2026-10-05T15:30:00.000Z',settingsVersion:1};
const booking: CalcomDemoBooking = {uid:'demo-1',status:'accepted',eventTypeId:42,hostEmail:'host@example.com',attendeeEmail:'pm@example.com',startsAt:target.startsAt,endsAt:target.endsAt,zoomMeetingId:target.zoomMeetingId,successorUid:null,recurring:false,seated:false};
const zoom: ZoomMeetingSnapshot = {id:target.zoomMeetingId,hostEmail:'host@example.com',type:2,usePmi:false,startsAt:target.startsAt,durationMinutes:30,autoRecording:'none'};
const valid = {target,booking,zoom,setting:{enabled:true,hostEmail:'host@example.com',calcomEventTypeId:42},at:'2026-10-05T14:00:00.000Z',reusedZoomId:false};
describe('demo recording eligibility', () => {
  it('requires_exact_demo_identity_and_future_time', () => {
    expect(recordingSetupEligibility(valid)).toEqual({ok:true,action:'set_local'});
    for(const change of [{eventTypeId:43},{uid:'old'},{successorUid:'next'},{status:'cancelled'},{hostEmail:'other@example.com'},{attendeeEmail:'other@example.com'},{zoomMeetingId:'99999999999'},{recurring:true},{seated:true},{startsAt:'2026-10-05T15:01:00Z'},{endsAt:'2026-10-05T15:31:00Z'}]) expect(recordingSetupEligibility({...valid,booking:{...booking,...change}}).ok).toBe(false);
    expect(recordingSetupEligibility({...valid,at:target.startsAt}).ok).toBe(false);
    expect(recordingSetupEligibility({...valid,at:'invalid'}).ok).toBe(false);
    expect(recordingSetupEligibility({...valid,reusedZoomId:true}).ok).toBe(false);
    expect(recordingSetupEligibility({...valid,setting:{...valid.setting,enabled:false}}).ok).toBe(false);
    expect(recordingSetupEligibility({...valid,target:{...target,attendeeEmail:''}}).ok).toBe(false);
  });
  it('rejects_unsupported_zoom_targets', () => {
    for(const change of [{id:'99999999999'},{hostEmail:'other@example.com'},{type:8},{type:1},{usePmi:true},{usePmi:null},{durationMinutes:29},{autoRecording:'cloud'},{autoRecording:'unknown'}]) expect(recordingSetupEligibility({...valid,zoom:{...zoom,...change}}).ok).toBe(false);
    expect(recordingSetupEligibility({...valid,zoom:{...zoom,autoRecording:'local'}})).toEqual({ok:true,action:'observe'});
    for(const [seconds,ok] of [[60,true],[-60,true],[61,false],[-61,false]] as const) expect(recordingSetupEligibility({...valid,zoom:{...zoom,startsAt:new Date(Date.parse(target.startsAt)+seconds*1000).toISOString()}}).ok).toBe(ok);
    const endsAt='2026-10-05T15:30:30Z';
    expect(recordingSetupEligibility({...valid,target:{...target,endsAt},booking:{...booking,endsAt}}).ok).toBe(false);
  });
  it('uses_stable_target_revision', () => {
    const hash=recordingSetupTargetHash(target);
    expect(hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(recordingSetupTargetHash({...target})).toBe(hash);
    expect(recordingSetupTargetHash({...target,settingsVersion:2})).not.toBe(hash);
    expect(recordingSetupTargetHash({...target,bookingUid:'new'})).not.toBe(hash);
  });
});

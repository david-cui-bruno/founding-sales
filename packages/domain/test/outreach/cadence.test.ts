import {it,expect} from 'vitest';
import {buildOutreachCadence,nextProspectingTouch} from '../../outreach/cadence.ts';
it('uses calendar offsets and keeps local send time across DST',()=>{
 const plan=buildOutreachCadence({lane:'email_first',startsAt:'2026-10-26T14:00:00Z',timeZone:'America/New_York'});
 expect(plan.touches.map(t=>t.localDate)).toEqual(['2026-10-26','2026-10-29','2026-11-02','2026-11-09','2026-11-16']);
 expect(plan.touches.map(t=>t.dueAt)).toEqual(['2026-10-26T14:00:00.000Z','2026-10-29T14:00:00.000Z','2026-11-02T15:00:00.000Z','2026-11-09T15:00:00.000Z','2026-11-16T15:00:00.000Z']);
 expect(plan.expiresAt).toBe('2026-11-17T04:59:59.999Z');
});
it('preserves call/email order with one weekday per touch and voicemail on calls one and four',()=>{
 const plan=buildOutreachCadence({lane:'call_first',startsAt:'2026-10-02T14:00:00Z',timeZone:'America/Chicago'});
 expect(plan.touches.map(t=>t.channel)).toEqual(['phone','email','phone','email','phone','email','phone','email']);
 expect(new Set(plan.touches.map(t=>t.localDate)).size).toBe(8);
 expect(plan.touches.filter(t=>t.voicemail).map(t=>t.channelOrdinal)).toEqual([1,4]);
 expect(plan.touches.filter(t=>t.channel==='email')).toHaveLength(4);
});
it('does not drain missed work, extend expiry, or propose another touch on the same date',()=>{
 const plan=buildOutreachCadence({lane:'call_first',startsAt:'2026-10-05T14:00:00Z',timeZone:'America/New_York'});
 const at='2026-10-12T15:00:00Z';
 const next=nextProspectingTouch({plan,at,completedOrdinals:[],lastTouchAt:null});
 expect(next?.touch.channel).toBe('email');
 expect(next?.skippedOrdinals).toEqual([1,2,3]);
 expect(nextProspectingTouch({plan,at,completedOrdinals:[4],lastTouchAt:at})).toBeNull();
 expect(nextProspectingTouch({plan,at:'2026-11-02T15:00:00Z',completedOrdinals:[],lastTouchAt:null})).toBeNull();
});

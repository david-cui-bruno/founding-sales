import {expect,it} from 'vitest';
import {placeEmailSend} from '../../src/rules/sendingWindow.ts';
import {buildOutreachCadence,nextProspectingTouch} from '../../outreach/cadence.ts';
import {outreachStepDue} from '../../outreach/timing.ts';

it('places afternoon cold mail at 10am recipient-local on the next weekday, across DST and holidays',()=>{
 expect(placeEmailSend('2026-10-07T18:37:00Z','America/Chicago',{prospecting:true}).sendAt).toBe('2026-10-08T15:00:00.000Z');
 expect(placeEmailSend('2026-10-30T16:00:00Z','America/New_York',{prospecting:true}).sendAt).toBe('2026-11-02T15:00:00.000Z');
 expect(placeEmailSend('2026-10-30T16:00:00Z','America/New_York',{prospecting:true,calendar:{version:'test',dates:['2026-11-02']}}).sendAt).toBe('2026-11-03T15:00:00.000Z');
});
it('enforces 9am inclusive to 11am exclusive without narrowing conversation replies',()=>{
 for(const [at,inside] of [['2026-10-07T12:59:59Z',false],['2026-10-07T13:00:00Z',true],['2026-10-07T14:59:59Z',true],['2026-10-07T15:00:00Z',false]] as const){
  expect(placeEmailSend(at,'America/New_York',{prospecting:true}).inPlace).toBe(inside);
 }
 expect(placeEmailSend('2026-10-07T18:37:00Z','America/Chicago').inPlace).toBe(true);
});
it('starts new afternoon email cohorts next morning, while calls retain their daytime slot',()=>{
 const email=buildOutreachCadence({lane:'email_first',startsAt:'2026-10-07T18:37:00Z',timeZone:'America/Chicago'});
 expect(email.touches[0]?.dueAt).toBe('2026-10-08T15:00:00.000Z');
 expect(email.touches[1]?.dueAt).toBe('2026-10-12T15:00:00.000Z');
 const calls=buildOutreachCadence({lane:'call_first',startsAt:'2026-10-07T18:37:00Z',timeZone:'America/Chicago'});
 expect(calls.touches[0]?.dueAt).toBe('2026-10-07T18:37:00.000Z');
 expect(calls.touches[1]?.dueAt).toBe('2026-10-09T15:00:00.000Z');
});
it('old afternoon plans recover to morning consistently in selection and successor timing',()=>{
 const plan=buildOutreachCadence({lane:'email_first',startsAt:'2026-10-07T15:00:00Z',timeZone:'America/Chicago'});
 const legacy={...plan,touches:plan.touches.map(t=>({...t,dueAt:t.dueAt.replace('15:00:00','17:36:00')}))};
 expect(outreachStepDue(legacy,{channel:'email',channelOrdinal:1,lastTouch:null})?.dueAt).toBe('2026-10-08T15:00:00.000Z');
 expect(nextProspectingTouch({plan:legacy,at:'2026-10-08T15:00:00Z',completedOrdinals:[],lastTouchAt:null})?.touch.ordinal).toBe(1);
 const second=outreachStepDue(legacy,{channel:'email',channelOrdinal:2,lastTouch:{ordinal:1,at:'2026-10-08T15:00:00Z'}})!;
 expect(nextProspectingTouch({plan:legacy,at:second.dueAt,completedOrdinals:[1],lastTouchAt:'2026-10-08T15:00:00Z'})?.touch.ordinal).toBe(2);
 expect(legacy.expiresAt).toBe(plan.expiresAt);
});

it('keeps a late-morning first touch but defaults subsequent emails to 10am',()=>{
 const plan=buildOutreachCadence({lane:'email_first',startsAt:'2026-10-07T15:37:00Z',timeZone:'America/Chicago'});
 expect(plan.touches[0]?.dueAt).toBe('2026-10-07T15:37:00.000Z');
 expect(plan.touches[1]?.dueAt).toBe('2026-10-12T15:00:00.000Z');
});

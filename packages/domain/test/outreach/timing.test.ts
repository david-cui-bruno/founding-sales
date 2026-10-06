import {it,expect} from 'vitest';
import {buildOutreachCadence} from '../../outreach/cadence.ts';
import {outreachStepDue} from '../../outreach/timing.ts';
it('uses frozen calendar dates rather than the legacy business-day delays',()=>{
 const plan=buildOutreachCadence({lane:'email_first',startsAt:'2026-10-05T14:00:00Z',timeZone:'America/New_York'});
 expect(outreachStepDue(plan,{channel:'email',channelOrdinal:2,lastTouch:null})?.dueAt).toBe('2026-10-08T14:00:00.000Z');
 expect(outreachStepDue(plan,{channel:'email',channelOrdinal:6,lastTouch:null})).toBeNull();
});
it('spaces the successor from an actual late touch without extending the original expiry',()=>{
 const plan=buildOutreachCadence({lane:'email_first',startsAt:'2026-10-05T14:00:00Z',timeZone:'America/New_York'});
 expect(outreachStepDue(plan,{channel:'email',channelOrdinal:2,lastTouch:{ordinal:1,at:'2026-10-09T14:00:00Z'}})?.dueAt).toBe('2026-10-12T14:00:00.000Z');
 expect(outreachStepDue(plan,{channel:'email',channelOrdinal:5,lastTouch:{ordinal:4,at:'2026-10-23T14:00:00Z'}})).toBeNull();
});
it('maps the real sequence call_task channel to the frozen phone slot',()=>{
 const plan=buildOutreachCadence({lane:'call_first',startsAt:'2026-10-05T14:00:00Z',timeZone:'America/New_York'});
 expect(outreachStepDue(plan,{channel:'call_task',channelOrdinal:1,lastTouch:null})?.dueAt).toBe('2026-10-05T14:00:00.000Z');
});

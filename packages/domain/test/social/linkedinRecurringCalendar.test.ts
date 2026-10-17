import {it,expect} from 'vitest';
import {linkedinRecurringDay} from '../../social/linkedinRecurringCalendar.ts';
it.each([
 ['2026-03-05T14:30:00Z','2026-03-05T15:00:00.000Z'],
 ['2026-03-10T13:30:00Z','2026-03-10T14:00:00.000Z'],
 ['2026-10-29T13:30:00Z','2026-10-29T14:00:00.000Z'],
 ['2026-11-03T14:30:00Z','2026-11-03T15:00:00.000Z'],
 ['2026-12-31T14:30:00Z','2026-12-31T15:00:00.000Z'],
] as const)('controlled scheduling calendar %s keeps exact NY10 across DST/month/year', (at,target)=>{
 expect(linkedinRecurringDay(at)).toEqual({targetAt:target,preparing:true,missed:false});
 expect(linkedinRecurringDay(new Date(Date.parse(at)-1).toISOString())).toEqual({targetAt:target,preparing:false,missed:false});
 expect(linkedinRecurringDay(new Date(Date.parse(target)-1).toISOString())).toEqual({targetAt:target,preparing:true,missed:false});
 expect(linkedinRecurringDay(target)).toEqual({targetAt:target,preparing:false,missed:true});
 expect(linkedinRecurringDay(new Date(Date.parse(target)+300000).toISOString())).toEqual({targetAt:target,preparing:false,missed:true});
});
it('one public calendar week admits only Tuesday/Thursday, never weekend/nextday/catch-up',()=>{
 const days=Array.from({length:7},(_,i)=>linkedinRecurringDay(new Date(Date.UTC(2026,10,2+i,14,30)).toISOString()));expect(days.filter(d=>d?.preparing).map(d=>d!.targetAt)).toEqual(['2026-11-03T15:00:00.000Z','2026-11-05T15:00:00.000Z']);expect(linkedinRecurringDay('invalid')).toBeNull();
});

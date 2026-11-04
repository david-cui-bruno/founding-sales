import {it,expect} from 'vitest';
import {standingWeek,standingWeekSlots} from '../../social/standingCadence.ts';
it('uses owner-local Monday week boundaries across midnight and year changes',()=>{
 expect(standingWeek(new Date('2026-11-02T04:30:00Z'),'America/New_York')).toBe('2026-10-26');
 expect(standingWeek(new Date('2026-11-02T05:00:00Z'),'America/New_York')).toBe('2026-11-02');
 expect(standingWeek(new Date('2027-01-01T12:00:00Z'),'Asia/Tokyo')).toBe('2026-12-28');
});
it('omits nonexistent local DST times rather than silently moving them and uses first repeated instant',()=>{
 const spring=standingWeekSlots(new Date('2026-03-02T12:00:00Z'),{timezone:'America/New_York',cadence:[{weekday:7,time:'02:30'},{weekday:7,time:'03:30'},{weekday:1,time:'10:00'}]});
 expect(spring.map(s=>s.publishAt.toISOString())).toEqual(['2026-03-02T15:00:00.000Z','2026-03-08T07:30:00.000Z']);
 const fall=standingWeekSlots(new Date('2026-10-26T12:00:00Z'),{timezone:'America/New_York',cadence:[{weekday:7,time:'01:30'},{weekday:1,time:'10:00'},{weekday:3,time:'10:00'}]});
 expect(fall.at(-1)?.publishAt.toISOString()).toBe('2026-11-01T05:30:00.000Z');
 expect(new Set(fall.map(s=>s.ordinal)).size).toBe(3);
});

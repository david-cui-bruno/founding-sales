import {it,expect} from 'vitest';import {socialScheduleInstants} from '../src/renderer/social/scheduleTime.ts';
it('requires a choice for repeated fall-back times and refuses spring-forward gaps',()=>{
 expect(socialScheduleInstants('2026-11-01T01:30','America/New_York').map(v=>v.instant)).toEqual(['2026-11-01T05:30:00.000Z','2026-11-01T06:30:00.000Z']);
 expect(socialScheduleInstants('2026-03-08T02:30','America/New_York')).toEqual([]);
 expect(socialScheduleInstants('2026-10-06T12:00','America/New_York').map(v=>v.instant)).toEqual(['2026-10-06T16:00:00.000Z']);
 expect(socialScheduleInstants('2026-02-30T12:00','America/New_York')).toEqual([]);
});

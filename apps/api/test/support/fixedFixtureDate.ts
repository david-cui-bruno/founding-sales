import {afterEach,beforeEach,vi} from 'vitest';

/** Explicit per-file fixture time. Timers, PostgreSQL leases and queue claims stay real. */
export function fixedFixtureDate(at='2026-10-13T17:00:00Z'){
 beforeEach(()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(at));});
 afterEach(()=>{vi.useRealTimers();});
}

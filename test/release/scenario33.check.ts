import { describe, expect, it } from 'vitest';
import { RAMP_ADMIN_RAISE_LIMIT, RAMP_HARD_CEILING, RAMP_SCHEDULE, RAMP_SETTLED_CAP } from '@fss/domain/outbound';
import { mustCover } from './support/coverage.ts';

/**
 * Appendix G 33: "Many contacts at one firm are due the same day; each has one active
 * enrollment, mailbox caps hold the excess, and one reply stops all."
 *
 * Three suites divide it: the sequences suite enrols three contacts at one firm and
 * asserts three distinct enrollments and one terminal stop consuming all of them, the
 * outbound suite drives the mailbox cap until it holds, and the Today suite asserts
 * the five due contacts collapse into one firm card with aggregate counts. This check
 * adds the ramp table those caps come from, because the number that makes the
 * scenario bite is a product decision written in one place.
 *
 * ## The vacuous-pass trap
 *
 * A cap set high enough for every contact in the fixture never holds anything: the
 * suite sends five emails, nothing is refused, and "the excess is held" is vacuously
 * true of an empty excess. The lane test closes it by setting the ramp so the cap is
 * below the number of due contacts. The trap this file closes is the schedule
 * quietly starting at a number no fixture will ever reach — raise the first rung to
 * fifty and every existing test still passes while the reputation ramp stops
 * existing.
 */

describe('Appendix G 33: the ramp starts small enough to hold a busy firm', () => {
  mustCover(33, ['Appendix G 33', 'daily_cap', 'enrollmentsStopped']);

  it('opens at five a day and climbs monotonically to the settled cap', () => {
    expect(RAMP_SCHEDULE.length).toBeGreaterThan(0);
    expect(RAMP_SCHEDULE[0]?.cap).toBe(5);
    // Five is below the number of contacts a single firm plausibly has, which is
    // what makes the held-excess case reachable at all rather than theoretical.
    expect(RAMP_SCHEDULE[0]?.cap).toBeLessThan(RAMP_SETTLED_CAP);

    let previousDay = 0;
    let previousCap = 0;
    for (const rung of RAMP_SCHEDULE) {
      expect(rung.throughDay, 'the schedule runs backwards').toBeGreaterThan(previousDay);
      expect(rung.cap, 'the schedule steps down').toBeGreaterThan(previousCap);
      previousDay = rung.throughDay;
      previousCap = rung.cap;
    }
    expect(RAMP_SETTLED_CAP).toBeGreaterThan(previousCap);
  });

  it('keeps the admin’s reach below the hard ceiling', () => {
    // 12.7: an admin may raise a mailbox to 75, and version one has a hard ceiling of
    // 100. If the raise limit ever reached the ceiling the cap would stop being a
    // ramp and start being a formality.
    expect(RAMP_SETTLED_CAP).toBeLessThan(RAMP_ADMIN_RAISE_LIMIT);
    expect(RAMP_ADMIN_RAISE_LIMIT).toBeLessThan(RAMP_HARD_CEILING);
  });
});

import { describe, expect, it } from 'vitest';
import {
  FOCUS_REFRESH_AFTER_MS,
  lanesKey,
  latestRollover,
  refreshDue,
  refreshFailed,
  updatedLine,
} from '../src/renderer/todayView.ts';
import type { TodayState } from '../src/renderer/todayContract.ts';

/**
 * Keeping Today current (lane g84, audit item G05): when Home reads the list again by
 * itself, and the line that says how old the list on screen is. Pure functions of a
 * clock, so every boundary is a value here — including the two Sundays a year when the
 * business zone's 05:00 is not five hours after UTC's midnight plus four.
 */

const at = (instant: string): number => Date.parse(instant);
const NEW_YORK = 'America/New_York';

const state = (overrides: Partial<TodayState> = {}): TodayState => ({
  snapshotDate: '2026-09-21',
  businessTimeZone: NEW_YORK,
  cards: [],
  expanded: null,
  online: true,
  stale: false,
  asOf: '2026-09-21T13:00:00.000Z',
  mayMutate: true,
  role: 'admin',
  notice: null,
  handoffNotice: 'Once a call is handed to the phone app, Callie cannot recall it.',
  ...overrides,
});

describe('the "Updated" line', () => {
  it('says just now, then minutes, then hours', () => {
    const asOf = '2026-09-21T13:00:00.000Z';
    expect(updatedLine(asOf, at('2026-09-21T13:00:59.000Z'))).toBe('Updated just now');
    expect(updatedLine(asOf, at('2026-09-21T13:01:00.000Z'))).toBe('Updated 1 min ago');
    expect(updatedLine(asOf, at('2026-09-21T13:59:59.000Z'))).toBe('Updated 59 min ago');
    expect(updatedLine(asOf, at('2026-09-21T14:00:00.000Z'))).toBe('Updated 1 hour ago');
    expect(updatedLine(asOf, at('2026-09-21T20:30:00.000Z'))).toBe('Updated 7 hours ago');
    expect(updatedLine(asOf, at('2026-09-22T13:00:00.000Z'))).toBe('Updated more than a day ago');
  });

  it('never says the future, and says nothing without a list', () => {
    expect(updatedLine('2026-09-21T13:00:05.000Z', at('2026-09-21T13:00:00.000Z'))).toBe('Updated just now');
    expect(updatedLine(null, at('2026-09-21T13:00:00.000Z'))).toBeNull();
  });
});

describe('the business day rollover', () => {
  it('is 05:00 and 05:10 in the business zone', () => {
    // 04:59 EDT: the last rollover was yesterday's second look.
    expect(latestRollover(at('2026-09-22T08:59:00.000Z'), NEW_YORK)).toBe(at('2026-09-21T09:10:00.000Z'));
    expect(latestRollover(at('2026-09-22T09:00:00.000Z'), NEW_YORK)).toBe(at('2026-09-22T09:00:00.000Z'));
    expect(latestRollover(at('2026-09-22T09:09:59.000Z'), NEW_YORK)).toBe(at('2026-09-22T09:00:00.000Z'));
    expect(latestRollover(at('2026-09-22T15:00:00.000Z'), NEW_YORK)).toBe(at('2026-09-22T09:10:00.000Z'));
  });

  it('follows the zone across a daylight-saving change', () => {
    // 1 November 2026: New York is back on EST, so 05:00 is 10:00 UTC, not 09:00.
    expect(latestRollover(at('2026-11-01T09:30:00.000Z'), NEW_YORK)).toBe(at('2026-10-31T09:10:00.000Z'));
    expect(latestRollover(at('2026-11-01T10:00:00.000Z'), NEW_YORK)).toBe(at('2026-11-01T10:00:00.000Z'));
    expect(latestRollover(at('2026-09-22T12:30:00.000Z'), 'America/Los_Angeles')).toBe(at('2026-09-22T12:10:00.000Z'));
  });

  it('is null for a zone this Mac does not know', () => {
    expect(latestRollover(at('2026-09-22T09:00:00.000Z'), 'Mars/Olympus_Mons')).toBeNull();
  });
});

describe('when Home reads the list again by itself', () => {
  const read = at('2026-09-21T13:00:00.000Z');

  it('on focus, once the last read is a minute old', () => {
    expect(refreshDue({ trigger: 'focus', now: read + FOCUS_REFRESH_AFTER_MS - 1, lastAttempt: read, zone: NEW_YORK })).toBe(false);
    expect(refreshDue({ trigger: 'focus', now: read + FOCUS_REFRESH_AFTER_MS, lastAttempt: read, zone: NEW_YORK })).toBe(true);
  });

  it('never on the tick alone, only once a rollover has passed since the last read', () => {
    expect(refreshDue({ trigger: 'tick', now: read + 6 * 60 * 60 * 1000, lastAttempt: read, zone: NEW_YORK })).toBe(false);
    const evening = at('2026-09-21T23:00:00.000Z');
    expect(refreshDue({ trigger: 'tick', now: at('2026-09-22T08:59:30.000Z'), lastAttempt: evening, zone: NEW_YORK })).toBe(false);
    expect(refreshDue({ trigger: 'tick', now: at('2026-09-22T09:00:10.000Z'), lastAttempt: evening, zone: NEW_YORK })).toBe(true);
    // Read at 05:00:10, the 05:10 look reads once more, and then nothing until tomorrow.
    const first = at('2026-09-22T09:00:10.000Z');
    expect(refreshDue({ trigger: 'tick', now: at('2026-09-22T09:10:20.000Z'), lastAttempt: first, zone: NEW_YORK })).toBe(true);
    const second = at('2026-09-22T09:10:20.000Z');
    expect(refreshDue({ trigger: 'tick', now: at('2026-09-22T20:00:00.000Z'), lastAttempt: second, zone: NEW_YORK })).toBe(false);
  });

  it('on the first tick after a Mac wakes from a night asleep', () => {
    expect(refreshDue({ trigger: 'tick', now: at('2026-09-22T12:45:00.000Z'), lastAttempt: at('2026-09-21T22:00:00.000Z'), zone: NEW_YORK })).toBe(true);
  });

  it('whenever it has never asked', () => {
    expect(refreshDue({ trigger: 'tick', now: read, lastAttempt: null, zone: NEW_YORK })).toBe(true);
  });
});

describe('what a read changes on screen', () => {
  it('leaves the lanes alone when only the read time moved', () => {
    expect(lanesKey(state())).toBe(lanesKey(state({ asOf: '2026-09-21T13:05:00.000Z' })));
    expect(lanesKey(state())).not.toBe(lanesKey(state({ stale: true })));
    expect(lanesKey(state())).not.toBe(lanesKey(state({ snapshotDate: '2026-09-22' })));
    expect(lanesKey(null)).toBe('null');
  });

  it('calls a read failed when the session fell back to the cache, was offline, or has no list', () => {
    expect(refreshFailed(state())).toBe(false);
    expect(refreshFailed(state({ stale: true }))).toBe(true);
    expect(refreshFailed(state({ online: false }))).toBe(true);
    expect(refreshFailed(state({ asOf: null }))).toBe(true);
  });
});

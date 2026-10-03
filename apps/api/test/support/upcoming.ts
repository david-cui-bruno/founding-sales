/**
 * A meeting time that stays in the future (lane M1): `days` after today's UTC midnight, at
 * `hour:minute` UTC, as an ISO instant. The suggestion to move a deal to Demo booked, and
 * anything else that compares a meeting with the clock, reads the database's `now()`, so a
 * test that needs an upcoming meeting must not name a calendar date that will pass. Computed
 * once per file load; the offsets are whole days, so a run is never close to the edge.
 */
const DAY_MS = 86_400_000;
const TODAY = Math.floor(Date.now() / DAY_MS) * DAY_MS;

export function upcoming(days: number, hour: number, minute = 0): string {
  return new Date(TODAY + days * DAY_MS + (hour * 60 + minute) * 60_000).toISOString();
}

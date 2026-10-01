import type { MeetingState } from '@fss/contracts';

/** A meeting's state, as the firm page and the bookings list say it (slice M1). */
export const MEETING_STATE_WORDS: Readonly<Record<MeetingState, string>> = Object.freeze({
  booked: 'Booked',
  rescheduled: 'Rescheduled',
  cancelled: 'Cancelled',
  held: 'Held',
  no_show: 'No-show',
});

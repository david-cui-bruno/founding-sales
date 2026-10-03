/**
 * A meeting's state, as the firm page, the bookings list and the board card say it (slice M1).
 *
 * Keyed by the state as it arrives on the wire, not by `MeetingState` (lane M1, B0): a
 * newer server may answer with a state this build has never heard of, and that must read as
 * a meeting rather than break the screen or show a code. `ended` is here before the server
 * writes it (migration 0039): Cal.com said the scheduled end passed, nobody confirmed who
 * came.
 */
const MEETING_STATE_WORDS: Readonly<Record<string, string>> = Object.freeze({
  booked: 'Booked',
  rescheduled: 'Rescheduled',
  cancelled: 'Cancelled',
  ended: 'Ended',
  held: 'Held',
  no_show: 'No-show',
});

/** What a state the build does not know reads as. */
export const UNKNOWN_MEETING_STATE_WORD = 'Meeting';

export function meetingStateWord(state: string): string {
  return Object.hasOwn(MEETING_STATE_WORDS, state) ? (MEETING_STATE_WORDS[state] ?? UNKNOWN_MEETING_STATE_WORD) : UNKNOWN_MEETING_STATE_WORD;
}

/** The states shown in the warning tone. Anything else, an unknown state included, is neutral. */
export function meetingStateWarns(state: string): boolean {
  return state === 'cancelled' || state === 'no_show';
}

/**
 * The firm page's row word (lane M1): `ended` says what is missing — Cal.com's end is the
 * scheduled end, and nobody has confirmed who came. Every other state is its plain word.
 */
export function meetingRowWord(state: string): string {
  return state === 'ended' ? 'Ended · attendance not confirmed' : meetingStateWord(state);
}

/** The board card's shorter form of the same (lane M1). */
export function meetingCardWord(state: string): string {
  return state === 'ended' ? 'Ended, not confirmed' : meetingStateWord(state);
}

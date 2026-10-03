import { meeting, type CallToBookingFixture } from './callToBookingCases.ts';

/**
 * A failing insert for every constraint migration 0040 adds (lane M2): the booking details on
 * `meetings`. Each case breaks exactly one constraint, inside the transaction the caller
 * rolls back. No real person: the meeting helper's addresses are `.example`.
 */

/** Details carry the source time that set them (review M2R): every case sets it, so only its own constraint breaks. */
const OBSERVED = { details_observed_at: '2026-10-01T12:00:00.000Z' };

interface Case {
  readonly constraint: string;
  readonly run: (fixture: CallToBookingFixture) => Promise<unknown>;
}

export const MEETING_BOOKING_DETAILS_CONSTRAINT_CASES: readonly Case[] = [
  { constraint: 'meetings_event_title_bounded', run: async f => await meeting(f, { ...OBSERVED, event_title: 'x'.repeat(301) }) },
  { constraint: 'meetings_attendee_name_bounded', run: async f => await meeting(f, { ...OBSERVED, attendee_name: '' }) },
  { constraint: 'meetings_booking_notes_bounded', run: async f => await meeting(f, { ...OBSERVED, booking_notes: 'n'.repeat(4001) }) },
  // An answer that is not text.
  { constraint: 'meetings_booking_answers_shape', run: async f => await meeting(f, { ...OBSERVED, booking_answers: JSON.stringify({ 'How many doors?': 40 }) }) },
  { constraint: 'meetings_location_type_bounded', run: async f => await meeting(f, { ...OBSERVED, location_type: 'l'.repeat(81) }) },
  // A join URL with its passcode: the query is never stored.
  {
    constraint: 'meetings_video_call_url_shape',
    run: async f => await meeting(f, { ...OBSERVED, video_call_url: 'https://us06web.zoom.us/j/81234567890?pwd=abc' }),
  },
  // A source time with no details, and details with no source time.
  { constraint: 'meetings_details_observed', run: async f => await meeting(f, { ...OBSERVED }) },
  { constraint: 'meetings_details_observed', run: async f => await meeting(f, { event_title: 'Callie demo' }) },
  { constraint: 'meetings_zoom_meeting_id_shape', run: async f => await meeting(f, { ...OBSERVED, zoom_meeting_id: '8123-4567' }) },
];

import { z } from 'zod';
import { instant, uuid } from './foundationRows.ts';

/**
 * Meetings, as the board and later the firm page read them (call-to-booking slice W,
 * migration 0028). Cal.com owns the booking, its reminders and its calendar invite; the
 * CRM records the booking's state and moves the pipeline on it.
 */

export const MEETING_STATES = ['booked', 'rescheduled', 'cancelled', 'held', 'no_show'] as const;
export type MeetingState = (typeof MEETING_STATES)[number];

/** The Cal.com webhook triggers the CRM applies. Any other trigger is recorded `ignored`. */
export const CALCOM_APPLIED_TRIGGERS = [
  'BOOKING_CREATED',
  'BOOKING_RESCHEDULED',
  'BOOKING_CANCELLED',
  'MEETING_ENDED',
  'BOOKING_NO_SHOW_UPDATED',
] as const;
export type CalcomAppliedTrigger = (typeof CALCOM_APPLIED_TRIGGERS)[number];

/** Cal.com's documented signature header: hex HMAC-SHA256 of the raw body. */
export const CALCOM_SIGNATURE_HEADER = 'x-cal-signature-256';

export const meetingDtoSchema = z.object({
  meetingId: uuid,
  state: z.enum(MEETING_STATES),
  startsAt: instant,
  endsAt: instant,
});
export type MeetingDto = z.infer<typeof meetingDtoSchema>;

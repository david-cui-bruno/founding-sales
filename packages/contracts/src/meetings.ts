import { z } from 'zod';
import { commandIdSchema } from './auth.ts';
import { semanticVersionSchema } from './clientVersion.ts';
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

// ---------------------------------------------------------------------------
// Slice M1: the firm page's meetings, the bookings to match, and the match command.
// ---------------------------------------------------------------------------

/** A meeting as the firm page lists it: its state and its time. Strict: nothing else. */
export const firmMeetingDtoSchema = z.strictObject({
  meetingId: uuid,
  state: z.enum(MEETING_STATES),
  startsAt: instant,
  endsAt: instant,
});
export type FirmMeetingDto = z.infer<typeof firmMeetingDtoSchema>;

/** `GET /meetings/firm?firmId=` — the firm's meetings, newest start first. */
export const firmMeetingsResponseSchema = z.strictObject({ meetings: z.array(firmMeetingDtoSchema) });

/**
 * A booking Callie could not attach to a firm by itself (`firm_unmatched` /
 * `firm_ambiguous`): who booked it and when, so a person can pick the firm.
 */
export const unmatchedMeetingDtoSchema = z.strictObject({
  meetingId: uuid,
  state: z.enum(MEETING_STATES),
  startsAt: instant,
  endsAt: instant,
  attendeeEmail: z.string().max(320).nullable(),
  reason: z.enum(['firm_unmatched', 'firm_ambiguous']).nullable(),
});
export type UnmatchedMeetingDto = z.infer<typeof unmatchedMeetingDtoSchema>;

/** `GET /meetings/unmatched` — at most fifty, soonest first. */
export const unmatchedMeetingsResponseSchema = z.strictObject({ meetings: z.array(unmatchedMeetingDtoSchema) });

/** What `POST /meetings/match` may refuse with. Each has a sentence in `reasonText.ts`. */
export const MEETING_MATCH_REFUSAL_CODES = [
  'meeting_unknown',
  'meeting_already_matched',
  'firm_unknown',
  'firm_merged',
  'not_assigned',
  'invalid_input',
] as const;
export type MeetingMatchRefusalCode = (typeof MEETING_MATCH_REFUSAL_CODES)[number];

/** `POST /meetings/match { meetingId, firmId }`: attach an unmatched booking to a firm. */
export const matchMeetingCommandSchema = z.strictObject({
  commandId: commandIdSchema,
  clientVersion: semanticVersionSchema,
  meetingId: uuid,
  firmId: uuid,
});

export const meetingMatchedSchema = z.strictObject({
  meetingId: uuid,
  firmId: uuid,
  contactId: uuid.nullable(),
  state: z.enum(MEETING_STATES),
  /** What the booked evidence did: `none` for a cancelled meeting, which owes nothing. */
  stage: z.enum(['moved', 'opened', 'unchanged', 'review', 'none']),
});
export type MeetingMatched = z.infer<typeof meetingMatchedSchema>;

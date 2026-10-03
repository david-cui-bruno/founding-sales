import { z } from 'zod';
import { commandIdSchema } from './auth.ts';
import { semanticVersionSchema } from './clientVersion.ts';
import { instant, uuid } from './foundationRows.ts';

/**
 * Meetings, as the board and later the firm page read them (call-to-booking slice W,
 * migration 0028). Cal.com owns the booking, its reminders and its calendar invite; the
 * CRM records the booking's state and moves the pipeline on it.
 */

/**
 * `ended` (lane M1, migration 0039): the scheduled end passed and nobody has confirmed who
 * came — what Cal.com's `MEETING_ENDED` means. `held` is confirmed attendance only, and
 * `no_show` confirmed absence (Cal.com's no-show flag, or a person).
 */
export const MEETING_STATES = ['booked', 'rescheduled', 'cancelled', 'ended', 'held', 'no_show'] as const;
export type MeetingState = (typeof MEETING_STATES)[number];

/** How attendance was confirmed (0039). Null on a meeting while it is unconfirmed. */
export const MEETING_ATTENDANCE_SOURCES = ['manual', 'calcom_no_show', 'recording'] as const;
export type MeetingAttendanceSource = (typeof MEETING_ATTENDANCE_SOURCES)[number];

/**
 * A meeting state as a READER accepts it (lane M1, B0): one of `MEETING_STATES`, or a state
 * a newer server added. Every answer the Mac parses carries the state through this rather
 * than through `z.enum(MEETING_STATES)`, because a strict enum made one unknown state fail
 * the whole board read: migration 0039 adds `ended`, and the desktop that is installed when
 * the server first answers with it must still show the board and the firm's meetings. A
 * state the reader does not know is shown neutrally ("Meeting"), never as its code.
 *
 * Bounded to the shape a state has (lower-case words joined by `_`), so the field cannot
 * carry text. The server writes only `MEETING_STATES`; the database CHECK is the list.
 */
export const MEETING_STATE_WIRE_SHAPE = /^[a-z][a-z_]{0,31}$/u;
export const meetingStateWireSchema = z.string().regex(MEETING_STATE_WIRE_SHAPE);

/** Whether a state read off the wire is one this build knows. */
export function isKnownMeetingState(state: string): state is MeetingState {
  return (MEETING_STATES as readonly string[]).includes(state);
}

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
  state: meetingStateWireSchema,
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
  state: meetingStateWireSchema,
  startsAt: instant,
  endsAt: instant,
  /**
   * How the meeting's attendance was confirmed, null while unconfirmed (lane M1, migration
   * 0039: `manual`, `calcom_no_show`, later `recording`). Declared before the server sends it,
   * optional and of the code shape, so the desktop released ahead of 0039 parses the answer
   * the server sends after it.
   */
  attendanceSource: meetingStateWireSchema.nullable().optional(),
});
export type FirmMeetingDto = z.infer<typeof firmMeetingDtoSchema>;

/**
 * A stage move Callie suggests and a person makes with one click (lane M1: a booking no
 * longer moves a deal by itself). `opportunityId` is the open deal to move, or null when the
 * firm has none and the click opens one at the stage. Not strict: a later field is ignored.
 */
export const stageSuggestionSchema = z.object({
  stageKey: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/u),
  opportunityId: uuid.nullable(),
});
export type StageSuggestion = z.infer<typeof stageSuggestionSchema>;

/** `GET /meetings/firm?firmId=` — the firm's meetings, newest start first. */
export const firmMeetingsResponseSchema = z.strictObject({
  meetings: z.array(firmMeetingDtoSchema),
  /** Lane M1: "Move to Demo booked" for a live booking, declared ahead of the server (above). */
  stageSuggestion: stageSuggestionSchema.nullable().optional(),
});

/**
 * A booking Callie could not attach to a firm by itself (`firm_unmatched` /
 * `firm_ambiguous`): who booked it and when, so a person can pick the firm.
 */
export const unmatchedMeetingDtoSchema = z.strictObject({
  meetingId: uuid,
  state: meetingStateWireSchema,
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
  state: meetingStateWireSchema,
  /** What the booked evidence did: `none` for a cancelled meeting, which owes nothing. */
  stage: z.enum(['moved', 'opened', 'unchanged', 'review', 'none']),
});
export type MeetingMatched = z.infer<typeof meetingMatchedSchema>;

// ---------------------------------------------------------------------------
// Lane M1: a person confirms attendance (`POST /meetings/attendance`).
// ---------------------------------------------------------------------------

/**
 * `attended` → `held`; `no_show` → `no_show`; `unconfirmed` undoes a person's confirmation,
 * back to `ended`. Never a Cal.com no-show: that is refused with its own reason.
 */
export const MEETING_ATTENDANCE_CHOICES = ['attended', 'no_show', 'unconfirmed'] as const;
export type MeetingAttendanceChoice = (typeof MEETING_ATTENDANCE_CHOICES)[number];

export const setMeetingAttendanceCommandSchema = z.strictObject({
  commandId: commandIdSchema,
  clientVersion: semanticVersionSchema,
  meetingId: uuid,
  attendance: z.enum(MEETING_ATTENDANCE_CHOICES),
});

/** What `POST /meetings/attendance` may refuse with. Each has a sentence in `reasonText.ts`. */
export const MEETING_ATTENDANCE_REFUSAL_CODES = [
  'meeting_unknown',
  'meeting_unmatched',
  'meeting_cancelled',
  'meeting_not_started',
  'attendance_from_calcom',
  'attendance_from_recording',
  'firm_unknown',
  'firm_merged',
  'not_assigned',
  'invalid_input',
] as const;
export type MeetingAttendanceRefusalCode = (typeof MEETING_ATTENDANCE_REFUSAL_CODES)[number];

export const meetingAttendanceSetSchema = z.strictObject({
  meetingId: uuid,
  state: meetingStateWireSchema,
  attendanceSource: meetingStateWireSchema.nullable(),
});
export type MeetingAttendanceSet = z.infer<typeof meetingAttendanceSetSchema>;

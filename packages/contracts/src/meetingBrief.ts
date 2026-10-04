import { z } from 'zod';
import { instant, uuid } from './foundationRows.ts';
import { meetingStateWireSchema } from './meetings.ts';

/**
 * The meeting brief (lane M2): what Callie already knows about a firm, gathered for one
 * meeting — the reason for the demo, the firm's research, the previous conversations, the
 * objections and the open commitments. Assembled on read from stored data; no model is
 * called. `GET /meetings/brief?meetingId=`, for the people who may read the firm page in
 * full (the assignee or an administrator).
 *
 * Every item names its source and its date, and how far it can be trusted:
 *
 *   * `stated` — the booker's own words on the booking form;
 *   * `observed` — a verbatim quote from a call transcript or a research page, or a record
 *     (a logged outcome, an e-mail's subject);
 *   * `inferred` — a model's summary or next step;
 *   * `unverified` — prepared research, "not verified by Callie".
 */

export const MEETING_BRIEF_SOURCES = [
  'booking_notes',
  'booking_answer',
  'call_signal',
  'call_next_step',
  'prepared_brief',
  'research_fact',
  'call',
  'email_thread',
  'call_objection',
  'call_commitment',
  'meeting_task',
] as const;
export type MeetingBriefSource = (typeof MEETING_BRIEF_SOURCES)[number];

export const MEETING_BRIEF_PROVENANCES = ['stated', 'observed', 'inferred', 'unverified'] as const;
export type MeetingBriefProvenance = (typeof MEETING_BRIEF_PROVENANCES)[number];

/** The most items one section carries; the desktop shows fewer and offers "Show more". */
export const MEETING_BRIEF_SECTION_MAX = 12;

/** A date: an instant, or a calendar day (`YYYY-MM-DD`) for a source dated by day only. */
const briefDate = z.union([instant, z.iso.date()]);

export const meetingBriefItemSchema = z.strictObject({
  /** A short label: a question, an outcome, an objection's category, who committed. */
  label: z.string().min(1).max(200).nullable(),
  text: z.string().min(1).max(1_200),
  source: z.enum(MEETING_BRIEF_SOURCES),
  provenance: z.enum(MEETING_BRIEF_PROVENANCES),
  /** When it was said, observed or recorded; null when the source carries no date. */
  at: briefDate.nullable(),
  /** The page a research fact or a prepared brief cites, when it has one. */
  sourceUrl: z.string().max(2_048).nullable(),
});
export type MeetingBriefItem = z.infer<typeof meetingBriefItemSchema>;

export const meetingBriefSectionSchema = z.strictObject({
  items: z.array(meetingBriefItemSchema).max(MEETING_BRIEF_SECTION_MAX),
  /** How many more the sources hold beyond `items`. */
  omitted: z.number().int().min(0),
});
export type MeetingBriefSection = z.infer<typeof meetingBriefSectionSchema>;

export const MEETING_BRIEF_SECTION_KEYS = ['whyThisDemo', 'firm', 'conversations', 'objections', 'commitments'] as const;
export type MeetingBriefSectionKey = (typeof MEETING_BRIEF_SECTION_KEYS)[number];

/** `GET /meetings/brief?meetingId=`. */
export const meetingBriefResponseSchema = z.strictObject({
  meetingId: uuid,
  firmId: uuid,
  meeting: z.strictObject({
    title: z.string().min(1).max(300).nullable(),
    attendeeName: z.string().min(1).max(200).nullable(),
    state: meetingStateWireSchema,
    startsAt: instant,
    endsAt: instant,
    /** Cal.com's location type (`zoom_video`, `integrations:…`, `link`, `other`). */
    locationType: z.string().min(1).max(80).nullable(),
  }),
  sections: z.strictObject({
    whyThisDemo: meetingBriefSectionSchema,
    firm: meetingBriefSectionSchema,
    conversations: meetingBriefSectionSchema,
    objections: meetingBriefSectionSchema,
    commitments: meetingBriefSectionSchema,
  }),
  generatedAt: instant,
});
export type MeetingBriefResponse = z.infer<typeof meetingBriefResponseSchema>;

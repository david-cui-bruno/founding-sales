/**
 * What a booking tells us besides its times (lane M2, migration 0041): the title, the
 * attendee's name, the notes, the booking form's answers, where it happens and — for M3 —
 * the Zoom meeting id. Read from both of Cal.com's shapes:
 *
 *   * the webhook payload (`parseWebhookBookingDetails`), Cal.com's webhook reference
 *     (https://cal.com/docs/developing/guides/automation/webhooks): `title`,
 *     `attendees[].name`, `additionalNotes` / `description`, `responses`
 *     (`{ <field>: { label, value, isHidden } }`), `location`, `videoCallData`
 *     (`{ type, id, password, url }`) and `metadata.videoCallUrl`. `MEETING_ENDED` is flat
 *     and carries `title`, `description`, `responses`, `location` and `attendees`;
 *     `BOOKING_NO_SHOW_UPDATED` carries none of them.
 *   * an API v2 booking (`parseApiBookingDetails`), the reconciliation's read
 *     (https://cal.com/docs/api-reference/v2/bookings/get-all-bookings): `title`,
 *     `attendees[].name`, `description`, `bookingFieldsResponses` (`{ <slug>: value }`),
 *     `location` and the deprecated `meetingUrl`. It has no `videoCallData`: a Zoom
 *     meeting's id is read from its join URL.
 *
 * The Zoom app's adapter returns `{ type: 'zoom_video', id: String(zoom.id), password,
 * url: zoom.join_url }` as `videoCallData`
 * (https://github.com/calcom/cal.com/blob/main/packages/app-store/zoomvideo/lib/VideoApiAdapter.ts).
 *
 * **Never stored:** `videoCallData.password`, and the query and fragment of a video-call
 * URL (a Zoom join URL carries the passcode as `?pwd=`). Nor the booker's name, address,
 * phone number, guests, location choice or reschedule reason among the answers: the name
 * and address are stored once, in their own columns, and the rest are not needed.
 *
 * Every field is null when the payload does not say it; a null never overwrites a stored
 * value (`calcom.ts` writes `COALESCE(new, stored)`).
 */

export interface BookingDetails {
  readonly title: string | null;
  readonly attendeeName: string | null;
  readonly notes: string | null;
  /** Question → answer, text only, bounded (`boundAnswers`). Null when there is none. */
  readonly answers: Readonly<Record<string, string>> | null;
  readonly locationType: string | null;
  /** https only, without its query or fragment. */
  readonly videoCallUrl: string | null;
  /** Digits only. */
  readonly zoomMeetingId: string | null;
}

export const NO_BOOKING_DETAILS: BookingDetails = Object.freeze({
  title: null,
  attendeeName: null,
  notes: null,
  answers: null,
  locationType: null,
  videoCallUrl: null,
  zoomMeetingId: null,
});

/** The bounds (0041 checks the same ones, `meetings_booking_*`). */
export const BOOKING_TITLE_MAX = 300;
export const BOOKING_ATTENDEE_NAME_MAX = 200;
export const BOOKING_NOTES_MAX = 4000;
export const BOOKING_ANSWER_KEY_MAX = 200;
export const BOOKING_ANSWER_VALUE_MAX = 1000;
/** The answers' JSON text, in bytes. */
export const BOOKING_ANSWERS_MAX_BYTES = 8192;
export const BOOKING_LOCATION_TYPE_MAX = 80;
export const BOOKING_VIDEO_URL_MAX = 2048;

/**
 * Booking-form fields that are not answers: the booker's identity and contact (stored in
 * their own columns, or not at all), the guests, the location choice, the notes (their
 * own column) and the reschedule reason. Cal.com's default fields
 * (https://cal.com/docs/developing/guides/automation/webhooks, `responses`).
 */
const NOT_ANSWERS: ReadonlySet<string> = new Set([
  'name',
  'email',
  'attendeePhoneNumber',
  'smsReminderNumber',
  'guests',
  'location',
  'notes',
  'rescheduleReason',
]);

const record = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** Trimmed, control characters but newline and tab removed, cut at `max` characters. */
function bounded(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '').trim();
  if (cleaned.length === 0) return null;
  const characters = [...cleaned];
  return characters.length <= max ? cleaned : `${characters.slice(0, max - 1).join('')}…`;
}

/** An answer as text: a string, a number or a boolean, or a list of strings. Anything else is no answer. */
function answerText(value: unknown): string | null {
  if (typeof value === 'string') return bounded(value, BOOKING_ANSWER_VALUE_MAX);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value) && value.every(entry => typeof entry === 'string')) return bounded(value.join(', '), BOOKING_ANSWER_VALUE_MAX);
  return null;
}

/**
 * Bound a list of (question, answer) pairs: each answer at most 1,000 characters, each
 * question at most 200, and the whole JSON at most 8 KB — answers past the budget are left
 * out, in order. Null when nothing is left.
 */
export function boundAnswers(entries: readonly (readonly [string, string])[]): Readonly<Record<string, string>> | null {
  const kept: Record<string, string> = {};
  let count = 0;
  for (const [question, answer] of entries) {
    const key = bounded(question, BOOKING_ANSWER_KEY_MAX);
    const value = bounded(answer, BOOKING_ANSWER_VALUE_MAX);
    if (key === null || value === null || Object.hasOwn(kept, key)) continue;
    const next = { ...kept, [key]: value };
    if (Buffer.byteLength(JSON.stringify(next), 'utf8') > BOOKING_ANSWERS_MAX_BYTES) continue;
    kept[key] = value;
    count += 1;
  }
  return count === 0 ? null : kept;
}

/** An https URL, without its query and fragment (a Zoom join URL's `?pwd=` is its passcode). */
export function videoCallUrlOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null;
  url.search = '';
  url.hash = '';
  const text = url.toString();
  return text.length <= BOOKING_VIDEO_URL_MAX ? text : null;
}

const ZOOM_HOST = /(^|\.)zoom\.us$/u;
const ZOOM_PATH = /^\/(?:j|w|s|wc\/join)\/(\d{9,12})(?:[/?#]|$)/u;

/** The meeting id in a Zoom join URL (`https://<sub>.zoom.us/j/<id>`), or null. */
export function zoomMeetingIdOfUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !ZOOM_HOST.test(url.hostname)) return null;
  return ZOOM_PATH.exec(url.pathname)?.[1] ?? null;
}

const zoomIdOf = (value: unknown): string | null => {
  const textValue = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : typeof value === 'string' ? value.trim() : '';
  return /^\d{9,12}$/u.test(textValue) ? textValue : null;
};

/** A location that names an app (`integrations:zoom`), a link, or something else. */
function locationTypeOf(location: unknown, videoType: unknown, zoomMeetingId: string | null): string | null {
  const typed = bounded(videoType, BOOKING_LOCATION_TYPE_MAX);
  if (typed !== null) return typed;
  if (zoomMeetingId !== null) return 'zoom_video';
  const where = bounded(location, BOOKING_VIDEO_URL_MAX);
  if (where === null) return null;
  if (where.startsWith('integrations:')) return bounded(where, BOOKING_LOCATION_TYPE_MAX);
  return videoCallUrlOf(where) === null ? 'other' : 'link';
}

function withNulls(details: BookingDetails): BookingDetails | null {
  return Object.values(details).every(value => value === null) ? null : details;
}

/**
 * The details in a webhook delivery's booking (`payload`, or the top level of a flat
 * `MEETING_ENDED`). The attendee is the first, the one whose address the meeting keeps.
 */
export function parseWebhookBookingDetails(booking: Readonly<Record<string, unknown>>): BookingDetails | null {
  const attendees = Array.isArray(booking['attendees']) ? (booking['attendees'] as unknown[]).map(record) : [];
  const responses = record(booking['responses']);
  const video = record(booking['videoCallData']);
  const metadata = record(booking['metadata']);
  const location = booking['location'];
  const zoomMeetingId =
    (video['type'] === 'zoom_video' ? zoomIdOf(video['id']) : null) ??
    zoomMeetingIdOfUrl(video['url']) ??
    zoomMeetingIdOfUrl(metadata['videoCallUrl']) ??
    zoomMeetingIdOfUrl(location);
  const answers: [string, string][] = [];
  for (const [field, raw] of Object.entries(responses)) {
    if (NOT_ANSWERS.has(field)) continue;
    const response = record(raw);
    // A field the form did not show is not an answer; a bare value is (older payloads).
    const hidden = response['isHidden'] === true;
    const value = Object.hasOwn(response, 'value') ? response['value'] : typeof raw === 'object' && raw !== null ? undefined : raw;
    const answer = hidden ? null : answerText(value);
    if (answer === null) continue;
    const label = typeof response['label'] === 'string' && response['label'].trim().length > 0 ? response['label'] : field;
    answers.push([label, answer]);
  }
  const notesResponse = record(responses['notes']);
  return withNulls({
    title: bounded(booking['title'], BOOKING_TITLE_MAX),
    attendeeName: bounded(attendees[0]?.['name'], BOOKING_ATTENDEE_NAME_MAX),
    notes:
      bounded(booking['additionalNotes'], BOOKING_NOTES_MAX) ??
      bounded(booking['description'], BOOKING_NOTES_MAX) ??
      bounded(notesResponse['value'], BOOKING_NOTES_MAX),
    answers: boundAnswers(answers),
    locationType: locationTypeOf(location, video['type'], zoomMeetingId),
    videoCallUrl: videoCallUrlOf(video['url']) ?? videoCallUrlOf(metadata['videoCallUrl']) ?? videoCallUrlOf(location),
    zoomMeetingId,
  });
}

/** The details in one API v2 booking (the reconciliation's read). */
export function parseApiBookingDetails(booking: Readonly<Record<string, unknown>>): BookingDetails | null {
  const attendees = Array.isArray(booking['attendees']) ? (booking['attendees'] as unknown[]).map(record) : [];
  const responses = record(booking['bookingFieldsResponses']);
  const metadata = record(booking['metadata']);
  const location = booking['location'];
  const zoomMeetingId = zoomMeetingIdOfUrl(location) ?? zoomMeetingIdOfUrl(booking['meetingUrl']) ?? zoomMeetingIdOfUrl(metadata['videoCallUrl']);
  const answers: [string, string][] = [];
  for (const [slug, value] of Object.entries(responses)) {
    if (NOT_ANSWERS.has(slug)) continue;
    const answer = answerText(value);
    if (answer !== null) answers.push([slug, answer]);
  }
  return withNulls({
    title: bounded(booking['title'], BOOKING_TITLE_MAX),
    attendeeName: bounded(attendees[0]?.['name'], BOOKING_ATTENDEE_NAME_MAX),
    notes: bounded(responses['notes'], BOOKING_NOTES_MAX) ?? bounded(booking['description'], BOOKING_NOTES_MAX),
    answers: boundAnswers(answers),
    locationType: locationTypeOf(location, null, zoomMeetingId),
    videoCallUrl: videoCallUrlOf(location) ?? videoCallUrlOf(booking['meetingUrl']) ?? videoCallUrlOf(metadata['videoCallUrl']),
    zoomMeetingId,
  });
}

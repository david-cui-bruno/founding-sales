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
 * URL (a Zoom join URL carries the passcode as `?pwd=`). Nor, among the answers, Cal.com's
 * default contact fields (name, address, phone numbers, guests, location choice, reschedule
 * reason) or any question whose field or label names a phone, an e-mail, a name or an
 * address (`contactLike`, review M2R): the name and address are stored once, in their own
 * columns, and the rest are not needed.
 *
 * Every field is null when the payload does not say it. How a parse meets what is stored —
 * which source is newer, and what a named location clears — is `mergeBookingDetails`.
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
  /**
   * Whether the source names where the meeting is (a `location`, `videoCallData` or a video
   * URL). One that does describes all three conferencing fields; one that does not says
   * nothing about them (review M2R, finding 4).
   */
  readonly locationNamed: boolean;
}

export const NO_BOOKING_DETAILS: BookingDetails = Object.freeze({
  title: null,
  attendeeName: null,
  notes: null,
  answers: null,
  locationType: null,
  videoCallUrl: null,
  zoomMeetingId: null,
  locationNamed: false,
});

/** The bounds (0040 checks the same ones, `meetings_booking_*`). */
export const BOOKING_TITLE_MAX = 300;
export const BOOKING_ATTENDEE_NAME_MAX = 200;
export const BOOKING_NOTES_MAX = 4000;
export const BOOKING_ANSWER_KEY_MAX = 200;
export const BOOKING_ANSWER_VALUE_MAX = 1000;
/** The answers' text as PostgreSQL prints a jsonb object, in bytes: 0040's CHECK. */
export const BOOKING_ANSWERS_MAX_BYTES = 8192;
/** The writer's budget, under the CHECK by a margin (review M2R, finding 3). */
export const BOOKING_ANSWERS_BUDGET_BYTES = 8000;
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

/**
 * A question whose field or label names a way to reach a person, or a person's name (review
 * M2R, minor 7): not an answer. The question is split into lower-case words (camelCase,
 * snake_case, spaces and punctuation all split); it is contact-like when a word, or two
 * adjacent words joined, begins with one of `CONTACT_PREFIXES` (`phoneNumber`, `E-mail`,
 * `first_name`, `Street address`), is one of `CONTACT_WORDS`, or the whole question is `name`.
 * Word-wise, so "cancellation policy" is not a cell phone, and "the company's name" is kept.
 */
const CONTACT_PREFIXES: readonly string[] = [
  'phone',
  'mobile',
  'cellphone',
  'telephone',
  'email',
  'whatsapp',
  'sms',
  'address',
  'street',
  'zip',
  'postcode',
  'postal',
  'surname',
  'firstname',
  'lastname',
  'fullname',
  'yourname',
  'givenname',
  'familyname',
];
const CONTACT_WORDS: ReadonlySet<string> = new Set(['cell', 'tel', 'mail']);
export function contactLike(question: string): boolean {
  const words = question
    .replace(/([a-z])([A-Z])/gu, '$1 $2')
    .toLowerCase()
    .split(/[^a-z]+/u)
    .filter(word => word.length > 0);
  if (words.length === 1 && words[0] === 'name') return true;
  const tokens = [...words, ...words.slice(1).map((word, index) => `${words[index] ?? ''}${word}`)];
  return tokens.some(token => CONTACT_WORDS.has(token) || CONTACT_PREFIXES.some(prefix => token.startsWith(prefix)));
}

/** Keys that would reach an object's prototype; never an answer's question. */
const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

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

/** The bytes a string takes in PostgreSQL's jsonb text: JSON escaping, UTF-8. */
const jsonTextBytes = (text: string): number => Buffer.byteLength(JSON.stringify(text), 'utf8');

/**
 * The bytes `answers::text` takes in PostgreSQL: `{"k": "v", "k2": "v2"}` — a space after
 * each colon and comma, keys in any order (the length does not depend on it), the same
 * escaping as `JSON.stringify` for the text this module keeps (control characters but newline
 * and tab are removed first).
 */
export function jsonbTextBytes(answers: Readonly<Record<string, string>>): number {
  const entries = Object.entries(answers);
  if (entries.length === 0) return 2;
  return 2 + entries.reduce((sum, [key, value]) => sum + jsonTextBytes(key) + 2 + jsonTextBytes(value), 0) + 2 * (entries.length - 1);
}

/**
 * Bound a list of (question, answer) pairs: each answer at most 1,000 characters, each
 * question at most 200, and the whole at most `BOOKING_ANSWERS_BUDGET_BYTES` as PostgreSQL
 * prints it — answers past the budget are left out, in order. A question that is contact-like
 * or a prototype key is left out. Built on a null-prototype object. Null when nothing is left.
 */
export function boundAnswers(entries: readonly (readonly [string, string])[]): Readonly<Record<string, string>> | null {
  const kept: Record<string, string> = Object.create(null) as Record<string, string>;
  let count = 0;
  let bytes = 2;
  for (const [question, answer] of entries) {
    const key = bounded(question, BOOKING_ANSWER_KEY_MAX);
    const value = bounded(answer, BOOKING_ANSWER_VALUE_MAX);
    if (key === null || value === null || UNSAFE_KEYS.has(key) || contactLike(key) || Object.hasOwn(kept, key)) continue;
    const added = jsonTextBytes(key) + 2 + jsonTextBytes(value) + (count === 0 ? 0 : 2);
    if (bytes + added > BOOKING_ANSWERS_BUDGET_BYTES) continue;
    kept[key] = value;
    bytes += added;
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
  // Cal.com names Zoom `integrations:zoom` in `location` and `zoom_video` in videoCallData.
  if (where === 'integrations:zoom') return 'zoom_video';
  if (where.startsWith('integrations:')) return bounded(where, BOOKING_LOCATION_TYPE_MAX);
  return videoCallUrlOf(where) === null ? 'other' : 'link';
}

/** Whether the details carry nothing. */
export function detailsEmpty(details: BookingDetails): boolean {
  return (
    details.title === null &&
    details.attendeeName === null &&
    details.notes === null &&
    details.answers === null &&
    details.locationType === null &&
    details.videoCallUrl === null &&
    details.zoomMeetingId === null &&
    !details.locationNamed
  );
}

function withNulls(details: BookingDetails): BookingDetails | null {
  return detailsEmpty(details) ? null : details;
}

const named = (value: unknown): boolean => (typeof value === 'string' && value.trim().length > 0) || (typeof value === 'object' && value !== null);

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
    if (NOT_ANSWERS.has(field) || contactLike(field) || UNSAFE_KEYS.has(field)) continue;
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
    locationNamed: named(location) || Object.keys(video).length > 0 || named(metadata['videoCallUrl']),
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
    if (NOT_ANSWERS.has(slug) || contactLike(slug) || UNSAFE_KEYS.has(slug)) continue;
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
    locationNamed: named(location) || named(booking['meetingUrl']) || named(metadata['videoCallUrl']),
  });
}

/** Stored details, and the source time that set them (null when none is stored). */
export interface ObservedDetails {
  readonly details: BookingDetails;
  readonly observedAt: string | null;
}

/**
 * The conferencing app a location type names, so `integrations:daily` and `daily_video`
 * (the same place, named by `location` and by videoCallData) are one location, and a change
 * from Zoom to Google Meet or a street address is a change.
 */
export function locationFamily(locationType: string | null): string | null {
  if (locationType === null) return null;
  const bare = locationType.toLowerCase().replace(/^integrations:/u, '');
  return /^[a-z0-9]+/u.exec(bare)?.[0] ?? bare;
}

/**
 * How a source's details meet the stored ones (review M2R, findings 1, 2 and 4). Pure.
 *
 *   * A source at least as new as the stored details (or any, when none is stored) replaces
 *     them: each field it carries replaces the stored one, a field it does not carry is kept.
 *     A location it names describes all three conferencing fields together: when the kind of
 *     location changed (Zoom → Meet, a video call → a room), its fields replace the stored
 *     three, clearing what it does not carry, so no obsolete Zoom id or URL survives; when the
 *     kind is the same, a field it does not carry is kept (a `MEETING_ENDED` names the
 *     location but carries no `videoCallData`). The stored time becomes the source's.
 *   * An older source only fills empty fields, the conferencing three as one; the stored
 *     time stays.
 *
 * The kind of a location is its `locationFamily`.
 */
export function mergeBookingDetails(stored: ObservedDetails, incoming: BookingDetails, incomingAt: string): ObservedDetails {
  const was = stored.details;
  const newer = stored.observedAt === null || Date.parse(incomingAt) >= Date.parse(stored.observedAt);
  const location = (from: BookingDetails): Pick<BookingDetails, 'locationType' | 'videoCallUrl' | 'zoomMeetingId'> => ({
    locationType: from.locationType,
    videoCallUrl: from.videoCallUrl,
    zoomMeetingId: from.zoomMeetingId,
  });
  let merged: BookingDetails;
  if (newer) {
    const conferencing = !incoming.locationNamed
      ? location(was)
      : locationFamily(incoming.locationType) !== locationFamily(was.locationType)
        ? location(incoming)
        : {
            locationType: incoming.locationType ?? was.locationType,
            videoCallUrl: incoming.videoCallUrl ?? was.videoCallUrl,
            zoomMeetingId: incoming.zoomMeetingId ?? was.zoomMeetingId,
          };
    merged = {
      title: incoming.title ?? was.title,
      attendeeName: incoming.attendeeName ?? was.attendeeName,
      notes: incoming.notes ?? was.notes,
      answers: incoming.answers ?? was.answers,
      ...conferencing,
      locationNamed: false,
    };
  } else {
    const empty = was.locationType === null && was.videoCallUrl === null && was.zoomMeetingId === null;
    merged = {
      title: was.title ?? incoming.title,
      attendeeName: was.attendeeName ?? incoming.attendeeName,
      notes: was.notes ?? incoming.notes,
      answers: was.answers ?? incoming.answers,
      ...(empty ? location(incoming) : location(was)),
      locationNamed: false,
    };
  }
  const observedAt = detailsEmpty(merged) ? null : newer ? new Date(Date.parse(incomingAt)).toISOString() : stored.observedAt;
  return { details: merged, observedAt };
}

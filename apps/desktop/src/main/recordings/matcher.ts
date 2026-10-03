import type { RecordingCandidate } from '@fss/contracts';

/**
 * Which Callie meeting a recording folder is (lane M4; E4). Pure: no file, no clock, no server.
 *
 * Two steps, and the order is the privacy rule.
 *
 * 1. **Overlap** (`overlappingMeetings`), from the folder's start time alone — its name, or
 *    its own creation time — before anything inside it is listed. A folder whose start falls
 *    inside no Callie meeting's window is `outside`: it is never listed, never read, never
 *    uploaded and never shown. That is how a class or any other recording stays out. The
 *    window is the meeting's scheduled time widened by `OVERLAP_MARGIN_MS` on each side;
 *    cancelled meetings are not candidates (the server does not send them).
 * 2. **Match** (`decideMatch`), only for a folder that overlapped: `matched` when exactly one
 *    meeting started within `MATCH_WINDOW_MS` of the folder's start AND something corroborates
 *    it — the folder's topic carries the attendee's name, or a participant's file name does.
 *    Everything else that overlapped is `needs_matching`, with the overlapping meetings as the
 *    choices. Never a guess: no corroboration is no match, and two near meetings are two.
 *
 * The attendee's name is the CRM contact linked to the meeting; failing that, the words of the
 * local part of the address they booked with (`john.smith` → john, smith; the server never
 * sends the whole address). Cal.com's event title and attendee name are not stored by the
 * server (migration 0028 keeps no payload), so the topic is checked against the attendee only.
 *
 * **Whole tokens only** (review M4R, finding 4). Every text is cut into tokens the same way —
 * camel case split, digits dropped, accents folded, separators split — and a name corroborates
 * only when EVERY one of its tokens is a whole token of the topic, or of one participant file's
 * name. `audioJoannSmith123.m4a` is `audio joann smith`, so "Ann Smith" is not in it.
 */

export const OVERLAP_MARGIN_MS = 30 * 60 * 1000;
export const MATCH_WINDOW_MS = 30 * 60 * 1000;

/** How far back and forward the Mac asks the server for meetings around a folder's start. */
export const CANDIDATE_LOOKBACK_MS = 2 * 24 * 60 * 60 * 1000;
export const CANDIDATE_LOOKAHEAD_MS = 24 * 60 * 60 * 1000;

/** A folder older than this is never considered (it predates any meeting a read would find). */
export const MAX_FOLDER_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function overlappingMeetings(startedAt: Date, meetings: readonly RecordingCandidate[]): readonly RecordingCandidate[] {
  const at = startedAt.getTime();
  return meetings.filter(meeting => {
    const start = Date.parse(meeting.startsAt);
    const end = Math.max(Date.parse(meeting.endsAt), start);
    return at >= start - OVERLAP_MARGIN_MS && at <= end + OVERLAP_MARGIN_MS;
  });
}

/**
 * Lower-case letter tokens of at least two letters: accents folded, camel case split
 * (`JordanPlaceholder`, `DavidCUI`), digits dropped, anything else a separator.
 */
export function wordsOf(text: string): readonly string[] {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/([a-z])([A-Z])/gu, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1 $2')
    .replace(/[0-9]+/gu, ' ')
    .toLowerCase()
    .split(/[^a-z]+/u)
    .filter(word => word.length >= 2);
}

/** A participant file's name as tokens, without its extension (the digits go in `wordsOf`). */
export function labelWords(label: string): readonly string[] {
  return wordsOf(label.replace(/\.[A-Za-z0-9]{1,5}$/u, ''));
}

type NameFields = Pick<RecordingCandidate, 'attendeeName' | 'attendeeLocalPart'> & Partial<Pick<RecordingCandidate, 'bookingAttendeeName' | 'eventTitle'>>;

/** The attendee's name as tokens: the contact's name, else the address's local part. */
export function attendeeWords(meeting: Pick<RecordingCandidate, 'attendeeName' | 'attendeeLocalPart'>): readonly string[] {
  const name = meeting.attendeeName?.trim() ?? '';
  // A contact the match created is named by its address until somebody types a name.
  if (name !== '' && !name.includes('@')) return wordsOf(name);
  const local = name.includes('@') ? (name.split('@')[0] ?? '') : (meeting.attendeeLocalPart ?? '');
  return wordsOf(local);
}

/**
 * Every name the meeting knows its attendee by, as tokens (lane M2 wired in): the contact's
 * name and the name they gave Cal.com; the address's local part only when neither is known.
 */
export function attendeeNames(meeting: NameFields): readonly (readonly string[])[] {
  const names = [attendeeWords({ attendeeName: meeting.attendeeName, attendeeLocalPart: null }), wordsOf(meeting.bookingAttendeeName ?? '')].filter(
    words => words.length > 0,
  );
  if (names.length > 0) return names;
  const local = wordsOf(meeting.attendeeLocalPart ?? '');
  return local.length > 0 ? [local] : [];
}

/** The fewest words a booking title must have to corroborate on its own: "Demo" is not enough. */
export const MIN_TITLE_WORDS = 2;

export type Corroboration = 'topic' | 'participant' | 'title' | null;

/**
 * Whether the folder says which meeting it was, by whole tokens only (camel case, separators
 * and digits split; never a substring — `audioJoannSmith1.m4a` does not carry "Ann Smith"):
 *
 *   * `topic` — every token of one of the attendee's names (the contact's, or the name they
 *     gave Cal.com) is a token of the folder's topic;
 *   * `participant` — or of one participant file's name (`audioJohnSmith11234567890.m4a` is
 *     `audio john smith`);
 *   * `title` — every token of the booking's title (Cal.com names the Zoom meeting after it,
 *     and Zoom names the folder after the meeting), at least two of them, is a token of the
 *     topic.
 *
 * Every name and the title arrive through the server's one minimiser.
 */
export function corroboration(meeting: NameFields, folder: { readonly topic: string | null; readonly participantLabels: readonly string[] }): Corroboration {
  const topic = new Set(wordsOf(folder.topic ?? ''));
  const names = attendeeNames(meeting);
  if (names.some(name => name.every(word => topic.has(word)))) return 'topic';
  for (const label of folder.participantLabels) {
    const tokens = new Set(labelWords(label));
    if (names.some(name => name.every(word => tokens.has(word)))) return 'participant';
  }
  const title = wordsOf(meeting.eventTitle ?? '');
  if (title.length >= MIN_TITLE_WORDS && title.every(word => topic.has(word))) return 'title';
  return null;
}

export type MatchDecision =
  | { readonly kind: 'outside' }
  | { readonly kind: 'matched'; readonly meetingId: string; readonly by: Exclude<Corroboration, null>; readonly candidates: readonly RecordingCandidate[] }
  | {
      readonly kind: 'needs_matching';
      readonly why: 'no_meeting_near_start' | 'several_meetings' | 'not_corroborated';
      readonly candidates: readonly RecordingCandidate[];
    };

export function decideMatch(
  folder: { readonly startedAt: Date; readonly topic: string | null; readonly participantLabels: readonly string[] },
  meetings: readonly RecordingCandidate[],
): MatchDecision {
  const candidates = overlappingMeetings(folder.startedAt, meetings);
  if (candidates.length === 0) return { kind: 'outside' };
  const at = folder.startedAt.getTime();
  const near = candidates.filter(meeting => Math.abs(Date.parse(meeting.startsAt) - at) <= MATCH_WINDOW_MS);
  if (near.length === 0) return { kind: 'needs_matching', why: 'no_meeting_near_start', candidates };
  if (near.length > 1) return { kind: 'needs_matching', why: 'several_meetings', candidates };
  const only = near[0] as RecordingCandidate;
  const by = corroboration(only, folder);
  if (by === null) return { kind: 'needs_matching', why: 'not_corroborated', candidates };
  return { kind: 'matched', meetingId: only.meetingId, by, candidates };
}

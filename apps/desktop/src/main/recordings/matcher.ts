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
 * address they booked with (`john.smith@` → john, smith). Cal.com's event title and attendee
 * name are not stored by the server (migration 0028 keeps no payload), so the topic is checked
 * against the attendee only.
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

/** Lower-case words of at least two letters or digits, accents folded. */
export function wordsOf(text: string): readonly string[] {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/gu, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(word => word.length >= 2);
}

/** The attendee's name as words: the contact's name, else the address's local part. */
export function attendeeWords(meeting: Pick<RecordingCandidate, 'attendeeName' | 'attendeeEmail'>): readonly string[] {
  const name = meeting.attendeeName?.trim() ?? '';
  // A contact the match created is named by its address until somebody types a name.
  if (name !== '' && !name.includes('@')) return wordsOf(name);
  const address = (name.includes('@') ? name : (meeting.attendeeEmail ?? '')).trim();
  const local = address.split('@')[0] ?? '';
  return wordsOf(local);
}

export type Corroboration = 'topic' | 'participant' | null;

/**
 * Whether the folder says who the meeting was with: every word of the attendee's name in the
 * topic, or the name's letters run together inside a participant file's name
 * (`audioJohnSmith11234567890.m4a` carries `johnsmith`).
 */
export function corroboration(
  meeting: Pick<RecordingCandidate, 'attendeeName' | 'attendeeEmail'>,
  folder: { readonly topic: string | null; readonly participantLabels: readonly string[] },
): Corroboration {
  // TODO(M2): once the server stores the booking's Cal.com title and the attendee's own name
  // (slice M2), the candidates read answers them and they corroborate here as well: the
  // title's words in the topic, and Cal.com's attendee name beside the contact's.
  const name = attendeeWords(meeting);
  if (name.length === 0) return null;
  const topic = new Set(wordsOf(folder.topic ?? ''));
  if (name.every(word => topic.has(word))) return 'topic';
  const joined = name.join('');
  for (const label of folder.participantLabels) {
    const letters = label.normalize('NFKD').replace(/[̀-ͯ]/gu, '').toLowerCase().replace(/[^a-z0-9]+/gu, '');
    if (letters.includes(joined)) return 'participant';
  }
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

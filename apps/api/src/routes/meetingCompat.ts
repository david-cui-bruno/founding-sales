import { compareVersions, semanticVersionSchema } from '@fss/contracts';
import type { AuthenticatedPrincipal } from '../auth/sessions.ts';

/**
 * Reads that answer a running 1.0.35 session (lane M1, review M1F finding 4).
 *
 * The minimum client is 1.0.36, but the minimum is checked when a session opens and on every
 * command, not on a read: a 1.0.35 Mac holding an unexpired session keeps reading until it
 * renews. Its strict schemas know neither `ended` nor `attendanceSource`, `stageSuggestion`
 * or `fromStageKey`, so one such field fails the whole read. For a session opened below
 * 1.0.36, the meetings and board reads leave those fields out and say `booked` for `ended`:
 * the least wrong word for a build that cannot confirm attendance anyway (it is display
 * only, and every command it sends is refused with 426, which takes it to "Update now").
 */

export const FIRST_ATTENDANCE_CLIENT = '1.0.36';

/** Whether the session was opened by a build older than the attendance release. */
export function readsLegacyMeetings(principal: Pick<AuthenticatedPrincipal, 'clientVersion'>): boolean {
  const version = semanticVersionSchema.safeParse(principal.clientVersion);
  return version.success && compareVersions(version.data, FIRST_ATTENDANCE_CLIENT) < 0;
}

const legacyState = (state: unknown): unknown => (state === 'ended' ? 'booked' : state);

/** One meeting row: `ended` read as `booked`, and no `attendanceSource`. */
export function legacyMeeting<T extends { readonly state: unknown }>(meeting: T): Omit<T, 'attendanceSource'> {
  const { attendanceSource: _dropped, ...rest } = meeting as T & { attendanceSource?: unknown };
  return { ...rest, state: legacyState(meeting.state) } as Omit<T, 'attendanceSource'>;
}

/** `GET /meetings/firm` as 1.0.35 parses it: `{ meetings }`, strict. */
export function legacyFirmMeetings(body: { readonly meetings: readonly { readonly state: unknown }[] }): { meetings: unknown[] } {
  return { meetings: body.meetings.map(legacyMeeting) };
}

/** `POST /pipeline/board` as 1.0.35 parses it: no card suggestion, no `ended`. */
export function legacyBoard<T extends { readonly cards?: Readonly<Record<string, unknown>> }>(board: T): T {
  if (board.cards === undefined) return board;
  const cards = Object.fromEntries(
    Object.entries(board.cards).map(([firmId, card]) => {
      const { stageSuggestion: _dropped, ...rest } = card as { stageSuggestion?: unknown; meeting?: { state: unknown } | null };
      const meeting = rest.meeting;
      return [firmId, meeting === null || meeting === undefined ? rest : { ...rest, meeting: { ...meeting, state: legacyState(meeting.state) } }];
    }),
  );
  return { ...board, cards };
}

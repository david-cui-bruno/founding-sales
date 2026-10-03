import {
  firmMeetingsResponseSchema,
  matchMeetingCommandSchema,
  meetingAttendanceSetSchema,
  meetingMatchedSchema,
  setMeetingAttendanceCommandSchema,
  unmatchedMeetingsResponseSchema,
  uuid,
} from '@fss/contracts';
import { setMeetingAttendance } from '@fss/domain/meetings/attendance.ts';
import { listFirmMeetings, listUnmatchedMeetings, matchMeetingToFirm, readFirmStageSuggestion } from '@fss/domain/meetings/match.ts';
import { REFUSAL_STATUS, redactError } from '../limits.ts';
import { contextForPrincipal, requirePrincipal, runRouteCommand } from './routeSupport.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * Meetings as the desktop reads and resolves them (slice M1).
 *
 *   * `GET /meetings/firm?firmId=` — the firm's meetings with their state and time, for
 *     the firm page's Meetings rows. Any active member: a meeting's state and date are
 *     Appendix F's first row. A firm outside the workspace is 404.
 *   * `GET /meetings/unmatched` — the bookings no firm is attached to, for the Pipeline
 *     screen's "Bookings to match". Any active member.
 *   * `POST /meetings/match { meetingId, firmId }` — attach one to a firm: the assignee or
 *     an administrator, decided by the domain command under the firm's row lock
 *     (`meetings/match.ts`), which then applies the booking exactly as a matched webhook
 *     would.
 *   * `POST /meetings/attendance { meetingId, attendance }` — lane M1: a person confirms who
 *     came (`attended`, `no_show`) or undoes their own confirmation (`unconfirmed`). The
 *     assignee or an administrator, decided by the domain command under the firm's row
 *     lock (`meetings/attendance.ts`). Idempotent per command id, audited, sends nothing.
 *
 * `GET /meetings/firm` also carries `stageSuggestion`, the one-click "Move to Demo booked"
 * for a live booking (lane M1: a booking no longer moves a deal by itself).
 *
 * None of the three reaches Cal.com, and none depends on the `calendar_integration`
 * switch: they read and resolve rows the webhook or the reconciliation already wrote,
 * and a meeting stays on the firm page after the switch is turned off.
 */

export const MEETING_PATHS: readonly string[] = ['/meetings/firm', '/meetings/unmatched', '/meetings/match', '/meetings/attendance'];

const COMMAND_PATHS: readonly string[] = ['/meetings/match', '/meetings/attendance'];

export async function routeMeetings(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!MEETING_PATHS.includes(request.path)) return null;
  const auth = options.auth;
  if (auth === undefined) return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
  const expected = COMMAND_PATHS.includes(request.path) ? 'POST' : 'GET';
  if (request.method !== expected) {
    return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  }
  const authenticated = await requirePrincipal(auth, request);
  if (!authenticated.ok) return authenticated.result;

  if (request.path === '/meetings/match') {
    return await runRouteCommand(
      { auth, request, principal: authenticated.principal },
      matchMeetingCommandSchema,
      'match_meeting',
      async (context, body) => {
        const matched = await matchMeetingToFirm(context, { meetingId: body.meetingId, firmId: body.firmId });
        return matched.ok ? { ok: true, value: meetingMatchedSchema.parse(matched.value) } : matched;
      },
    );
  }

  if (request.path === '/meetings/attendance') {
    return await runRouteCommand(
      { auth, request, principal: authenticated.principal },
      setMeetingAttendanceCommandSchema,
      'set_meeting_attendance',
      async (context, body) => {
        const set = await setMeetingAttendance(context, { meetingId: body.meetingId, attendance: body.attendance });
        return set.ok ? { ok: true, value: meetingAttendanceSetSchema.parse(set.value) } : set;
      },
    );
  }

  const scoped = contextForPrincipal(auth, authenticated.principal);
  if (!scoped.ok) return scoped.result;

  if (request.path === '/meetings/unmatched') {
    const meetings = await listUnmatchedMeetings(scoped.context);
    return { status: 200, body: unmatchedMeetingsResponseSchema.parse({ meetings }) };
  }

  const firmId = uuid.safeParse(request.query.get('firmId') ?? '');
  if (!firmId.success) return { status: REFUSAL_STATUS.malformed_body, body: redactError('malformed_body') };
  const meetings = await listFirmMeetings(scoped.context, firmId.data);
  if (meetings === null) return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
  const stageSuggestion = await readFirmStageSuggestion(scoped.context, firmId.data);
  return { status: 200, body: firmMeetingsResponseSchema.parse({ meetings, stageSuggestion }) };
}

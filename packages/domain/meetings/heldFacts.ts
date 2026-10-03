import type { RepositoryContext } from '../db/workspaceScope.ts';
import { recordFunnelFact, reinstateFunnelFact, withdrawFunnelFacts } from '../funnel/facts.ts';
import type { MeetingRow } from './calcom.ts';

/**
 * A meeting's `meeting.held` funnel fact (lane M1, 0039): written only for confirmed
 * attendance, dated at the meeting's start, keyed by one of the booking uids the meeting has
 * had, withdrawn rather than removed. Its own module so both the attendance command
 * (`attendance.ts`) and the Cal.com folds (`calcom.ts`) use it without importing each other.
 */

/** Why a fold withdrew a meeting's extra or no-longer-true fact. */
export const MEETING_FOLDED_REASON = 'meeting_folded';

/** Every booking uid a meeting has had: its `meeting.held` fact is keyed by one of them. */
async function bookingUidsOf(context: RepositoryContext, meeting: Pick<MeetingRow, 'id' | 'booking_uid' | 'current_booking_uid'>): Promise<string[]> {
  const { rows } = await context.db.query<{ booking_uid: string }>(
    'SELECT booking_uid FROM meeting_booking_uids WHERE workspace_id = $1 AND meeting_id = $2',
    [context.scope.workspaceId, meeting.id],
  );
  return [...new Set([meeting.booking_uid, meeting.current_booking_uid, ...rows.map(row => row.booking_uid)])];
}

/**
 * The `meeting.held` fact for a meeting that is now confirmed held: the one it had, brought
 * back if it was withdrawn, or a new one dated at the meeting's start. Exported for the
 * person's match of an unmatched booking (`meetings/match.ts`), which owes it for a meeting
 * already confirmed.
 */
export async function recordHeldFact(
  context: RepositoryContext,
  meeting: Pick<MeetingRow, 'id' | 'booking_uid' | 'current_booking_uid' | 'firm_id' | 'starts_at' | 'attendance_source'>,
): Promise<void> {
  if (meeting.firm_id === null) return;
  const keys = await bookingUidsOf(context, meeting);
  const existing = await reinstateFunnelFact(context, { kind: 'meeting.held', dedupeKeys: keys, preferredKey: meeting.booking_uid });
  if (existing !== 'absent') return;
  await recordFunnelFact(context, {
    kind: 'meeting.held',
    source: 'calendar',
    dedupeKey: meeting.booking_uid,
    firmId: meeting.firm_id,
    occurredAt: meeting.starts_at.toISOString(),
    detail: { attendanceSource: meeting.attendance_source ?? 'manual' },
  });
}

/** Withdraw a meeting's `meeting.held` fact, under whichever of its uids it was keyed. */
export async function withdrawHeldFact(
  context: RepositoryContext,
  meeting: Pick<MeetingRow, 'id' | 'booking_uid' | 'current_booking_uid'>,
  reason: string,
): Promise<number> {
  return await withdrawFunnelFacts(context, { kind: 'meeting.held', dedupeKeys: await bookingUidsOf(context, meeting), reason });
}


/**
 * After rows that were one meeting are folded into one (lane M1, review M1R finding 4): exactly
 * one counted `meeting.held` fact when the survivor is held — the survivor's own uid first,
 * else the earliest, brought back or written if none counts — and none when it is not. The
 * extras are withdrawn (`meeting_folded`), in the fold's transaction. The caller has moved the
 * folded rows' uids to the survivor, so every fact any of them had is found.
 */
export async function reconcileHeldFacts(
  context: RepositoryContext,
  meeting: Pick<MeetingRow, 'id' | 'state' | 'booking_uid' | 'current_booking_uid' | 'firm_id' | 'starts_at' | 'attendance_source'>,
): Promise<void> {
  const keys = await bookingUidsOf(context, meeting);
  const { rows } = await context.db.query<{ id: string }>(
    `SELECT id FROM funnel_facts
      WHERE workspace_id = $1 AND kind = 'meeting.held' AND dedupe_key = ANY($2::text[]) AND withdrawn_at IS NULL
      ORDER BY (dedupe_key = $3) DESC, occurred_at, id
      FOR UPDATE`,
    [context.scope.workspaceId, keys, meeting.booking_uid],
  );
  const held = meeting.state === 'held' && meeting.firm_id !== null;
  const extras = held ? rows.slice(1) : rows;
  if (extras.length > 0) {
    await context.db.query(
      `UPDATE funnel_facts SET withdrawn_at = now(), withdrawn_reason = $3
        WHERE workspace_id = $1 AND id = ANY($2::uuid[])`,
      [context.scope.workspaceId, extras.map(row => row.id), MEETING_FOLDED_REASON],
    );
  }
  if (held && rows.length === 0) await recordHeldFact(context, meeting);
}

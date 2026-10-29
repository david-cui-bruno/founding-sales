import type { Queryable } from '../db/queryable.ts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { settleAttempt } from '../research/reservations.ts';
import { eraseExpiredAudioTestDestinations } from './audioTestErasure.ts';

/**
 * Finalise the reservations of sessions whose callbacks will not come (one workspace).
 *
 *   * never consumed and past its minute — `released`: no call can have happened;
 *   * consumed, still open, and older than the longest call it reserved plus fifteen
 *     minutes — `estimated` at the full reservation, because a call may have been billed
 *     and zero is the one answer that is certainly wrong.
 *
 * Scheduled by the worker's `telephony-sweep` source (`telephony.sweep`, every quarter
 * hour for a workspace that owes one: `workspacesOwingCallSessionSweep`). It is safe to
 * run at any time and any number of times.
 */
export async function sweepCallSessionReservations(
  context: RepositoryContext,
): Promise<{ readonly released: number; readonly estimated: number }> {
  const { rows } = await context.db.query<{ reservation_id: string; consumed: boolean }>(
    `SELECT s.reservation_id, (s.consumed_at IS NOT NULL) AS consumed
       FROM call_sessions s
       JOIN provider_reservations r ON r.workspace_id = s.workspace_id AND r.id = s.reservation_id
      WHERE s.workspace_id = $1 AND r.state IN ('reserved', 'calling')
        AND ((s.consumed_at IS NULL AND s.expires_at <= now())
             OR (s.consumed_at IS NOT NULL
                 AND s.consumed_at + make_interval(mins => COALESCE(r.max_units, 0) + 15) <= now()))
      ORDER BY s.created_at
      FOR UPDATE OF s`,
    [context.scope.workspaceId],
  );
  let released = 0;
  let estimated = 0;
  const at = new Date().toISOString();
  for (const row of rows) {
    const settled = await settleAttempt(context, {
      reservationId: row.reservation_id,
      at,
      outcome: row.consumed ? { kind: 'estimated' } : { kind: 'released' },
    });
    if (settled === null) continue;
    if (row.consumed) estimated += 1;
    else released += 1;
  }
  // Last: callbacks lock session -> request. Broad erasure skips request rows
  // held by consumers waiting for our budget lock; no send gate is needed.
  await eraseExpiredAudioTestDestinations(context);
  return { released, estimated };
}

/**
 * The workspaces with at least one call-session reservation the sweep would finalise
 * now: the scheduler's question, asked with no scope because the pass has none. The
 * same predicate as `sweepCallSessionReservations`, so a workspace is named only when
 * the job will find work, whatever its calling switch says — a switch turned off does
 * not strand a reservation.
 */
export async function workspacesOwingCallSessionSweep(db: Queryable): Promise<readonly string[]> {
  const { rows } = await db.query<{ workspace_id: string }>(
    `SELECT DISTINCT s.workspace_id
       FROM call_sessions s
       JOIN provider_reservations r ON r.workspace_id = s.workspace_id AND r.id = s.reservation_id
      WHERE r.state IN ('reserved', 'calling')
        AND ((s.consumed_at IS NULL AND s.expires_at <= now())
             OR (s.consumed_at IS NOT NULL
                 AND s.consumed_at + make_interval(mins => COALESCE(r.max_units, 0) + 15) <= now()))
     UNION
     SELECT r.workspace_id FROM browser_audio_test_requests r
      WHERE r.erased_at IS NULL AND (r.expires_at<=clock_timestamp() OR EXISTS (
        SELECT 1 FROM call_sessions s WHERE s.workspace_id=r.workspace_id AND s.audio_test_request_id=r.id
          AND s.purpose='audio_test' AND s.status IN ('completed','failed','canceled')))
      ORDER BY workspace_id`,
  );
  return rows.map(row => row.workspace_id);
}

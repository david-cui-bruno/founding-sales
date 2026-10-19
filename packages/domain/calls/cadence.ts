import { CALL_CADENCE, type CallCadence, type CallOutcome } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { localParts } from '../src/rules/localClock.ts';

export const CALL_CADENCE_PARKED_SOURCE = 'call_cadence_parked';
export const UNANSWERED_OUTCOMES: ReadonlySet<CallOutcome> = new Set(['no_answer', 'busy', 'voicemail_left']);
const RESETTING_OUTCOMES: readonly CallOutcome[] = ['interested', 'referral_or_wrong_person', 'callback_requested', 'not_interested', 'do_not_call'];
export interface CallCadenceState extends CallCadence {
  readonly lastAttemptSessionId: string | null;
  readonly parkingHoldId: string | null;
}
/** Preserve database precision across lock waits and correction previews. */
export const isoMicroseconds = (expression: string): string =>
  `to_char((${expression}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** Both providers share one conservative attempt stream. Expiry never refunds a handoff. */
export async function readCallCadence(
  context: RepositoryContext, firmId: string, at: string, countThrough?: string,
  override?: { readonly callLogId: string; readonly outcome: CallOutcome },
): Promise<CallCadenceState> {
  const w = context.scope.workspaceId;
  const outcomeOf = (alias: string, p: number): string =>
    `CASE WHEN ${alias}id=$${p}::uuid THEN $${p + 1}::text ELSE ${alias}outcome END`;
  const resets = await context.db.query<{ reset_at: string | null }>(
    `SELECT ${isoMicroseconds('max(t)')} AS reset_at FROM (
       SELECT occurred_at AS t FROM call_logs WHERE workspace_id=$1 AND firm_id=$2 AND (${outcomeOf('', 5)})=ANY($3::text[])
       UNION ALL SELECT released_at FROM active_holds WHERE workspace_id=$1 AND scope_kind='firm' AND scope_key=($2::uuid)::text
         AND source_event_kind=$4 AND released_at IS NOT NULL) r`,
    [w, firmId, RESETTING_OUTCOMES, CALL_CADENCE_PARKED_SOURCE, override?.callLogId ?? null, override?.outcome ?? null]);
  const rows = await context.db.query<{ id: string; consumed_at: Date; outcome: CallOutcome | null }>(
    `SELECT s.id,s.consumed_at,${outcomeOf('l.', 7)} AS outcome FROM (
       SELECT id,consumed_at,call_log_id FROM call_sessions WHERE workspace_id=$1 AND firm_id=$2 AND consumed_at IS NOT NULL
       UNION ALL SELECT id,reserved_at,call_log_id FROM phone_handoff_attempts WHERE workspace_id=$1 AND firm_id=$2
     ) s LEFT JOIN call_logs l ON l.workspace_id=$1 AND l.id=s.call_log_id
     WHERE s.consumed_at>$3::timestamptz-make_interval(days=>$4)
       AND s.consumed_at<=GREATEST($3::timestamptz,COALESCE($6::timestamptz,$3::timestamptz))
       AND ($5::timestamptz IS NULL OR s.consumed_at>$5::timestamptz) ORDER BY s.consumed_at,s.id`,
    [w, firmId, at, CALL_CADENCE.windowDays, resets.rows[0]?.reset_at ?? null, countThrough ?? null, override?.callLogId ?? null, override?.outcome ?? null]);
  const attempts = rows.rows.filter(row => row.outcome === null || !RESETTING_OUTCOMES.includes(row.outcome));
  const last = attempts.at(-1) ?? null;
  const holds = await context.db.query<{ id: string }>(
    `SELECT id FROM active_holds WHERE workspace_id=$1 AND scope_kind='firm' AND scope_key=($2::uuid)::text
       AND source_event_kind=$3 AND released_at IS NULL ORDER BY started_at,id LIMIT 1`, [w, firmId, CALL_CADENCE_PARKED_SOURCE]);
  const parkingHoldId = holds.rows[0]?.id ?? null;
  const parked = attempts.length >= CALL_CADENCE.unansweredLimit || parkingHoldId !== null;
  let refusal: CallCadence['refusal'] = parked ? 'call_attempts_exhausted' : null;
  if (refusal === null && last !== null) {
    const firms = await context.db.query<{ time_zone: string | null }>('SELECT time_zone FROM firms WHERE workspace_id=$1 AND id=$2', [w, firmId]);
    const zone = firms.rows[0]?.time_zone;
    if (zone) {
      const previous = localParts(last.consumed_at.toISOString(), zone);
      const current = localParts(at, zone);
      if (previous.date === current.date) refusal = 'call_attempt_today';
      else if (Math.abs(current.minuteOfDay - previous.minuteOfDay) < CALL_CADENCE.spacingMinutes) refusal = 'call_attempt_too_soon';
    }
  }
  return { unansweredAttempts: attempts.length, nextAttempt: parked ? null : attempts.length + 1,
    limit: CALL_CADENCE.unansweredLimit, parked, refusal, lastAttemptSessionId: last?.id ?? null, parkingHoldId };
}

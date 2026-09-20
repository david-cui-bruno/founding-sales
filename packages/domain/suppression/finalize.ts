import { MANUAL_SUPPRESSION_CORRECTION_SECONDS } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import { databaseNow } from '../policy/clock.ts';
import { releaseHoldsOfEvent } from '../policy/holds.ts';

/**
 * The manual-suppression finalizer (specification 10.2, Appendix A, Appendix C,
 * Appendix G 29).
 *
 * "At the deadline, an idempotent finalizer locks the event and enrollments and
 * performs terminal stops. A concurrent correction or finalizer has one winner."
 *
 * `suppression_events` cannot be locked: migration 0001 revokes UPDATE from both
 * application roles, and PostgreSQL requires the UPDATE privilege for `SELECT ...
 * FOR UPDATE`. So the lock is an insert into `suppression_finalizations`, whose
 * primary key is the event. Whichever of the correction and the finalizer inserts
 * first wins; the loser's `ON CONFLICT DO NOTHING` waits on the winner's row lock,
 * returns nothing when it commits, and then reads which answer won. One statement,
 * one winner, no advisory lock to leak. See
 * `docs/decisions/g4-finalization-is-the-lock.md`.
 */

export type FinalizationOutcome = 'finalized' | 'corrected';

export interface FinalizationClaim {
  readonly won: boolean;
  /** Who holds the decision now: this caller's outcome when it won, the winner's when it lost. */
  readonly outcome: FinalizationOutcome;
}

export interface ClaimFinalizationInput {
  readonly eventId: string;
  readonly outcome: FinalizationOutcome;
  /** Required for `corrected`: the event that supersedes the original. */
  readonly correctionEventId?: string | undefined;
  readonly decidedByUserId?: string | undefined;
}

/**
 * Claim the decision for one suppression event.
 *
 * The `RETURNING` is what distinguishes the winner: `ON CONFLICT DO NOTHING` returns
 * a row only when it inserted one. A second read then says who won, and that read
 * cannot see a torn state because the conflicting insert already waited for the
 * other transaction to finish.
 */
export async function claimFinalization(
  context: RepositoryContext,
  input: ClaimFinalizationInput,
): Promise<FinalizationClaim> {
  const { rows } = await context.db.query<{ outcome: FinalizationOutcome }>(
    `INSERT INTO suppression_finalizations
       (workspace_id, event_id, outcome, correction_event_id, decided_by_user_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT ON CONSTRAINT suppression_finalizations_pkey DO NOTHING
     RETURNING outcome`,
    [
      context.scope.workspaceId,
      input.eventId,
      input.outcome,
      input.outcome === 'corrected' ? (input.correctionEventId ?? null) : null,
      input.decidedByUserId ?? null,
    ],
  );
  const won = rows[0];
  if (won !== undefined) return { won: true, outcome: won.outcome };

  const existing = await context.db.query<{ outcome: FinalizationOutcome }>(
    'SELECT outcome FROM suppression_finalizations WHERE workspace_id = $1 AND event_id = $2',
    [context.scope.workspaceId, input.eventId],
  );
  const outcome = existing.rows[0]?.outcome;
  if (outcome === undefined) throw new Error('the finalization claim conflicted with a row that is not there');
  return { won: false, outcome };
}

export async function readFinalization(
  context: RepositoryContext,
  eventId: string,
): Promise<{ readonly outcome: FinalizationOutcome; readonly decidedAt: string } | null> {
  const { rows } = await context.db.query<{ outcome: FinalizationOutcome; decided_at: Date }>(
    'SELECT outcome, decided_at FROM suppression_finalizations WHERE workspace_id = $1 AND event_id = $2',
    [context.scope.workspaceId, eventId],
  );
  const row = rows[0];
  return row === undefined ? null : { outcome: row.outcome, decidedAt: row.decided_at.toISOString() };
}

export type FinalizeResult =
  | 'finalized'
  | 'lost_to_correction'
  | 'already_finalized'
  | 'not_due'
  | 'not_applicable'
  | 'unknown';

/**
 * Run the finalizer for one event. Idempotent, and safe to run early or twice.
 *
 * `at` is the instant the finalizer believes it is running at, in database time. It
 * defaults to the database's own clock; the job handler never supplies one, and a
 * test supplies the deadline so the race in Appendix G 29 is a real race rather than
 * a wait. See `docs/decisions/g4-database-time-is-a-parameter.md`.
 *
 * Running before the deadline is `not_due` rather than an error: the job's `run_at`
 * already holds it back, and a scheduler that woke a minute early must not turn a
 * correctable suppression into a terminal one.
 */
export async function finalizeManualSuppression(
  context: RepositoryContext,
  input: { readonly eventId: string; readonly at?: string | undefined },
): Promise<FinalizeResult> {
  const { rows } = await context.db.query<{ source: string; recorded_at: Date }>(
    'SELECT source, recorded_at FROM suppression_events WHERE workspace_id = $1 AND event_id = $2',
    [context.scope.workspaceId, input.eventId],
  );
  const event = rows[0];
  if (event === undefined) return 'unknown';
  if (event.source !== 'salesperson_manual') return 'not_applicable';

  const at = input.at ?? (await databaseNow(context));
  const deadline = event.recorded_at.getTime() + MANUAL_SUPPRESSION_CORRECTION_SECONDS * 1000;
  const now = Date.parse(at);
  if (!Number.isFinite(now)) throw new TypeError('a finalizer runs at an ISO 8601 database time');
  if (now < deadline) return 'not_due';

  const claim = await claimFinalization(context, { eventId: input.eventId, outcome: 'finalized' });
  if (!claim.won) return claim.outcome === 'corrected' ? 'lost_to_correction' : 'already_finalized';

  // The window is over, so the review hold has done its job: what blocked contact
  // during the ten minutes is now the suppression itself, which never lifts. The
  // terminal stops on enrollments belong to the sequences lane, which reads the
  // marker this claim just wrote.
  await releaseHoldsOfEvent(context, {
    sourceEventId: input.eventId,
    reasonCode: 'manual_suppression_review',
  });
  await recordCrmAuditEvent(context, {
    action: 'suppression.finalized',
    subjectKind: 'suppression_event',
    subjectId: input.eventId,
    detail: { deadline: new Date(deadline).toISOString() },
  });
  return 'finalized';
}

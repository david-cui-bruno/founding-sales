import type { Queryable } from '../db/queryable.ts';
import { CHANNEL_ACTION_KINDS, CHANNEL_PAUSE_KEYS } from './eligibility.ts';
import type { StepChannel } from '@fss/contracts';

/**
 * When a step execution is owed another look, and the job key that look runs under
 * (specification 4.3, 11.2, 13.1, Appendix B, Appendix C; lane g82, audit C02, C03,
 * C05 and C10).
 *
 * ## The defect this file exists for
 *
 * The `sequence.action` key used to be `step-execution:{id}` and nothing else. A step
 * held by the day's cap, a closed window or an administrator's pause completed its
 * job, and `completeJob` marked that one row `done` for ever. When the cap cleared or
 * the pause was released, the scheduler found the step again and inserted the same
 * key, `ON CONFLICT DO NOTHING` inserted nothing, and the step never ran again. The
 * same was true of a step whose worker died between the step's transaction and the
 * dispatch claim: the retry read `dispatched`, did nothing, and the prepared fence was
 * left where it was.
 *
 * ## The wake
 *
 * A job is now one look at one *version* of the execution row:
 * `step-execution:{id}:{wake}`, where the wake is the row's `updated_at` in
 * microseconds. Every writer of `step_executions` sets `updated_at = now()`, so a row
 * nobody has written to since its last job ran has nothing new to say and is not asked
 * again — the key is already there — and a row that has moved (held with a new
 * `not_before`, resumed, rescheduled, marked dispatched) is a new wake. The one-row
 * rule stands: there is still exactly one execution per step of an enrollment
 * (`step_executions_one_per_step`), and at most one email per execution is still the
 * outbound fence's guarantee, never the job's.
 *
 * Two jobs for one execution are never live together: the source skips an execution
 * that has a `queued`, `running` or `retryable` job of this kind. A job that is queued
 * while its row moves on reads the row as it is when it runs, because everything the
 * handler decides it decides from the row, under `FOR UPDATE`.
 *
 * ## What is woken
 *
 * * **Due pending work**, always. A pending step blocked by a hold runs once and is
 *   held with the hold's reason, so the card says why.
 * * **Held work whose `not_before` has passed and that no open hold blocks.** The
 *   blocking question is `BLOCKING_HOLD_SQL`, which asks every scope `active_holds`
 *   can carry — workspace, firm, opportunity, owner, the owner's mailbox, the
 *   enrollment and the step's channel — about the step's own action kind and
 *   `enrollment_advance`, the same scopes and kinds `holdSource` asks through
 *   `listApplicableHolds` (C10). A step whose hold is released is therefore woken on
 *   the next pass, and the handler's first act on a held step is the resume evaluation
 *   4.3 requires (C05). A held step no hold row explains — a route that is missing, a
 *   template not yet approved, coverage that went stale — is asked again when its
 *   `not_before` passes, which `holdExecution` pushes out by the reason's interval.
 * * **Work of an enrollment an older release left in `review_required`** (wave 2,
 *   S4.1), on the same terms as an active one's. A long hold no longer waits for a
 *   person, and the handler's resume evaluation is what moves such an enrollment back
 *   to `active` — once its holds have cleared, and not before.
 * * **Dispatched work that has sat for `DISPATCH_RECOVERY_GRACE_SECONDS`** (C03). The
 *   step's transaction marks the execution `dispatched` in the same commit that
 *   prepares its fence, and the claim happens after; a worker that dies in between
 *   leaves a prepared fence nobody dispatches. The handler reads the fence and moves
 *   the step to what the fence became — dispatching a fence that is still `prepared`
 *   or `held` through the one dispatch path, which claims atomically or not at all.
 *
 * A step's own fence's holds do not block its own wake. They are the holds a dispatch
 * attempt opened (a cap, a window, a reconciliation in doubt), and the dispatch path
 * releases the stale ones itself before it decides again; counting them here would be
 * the deadlock of a fence held by Monday's cap that can never be re-decided.
 */

/** How long a `dispatched` execution may sit before the scheduler wakes it (C03). */
export const DISPATCH_RECOVERY_GRACE_SECONDS = 10 * 60;

/** How many wakes one pass materializes. The next minute takes the rest. */
export const STEP_WAKE_LIMIT = 500;

/** A `CASE e.channel … END` over one of the per-channel tables, so a new channel updates both. */
function caseOfChannel(table: Readonly<Record<StepChannel, string>>): string {
  const arms = Object.entries(table).map(([channel, value]) => `WHEN '${channel}' THEN '${value}'`);
  return `(CASE e.channel ${arms.join(' ')} END)`;
}

/**
 * The subject a hold is matched against, as SQL expressions. One builder serves the
 * scheduler's selection, `holdExecution`'s interval and the resume's union, so the
 * three cannot disagree about which scopes apply.
 */
export interface HoldSubjectSql {
  readonly workspaceId: string;
  readonly firmId: string;
  readonly opportunityId: string;
  readonly ownerUserId: string;
  readonly mailboxId: string;
  readonly enrollmentId: string;
  readonly channelKey: string;
  /** A `text[]` expression: the action kinds the work would be blocked under. */
  readonly actionKinds: string;
}

/**
 * Whether hold `alias` applies to the subject: its workspace, one of the action kinds,
 * and one of the seven scopes of migration 0001 on its own key (`listApplicableHolds`).
 * Released or open is the caller's question.
 */
export function holdAppliesSql(alias: string, subject: HoldSubjectSql): string {
  return `${alias}.workspace_id = ${subject.workspaceId}
          AND ${alias}.blocked_action_kinds && ${subject.actionKinds}
          AND (
                ${alias}.scope_kind = 'workspace'
                OR (${alias}.scope_kind = 'firm' AND ${alias}.scope_key = ${subject.firmId})
                OR (${alias}.scope_kind = 'opportunity' AND ${alias}.scope_key = ${subject.opportunityId})
                OR (${alias}.scope_kind = 'owner' AND ${alias}.scope_key = ${subject.ownerUserId})
                OR (${alias}.scope_kind = 'mailbox' AND ${alias}.scope_key = ${subject.mailboxId})
                OR (${alias}.scope_kind = 'enrollment' AND ${alias}.scope_key = ${subject.enrollmentId})
                OR (${alias}.scope_kind = 'channel' AND ${alias}.scope_key = ${subject.channelKey})
              )`;
}

/**
 * The execution `e` of enrollment `n`, as a hold subject: the enrollment's firm,
 * opportunity and owner, the owner's one mailbox (12.1, `mailboxes_one_per_owner`), the
 * enrollment, and the step's channel — exactly what `holdSource` passes.
 */
const EXECUTION_SUBJECT: HoldSubjectSql = {
  workspaceId: 'e.workspace_id',
  firmId: 'n.firm_id::text',
  opportunityId: 'n.opportunity_id::text',
  ownerUserId: 'n.assigned_user_id::text',
  mailboxId: `(SELECT m.id::text FROM mailboxes m
                WHERE m.workspace_id = e.workspace_id AND m.owner_user_id = n.assigned_user_id)`,
  enrollmentId: 'n.id::text',
  channelKey: caseOfChannel(CHANNEL_PAUSE_KEYS),
  actionKinds: `ARRAY[${caseOfChannel(CHANNEL_ACTION_KINDS)}, 'enrollment_advance']::text[]`,
};

/**
 * True while an open hold blocks execution `e` of enrollment `n`, not counting the
 * holds its own fence opened. See the file header for why those are not counted.
 */
export const BLOCKING_HOLD_SQL = `EXISTS (
      SELECT 1 FROM active_holds h
       WHERE h.released_at IS NULL
         AND ${holdAppliesSql('h', EXECUTION_SUBJECT)}
         AND NOT (h.source_event_kind = 'outbound_message'
                  AND EXISTS (SELECT 1 FROM outbound_messages f
                               WHERE f.workspace_id = e.workspace_id AND f.step_execution_id = e.id
                                 AND f.id::text = h.source_event_id))
    )`;

/** The wake of execution `e`: its `updated_at`, in whole microseconds, as text. */
export const WAKE_SQL = '(extract(epoch FROM e.updated_at) * 1000000)::bigint::text';

export interface StepWake {
  readonly workspaceId: string;
  readonly stepExecutionId: string;
  /** The row version this look is for. The job key's last segment. */
  readonly wake: string;
}

/**
 * Every execution owed a look at `now`, over every workspace, oldest due first.
 *
 * Cross-workspace on purpose, like the queue's claim: one scheduler serves every
 * workspace and the job row carries the workspace (docs/decisions/g5-queue-scope.md).
 * Every comparison is PostgreSQL's.
 */
export async function listStepWakes(
  db: Queryable,
  input: {
    readonly now: string;
    readonly limit?: number | undefined;
    readonly recoveryGraceSeconds?: number | undefined;
  },
): Promise<readonly StepWake[]> {
  const { rows } = await db.query<{ id: string; workspace_id: string; wake: string }>(
    `SELECT e.id, e.workspace_id, ${WAKE_SQL} AS wake
       FROM step_executions e
       JOIN sequence_enrollments n
         ON n.workspace_id = e.workspace_id AND n.id = e.enrollment_id
      WHERE n.ended_at IS NULL
        AND n.state IN ('active', 'review_required')
        AND (
              (e.state IN ('pending', 'held')
               AND e.due_at <= $1::timestamptz
               AND e.not_before <= $1::timestamptz
               AND (e.state = 'pending' OR NOT ${BLOCKING_HOLD_SQL}))
              OR (e.state = 'dispatched'
                  AND e.updated_at <= $1::timestamptz - make_interval(secs => $2::double precision))
            )
        AND NOT EXISTS (
              SELECT 1 FROM jobs j
               WHERE j.workspace_id = e.workspace_id
                 AND j.kind = 'sequence.action'
                 AND j.state IN ('queued', 'running', 'retryable')
                 AND j.payload ->> 'stepExecutionId' = e.id::text
            )
      ORDER BY e.due_at, e.id
      LIMIT $3`,
    [
      input.now,
      input.recoveryGraceSeconds ?? DISPATCH_RECOVERY_GRACE_SECONDS,
      Math.trunc(input.limit ?? STEP_WAKE_LIMIT),
    ],
  );
  return rows.map(row => ({ workspaceId: row.workspace_id, stepExecutionId: row.id, wake: row.wake }));
}

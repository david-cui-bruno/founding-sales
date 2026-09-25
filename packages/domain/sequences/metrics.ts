import { HOLD_REASON_CODES, type HoldReasonCode } from '@fss/contracts';
import type { Queryable } from '../db/queryable.ts';
import type { MetricDatum } from '../jobs/metrics.ts';
import { CHANNEL_ACTION_KINDS } from './eligibility.ts';
import { CLOCK_CLEARING_HOLDS } from './executions.ts';

/**
 * The sequences lane's two gauges, `ActiveEnrollments` and `HeldEnrollments`
 * (specification 4.3, 11.2, 13.3; lane g72).
 *
 * 13.3 alarms when "all active sequences [are] unexpectedly held". The alarm in
 * `infra/modules/alerts/main.tf`, `all_sequences_held`, is metric math:
 * `IF(active > 0, held / active, 0) >= 1`, each input at `Maximum` over five minutes,
 * three periods of three, missing data not breaching. Until g72 nothing published
 * either input, so once real enrollments existed the alarm had nothing to read.
 *
 * Both are published on every metric pass, with no dimensions, summed over every
 * workspace, and **zero when nothing is enrolled**: the expression is 0 at 0/0, so the
 * alarm is OK rather than INSUFFICIENT_DATA whenever the worker is publishing, and it
 * never fires on an empty system.
 *
 * **Active** is every live enrollment: `ended_at IS NULL`, which the database ties to
 * the states `active` and `review_required` (`sequence_enrollments_live_has_no_end`).
 * Completed and stopped enrollments are over and are not counted. The denominator and
 * the numerator are the same population, so the fraction cannot exceed one.
 *
 * **Held** is every live enrollment whose next work is blocked, right now, by a hold
 * nobody chose. An enrollment is held when any of these is true:
 *
 *   1. it is `review_required` — 4.3's long-hold review, which only a person resumes;
 *   2. one of its step executions is `held` with a counted reason — what the worker
 *      concluded the last time it tried the step, including the reasons that have no
 *      `active_holds` row at all (a missing route, an unapproved template, an owner
 *      with no connected mailbox);
 *   3. an open `active_holds` row with a counted reason applies to it — scoped to the
 *      workspace, its firm, its opportunity, its owner or itself, which are the scopes
 *      `holdSource` and `holdsAffectingEnrollment` apply — and blocks the action kind
 *      of its unfinished step or `enrollment_advance`, which blocks every channel.
 *
 * The third is why this reads holds and not only step states. A step is held only
 * when it comes due and the worker tries it, and a cadence spends most of its life
 * waiting for a step days away, so a gauge over step states alone would call a
 * workspace under a restore hold "mostly running" until each step's day arrived.
 *
 * **Counted** means every section 15 reason except the ones in
 * `EXPECTED_HOLD_REASONS`: `scoped_pause`, and the four that clear with the clock.
 *
 *   * `scoped_pause` is every stop somebody chose. An administrator's pause at any
 *     scope and a salesperson's Today delay open holds with it, and the send hand-off
 *     holds a step with it when sending is switched off: the deployment's flag, the
 *     workspace attestation, the domain's automated-sending switch or a missing
 *     sending domain (`refusalFor` in `apps/worker/src/handlers/outboundSendHandoff.ts`).
 *     Production runs with sending disabled until the rehearsal gate passes and an
 *     admin enables it (4.2, 16.2), and that state must not page anybody on its own.
 *   * `daily_cap`, `domain_cap`, `outside_email_window` and
 *     `send_unknown_reconciling` are `CLOCK_CLEARING_HOLDS`: the pacing rules of
 *     Appendix D and a fence waiting on Gmail's Sent index. The worker re-asks them on
 *     its own, and a cap reached is the system working as designed.
 *
 * Everything else counts, including a new reason added later, because the failure
 * this alarm exists for — mailbox health, a restore, a provider refusing, a dead job,
 * a send nobody can account for — is the unexpected kind. A counted hold under a pause
 * still counts: the pause does not make a restore hold expected.
 *
 * At a handful of enrollments the fraction is coarse: with one enrollment, one
 * uncertain reply on it reads 1/1. That is literally every active sequence held, by
 * something only a person can clear, and the runbook's first check names the reason.
 */

export const SEQUENCE_METRIC_NAMES: readonly string[] = Object.freeze(['ActiveEnrollments', 'HeldEnrollments']);

/**
 * The hold reasons that do not make an enrollment count as held: every deliberate
 * stop (`scoped_pause`) and the holds that clear with the clock. Derived from
 * `CLOCK_CLEARING_HOLDS` rather than restated, so the gauge and the scheduler agree
 * about which holds wait for time.
 */
export const EXPECTED_HOLD_REASONS: readonly HoldReasonCode[] = Object.freeze(
  HOLD_REASON_CODES.filter(code => code === 'scoped_pause' || CLOCK_CLEARING_HOLDS[code] !== undefined),
);

export interface EnrollmentCounts {
  /** Live enrollments: `active` and `review_required`, over every workspace. */
  readonly active: number;
  /** Live enrollments whose next work is blocked by a counted hold. */
  readonly held: number;
}

/**
 * Count live and held enrollments over every workspace, in one statement.
 *
 * One statement for the reason `listApplicableHolds` is one: the two numbers are a
 * fraction, and reading them at two instants could produce a numerator from after an
 * enrollment ended over a denominator from before.
 */
export async function countEnrollments(db: Queryable): Promise<EnrollmentCounts> {
  const channels = Object.keys(CHANNEL_ACTION_KINDS);
  const actionKinds = Object.values(CHANNEL_ACTION_KINDS);
  const { rows } = await db.query<{ active: string; held: string }>(
    `SELECT count(*)::text AS active,
            count(*) FILTER (WHERE live.held)::text AS held
       FROM (
         SELECT n.state = 'review_required'
                OR EXISTS (
                     SELECT 1
                       FROM step_executions e
                      WHERE e.workspace_id = n.workspace_id
                        AND e.enrollment_id = n.id
                        AND e.state = 'held'
                        AND NOT (e.hold_reason_code = ANY ($1::text[]))
                   )
                OR EXISTS (
                     SELECT 1
                       FROM active_holds h
                      WHERE h.workspace_id = n.workspace_id
                        AND h.released_at IS NULL
                        AND NOT (h.reason_code = ANY ($1::text[]))
                        AND (
                              h.scope_kind = 'workspace'
                              OR (h.scope_kind = 'firm' AND h.scope_key = n.firm_id::text)
                              OR (h.scope_kind = 'opportunity' AND h.scope_key = n.opportunity_id::text)
                              OR (h.scope_kind = 'owner' AND h.scope_key = n.assigned_user_id::text)
                              OR (h.scope_kind = 'enrollment' AND h.scope_key = n.id::text)
                            )
                        AND h.blocked_action_kinds && ARRAY(
                              SELECT 'enrollment_advance'::text
                              UNION ALL
                              SELECT kind.action_kind
                                FROM step_executions u
                                JOIN unnest($2::text[], $3::text[]) AS kind(channel, action_kind)
                                  ON kind.channel = u.channel
                               WHERE u.workspace_id = n.workspace_id
                                 AND u.enrollment_id = n.id
                                 AND u.state IN ('pending', 'held', 'dispatched')
                            )
                   ) AS held
           FROM sequence_enrollments n
          WHERE n.ended_at IS NULL
       ) live`,
    [[...EXPECTED_HOLD_REASONS], channels, actionKinds],
  );
  const row = rows[0];
  return { active: Number(row?.active ?? '0'), held: Number(row?.held ?? '0') };
}

/**
 * Everything the sequences lane publishes on one metric pass: the two counts, always,
 * as `Count` with no dimension. The alarm has none, and 13.3's metrics are aggregate;
 * which workspace and which reason is the runbook's first check.
 */
export async function collectSequenceMetrics(db: Queryable): Promise<readonly MetricDatum[]> {
  const counts = await countEnrollments(db);
  return [
    { name: 'ActiveEnrollments', value: counts.active, unit: 'Count' },
    { name: 'HeldEnrollments', value: counts.held, unit: 'Count' },
  ];
}

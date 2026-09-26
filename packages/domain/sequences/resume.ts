import {
  knownBlockedActionKinds,
  type BlockedActionKind,
  type HoldReasonCode,
  STEP_CHANNELS,
  type StepChannel,
  type StepExecutionState,
} from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import {
  composeHolds,
  decideResume,
  shiftDueInstant,
  type HoldRecord,
  type ResumeDecision,
} from '../src/rules/holds.ts';
import { CHANNEL_ACTION_KINDS, CHANNEL_PAUSE_KEYS } from './eligibility.ts';
import { loadEnrollmentForUpdate, readEnrollment, unexecutedExecutions } from './rows.ts';
import { rescheduleExecution } from './shifts.ts';
import { acceptSequence, isStepChannel, refuseSequence, type EnrollmentRow, type SequenceResult } from './types.ts';
import { holdAppliesSql } from './wake.ts';

/**
 * Releasing holds and resuming an enrollment (specification 4.3, 11.2, Appendix G 28
 * and 31).
 *
 * "When all applicable holds clear, unexecuted work shifts by the union of blocking
 * intervals. Every resume performs a fresh eligibility check."
 *
 * A union longer than seven days used to send the enrollment to `review_required`,
 * where only a person's explicit resume got it out (wave 2, S4.1). Now it resumes on
 * its own like any other: once, by the union, when the last applicable hold clears. An
 * enrollment an older release left in `review_required` is taken by the same path — the
 * scheduler wakes it (`wake.ts`) and `runDueStepExecution` resumes it — so no row waits
 * for a person who has nothing to decide. The safety that matters is not the length of
 * the hold but what is still true when it ends, and that is the fresh eligibility check:
 * suppression and tombstones, coverage, uncertain replies, windows and caps.
 *
 * The arithmetic is G0's, in `packages/domain/src/rules/holds.ts`, and it is a union
 * rather than a sum for the reason that file states: two holds that ran side by side
 * for a day delayed the work by a day. This file is the database half — which holds
 * are *applicable*, and what happens to the rows once the decision is made.
 *
 * ## Why this reads released holds too
 *
 * `listApplicableHolds` answers "is anything blocking right now", which is what an
 * eligibility check wants. The union wants something different: every interval that
 * blocked this enrollment since it started, open or closed. A hold that opened and
 * closed while the enrollment sat still is exactly the thing whose length has to be
 * added, and it is invisible to a query that filters on `released_at IS NULL`.
 *
 * The window starts at the enrollment's own `started_at`, so a hold that closed
 * before this contact was ever enrolled does not push their first email out.
 *
 * ## Only what has not been applied (audit C09)
 *
 * A resume used to count every interval since the enrollment started, every time. The
 * first release of a three-day pause shifted the steps three days; a second, one-day
 * pause a week later shifted them four — the first three again. Every applied resume
 * writes its `hold_union` rows in `step_execution_shifts` at one instant, so the window
 * now starts at the later of the enrollment's start and the last of those rows: an
 * interval is counted by the first resume that applies it and by no later one — the
 * blocking episode that just ended, not the enrollment's lifetime total.
 *
 * ## The holds eligibility asks about (audit C10)
 *
 * The query matches every scope `active_holds` can carry — mailbox and channel
 * included, which it used to omit — through the same `holdAppliesSql` the scheduler's
 * wake uses, and for the action kinds of the work that is actually next: that step's
 * channel and `enrollment_advance`, as `holdSource` asks. A pause of the call channel
 * does not shift an enrollment whose next step is an email.
 *
 * The holds this enrollment's own fences opened are not counted. They are a dispatch
 * attempt waiting on its cap or window, or a send in doubt, and 12.5 says a send
 * confirmed after reconciliation continues "from the original dispatch time" — which
 * the successor's anchor already honours (`successor.ts`) and a shift by the doubt
 * would undo.
 */

/** The action kinds an enrollment's work can be blocked under. */
const ENROLLMENT_ACTION_KINDS: readonly BlockedActionKind[] = Object.freeze([
  'email_send',
  'call_task',
  'enrollment_advance',
]);

interface HoldDbRow {
  readonly id: string;
  readonly reason_code: HoldReasonCode;
  readonly blocked_action_kinds: string[];
  readonly started_at: Date;
  readonly released_at: Date | null;
  readonly [column: string]: unknown;
}

/** The action kinds a step of this channel is blocked under: its own and `enrollment_advance`. */
function actionKindsOf(channel: StepChannel | undefined): readonly BlockedActionKind[] {
  return channel === undefined ? ENROLLMENT_ACTION_KINDS : [CHANNEL_ACTION_KINDS[channel], 'enrollment_advance'];
}

/**
 * Every hold, open or closed, that blocked this enrollment's work since `since`.
 *
 * `channel` is the channel of the enrollment's next unfinished step; absent, every
 * enrollment action kind is asked and no channel pause matches.
 */
export async function holdsAffectingEnrollment(
  context: RepositoryContext,
  input: {
    readonly enrollmentId: string;
    readonly firmId: string;
    readonly opportunityId: string;
    readonly ownerUserId: string;
    readonly since: string;
    readonly channel?: StepChannel | undefined;
  },
): Promise<readonly HoldRecord[]> {
  const applies = holdAppliesSql('h', {
    workspaceId: '$1::uuid',
    firmId: '$3::text',
    opportunityId: '$4::text',
    ownerUserId: '$5::text',
    mailboxId: `(SELECT m.id::text FROM mailboxes m
                  WHERE m.workspace_id = $1::uuid AND m.owner_user_id::text = $5::text)`,
    enrollmentId: '$6::text',
    channelKey: '$7::text',
    actionKinds: '$2::text[]',
  });
  const { rows } = await context.db.query<HoldDbRow>(
    `SELECT h.id, h.reason_code, h.blocked_action_kinds, h.started_at, h.released_at
       FROM active_holds h
      WHERE ${applies}
        AND (h.released_at IS NULL OR h.released_at >= $8::timestamptz)
        AND NOT (h.source_event_kind = 'outbound_message'
                 AND EXISTS (SELECT 1 FROM outbound_messages f
                               JOIN step_executions x
                                 ON x.workspace_id = f.workspace_id AND x.id = f.step_execution_id
                              WHERE f.workspace_id = $1::uuid
                                AND x.enrollment_id::text = $6::text
                                AND f.id::text = h.source_event_id))
      ORDER BY h.started_at, h.id`,
    [
      context.scope.workspaceId,
      [...actionKindsOf(input.channel)],
      input.firmId,
      input.opportunityId,
      input.ownerUserId,
      input.enrollmentId,
      input.channel === undefined ? null : CHANNEL_PAUSE_KEYS[input.channel],
      input.since,
    ],
  );
  return rows.map(row => ({
    id: row.id,
    reasonCode: row.reason_code,
    blockedActionKinds: knownBlockedActionKinds(row.blocked_action_kinds),
    // A hold that opened before the window counts only from the window's start: it
    // did not delay work that did not exist, or that an earlier resume already moved.
    startedAt: (row.started_at.getTime() < Date.parse(input.since)
      ? new Date(Date.parse(input.since))
      : row.started_at
    ).toISOString(),
    releasedAt: row.released_at === null ? null : row.released_at.toISOString(),
  }));
}

/**
 * Where an enrollment's resume window starts: its own start, or the instant the last
 * applied resume moved its steps, whichever is later (C09).
 */
async function resumeWindowStart(
  context: RepositoryContext,
  enrollment: { readonly id: string; readonly startedAt: string },
): Promise<string> {
  const { rows } = await context.db.query<{ at: Date | null }>(
    `SELECT max(shifted_at) AS at FROM step_execution_shifts
      WHERE workspace_id = $1 AND enrollment_id = $2 AND reason = 'hold_union'`,
    [context.scope.workspaceId, enrollment.id],
  );
  const applied = rows[0]?.at ?? null;
  if (applied === null || applied.getTime() <= Date.parse(enrollment.startedAt)) return enrollment.startedAt;
  return applied.toISOString();
}

/**
 * The channel of the enrollment's next unfinished step, if it has one.
 */
async function nextChannel(context: RepositoryContext, enrollmentId: string): Promise<StepChannel | undefined> {
  const { rows } = await context.db.query<{ channel: string }>(
    `SELECT channel FROM step_executions
      WHERE workspace_id = $1 AND enrollment_id = $2 AND state IN ('pending', 'held', 'dispatched')
      ORDER BY ordinal, id LIMIT 1`,
    [context.scope.workspaceId, enrollmentId],
  );
  const channel = rows[0]?.channel;
  return channel !== undefined && isStepChannel(channel) ? channel : undefined;
}

/**
 * The holds, their composition and `decideResume`'s answer for one enrollment, now.
 *
 * One function, called by the resume and by its preview, so that the dates a
 * person reviews are the dates a confirmation applies: the same window, the same next
 * channel, the same action kinds, the same database clock. A preview computed by a
 * second copy of these lines would be a promise the resume need not keep.
 */
async function resumeDecisionFor(
  context: RepositoryContext,
  enrollment: EnrollmentRow,
): Promise<{
  readonly holds: readonly HoldRecord[];
  readonly composition: ReturnType<typeof composeHolds>;
  readonly decision: ResumeDecision;
}> {
  const { rows: clock } = await context.db.query<{ now: Date }>('SELECT now() AS now');
  const now = (clock[0]?.now ?? new Date()).toISOString();

  const channel = await nextChannel(context, enrollment.id);
  const holds = await holdsAffectingEnrollment(context, {
    enrollmentId: enrollment.id,
    firmId: enrollment.firmId,
    opportunityId: enrollment.opportunityId,
    ownerUserId: enrollment.assignedUserId,
    since: await resumeWindowStart(context, enrollment),
    channel,
  });
  const composition = composeHolds({ holds, now, actionKinds: actionKindsOf(channel) });
  return { holds, composition, decision: decideResume(composition) };
}

export interface ResumeOutcome {
  readonly kind: ResumeDecision['kind'];
  readonly shiftMilliseconds: number;
  readonly unionMilliseconds: number;
  readonly openHoldIds: readonly string[];
  readonly executionsShifted: number;
}

/**
 * Reconsider an enrollment's holds and do what the decision says.
 *
 * Two answers, straight from `decideResume`:
 *
 *   * `still_held` — something is open; nothing moves, and the enrollment keeps its
 *     state (an older release's `review_required` included) until the next release.
 *   * `resume` — every unexecuted step moves forward by the union, each move recorded
 *     as a shift, and the enrollment is `active` again, whatever state it was in.
 *
 * Three callers: `runDueStepExecution`, as the first thing it does with a held step the
 * scheduler woke because no open hold blocks it any more, or with any step of an
 * enrollment an older release left in `review_required` (audit C05, wave 2 S4.1); the
 * Today pause's Resume; and `POST /enrollments/resume`, which installed desktops call
 * after the review they show. Releasing a hold is every lane's own statement
 * (`releaseHoldsOfEvent`, `releasePause`, the mailbox proof); none of them has to know
 * that a sequence is waiting, because the wake notices the release on the next pass.
 *
 * The fresh eligibility check 4.3 asks for is the one `runDueStepExecution` performs
 * straight after, inside the same claiming transaction. Doing it here as well would be
 * a second answer at a different instant, which is the thing eligibility composition
 * exists to avoid.
 *
 * A shift that finds no unexecuted step to move — the next step is `dispatched` — writes
 * no row, so its window is counted again by the next resume that does. The successor
 * of a dispatched step is placed by `successor.ts` from the instant it was sent.
 */
export async function resumeEnrollment(
  context: RepositoryContext,
  input: { readonly enrollmentId: string },
): Promise<SequenceResult<ResumeOutcome>> {
  const enrollment = await loadEnrollmentForUpdate(context, input.enrollmentId);
  if (enrollment === null) return refuseSequence('enrollment_unknown');
  if (enrollment.endedAt !== null) return refuseSequence('enrollment_not_live');

  const { composition, decision } = await resumeDecisionFor(context, enrollment);

  if (decision.kind === 'still_held') {
    return acceptSequence({
      kind: 'still_held',
      shiftMilliseconds: 0,
      unionMilliseconds: composition.unionMilliseconds,
      openHoldIds: decision.openHoldIds,
      executionsShifted: 0,
    });
  }

  const shiftMilliseconds = decision.shiftMilliseconds;
  const pending = await unexecutedExecutions(context, enrollment.id);
  let shifted = 0;
  for (const execution of pending) {
    if (shiftMilliseconds <= 0) continue;
    // A step of a channel this lane no longer runs (lane A2) is not moved: it will never
    // be due, and the review showed it unmoved.
    if (!isStepChannel(execution.channel)) continue;
    await rescheduleExecution(context, {
      execution,
      toDueAt: shiftDueInstant(execution.dueAt, shiftMilliseconds),
      reason: 'hold_union',
      holdUnionMilliseconds: composition.unionMilliseconds,
    });
    shifted += 1;
  }

  await context.db.query(
    `UPDATE sequence_enrollments
        SET state = 'active', review_union_milliseconds = NULL, updated_at = now()
      WHERE workspace_id = $1 AND id = $2 AND ended_at IS NULL`,
    [context.scope.workspaceId, enrollment.id],
  );
  // A step held for a reason that has now cleared goes back to pending; a step held
  // for `missing_variables`, whose hold this lane opened and nobody released, stays.
  await context.db.query(
    `UPDATE step_executions
        SET state = 'pending', hold_reason_code = NULL, updated_at = now()
      WHERE workspace_id = $1 AND enrollment_id = $2 AND state = 'held'
        AND hold_reason_code <> 'missing_variables'
        AND channel = ANY($3::text[])`,
    [context.scope.workspaceId, enrollment.id, [...STEP_CHANNELS]],
  );

  return acceptSequence({
    kind: 'resume',
    shiftMilliseconds,
    unionMilliseconds: composition.unionMilliseconds,
    openHoldIds: [],
    executionsShifted: shifted,
  });
}

interface ResumePreviewStepDates {
  readonly stepExecutionId: string;
  readonly ordinal: number;
  /** The instant the step was first planned for, which no shift ever moves (11.2). */
  readonly originalDueAt: string;
  readonly dueAt: string;
  /** Where a confirmed resume moves it. Equal to `dueAt` when nothing would move. */
  readonly proposedDueAt: string;
}

/**
 * One unexecuted step as the review shows it: where it is due now, and where a resume
 * puts it.
 */
export type ResumePreviewStep = ResumePreviewStepDates & {
  readonly channel: StepChannel;
  readonly state: StepExecutionState;
};

/** A hold that delayed this enrollment's work in the window the resume would apply. */
export interface ResumePreviewHold {
  readonly reasonCode: HoldReasonCode;
  readonly startedAt: string;
  readonly releasedAt: string | null;
}

/**
 * What "Review and resume" shows before anything is pressed (4.3; audit G06).
 *
 * `kind` is `decideResume`'s answer. `still_held` means something is open and a resume
 * would move nothing; `resume` means a confirmation would shift every unexecuted step by
 * `shiftMilliseconds`, which `steps` has already applied. Installed desktops up to 1.0.11
 * show it for an enrollment an older release left in `review_required`.
 */
export interface ResumePreview {
  readonly enrollmentId: string;
  readonly kind: ResumeDecision['kind'];
  readonly unionMilliseconds: number;
  readonly shiftMilliseconds: number;
  readonly openHoldIds: readonly string[];
  /** The zone every due instant of this enrollment is resolved in, frozen at enrolment. */
  readonly firmTimeZone: string;
  readonly holds: readonly ResumePreviewHold[];
  readonly steps: readonly ResumePreviewStep[];
}

/**
 * The dates a resume would give the unexecuted steps (audit G06).
 *
 * A read, and nothing else: no lock and no state change. It computes what
 * `resumeEnrollment` would do at this instant with the same function that does it, and
 * applies the shift to each unexecuted step with the same `shiftDueInstant`. The
 * confirmation that follows runs the decision again under its lock, because a hold may
 * open in between and the resume, not the preview, is the thing that has to be right.
 *
 * A salesperson may preview only their own enrollment; an admin any. The dates are due
 * instants, not send times: an email still waits for its window and its cap.
 */
export async function previewResume(
  context: RepositoryContext,
  input: { readonly enrollmentId: string },
): Promise<SequenceResult<ResumePreview>> {
  const enrollment = await readEnrollment(context, { enrollmentId: input.enrollmentId });
  if (enrollment === null) return refuseSequence('enrollment_unknown');
  const actor = context.scope.actor;
  if (actor.kind === 'user' && actor.role !== 'admin' && enrollment.assignedUserId !== actor.userId) {
    return refuseSequence('not_assigned');
  }
  if (enrollment.endedAt !== null) return refuseSequence('enrollment_not_live');

  const { holds, composition, decision } = await resumeDecisionFor(context, enrollment);
  const shift = decision.kind === 'still_held' ? 0 : decision.shiftMilliseconds;
  const pending = await unexecutedExecutions(context, enrollment.id, { lock: false });

  return acceptSequence({
    enrollmentId: enrollment.id,
    kind: decision.kind,
    unionMilliseconds: composition.unionMilliseconds,
    shiftMilliseconds: shift,
    openHoldIds: decision.kind === 'still_held' ? decision.openHoldIds : [],
    firmTimeZone: enrollment.firmTimeZone,
    holds: holds.map(hold => ({ reasonCode: hold.reasonCode, startedAt: hold.startedAt, releasedAt: hold.releasedAt })),
    steps: pending.map((execution): ResumePreviewStep => {
      const dates = {
        stepExecutionId: execution.id,
        ordinal: execution.ordinal,
        originalDueAt: execution.originalDueAt,
        dueAt: execution.dueAt,
      };
      return {
        ...dates,
        channel: execution.channel,
        state: execution.state,
        proposedDueAt: shift > 0 ? shiftDueInstant(execution.dueAt, shift) : execution.dueAt,
      };
    }),
  });
}

import type { HoldReasonCode } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { openHold } from '../policy/index.ts';
import { placeEmailSend, resolveStepDue, type WorkspaceHolidayCalendar } from '../src/index.ts';
import { readTemplateVersion, renderTemplateVersion } from '../templates/index.ts';
import { businessDateOf } from '../today/index.ts';
import { calendarOfEnrollment, completeEnrollment, stepForCadence, stopEnrollments } from './enrollments.ts';
import { CHANNEL_ACTION_KINDS, type StepEligibility } from './eligibility.ts';
import {
  loadEnrollmentForUpdate,
  loadStepExecutionForUpdate,
  nextUnfinishedExecution,
  readSequenceVersion,
  readStepExecution,
} from './rows.ts';
import { SEND_HANDOFF_REFUSALS, type OutboundEmailRequest, type SendHandoff } from './sendHandoff.ts';
import {
  acceptSequence,
  refuseSequence,
  type EnrollmentRow,
  type SequenceResult,
  type SequenceStepRow,
  type SequenceVersionRow,
  type StepChannel,
  type StepCompletionSource,
  type StepExecutionRow,
  type StepResult,
} from './types.ts';
import { templateVariablesFor } from './variables.ts';

/**
 * Running a due step (specification 11.2, 11.3, 12.2, Appendix B, Appendix C).
 *
 * One function is the whole of the worker's `sequence.action` handler:
 * `runDueStepExecution`. It re-reads eligibility inside the claiming transaction,
 * places an email in the firm's own window, renders it, and hands it to the send —
 * or holds the step with the reason that stopped it.
 *
 * ## The four answers, and why there is no fifth
 *
 * * `handed_to_send` — the bytes are decided and the fence is G7-2's from here.
 * * `scheduled` — the step was due outside a sending window, so its due instant moved
 *   to the next one and a shift was recorded. This is not a hold: nothing is wrong,
 *   the work is simply not at 03:00 on a Sunday.
 * * `awaiting_manual` — a call or LinkedIn task is due, and the only thing that can
 *   complete it is a person. The worker's job on these is to make them visible on
 *   Today, which the Today source does from the same rows.
 * * `held` — one of the eleven eligibility questions said no, with the reason code
 *   section 15 gives it.
 *
 * There is deliberately no "sent" among them. `runDueStepExecution` decides bytes and
 * prepares a fence; it never learns that something was sent. That happens one function
 * later, in `dispatchPreparedStep`, which runs after the step's transaction has
 * committed and reads the fence rather than assuming it
 * (`docs/decisions/g8-this-lane-dispatches.md`), and in `completeEmailStep`, which is
 * what an administrator's unknown-terminal resolution lands in.
 *
 * ## Which holds this lane opens
 *
 * Exactly one: `missing_variables`. 11.1 makes it this lane's — nobody else can see
 * that a template's required variable has no eligible CRM value — and section 15
 * makes it a recoverable hold with a control. Every other refusal already *is* a
 * hold somebody else opened, or a cap the sending lane re-reads inside its own
 * fence, and opening a second row for it would be a second thing to clear.
 */

export const LINKEDIN_UNDO_WINDOW_MILLISECONDS = 10 * 60 * 1000;

/**
 * The hold reasons that clear with the clock rather than with a person, and how long
 * the step waits before asking again.
 *
 * Every other reason in section 15 is cleared by somebody: an administrator lifts a
 * pause, an approver approves a template, a salesperson fixes a route, and the
 * release re-arms the step through `resumeEnrollment`. These four are not — a daily
 * cap ends with the business date, a domain guard with its rolling window, a window
 * with the firm's morning, and a reconciling fence with the Gmail Sent folder — so a
 * step held for one of them is put back on the queue instead of waiting for a person
 * who has nothing to do. `not_before` is what keeps that from being a spin: the step
 * is invisible to the scheduler until the interval has passed.
 *
 * `due_at` deliberately does not move, so no shift row is written: the cadence still
 * says what it said, and only the earliest moment the worker may look again changes.
 */
export const CLOCK_CLEARING_HOLDS: Partial<Record<HoldReasonCode, number>> = {
  daily_cap: 60 * 60 * 1000,
  domain_cap: 60 * 60 * 1000,
  outside_email_window: 60 * 60 * 1000,
  send_unknown_reconciling: 5 * 60 * 1000,
};

export type StepRunOutcome =
  | {
      readonly kind: 'handed_to_send';
      readonly stepExecutionId: string;
      readonly outboundMessageId: string;
      readonly sendAt: string;
    }
  | { readonly kind: 'scheduled'; readonly stepExecutionId: string; readonly sendAt: string }
  | {
      readonly kind: 'awaiting_manual';
      readonly stepExecutionId: string;
      readonly channel: StepChannel;
    }
  | {
      readonly kind: 'held';
      readonly stepExecutionId: string;
      readonly reasonCode: HoldReasonCode;
    }
  | { readonly kind: 'not_due'; readonly stepExecutionId: string; readonly notBefore: string }
  | { readonly kind: 'nothing_to_do' };

export interface RunDueStepInput {
  /** One of the two. The worker's job payload names an execution; tests name an enrollment. */
  readonly stepExecutionId?: string | undefined;
  readonly enrollmentId?: string | undefined;
  /** Database time, passed in. Nothing in this file reads a clock. */
  readonly now: string;
  readonly eligibility: StepEligibility;
  readonly sendHandoff: SendHandoff;
}

export async function runDueStepExecution(
  context: RepositoryContext,
  input: RunDueStepInput,
): Promise<StepRunOutcome> {
  const execution =
    input.stepExecutionId !== undefined
      ? await loadStepExecutionForUpdate(context, input.stepExecutionId)
      : input.enrollmentId === undefined
        ? null
        : await nextUnfinishedExecution(context, input.enrollmentId);
  if (execution === null) return { kind: 'nothing_to_do' };
  if (execution.state !== 'pending' && execution.state !== 'held') {
    return { kind: 'nothing_to_do' };
  }

  const enrollment = await loadEnrollmentForUpdate(context, execution.enrollmentId);
  if (enrollment === null) return { kind: 'nothing_to_do' };
  if (enrollment.endedAt !== null) return { kind: 'nothing_to_do' };
  if (enrollment.state === 'review_required') {
    // 4.3: "the enrollment remains held for salesperson review and explicit resume".
    return await holdExecution(context, execution, 'long_hold_review');
  }

  if (Date.parse(execution.notBefore) > Date.parse(input.now)) {
    return { kind: 'not_due', stepExecutionId: execution.id, notBefore: execution.notBefore };
  }

  const eligible = await input.eligibility.evaluate(context, {
    execution,
    opportunityId: enrollment.opportunityId,
    firmId: enrollment.firmId,
    contactId: enrollment.contactId,
    ownerUserId: enrollment.assignedUserId,
    channel: execution.channel,
    actionKind: CHANNEL_ACTION_KINDS[execution.channel],
    now: input.now,
  });
  if (!eligible.ok) return await holdExecution(context, execution, eligible.reasonCode);

  if (execution.channel !== 'email') {
    // A call task and a LinkedIn task are completed by a person. Clearing a stale
    // hold is the whole of the state change; the Today source makes it visible.
    if (execution.state === 'held') await clearExecutionHold(context, execution.id);
    return { kind: 'awaiting_manual', stepExecutionId: execution.id, channel: execution.channel };
  }

  return await runEmailStep(context, { execution, enrollment, ...input });
}

async function runEmailStep(
  context: RepositoryContext,
  input: RunDueStepInput & { readonly execution: StepExecutionRow; readonly enrollment: EnrollmentRow },
): Promise<StepRunOutcome> {
  const { execution, enrollment } = input;
  const calendar = await calendarOfEnrollment(context, enrollment);

  // 11.2 and Appendix G 32. A due instant already inside a window stays where it is;
  // anything else moves to the next window's morning, and the move is recorded.
  const placement = placeEmailSend(execution.dueAt, enrollment.firmTimeZone, { calendar });
  if (!placement.inPlace) {
    await rescheduleExecution(context, {
      execution,
      toDueAt: placement.sendAt,
      reason: 'send_window',
    });
    return { kind: 'scheduled', stepExecutionId: execution.id, sendAt: placement.sendAt };
  }
  // The window opened before now, but the step is only released once the clock
  // reaches its own due instant.
  if (Date.parse(execution.dueAt) > Date.parse(input.now)) {
    return { kind: 'not_due', stepExecutionId: execution.id, notBefore: execution.dueAt };
  }

  const step = await stepOf(context, execution);
  if (step === null || step.templateVersionId === null) {
    return await holdExecution(context, execution, 'template_unapproved');
  }
  const template = await readTemplateVersion(context, step.templateVersionId);
  if (template === null || template.approvedAt === null) {
    return await holdExecution(context, execution, 'template_unapproved');
  }

  const values = await templateVariablesFor(context, {
    firmId: enrollment.firmId,
    contactId: enrollment.contactId,
  });
  const rendered = renderTemplateVersion(template, values);
  if (!rendered.rendered) {
    // 11.1: "Missing required variables hold the step." This is the one hold this
    // lane opens itself, because it is the one nobody else can see.
    return await holdExecution(context, execution, 'missing_variables', {
      openHoldRow: true,
      detail: rendered.missing,
    });
  }

  const route = await usableEmailRoute(context, enrollment.contactId);
  if (route === null) return await holdExecution(context, execution, 'route_missing');

  const request: OutboundEmailRequest = {
    enrollmentId: enrollment.id,
    stepExecutionId: execution.id,
    opportunityId: enrollment.opportunityId,
    firmId: enrollment.firmId,
    contactId: enrollment.contactId,
    ownerUserId: enrollment.assignedUserId,
    templateVersionId: template.id,
    templateContentHash: template.contentHash,
    emailAddressId: route.id,
    toAddress: route.address,
    subject: rendered.subject,
    body: rendered.body,
    sendAt: placement.sendAt,
    sourceZone: placement.sourceZone,
    ruleVersion: execution.ruleVersion,
    // Appendix D: the daily cap counts in the workspace business zone, and the date
    // is PostgreSQL's so that the cap and the placement agree about midnight.
    businessDate: await businessDateOf(context, placement.sendAt),
  };
  const prepared = await input.sendHandoff.prepare(context, request);
  if (!prepared.ok) return await holdExecution(context, execution, prepared.reason);

  await context.db.query(
    `UPDATE step_executions SET state = 'dispatched', hold_reason_code = NULL, updated_at = now()
      WHERE workspace_id = $1 AND id = $2`,
    [context.scope.workspaceId, execution.id],
  );
  return {
    kind: 'handed_to_send',
    stepExecutionId: execution.id,
    outboundMessageId: prepared.outboundMessageId,
    sendAt: placement.sendAt,
  };
}

export type DispatchStepOutcome =
  | { readonly kind: 'sent'; readonly stepExecutionId: string }
  | { readonly kind: 'held'; readonly stepExecutionId: string; readonly reasonCode: HoldReasonCode }
  | { readonly kind: 'nothing_to_do' };

/**
 * Dispatch the fence a due email step prepared, and move the step to what it became.
 *
 * Appendix C has no send job kind. The coordinator settled the consequence: nobody on
 * the sending lane's side picks a prepared fence up, so the lane that prepared it is
 * the lane that dispatches it. `runDueStepExecution` prepares inside the step's
 * transaction; this runs *after* that transaction commits, because
 * `prepared → dispatching` and the provider call after it cannot be rolled back.
 *
 * It dispatches only while the fence still reads `prepared`. That is the whole of the
 * at-most-once discipline on this side: a retry after a stolen lease re-prepares the
 * same fence (prepare is idempotent by step execution), reads a state that is no
 * longer `prepared`, and reports rather than sends again.
 *
 * A held fence is not terminal — G7-2's `g7-held-returns-to-prepared` says a cap that
 * clears puts it back — so the step is held with the cap's own reason and a
 * `not_before` from `CLOCK_CLEARING_HOLDS`, and the scheduler asks again later.
 */
export async function dispatchPreparedStep(
  context: RepositoryContext,
  input: {
    readonly stepExecutionId: string;
    readonly outboundMessageId: string;
    readonly sendHandoff: SendHandoff;
    readonly now: string;
  },
): Promise<DispatchStepOutcome> {
  const execution = await readStepExecution(context, input.stepExecutionId);
  if (execution === null || execution.state !== 'dispatched') return { kind: 'nothing_to_do' };

  let fence = await input.sendHandoff.readOutcome(context, execution.id);
  if (fence.state === 'prepared') {
    const dispatched = await input.sendHandoff.dispatch(context, {
      outboundMessageId: input.outboundMessageId,
      stepExecutionId: execution.id,
    });
    if (!dispatched.ok) return await heldStep(context, execution, dispatched.reason);
    fence = await input.sendHandoff.readOutcome(context, execution.id);
  }

  if (fence.state === 'sent') {
    await completeEmailStep(context, {
      stepExecutionId: execution.id,
      result: 'sent',
      at: fence.dispatchedAt ?? input.now,
    });
    return { kind: 'sent', stepExecutionId: execution.id };
  }
  if (fence.state === 'held') {
    return await heldStep(context, execution, holdReasonFrom(fence.heldReason));
  }
  if (fence.state === 'unknown_terminal') {
    // Appendix B: an administrator marks it delivered or skipped; both land in
    // `completeEmailStep`. Until then the step waits, visible and named.
    return await heldStep(context, execution, 'send_unknown_terminal');
  }
  // `dispatching`, `reconciling` and the absent fence of a lane with no send wired.
  return await heldStep(context, execution, 'send_unknown_reconciling');
}

async function heldStep(
  context: RepositoryContext,
  execution: StepExecutionRow,
  reasonCode: HoldReasonCode,
): Promise<DispatchStepOutcome> {
  await holdExecution(context, execution, reasonCode);
  return { kind: 'held', stepExecutionId: execution.id, reasonCode };
}

/** A fence's own held reason, if it is one of section 15's; `scoped_pause` otherwise. */
function holdReasonFrom(reason: string | null): HoldReasonCode {
  const known: readonly string[] = SEND_HANDOFF_REFUSALS;
  return reason !== null && known.includes(reason) ? (reason as HoldReasonCode) : 'scoped_pause';
}

async function stepOf(
  context: RepositoryContext,
  execution: StepExecutionRow,
): Promise<SequenceStepRow | null> {
  const enrollment = await loadEnrollmentForUpdate(context, execution.enrollmentId);
  if (enrollment === null) return null;
  const version = await readSequenceVersion(context, enrollment.sequenceVersionId);
  return version?.steps.find(step => step.id === execution.stepId) ?? null;
}

async function usableEmailRoute(
  context: RepositoryContext,
  contactId: string,
): Promise<{ readonly id: string; readonly address: string } | null> {
  const { rows } = await context.db.query<{ id: string; address: string }>(
    `SELECT id, address FROM email_addresses
      WHERE workspace_id = $1 AND contact_id = $2 AND eligibility = 'usable' AND retired_at IS NULL
      ORDER BY created_at, id LIMIT 1`,
    [context.scope.workspaceId, contactId],
  );
  const row = rows[0];
  return row === undefined ? null : { id: row.id, address: row.address };
}

/**
 * Hold a step with the reason that stopped it.
 *
 * The execution's own `hold_reason_code` is always written, because that is what a
 * card reads. An `active_holds` row is written only when `openHoldRow` says so —
 * every other reason already has one, and 4.3's "clearing one hold never clears
 * another" would be a lie if this lane copied somebody else's hold into a second row
 * that nobody's release statement matches.
 */
async function holdExecution(
  context: RepositoryContext,
  execution: StepExecutionRow,
  reasonCode: HoldReasonCode,
  options: { readonly openHoldRow?: boolean; readonly detail?: readonly string[] } = {},
): Promise<StepRunOutcome> {
  await context.db.query(
    `UPDATE step_executions
        SET state = 'held', hold_reason_code = $3,
            not_before = CASE WHEN $4::double precision > 0
                              THEN GREATEST(not_before, now() + ($4 * interval '1 millisecond'))
                              ELSE not_before END,
            updated_at = now()
      WHERE workspace_id = $1 AND id = $2 AND state IN ('pending', 'held', 'dispatched')`,
    [context.scope.workspaceId, execution.id, reasonCode, CLOCK_CLEARING_HOLDS[reasonCode] ?? 0],
  );

  if (options.openHoldRow === true) {
    const { rows } = await context.db.query<{ id: string }>(
      `SELECT id FROM active_holds
        WHERE workspace_id = $1 AND released_at IS NULL AND reason_code = $2
          AND scope_kind = 'enrollment' AND scope_key = $3`,
      [context.scope.workspaceId, reasonCode, execution.enrollmentId],
    );
    if (rows.length === 0) {
      await openHold(context, {
        scopeKind: 'enrollment',
        scopeKey: execution.enrollmentId,
        reasonCode,
        blockedActionKinds: [CHANNEL_ACTION_KINDS[execution.channel]],
        sourceEventKind: 'sequence.step_execution',
        sourceEventId: execution.id,
        recoveryAction: 'resume_after_review',
      });
    }
  }
  return { kind: 'held', stepExecutionId: execution.id, reasonCode };
}

async function clearExecutionHold(context: RepositoryContext, stepExecutionId: string): Promise<void> {
  await context.db.query(
    `UPDATE step_executions SET state = 'pending', hold_reason_code = NULL, updated_at = now()
      WHERE workspace_id = $1 AND id = $2 AND state = 'held'`,
    [context.scope.workspaceId, stepExecutionId],
  );
}

export interface RescheduleInput {
  readonly execution: StepExecutionRow;
  readonly toDueAt: string;
  readonly reason: 'hold_union' | 'send_window' | 'migration' | 'retry_call' | 'linkedin_grace';
  readonly holdUnionMilliseconds?: number | undefined;
  readonly sourceEventId?: string | undefined;
}

/**
 * Move an unexecuted step forward and record why.
 *
 * `original_due_at` never moves, and the shift row is append-only, so "original and
 * shifted timing history" (11.2) survives every later move. A shift that would move
 * work earlier is refused by the database rather than clamped here, because a caller
 * asking to move a send earlier has a bug this should not hide.
 */
export async function rescheduleExecution(
  context: RepositoryContext,
  input: RescheduleInput,
): Promise<void> {
  const from = input.execution.dueAt;
  const shift = Date.parse(input.toDueAt) - Date.parse(from);
  if (shift <= 0) return;

  await context.db.query(
    `UPDATE step_executions
        SET due_at = $3::timestamptz,
            not_before = GREATEST(not_before, $3::timestamptz),
            updated_at = now()
      WHERE workspace_id = $1 AND id = $2 AND state IN ('pending', 'held')`,
    [context.scope.workspaceId, input.execution.id, input.toDueAt],
  );
  await context.db.query(
    `INSERT INTO step_execution_shifts
       (workspace_id, step_execution_id, enrollment_id, from_due_at, to_due_at,
        shift_milliseconds, reason, hold_union_milliseconds, source_event_id)
     VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6, $7, $8, $9)`,
    [
      context.scope.workspaceId,
      input.execution.id,
      input.execution.enrollmentId,
      from,
      input.toDueAt,
      shift,
      input.reason,
      input.holdUnionMilliseconds ?? null,
      input.sourceEventId ?? null,
    ],
  );
}

export interface CompleteStepInput {
  readonly stepExecutionId: string;
  readonly completionSource: StepCompletionSource;
  readonly result: StepResult;
  /** The instant the completion happened. The successor's delay is not counted from it. */
  readonly completedAt?: string | undefined;
  /** 11.3's ten-minute grace on the successor. */
  readonly successorNotBeforeMilliseconds?: number | undefined;
}

export interface CompletedStep {
  readonly stepExecutionId: string;
  readonly completionSource: StepCompletionSource;
  readonly result: StepResult;
  readonly successorExecutionId: string | null;
  readonly successorNotBefore: string | null;
  readonly enrollmentCompleted: boolean;
}

/**
 * Complete a step and create its successor, in one transaction (Appendix A).
 *
 * The successor's due instant is start-anchored: counted from the instant the
 * enrollment began, not from this completion. That is G0's ported rule
 * (`packages/domain/src/rules/cadence.ts`) and the reason is unchanged — a firm that
 * sat in a queue should not have its whole cadence pushed out by the wait.
 *
 * The grace period is the exception, and it is a `not_before` rather than a due
 * instant: 11.3's ten minutes are an undo window, not a delay, and putting them in
 * `due_at` would make the cadence a different shape from the one the salesperson
 * reviewed.
 */
export async function completeStepExecution(
  context: RepositoryContext,
  input: CompleteStepInput,
): Promise<SequenceResult<CompletedStep>> {
  const execution = await loadStepExecutionForUpdate(context, input.stepExecutionId);
  if (execution === null) return refuseSequence('execution_unknown');
  if (execution.state === 'completed' || execution.state === 'cancelled') {
    return refuseSequence('execution_not_pending');
  }
  const enrollment = await loadEnrollmentForUpdate(context, execution.enrollmentId);
  if (enrollment === null) return refuseSequence('enrollment_unknown');
  if (enrollment.endedAt !== null) return refuseSequence('enrollment_not_live');

  await context.db.query(
    `UPDATE step_executions
        SET state = 'completed', completed_at = coalesce($3::timestamptz, now()),
            completion_source = $4, result = $5, hold_reason_code = NULL, updated_at = now()
      WHERE workspace_id = $1 AND id = $2`,
    [
      context.scope.workspaceId,
      execution.id,
      input.completedAt ?? null,
      input.completionSource,
      input.result,
    ],
  );

  const successor = await createSuccessor(context, {
    enrollment,
    afterOrdinal: execution.ordinal,
    notBeforeMilliseconds: input.successorNotBeforeMilliseconds ?? 0,
  });
  if (successor === null) {
    await completeEnrollment(context, enrollment.id);
    return acceptSequence({
      stepExecutionId: execution.id,
      completionSource: input.completionSource,
      result: input.result,
      successorExecutionId: null,
      successorNotBefore: null,
      enrollmentCompleted: true,
    });
  }
  return acceptSequence({
    stepExecutionId: execution.id,
    completionSource: input.completionSource,
    result: input.result,
    successorExecutionId: successor.id,
    successorNotBefore: successor.notBefore,
    enrollmentCompleted: false,
  });
}

interface SuccessorInput {
  readonly enrollment: EnrollmentRow;
  readonly afterOrdinal: number;
  readonly notBeforeMilliseconds: number;
}

/** The next step of the frozen version, or null when the plan has run out. */
async function createSuccessor(
  context: RepositoryContext,
  input: SuccessorInput,
): Promise<{ readonly id: string; readonly notBefore: string } | null> {
  const version = await readSequenceVersion(context, input.enrollment.sequenceVersionId);
  if (version === null) return null;
  const next = version.steps.find(step => step.ordinal === input.afterOrdinal + 1);
  if (next === undefined) return null;

  const calendar = await calendarOfEnrollment(context, input.enrollment);
  const due = resolveStepDue(
    stepForCadence(next),
    input.enrollment.startedAt,
    input.enrollment.firmTimeZone,
    calendar,
  );
  const { rows: clock } = await context.db.query<{ now: Date }>('SELECT now() AS now');
  const now = (clock[0]?.now ?? new Date()).toISOString();
  const notBefore = new Date(Date.parse(now) + input.notBeforeMilliseconds).toISOString();

  const { rows } = await context.db.query<{ id: string; not_before: Date }>(
    `INSERT INTO step_executions
       (workspace_id, enrollment_id, step_id, firm_id, contact_id, channel, ordinal,
        due_at, not_before, original_due_at, source_zone, rule_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz,
             GREATEST($8::timestamptz, $9::timestamptz), $8::timestamptz, $10, $11)
     ON CONFLICT ON CONSTRAINT step_executions_one_per_step DO NOTHING
     RETURNING id, not_before`,
    [
      context.scope.workspaceId,
      input.enrollment.id,
      next.id,
      input.enrollment.firmId,
      input.enrollment.contactId,
      next.channel,
      next.ordinal,
      due.dueAt,
      notBefore,
      due.sourceZone,
      due.ruleVersion,
    ],
  );
  const created = rows[0];
  if (created === undefined) return null;
  return { id: created.id, notBefore: created.not_before.toISOString() };
}

/**
 * What Appendix B's unknown-terminal resolution does to a sequence, and what a
 * successful send does.
 *
 * G7-2 calls this from its own transaction: `sent` continues the cadence from the
 * original dispatch time, `skipped` stops the enrollment terminally for salesperson
 * review, and neither ever releases the same step for a resend. It is a function
 * rather than a port because it is this lane's business rule; a port would let
 * somebody supply a different one, and "marked skipped stops and never resends" is
 * not a thing another lane should be able to redefine.
 */
export async function completeEmailStep(
  context: RepositoryContext,
  input: {
    readonly stepExecutionId: string;
    readonly result: 'sent' | 'skipped' | 'no_email';
    /** The original dispatch instant, for `sent`. Appendix B's "from the original dispatch time". */
    readonly at?: string | undefined;
  },
): Promise<SequenceResult<CompletedStep>> {
  const execution = await readStepExecution(context, input.stepExecutionId);
  if (execution === null) return refuseSequence('execution_unknown');
  if (execution.channel !== 'email') return refuseSequence('execution_wrong_channel');

  if (input.result === 'skipped') {
    await context.db.query(
      `UPDATE step_executions
          SET state = 'completed', completed_at = coalesce($3::timestamptz, now()),
              completion_source = 'admin', result = 'skipped', hold_reason_code = NULL, updated_at = now()
        WHERE workspace_id = $1 AND id = $2 AND state <> 'completed'`,
      [context.scope.workspaceId, execution.id, input.at ?? null],
    );
    await stopEnrollments(context, {
      enrollmentId: execution.enrollmentId,
      reason: 'send_skipped',
    });
    return acceptSequence({
      stepExecutionId: execution.id,
      completionSource: 'admin',
      result: 'skipped',
      successorExecutionId: null,
      successorNotBefore: null,
      enrollmentCompleted: false,
    });
  }

  return await completeStepExecution(context, {
    stepExecutionId: execution.id,
    completionSource: input.result === 'sent' ? 'send' : 'admin',
    result: input.result,
    ...(input.at === undefined ? {} : { completedAt: input.at }),
  });
}

export type { SequenceVersionRow, WorkspaceHolidayCalendar };

import type { HoldReasonCode } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { openHold, releaseHoldsOfEvent } from '../policy/index.ts';
import { placeEmailSend, type WorkspaceHolidayCalendar } from '../src/index.ts';
import { readTemplateVersion, renderTemplateVersion } from '../templates/index.ts';
import { businessDateOf } from '../today/index.ts';
import { calendarOfEnrollment, completeEnrollment, stepForCadence, stopEnrollments } from './enrollments.ts';
import { CHANNEL_ACTION_KINDS, type StepEligibility } from './eligibility.ts';
import { resumeEnrollment } from './resume.ts';
import {
  loadEnrollmentForUpdate,
  loadStepExecutionForUpdate,
  lockStepWithEnrollment,
  nextUnfinishedExecution,
  readSequenceVersion,
  readStepExecution,
} from './rows.ts';
import {
  SEND_HANDOFF_REFUSALS,
  type OutboundEmailRequest,
  type OutboundFenceOutcome,
  type SendHandoff,
} from './sendHandoff.ts';
import { rescheduleExecution } from './shifts.ts';
import { successorDue } from './successor.ts';
import { BLOCKING_HOLD_SQL } from './wake.ts';
import {
  acceptSequence,
  isStepChannel,
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

export { rescheduleExecution, type RescheduleInput } from './shifts.ts';

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
 * * `awaiting_manual` — a call task is due, and the only thing that can complete it
 *   is a person. The worker's job on these is to make them visible on Today, which
 *   the Today source does from the same rows.
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
 * ## A step is run more than once (lane g82)
 *
 * The scheduler wakes a step again whenever its row has moved and it is due: a held
 * step whose `not_before` has passed and that no open hold blocks, and a `dispatched`
 * step whose worker went quiet (`wake.ts`). So `runDueStepExecution` begins from what
 * already happened rather than assuming nothing did:
 *
 * * an email step that already has a fence is driven from the fence. `sent` completes
 *   the step from the original dispatch instant; `dispatching` and `reconciling` hold
 *   it while Gmail's Sent folder decides; `unknown_terminal` waits for the admin's
 *   answer and then continues or stops the sequence (12.5, Appendix B); `prepared` and
 *   `held` — nothing ever reached Gmail — are handed to the dispatch path again, which
 *   rechecks everything under the send gate and claims atomically or not at all;
 * * a held step is resumed first (`resumeEnrollment`): 4.3's shift by the union of the
 *   holds that just cleared, and then the fresh eligibility check in the same
 *   transaction (audit C05). So is any step of an enrollment an older release left in
 *   `review_required`: a long hold resumes on its own since wave 2 (S4.1).
 *
 * Two more answers follow from that: `completed`, when the fence says the step is
 * done, and a `handed_to_send` for a fence that already existed.
 *
 * ## Which holds this lane opens
 *
 * Exactly one: `missing_variables`. 11.1 makes it this lane's — nobody else can see
 * that a template's required variable has no eligible CRM value — and section 15
 * makes it a recoverable hold with a control. Every other refusal already *is* a
 * hold somebody else opened, or a cap the sending lane re-reads inside its own
 * fence, and opening a second row for it would be a second thing to clear.
 */

/**
 * The hold reasons that clear with the clock rather than with a person, and how long
 * the step waits before asking again.
 *
 * Every other reason in section 15 is cleared by somebody: an administrator lifts a
 * pause, an approver approves a template, a salesperson fixes a route, and the
 * release re-arms the step through `resumeEnrollment`. These three are not — a daily
 * cap ends with the business date, a window with the firm's morning, and a
 * reconciling fence with the Gmail Sent folder — so a
 * step held for one of them is put back on the queue instead of waiting for a person
 * who has nothing to do. `not_before` is what keeps that from being a spin: the step
 * is invisible to the scheduler until the interval has passed.
 *
 * `due_at` deliberately does not move, so no shift row is written: the cadence still
 * says what it said, and only the earliest moment the worker may look again changes.
 */
export const CLOCK_CLEARING_HOLDS: Partial<Record<HoldReasonCode, number>> = {
  daily_cap: 60 * 60 * 1000,
  outside_email_window: 60 * 60 * 1000,
  send_unknown_reconciling: 5 * 60 * 1000,
};

/**
 * How long a step held for any *other* reason waits before it is asked again, when no
 * open hold row explains it (lane g82).
 *
 * A step held because an open hold blocks it is not asked at all until that hold is
 * released — `holdExecution` leaves its `not_before` where it was and the wake skips it
 * while the hold is open. The reasons no hold row stands behind — a route that is
 * missing, a template not yet approved, coverage that went stale for a moment, a
 * mailbox never connected — have nobody to release them, and before lane g82 a step
 * held for one of them waited for ever. It is asked again after this long instead.
 *
 * `send_unknown_terminal` is shorter because the thing it waits for is an
 * administrator's answer, and the step should continue soon after it is given.
 */
export const HOLD_RECHECK_MILLISECONDS: Partial<Record<HoldReasonCode, number>> = {
  send_unknown_terminal: 15 * 60 * 1000,
};

/** The recheck for every reason neither table names. */
export const DEFAULT_HOLD_RECHECK_MILLISECONDS = 60 * 60 * 1000;

/** How long a step held for this reason waits before the scheduler may ask again. */
export function holdRecheckMilliseconds(reasonCode: HoldReasonCode): number {
  return (
    CLOCK_CLEARING_HOLDS[reasonCode] ?? HOLD_RECHECK_MILLISECONDS[reasonCode] ?? DEFAULT_HOLD_RECHECK_MILLISECONDS
  );
}

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
  | {
      readonly kind: 'completed';
      readonly stepExecutionId: string;
      readonly result: 'sent' | 'skipped';
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

const NO_FENCE: OutboundFenceOutcome = { state: 'absent', dispatchedAt: null, heldReason: null };

export async function runDueStepExecution(
  context: RepositoryContext,
  input: RunDueStepInput,
): Promise<StepRunOutcome> {
  // The enrollment is locked before the step, the order the resume command takes too
  // (`lockStepWithEnrollment`): the scheduler resumes `review_required` enrollments
  // since wave 2, and two orders on one enrollment could deadlock.
  let loaded: StepExecutionRow | null = null;
  let enrollment: EnrollmentRow | null = null;
  if (input.stepExecutionId !== undefined) {
    ({ execution: loaded, enrollment } = await lockStepWithEnrollment(context, input.stepExecutionId));
  } else if (input.enrollmentId !== undefined) {
    enrollment = await loadEnrollmentForUpdate(context, input.enrollmentId);
    loaded = enrollment === null ? null : await nextUnfinishedExecution(context, input.enrollmentId);
  }
  if (loaded === null) return { kind: 'nothing_to_do' };
  // `dispatched` is runnable since lane g82 (audit C03): its fence may still be
  // `prepared` because the worker that prepared it died before the claim.
  if (loaded.state !== 'pending' && loaded.state !== 'held' && loaded.state !== 'dispatched') {
    return { kind: 'nothing_to_do' };
  }

  if (enrollment === null) return { kind: 'nothing_to_do' };
  if (enrollment.endedAt !== null) return { kind: 'nothing_to_do' };

  // A channel this lane does not know is held and never run. None can be stored since
  // migration 0019 took the LinkedIn marker out of the channel CHECKs; this is the guard.
  if (!isStepChannel(loaded.channel)) return await holdExecution(context, loaded, 'long_hold_review');

  // What the fence says comes first once there is one. A send that happened, or may
  // have, is settled from the fence whatever else is true of the enrollment now.
  const fence = loaded.channel === 'email' ? await input.sendHandoff.readOutcome(context, loaded.id) : NO_FENCE;
  const settled = await settleFromFence(context, loaded, fence, input.now);
  if (settled !== null) return settled;

  // From here nothing was ever handed to Gmail: the fence is absent, prepared or held.
  if (loaded.state !== 'dispatched' && Date.parse(loaded.notBefore) > Date.parse(input.now)) {
    return { kind: 'not_due', stepExecutionId: loaded.id, notBefore: loaded.notBefore };
  }

  let execution = loaded;
  if (execution.state === 'dispatched' && fence.state === 'absent') {
    // No fence means nothing was prepared, let alone sent: the step is simply pending.
    await context.db.query(
      `UPDATE step_executions SET state = 'pending', updated_at = now()
        WHERE workspace_id = $1 AND id = $2 AND state = 'dispatched'`,
      [context.scope.workspaceId, execution.id],
    );
    execution = { ...execution, state: 'pending' };
  }
  // An enrollment an older release sent to `review_required` resumes through the same
  // path as a held step (wave 2, S4.1): its holds are asked again, and the work shifts
  // once by the union and runs, or stays held by what is still open.
  if (execution.state === 'held' || enrollment.state === 'review_required') {
    const resumed = await resumeHeldStep(context, execution, input.now);
    if (resumed.kind === 'stopped') return resumed.outcome;
    execution = resumed.execution;
  }

  const fenceId = fence.outboundMessageId ?? null;
  if ((fence.state === 'prepared' || fence.state === 'held') && fenceId !== null) {
    // The bytes were decided and frozen when the fence was prepared, and nothing was
    // attempted with them. Appendix B: "Prepared, and Gmail request provably not
    // started — retry same fence". The dispatch that follows the commit re-decides
    // everything — eligibility, window, cap — under the send gate.
    return await handBackToSend(context, execution, fenceId);
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
    // A call task is completed by a person. Clearing a stale hold is the whole of the
    // state change; the Today source makes it visible.
    if (execution.state === 'held') await clearExecutionHold(context, execution.id);
    return { kind: 'awaiting_manual', stepExecutionId: execution.id, channel: execution.channel };
  }

  return await runEmailStep(context, { ...input, execution, enrollment });
}

/**
 * Settle an email step whose fence has left `prepared` for good, or return null.
 *
 * * `sent` — complete it from the original dispatch instant (12.5), however late the
 *   step learns of it: after a reconciliation, a restore, or a worker that died between
 *   the send and the step's own completion.
 * * `dispatching`, `reconciling` — the request may have left, so the step waits on the
 *   Sent folder; `CLOCK_CLEARING_HOLDS` asks again in five minutes.
 * * `unknown_terminal` — 12.5's admin answer. `delivered` continues the sequence from
 *   the original dispatch time and `skipped` stops the enrollment, and either way the
 *   terminal hold the fence opened on the firm comes off with it: Appendix A commits
 *   "delivered and successor, or skipped and terminal stop" together. Unanswered, the
 *   step waits and is asked again (`HOLD_RECHECK_MILLISECONDS`).
 */
async function settleFromFence(
  context: RepositoryContext,
  execution: StepExecutionRow,
  fence: OutboundFenceOutcome,
  now: string,
): Promise<StepRunOutcome | null> {
  switch (fence.state) {
    case 'sent':
      return await completeFromFence(context, execution, 'sent', fence.dispatchedAt ?? now);
    case 'dispatching':
    case 'reconciling':
      return await holdExecution(context, execution, 'send_unknown_reconciling');
    case 'unknown_terminal': {
      const resolution = fence.adminResolution ?? null;
      if (resolution === null) return await holdExecution(context, execution, 'send_unknown_terminal');
      const fenceId = fence.outboundMessageId ?? null;
      if (fenceId !== null) {
        await releaseHoldsOfEvent(context, { sourceEventId: fenceId, reasonCode: 'send_unknown_terminal' });
      }
      return await completeFromFence(
        context,
        execution,
        resolution === 'delivered' ? 'sent' : 'skipped',
        fence.dispatchedAt ?? now,
      );
    }
    default:
      return null;
  }
}

async function completeFromFence(
  context: RepositoryContext,
  execution: StepExecutionRow,
  result: 'sent' | 'skipped',
  at: string,
): Promise<StepRunOutcome> {
  const completed = await completeEmailStep(context, { stepExecutionId: execution.id, result, at });
  if (!completed.ok) return { kind: 'nothing_to_do' };
  return { kind: 'completed', stepExecutionId: execution.id, result };
}

type ResumedStep =
  | { readonly kind: 'resumed'; readonly execution: StepExecutionRow }
  | { readonly kind: 'stopped'; readonly outcome: StepRunOutcome };

/**
 * 4.3 for a held step the scheduler woke (audit C05): the enrollment's holds are
 * reconsidered before anything else, so a released hold shifts the unexecuted steps by
 * the union it blocked for, however long it was (wave 2, S4.1).
 *
 * `still_held` holds the step with the reason of the oldest hold still open — the wake
 * and the resume ask the same scopes, so this is the rare case of a hold opened between
 * the two. A shift that moves the step's due instant past now leaves it pending until
 * then; the scheduler wakes it when it is due.
 */
async function resumeHeldStep(
  context: RepositoryContext,
  execution: StepExecutionRow,
  now: string,
): Promise<ResumedStep> {
  const resumed = await resumeEnrollment(context, { enrollmentId: execution.enrollmentId });
  if (!resumed.ok) return { kind: 'stopped', outcome: { kind: 'nothing_to_do' } };
  if (resumed.value.kind === 'still_held') {
    const reason = await oldestOpenHoldReason(context, resumed.value.openHoldIds);
    return {
      kind: 'stopped',
      outcome: await holdExecution(context, execution, reason ?? execution.holdReasonCode ?? 'scoped_pause'),
    };
  }
  const current = await loadStepExecutionForUpdate(context, execution.id);
  // `dispatched` too: a step of an enrollment an older release sent to review may carry a
  // prepared fence, which the dispatch path takes from here.
  if (current === null || (current.state !== 'pending' && current.state !== 'held' && current.state !== 'dispatched')) {
    return { kind: 'stopped', outcome: { kind: 'nothing_to_do' } };
  }
  if (current.state !== 'dispatched' && Date.parse(current.notBefore) > Date.parse(now)) {
    return { kind: 'stopped', outcome: { kind: 'not_due', stepExecutionId: current.id, notBefore: current.notBefore } };
  }
  return { kind: 'resumed', execution: current };
}

async function oldestOpenHoldReason(
  context: RepositoryContext,
  holdIds: readonly string[],
): Promise<HoldReasonCode | null> {
  if (holdIds.length === 0) return null;
  const { rows } = await context.db.query<{ reason_code: HoldReasonCode }>(
    `SELECT reason_code FROM active_holds
      WHERE workspace_id = $1 AND id = ANY($2::uuid[])
      ORDER BY started_at, id LIMIT 1`,
    [context.scope.workspaceId, [...holdIds]],
  );
  return rows[0]?.reason_code ?? null;
}

/**
 * A fence that already exists and never reached Gmail goes back to the dispatch path:
 * the step is `dispatched` again, and `dispatchPreparedStep` runs after the commit.
 */
async function handBackToSend(
  context: RepositoryContext,
  execution: StepExecutionRow,
  outboundMessageId: string,
): Promise<StepRunOutcome> {
  await context.db.query(
    `UPDATE step_executions SET state = 'dispatched', hold_reason_code = NULL, updated_at = now()
      WHERE workspace_id = $1 AND id = $2 AND state IN ('pending', 'held', 'dispatched')`,
    [context.scope.workspaceId, execution.id],
  );
  return { kind: 'handed_to_send', stepExecutionId: execution.id, outboundMessageId, sendAt: execution.dueAt };
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
 * It dispatches only while the fence reads `prepared` or `held` — states that never
 * entered `dispatching` — and the claim inside the dispatch is the atomic
 * `prepared → dispatching` that exactly one caller can win. That is the whole of the
 * at-most-once discipline on this side: a retry after a stolen lease, or a second wake
 * of the same step, reads a fence that is no longer claimable and reports rather than
 * sends again.
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
  // `held` as well as `prepared` since lane g82: a step woken after its cap, window or
  // pause cleared carries a held fence, and the dispatch path is what releases it and
  // decides again (`g7-held-returns-to-prepared`). Neither state ever entered
  // `dispatching`, so neither can have reached Gmail, and the claim is still the one
  // atomic `prepared → dispatching`.
  if (fence.state === 'prepared' || fence.state === 'held') {
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
  // The hold row first, so the `not_before` decision below sees it (lane g82).
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

  // When the scheduler may ask again (lane g82, `wake.ts`). A step an open hold blocks
  // keeps its `not_before`: the wake skips it while the hold is open and takes it on
  // the first pass after the release, which is 4.3's resume. Any other held step —
  // its own fence's cap or window, a reason no hold row stands behind — waits out the
  // reason's interval. The blocking question is the wake's own `BLOCKING_HOLD_SQL`,
  // asked in this statement, so the two cannot disagree: a step is either skipped
  // until a release or asked again later, never re-run every pass.
  await context.db.query(
    `UPDATE step_executions AS e
        SET state = 'held', hold_reason_code = $3,
            not_before = CASE WHEN ${BLOCKING_HOLD_SQL}
                              THEN e.not_before
                              ELSE GREATEST(e.not_before, now() + ($4::double precision * interval '1 millisecond'))
                         END,
            updated_at = now()
       FROM sequence_enrollments n
      WHERE e.workspace_id = $1 AND e.id = $2 AND e.state IN ('pending', 'held', 'dispatched')
        AND n.workspace_id = e.workspace_id AND n.id = e.enrollment_id`,
    [context.scope.workspaceId, execution.id, reasonCode, holdRecheckMilliseconds(reasonCode)],
  );
  return { kind: 'held', stepExecutionId: execution.id, reasonCode };
}

async function clearExecutionHold(context: RepositoryContext, stepExecutionId: string): Promise<void> {
  await context.db.query(
    `UPDATE step_executions SET state = 'pending', hold_reason_code = NULL, updated_at = now()
      WHERE workspace_id = $1 AND id = $2 AND state = 'held'`,
    [context.scope.workspaceId, stepExecutionId],
  );
}

export interface CompleteStepInput {
  readonly stepExecutionId: string;
  readonly completionSource: StepCompletionSource;
  readonly result: StepResult;
  /**
   * The instant the step actually happened: for a sent email, the fence's original
   * dispatch time (12.5), never the moment a reconciliation or an admin settled it.
   * Absent is database now. The successor's spacing floor counts from it (`successor.ts`).
   */
  readonly completedAt?: string | undefined;
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
 * The successor's due instant is the plan — the next step's delay from the instant the
 * enrollment began, G0's start anchor (`packages/domain/src/rules/cadence.ts`) and what
 * the editor shows as "N business days after enrollment" — unless this step ran late,
 * in which case it is the plan's gap between the two steps counted from when this one
 * actually happened (lane g82, audit C11; `successor.ts`). On time the two agree, so a
 * firm that sat in a queue before its first step still keeps its cadence; late, the
 * next step keeps its spacing instead of falling due the same hour.
 */
export async function completeStepExecution(
  context: RepositoryContext,
  input: CompleteStepInput,
): Promise<SequenceResult<CompletedStep>> {
  // Enrollment first, then the step: the one lock order (`lockStepWithEnrollment`).
  const { execution, enrollment } = await lockStepWithEnrollment(context, input.stepExecutionId);
  if (execution === null) return refuseSequence('execution_unknown');
  if (execution.state === 'completed' || execution.state === 'cancelled') {
    return refuseSequence('execution_not_pending');
  }
  if (enrollment === null) return refuseSequence('enrollment_unknown');
  if (enrollment.endedAt !== null) return refuseSequence('enrollment_not_live');

  const { rows: done } = await context.db.query<{ completed_at: Date }>(
    `UPDATE step_executions
        SET state = 'completed', completed_at = coalesce($3::timestamptz, now()),
            completion_source = $4, result = $5, hold_reason_code = NULL, updated_at = now()
      WHERE workspace_id = $1 AND id = $2
      RETURNING completed_at`,
    [
      context.scope.workspaceId,
      execution.id,
      input.completedAt ?? null,
      input.completionSource,
      input.result,
    ],
  );
  const completedAt = (done[0]?.completed_at ?? new Date()).toISOString();

  const successor = await createSuccessor(context, {
    enrollment,
    afterOrdinal: execution.ordinal,
    completedAt,
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
  /** When the completed step actually happened. */
  readonly completedAt: string;
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
  const previous = version.steps.find(step => step.ordinal === input.afterOrdinal);

  const calendar = await calendarOfEnrollment(context, input.enrollment);
  const due = successorDue({
    previous: previous === undefined ? undefined : stepForCadence(previous),
    next: stepForCadence(next),
    startedAt: input.enrollment.startedAt,
    zone: input.enrollment.firmTimeZone,
    calendar,
    completedAt: input.completedAt,
  });
  const { rows: clock } = await context.db.query<{ now: Date }>('SELECT now() AS now');
  const notBefore = (clock[0]?.now ?? new Date()).toISOString();

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

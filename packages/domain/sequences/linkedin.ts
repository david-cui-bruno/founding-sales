import type { RepositoryContext } from '../db/workspaceScope.ts';
import { setManualControlMode } from '../crm/index.ts';
import { stopEnrollments } from './enrollments.ts';
import {
  LINKEDIN_UNDO_WINDOW_MILLISECONDS,
  completeStepExecution,
  type CompletedStep,
} from './executions.ts';
import { loadEnrollmentForUpdate, loadStepExecutionForUpdate, readSequenceVersion } from './rows.ts';
import type { SendHandoff } from './sendHandoff.ts';
import { acceptSequence, refuseSequence, type SequenceResult } from './types.ts';

/**
 * The LinkedIn open-and-copy handoff (specification 11.3, Appendix G 9 and 18).
 *
 * David's decision, and the specification's: steps proceed on a delay, the
 * salesperson presses "They replied" or "No engagement", and there is no LinkedIn
 * automation of any kind. FSS never claims the message was sent — `result` is
 * `handed_off`, and that word is the whole of what this system knows.
 *
 * Three rules, each of which is a sentence in 11.3:
 *
 *   * completing copies the text, opens the profile and creates the successor with a
 *     **ten-minute `not_before`** — one transaction, both rows locked;
 *   * undo is available for those ten minutes, reopens the step and cancels the
 *     successor, and **fails visibly** if the successor's fence is already dispatching
 *     or later;
 *   * "They replied" stays available for the enrollment's life and terminally
 *     switches the opportunity to manual; "No engagement" records an observation and
 *     claims nothing.
 *
 * The copy and the browser open are the Mac's. This module decides the state; it
 * hands back the URL and the text for the client to use, and the client's success or
 * failure never changes what the database recorded. That is deliberate: a handoff
 * that depended on the clipboard working would be a step whose completion the server
 * could not explain.
 */

export interface LinkedInHandoff extends CompletedStep {
  /** What the client opens. Null when the contact has no recorded profile. */
  readonly linkedInUrl: string | null;
  /** What the client copies: the step's frozen text. */
  readonly message: string;
  /** Until when the undo is available. */
  readonly undoUntil: string;
}

/**
 * Complete a LinkedIn step as `handed_off`.
 *
 * The successor's ten minutes are a `not_before` and not a delay: the cadence the
 * salesperson reviewed is unchanged, and what the grace period buys is the undo.
 */
export async function completeLinkedInStep(
  context: RepositoryContext,
  input: { readonly stepExecutionId: string },
): Promise<SequenceResult<LinkedInHandoff>> {
  const execution = await loadStepExecutionForUpdate(context, input.stepExecutionId);
  if (execution === null) return refuseSequence('execution_unknown');
  if (execution.channel !== 'linkedin_task') return refuseSequence('execution_wrong_channel');
  if (execution.state !== 'pending' && execution.state !== 'held') {
    return refuseSequence('execution_not_pending');
  }

  const enrollment = await loadEnrollmentForUpdate(context, execution.enrollmentId);
  if (enrollment === null) return refuseSequence('enrollment_unknown');
  if (enrollment.endedAt !== null) return refuseSequence('enrollment_not_live');

  const version = await readSequenceVersion(context, enrollment.sequenceVersionId);
  const step = version?.steps.find(candidate => candidate.id === execution.stepId);
  if (step === undefined || step.linkedInMessage === null) return refuseSequence('step_unknown');

  const completed = await completeStepExecution(context, {
    stepExecutionId: execution.id,
    completionSource: 'open_and_copy',
    result: 'handed_off',
    successorNotBeforeMilliseconds: LINKEDIN_UNDO_WINDOW_MILLISECONDS,
  });
  if (!completed.ok) return completed;

  const { rows } = await context.db.query<{ linkedin_url: string | null; completed_at: Date | null }>(
    `SELECT c.linkedin_url, e.completed_at
       FROM step_executions e
       JOIN contacts c ON c.workspace_id = e.workspace_id AND c.id = e.contact_id
      WHERE e.workspace_id = $1 AND e.id = $2`,
    [context.scope.workspaceId, execution.id],
  );
  const completedAt = rows[0]?.completed_at ?? new Date();
  return acceptSequence({
    ...completed.value,
    linkedInUrl: rows[0]?.linkedin_url ?? null,
    message: step.linkedInMessage,
    undoUntil: new Date(completedAt.getTime() + LINKEDIN_UNDO_WINDOW_MILLISECONDS).toISOString(),
  });
}

export interface UndoLinkedInStepInput {
  readonly stepExecutionId: string;
  /** Database time. The ten minutes are measured against the database, never a Mac. */
  readonly now: string;
  /**
   * The sending lane, when there is one. Present, the undo also asks whether the
   * successor's outbound fence has begun dispatching — Appendix G 9's "no early
   * fence" — and refuses visibly if it has.
   */
  readonly sendHandoff?: SendHandoff | undefined;
}

/**
 * Undo a handoff inside the ten-minute window.
 *
 * Appendix G 9 is a race between the successor and the undo at 9:59 and 10:00
 * database time. The predecessor and the successor are both locked here, in that
 * order, so the two commands serialize; the window is a comparison against the
 * predecessor's own `completed_at`, and the successor's `not_before` was computed
 * from the same instant, so the two agree by construction rather than by two clocks
 * happening to match.
 *
 * "Fails visibly" is the important half. A successor whose fence has begun
 * dispatching is an email that may already have left, and the only honest answer is
 * that the undo did not happen — never a quiet reopen that leaves the step looking
 * undone while a message is in flight.
 */
export async function undoLinkedInStep(
  context: RepositoryContext,
  input: UndoLinkedInStepInput,
): Promise<SequenceResult<{ readonly reopenedExecutionId: string; readonly cancelledSuccessorId: string | null }>> {
  const execution = await loadStepExecutionForUpdate(context, input.stepExecutionId);
  if (execution === null) return refuseSequence('execution_unknown');
  if (execution.channel !== 'linkedin_task') return refuseSequence('execution_wrong_channel');
  if (execution.state !== 'completed' || execution.completedAt === null) {
    return refuseSequence('execution_not_completed');
  }
  const elapsed = Date.parse(input.now) - Date.parse(execution.completedAt);
  if (elapsed > LINKEDIN_UNDO_WINDOW_MILLISECONDS) return refuseSequence('undo_window_expired');

  const { rows: successors } = await context.db.query<{ id: string; state: string }>(
    `SELECT id, state FROM step_executions
      WHERE workspace_id = $1 AND enrollment_id = $2 AND ordinal = $3
      FOR UPDATE`,
    [context.scope.workspaceId, execution.enrollmentId, execution.ordinal + 1],
  );
  const successor = successors[0] ?? null;

  if (successor !== null) {
    if (successor.state === 'dispatched' || successor.state === 'completed') {
      return refuseSequence('successor_dispatching');
    }
    if (input.sendHandoff !== undefined) {
      const fence = await input.sendHandoff.readOutcome(context, successor.id);
      if (fence.state !== 'absent' && fence.state !== 'prepared' && fence.state !== 'held') {
        return refuseSequence('successor_dispatching');
      }
    }
    await context.db.query(
      `UPDATE step_executions
          SET state = 'cancelled', cancelled_at = now(), cancel_reason = 'linkedin_undo',
              hold_reason_code = NULL, updated_at = now()
        WHERE workspace_id = $1 AND id = $2`,
      [context.scope.workspaceId, successor.id],
    );
  }

  await context.db.query(
    `UPDATE step_executions
        SET state = 'pending', completed_at = NULL, completion_source = NULL, result = NULL,
            updated_at = now()
      WHERE workspace_id = $1 AND id = $2`,
    [context.scope.workspaceId, execution.id],
  );
  // The enrollment may have been completed by the handoff, if the LinkedIn step was
  // the last one. Reopening the step reopens the enrollment with it.
  await context.db.query(
    `UPDATE sequence_enrollments
        SET state = 'active', ended_at = NULL, end_reason = NULL, updated_at = now()
      WHERE workspace_id = $1 AND id = $2 AND end_reason = 'sequence_complete'`,
    [context.scope.workspaceId, execution.enrollmentId],
  );

  return acceptSequence({
    reopenedExecutionId: execution.id,
    cancelledSuccessorId: successor?.id ?? null,
  });
}

export interface RecordLinkedInResultInput {
  readonly enrollmentId: string;
  readonly result: 'replied' | 'no_engagement';
  readonly stepExecutionId?: string | undefined;
  readonly note?: string | undefined;
  readonly commandId?: string | undefined;
}

/**
 * "They replied" and "No engagement" (11.3, Appendix G 18).
 *
 * A reply is a terminal condition: it switches the opportunity to manual and ends
 * every live enrollment of the *firm*, not only this one, because 7.3's reply
 * boundary is firm-wide and a prospect who answered on LinkedIn has answered on
 * behalf of the firm exactly as much as one who answered by email.
 *
 * "No engagement" writes a row and changes nothing else. It is an observation the
 * dashboard counts (13.4's "LinkedIn handoffs and recorded replies"), and it
 * deliberately does not complete a step, because 11.3 is explicit that it "does not
 * claim delivery".
 */
export async function recordLinkedInResult(
  context: RepositoryContext,
  input: RecordLinkedInResultInput,
): Promise<SequenceResult<{ readonly recorded: 'replied' | 'no_engagement'; readonly stopped: number }>> {
  const enrollment = await loadEnrollmentForUpdate(context, input.enrollmentId);
  if (enrollment === null) return refuseSequence('enrollment_unknown');
  if (context.scope.actor.kind !== 'user') return refuseSequence('not_assigned');
  if (
    context.scope.actor.role === 'salesperson' &&
    enrollment.assignedUserId !== context.scope.actor.userId
  ) {
    return refuseSequence('not_assigned');
  }

  await context.db.query(
    `INSERT INTO enrollment_linkedin_results
       (workspace_id, enrollment_id, firm_id, step_execution_id, result, recorded_by_user_id, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      context.scope.workspaceId,
      enrollment.id,
      enrollment.firmId,
      input.stepExecutionId ?? null,
      input.result,
      context.scope.actor.userId,
      input.note ?? null,
    ],
  );

  if (input.result === 'no_engagement') {
    return acceptSequence({ recorded: 'no_engagement', stopped: 0 });
  }

  const manual = await setManualControlMode(context, {
    opportunityId: enrollment.opportunityId,
    reason: 'A LinkedIn reply was recorded by the salesperson.',
    origin: 'linkedin_reply',
    ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
  });
  if (!manual.ok) return refuseSequence('opportunity_unknown');

  const stopped = await stopEnrollments(context, {
    firmId: enrollment.firmId,
    reason: 'linkedin_reply',
  });
  return acceptSequence({ recorded: 'replied', stopped: stopped.enrollmentsStopped });
}

export { LINKEDIN_UNDO_WINDOW_MILLISECONDS };

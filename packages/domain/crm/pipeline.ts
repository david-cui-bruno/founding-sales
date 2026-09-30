import type { RepositoryContext } from '../db/workspaceScope.ts';
import { lockSendGateForStopFact } from '../policy/sendGate.ts';
import { decideAdminOnly, decideFirmMutation } from './authorization.ts';
import { recordCrmAuditEvent } from './audit.ts';
import { emitCrmDomainEvent, type ManualModeOrigin } from './events.ts';
import { loadFirmForUpdate } from './firms.ts';
import {
  accept,
  actorKind,
  actorUserId,
  refuse,
  type CrmResult,
  type OpportunityRow,
  type PipelineStageRow,
} from './types.ts';

/**
 * The pipeline: stages, stage changes, closing and reopening
 * (specification 7.2, 7.3, 8.1, Appendix A "Stage change").
 *
 * Four sentences from section 8.1 are this file:
 *
 *   * "Every stage change creates an append-only event in the same transaction."
 *   * "Closing an opportunity stops its active enrollments."
 *   * "Reopening is an explicit command ... it never silently restarts old automation."
 *   * "Lost changes require a reason; an LLM may suggest but never commit it."
 *
 * The second is the one this lane cannot finish, because enrollments belong to G8. So
 * closing writes an `opportunity.terminal_stop` signal in the same transaction, and
 * the sequences lane subscribes to it. The signal is the contract; what G8 does with
 * it is G8's. That is why the stop is a durable row rather than a callback: a
 * callback would have to be registered by whoever happened to call `changeStage`, and
 * a stage change from an import, a job or a route the desktop has not been taught
 * about would silently skip it.
 *
 * The third is the reason `reopenOpportunity` sets `control_mode = 'manual'`. A
 * reopened opportunity that came back automated would restart the sequence that was
 * running when it closed, which is exactly the sentence's "silently".
 */

const OPPORTUNITY_COLUMNS = `id, workspace_id, firm_id, stage_id, status, control_mode, control_mode_reason,
  control_mode_changed_at, control_mode_origin, opened_at, closed_at, close_reason,
  reopened_from_opportunity_id, created_at, updated_at`;

const STAGE_COLUMNS = 'id, workspace_id, key, display_name, position, terminal_kind, retired, created_at, updated_at';

/** Every stage of the workspace's pipeline in order, retired ones included (7.2). */
export async function listPipelineStages(context: RepositoryContext): Promise<readonly PipelineStageRow[]> {
  const { rows } = await context.db.query<PipelineStageRow>(
    `SELECT ${STAGE_COLUMNS} FROM pipeline_stages WHERE workspace_id = $1 ORDER BY position`,
    [context.scope.workspaceId],
  );
  return rows;
}

async function readStageByKey(context: RepositoryContext, key: string): Promise<PipelineStageRow | null> {
  const { rows } = await context.db.query<PipelineStageRow>(
    `SELECT ${STAGE_COLUMNS} FROM pipeline_stages WHERE workspace_id = $1 AND key = $2`,
    [context.scope.workspaceId, key],
  );
  return rows[0] ?? null;
}

export async function readOpportunity(
  context: RepositoryContext,
  opportunityId: string,
): Promise<OpportunityRow | null> {
  const { rows } = await context.db.query<OpportunityRow>(
    `SELECT ${OPPORTUNITY_COLUMNS} FROM opportunities WHERE workspace_id = $1 AND id = $2`,
    [context.scope.workspaceId, opportunityId],
  );
  return rows[0] ?? null;
}

export async function readOpenOpportunity(
  context: RepositoryContext,
  firmId: string,
): Promise<OpportunityRow | null> {
  const { rows } = await context.db.query<OpportunityRow>(
    `SELECT ${OPPORTUNITY_COLUMNS} FROM opportunities
      WHERE workspace_id = $1 AND firm_id = $2 AND status = 'open'`,
    [context.scope.workspaceId, firmId],
  );
  return rows[0] ?? null;
}

async function loadOpportunityForUpdate(
  context: RepositoryContext,
  opportunityId: string,
): Promise<OpportunityRow | null> {
  const { rows } = await context.db.query<OpportunityRow>(
    `SELECT ${OPPORTUNITY_COLUMNS} FROM opportunities WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
    [context.scope.workspaceId, opportunityId],
  );
  return rows[0] ?? null;
}

/**
 * Open the firm's opportunity. One per firm is the database's rule; this refuses with
 * a named reason rather than letting the partial unique index abort the transaction,
 * because an aborted transaction cannot write its command receipt.
 */
export async function openOpportunity(
  context: RepositoryContext,
  input: { readonly firmId: string; readonly stageKey?: string | undefined },
): Promise<CrmResult<OpportunityRow>> {
  const firm = await loadFirmForUpdate(context, input.firmId);
  if (firm === null) return refuse('firm_unknown');
  const decision = decideFirmMutation(context, firm);
  if (!decision.permitted) return refuse(decision.reason);

  const existing = await readOpenOpportunity(context, input.firmId);
  if (existing !== null) return refuse('opportunity_open_exists');

  const stage = await readStageByKey(context, input.stageKey ?? 'new');
  if (stage === null) return refuse('stage_unknown');
  if (stage.retired) return refuse('stage_retired');

  const { rows } = await context.db.query<OpportunityRow>(
    `INSERT INTO opportunities (workspace_id, firm_id, stage_id, control_mode_changed_at)
     VALUES ($1, $2, $3, now())
     RETURNING ${OPPORTUNITY_COLUMNS}`,
    [context.scope.workspaceId, input.firmId, stage.id],
  );
  const created = rows[0];
  if (created === undefined) return refuse('invalid_input');

  await writeStageEvent(context, created, null, stage.id, undefined, undefined);
  await recordCrmAuditEvent(context, {
    action: 'opportunity.opened',
    subjectKind: 'opportunity',
    subjectId: created.id,
    detail: { firmId: input.firmId, stage: stage.key },
  });
  return accept(created);
}

export interface ChangeStageInput {
  readonly opportunityId: string;
  readonly toStageKey: string;
  /** Required when the target stage is Lost (8.1). */
  readonly reason?: string | undefined;
  readonly commandId?: string | undefined;
}

/**
 * Move an opportunity to another stage, and write its event in the same transaction.
 *
 * Won and Lost also close the opportunity and raise the terminal-stop signal. A Lost
 * with no reason is refused before anything is written, so "Lost changes require a
 * reason" is a refusal a person can act on rather than a constraint violation that
 * loses the whole command.
 */
export async function changeStage(
  context: RepositoryContext,
  input: ChangeStageInput,
): Promise<CrmResult<OpportunityRow>> {
  // Won and Lost stop automation (8.1), so a stage change is a potential stop fact and
  // takes the send gate before the opportunity's row (`policy/sendGate.ts`).
  await lockSendGateForStopFact(context);
  const opportunity = await loadOpportunityForUpdate(context, input.opportunityId);
  if (opportunity === null) return refuse('opportunity_unknown');
  const firm = await loadFirmForUpdate(context, opportunity.firm_id);
  if (firm === null) return refuse('firm_unknown');
  const decision = decideFirmMutation(context, firm);
  if (!decision.permitted) return refuse(decision.reason);
  if (opportunity.status !== 'open') return refuse('opportunity_closed');

  const stage = await readStageByKey(context, input.toStageKey);
  if (stage === null) return refuse('stage_unknown');
  if (stage.retired) return refuse('stage_retired');
  if (stage.id === opportunity.stage_id) return accept(opportunity);

  const reason = input.reason?.trim();
  if (stage.terminal_kind === 'lost' && (reason === undefined || reason.length === 0)) {
    return refuse('lost_reason_required');
  }

  const terminal = stage.terminal_kind !== null;
  const { rows } = await context.db.query<OpportunityRow>(
    `UPDATE opportunities
        SET stage_id = $3,
            status = COALESCE($4, status),
            closed_at = CASE WHEN $4::text IS NULL THEN closed_at ELSE now() END,
            close_reason = COALESCE($5, close_reason),
            updated_at = now()
      WHERE workspace_id = $1 AND id = $2
      RETURNING ${OPPORTUNITY_COLUMNS}`,
    [
      context.scope.workspaceId,
      input.opportunityId,
      stage.id,
      terminal ? stage.terminal_kind : null,
      reason ?? null,
    ],
  );
  const updated = rows[0];
  if (updated === undefined) return refuse('opportunity_unknown');

  await writeStageEvent(context, updated, opportunity.stage_id, stage.id, reason, input.commandId);

  if (terminal) {
    // Section 8.1: "Closing an opportunity stops its active enrollments." The
    // enrollments are G8's; the signal that they must stop is written here, with the
    // stage change, so the two cannot disagree.
    await emitCrmDomainEvent(context, {
      kind: 'opportunity.terminal_stop',
      firmId: updated.firm_id,
      opportunityId: updated.id,
      dedupeKey: `${updated.id}:${stage.key}`,
      commandId: input.commandId,
      detail: { terminalKind: stage.terminal_kind, stage: stage.key },
    });
  }

  await recordCrmAuditEvent(context, {
    action: 'opportunity.stage_changed',
    subjectKind: 'opportunity',
    subjectId: updated.id,
    detail: { firmId: updated.firm_id, toStage: stage.key, terminal },
  });
  return accept(updated);
}

/**
 * Set the opportunity's control mode (7.3).
 *
 * "Automation never reverses manual mode": a caller may move `automated → manual`,
 * and only a person's explicit reopen or a new enrollment moves the other way, which
 * is why there is no `manual → automated` path here at all.
 *
 * `origin` is required and is not the same thing as `reason`. The reason is
 * a sentence a person reads; the origin is one of `MANUAL_MODE_ORIGINS`, the fact the
 * terminal-stop consumer turns into an `end_reason`. It is required rather than
 * defaulted so that a new caller has to say which of 7.3's four ways in it is, instead
 * of inheriting somebody else's answer — G15 recorded `human_reply` for every one of
 * them precisely because the signal did not carry this.
 *
 * Since migration 0025 the origin is also **stored on the opportunity**
 * (`control_mode_origin`), not only emitted in the event's detail. The eligibility gate
 * reads the opportunity row, and it now has a question the row could not answer: was
 * this a prospect signal, which does not block an evidenced follow-up, or a person's
 * explicit takeover, which does (`controlModeSource`)?
 */
export async function setManualControlMode(
  context: RepositoryContext,
  input: {
    readonly opportunityId: string;
    readonly reason: string;
    /**
     * One of the four causes. `direct_send_keep_automation` is **not** one of them: it is
     * a person's choice rather than a cause of manual mode, and only
     * `keepFollowingUpAfterDirectSend` may write it (P1-1 of the second review of PR
     * 332). Excluding it here is what makes that a fact about the code rather than a rule
     * about the routes.
     */
    readonly origin: Exclude<ManualModeOrigin, 'direct_send_keep_automation'>;
    readonly commandId?: string | undefined;
  },
): Promise<CrmResult<OpportunityRow>> {
  // 7.3's manual mode is the confirmed reply's stop, so it takes the send gate before
  // any row (`policy/sendGate.ts`): a send whose claim is in flight commits
  // first, and one that has not claimed yet reads `manual` and does not.
  await lockSendGateForStopFact(context);
  const opportunity = await loadOpportunityForUpdate(context, input.opportunityId);
  if (opportunity === null) return refuse('opportunity_unknown');
  const firm = await loadFirmForUpdate(context, opportunity.firm_id);
  if (firm === null) return refuse('firm_unknown');
  const decision = decideFirmMutation(context, firm);
  if (!decision.permitted) return refuse(decision.reason);
  if (input.reason.trim().length === 0) return refuse('invalid_input');
  if (opportunity.control_mode === 'manual') {
    // Already manual, so there is no transition to record — except one. Migration 0025
    // stores *which* of `MANUAL_MODE_ORIGINS` put the opportunity here, because the
    // eligibility gate now asks: a signal-set manual mode does not block an evidenced
    // follow-up, an explicit takeover does. An opportunity that went manual on a reply
    // and is then taken over by a person must stop being a signal, or the takeover
    // would be the one fact this design ignores. Escalation only — a signal never
    // overwrites a recorded takeover, and nothing here reverses manual mode.
    // A *later* direct Gmail send is a fresh takeover, even of an opportunity whose
    // origin is the choice to keep following up (P1-1 of the second review of PR 332).
    // The person chose to let the automation continue after one hand-written message;
    // writing again by hand is them taking the conversation back, and the choice can be
    // made again with `keepFollowingUpAfterDirectSend`. It is still escalation only: a
    // `salesperson_command` is never downgraded to `direct_send`.
    const escalation =
      input.origin === 'salesperson_command' && opportunity['control_mode_origin'] !== 'salesperson_command'
        ? 'salesperson_command'
        : input.origin === 'direct_send' && opportunity['control_mode_origin'] === 'direct_send_keep_automation'
          ? 'direct_send'
          : null;
    if (escalation !== null) {
      const { rows: escalated } = await context.db.query<OpportunityRow>(
        `UPDATE opportunities
            SET control_mode_origin = $3, updated_at = now()
          WHERE workspace_id = $1 AND id = $2
          RETURNING ${OPPORTUNITY_COLUMNS}`,
        [context.scope.workspaceId, input.opportunityId, escalation],
      );
      const takenOver = escalated[0];
      if (takenOver !== undefined) {
        await recordCrmAuditEvent(context, {
          action: 'opportunity.manual',
          subjectKind: 'opportunity',
          subjectId: takenOver.id,
          detail: { firmId: takenOver.firm_id, origin: input.origin, escalated: true },
        });
        return accept(takenOver);
      }
    }
    return accept(opportunity);
  }

  const { rows } = await context.db.query<OpportunityRow>(
    `UPDATE opportunities
        SET control_mode = 'manual', control_mode_reason = $3, control_mode_origin = $4,
            control_mode_changed_at = now(), updated_at = now()
      WHERE workspace_id = $1 AND id = $2
      RETURNING ${OPPORTUNITY_COLUMNS}`,
    [context.scope.workspaceId, input.opportunityId, input.reason.trim(), input.origin],
  );
  const updated = rows[0];
  if (updated === undefined) return refuse('opportunity_unknown');

  await emitCrmDomainEvent(context, {
    kind: 'opportunity.manual_mode',
    firmId: updated.firm_id,
    opportunityId: updated.id,
    dedupeKey: `${updated.id}:${instantLabel(updated['control_mode_changed_at'])}`,
    reasonCode: 'opportunity_manual',
    commandId: input.commandId,
    detail: { reason: input.reason.trim(), origin: input.origin },
  });
  await recordCrmAuditEvent(context, {
    action: 'opportunity.manual',
    subjectKind: 'opportunity',
    subjectId: updated.id,
    detail: { firmId: updated.firm_id, origin: input.origin },
  });
  return accept(updated);
}

/**
 * A person takes this firm over by hand (P1-1 of the GPT-6 review of PR 332).
 *
 * The takeover origin, `salesperson_command`, had no production caller: the eligibility
 * gate distinguishes a prospect's signal from a person's decision, and until this
 * command existed only the signals could be written, so "preserve explicit manual
 * takeover" rested on a value nothing produced. This is that command. It is
 * `setManualControlMode` with the one origin the gate treats as a decision, which also
 * means it escalates an opportunity that is already manual on a signal, and never the
 * other way round.
 */
export async function takeOverOpportunity(
  context: RepositoryContext,
  input: {
    readonly opportunityId: string;
    readonly reason: string;
    readonly commandId?: string | undefined;
  },
): Promise<CrmResult<OpportunityRow>> {
  return await setManualControlMode(context, { ...input, origin: 'salesperson_command' });
}

/**
 * The user chooses to keep the follow-up automation running after their own direct
 * Gmail send (P1-1).
 *
 * A salesperson writing to a prospect from Gmail is that salesperson taking the
 * conversation over, not the prospect signalling something — so `direct_send` blocks an
 * evidenced follow-up like any other takeover. The review asked for the one exception to
 * be a *choice*, made by the person, recorded where the gate reads: this command moves
 * the stored origin from `direct_send` to `direct_send_keep_automation`, which is the
 * fifth member of `MANUAL_MODE_ORIGINS` and the only one of them created by a person
 * asking for automation rather than by an event.
 *
 * It is deliberately narrow. The UPDATE is conditional on the origin still being
 * `direct_send`, so a takeover recorded in between — or a manual mode that a reply or a
 * call put there — is never relabelled, and a takeover can never be downgraded by this
 * path. The control mode itself does not change: the opportunity stays manual.
 */
export async function keepFollowingUpAfterDirectSend(
  context: RepositoryContext,
  input: {
    readonly opportunityId: string;
    readonly reason: string;
    readonly commandId?: string | undefined;
  },
): Promise<CrmResult<OpportunityRow>> {
  await lockSendGateForStopFact(context);
  const opportunity = await loadOpportunityForUpdate(context, input.opportunityId);
  if (opportunity === null) return refuse('opportunity_unknown');
  const firm = await loadFirmForUpdate(context, opportunity.firm_id);
  if (firm === null) return refuse('firm_unknown');
  const decision = decideFirmMutation(context, firm);
  if (!decision.permitted) return refuse(decision.reason);
  if (input.reason.trim().length === 0) return refuse('invalid_input');

  const { rows } = await context.db.query<OpportunityRow>(
    `UPDATE opportunities
        SET control_mode_origin = 'direct_send_keep_automation', updated_at = now()
      WHERE workspace_id = $1 AND id = $2
        AND control_mode = 'manual' AND control_mode_origin = 'direct_send'
      RETURNING ${OPPORTUNITY_COLUMNS}`,
    [context.scope.workspaceId, input.opportunityId],
  );
  const chosen = rows[0];
  if (chosen === undefined) return refuse('invalid_input');
  await recordCrmAuditEvent(context, {
    action: 'opportunity.manual',
    subjectKind: 'opportunity',
    subjectId: chosen.id,
    detail: {
      firmId: chosen.firm_id,
      origin: 'direct_send_keep_automation',
      from: 'direct_send',
      reason: input.reason.trim(),
    },
  });
  return accept(chosen);
}

/**
 * An administrator classifies one opportunity whose manual mode predates
 * `control_mode_origin` (P1-1).
 *
 * Every opportunity that went manual before migration 0025 has a NULL origin, and a NULL
 * is not evidence of a signal, so the gate blocks it. The review asked for "an audited,
 * evidence-reviewed way to classify an old reply's NULL origin; do not blanket backfill
 * it", and the coordinator's reading of 29 September 2026 is the same: one opportunity at
 * a time, an administrator, a reason, and the evidence the administrator looked at
 * written into the audit row.
 *
 * The evidence is the opportunity's own record of why it went manual — the sentence in
 * `control_mode_reason` and the instant it changed — because that is what a person
 * reviewing an old row actually reads. The UPDATE is conditional on the origin still
 * being NULL, so a recorded origin, takeover or signal, is never overwritten by this
 * command.
 */
export async function classifyControlModeOrigin(
  context: RepositoryContext,
  input: {
    readonly opportunityId: string;
    readonly origin: ManualModeOrigin;
    readonly reason: string;
    readonly commandId?: string | undefined;
  },
): Promise<CrmResult<OpportunityRow>> {
  const permitted = decideAdminOnly(context);
  if (!permitted.permitted) return refuse(permitted.reason);
  await lockSendGateForStopFact(context);
  const opportunity = await loadOpportunityForUpdate(context, input.opportunityId);
  if (opportunity === null) return refuse('opportunity_unknown');
  const firm = await loadFirmForUpdate(context, opportunity.firm_id);
  if (firm === null) return refuse('firm_unknown');
  if (input.reason.trim().length === 0) return refuse('invalid_input');

  const { rows } = await context.db.query<OpportunityRow>(
    `UPDATE opportunities
        SET control_mode_origin = $3, updated_at = now()
      WHERE workspace_id = $1 AND id = $2
        AND control_mode = 'manual' AND control_mode_origin IS NULL
      RETURNING ${OPPORTUNITY_COLUMNS}`,
    [context.scope.workspaceId, input.opportunityId, input.origin],
  );
  const classified = rows[0];
  if (classified === undefined) return refuse('invalid_input');
  await recordCrmAuditEvent(context, {
    action: 'opportunity.manual',
    subjectKind: 'opportunity',
    subjectId: classified.id,
    detail: {
      firmId: classified.firm_id,
      origin: input.origin,
      classified: true,
      reason: input.reason.trim(),
      // The evidence the administrator was shown, kept with the decision — as facts
      // rather than as text: `audit.ts` keeps notes and message content out of a
      // `detail`, and the sentence itself stays where it already is, on the
      // opportunity, unchanged by this command.
      evidence: {
        controlModeChangedAt: instantLabel(opportunity['control_mode_changed_at']),
        controlModeReasonRecorded: opportunity.control_mode_reason !== null,
      },
    },
  });
  return accept(classified);
}

export interface ReopenOutcome {
  readonly opportunityId: string;
  readonly firmId: string;
  readonly reopenedFrom: string;
}

/**
 * Reopen a firm's pipeline (8.1).
 *
 * "Reopening is an explicit command that either creates a new open opportunity or
 * reopens the existing one under configured policy; it never silently restarts old
 * automation."
 *
 * The configured policy in version one is: a new opportunity, linked to the one it
 * came from, starting at the first non-terminal stage and in **manual** control mode.
 * A new row rather than an un-closing keeps the closed opportunity's stage history
 * intact and keeps the record's history honest; manual mode is what
 * makes "never silently restarts" true, because an automated reopen would be eligible
 * for the sequences that were running when it closed.
 */
export async function reopenOpportunity(
  context: RepositoryContext,
  input: { readonly firmId: string; readonly reason: string; readonly commandId?: string | undefined },
): Promise<CrmResult<ReopenOutcome>> {
  const firm = await loadFirmForUpdate(context, input.firmId);
  if (firm === null) return refuse('firm_unknown');
  const decision = decideFirmMutation(context, firm);
  if (!decision.permitted) return refuse(decision.reason);
  if (input.reason.trim().length === 0) return refuse('invalid_input');

  const open = await readOpenOpportunity(context, input.firmId);
  if (open !== null) return refuse('opportunity_open_exists');

  const { rows: closedRows } = await context.db.query<OpportunityRow>(
    `SELECT ${OPPORTUNITY_COLUMNS} FROM opportunities
      WHERE workspace_id = $1 AND firm_id = $2 AND status <> 'open'
      ORDER BY closed_at DESC
      LIMIT 1
      FOR UPDATE`,
    [context.scope.workspaceId, input.firmId],
  );
  const closed = closedRows[0];
  if (closed === undefined) return refuse('opportunity_not_closed');

  const stages = await listPipelineStages(context);
  const first = stages.find(stage => stage.terminal_kind === null && !stage.retired);
  if (first === undefined) return refuse('stage_unknown');

  const { rows } = await context.db.query<OpportunityRow>(
    `INSERT INTO opportunities
       (workspace_id, firm_id, stage_id, control_mode, control_mode_reason, control_mode_changed_at,
        reopened_from_opportunity_id)
     VALUES ($1, $2, $3, 'manual', $4, now(), $5)
     RETURNING ${OPPORTUNITY_COLUMNS}`,
    [context.scope.workspaceId, input.firmId, first.id, `reopened: ${input.reason.trim()}`, closed.id],
  );
  const reopened = rows[0];
  if (reopened === undefined) return refuse('invalid_input');

  await writeStageEvent(context, reopened, null, first.id, input.reason.trim(), input.commandId);
  await emitCrmDomainEvent(context, {
    kind: 'opportunity.reopened',
    firmId: input.firmId,
    opportunityId: reopened.id,
    dedupeKey: `${reopened.id}`,
    commandId: input.commandId,
    detail: { reopenedFrom: closed.id },
  });
  await recordCrmAuditEvent(context, {
    action: 'opportunity.reopened',
    subjectKind: 'opportunity',
    subjectId: reopened.id,
    detail: { firmId: input.firmId, reopenedFrom: closed.id },
  });

  return accept({ opportunityId: reopened.id, firmId: input.firmId, reopenedFrom: closed.id });
}

/** A timestamptz column as a stable string, for an idempotency key. */
function instantLabel(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

/** The append-only event every stage change commits with (8.1, Appendix A). */
async function writeStageEvent(
  context: RepositoryContext,
  opportunity: OpportunityRow,
  fromStageId: string | null,
  toStageId: string,
  reason: string | undefined,
  commandId: string | undefined,
): Promise<void> {
  await context.db.query(
    `INSERT INTO opportunity_stage_events
       (workspace_id, opportunity_id, firm_id, from_stage_id, to_stage_id, actor_kind, actor_user_id, reason, command_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      context.scope.workspaceId,
      opportunity.id,
      opportunity.firm_id,
      fromStageId,
      toStageId,
      actorKind(context),
      actorUserId(context),
      reason ?? null,
      commandId ?? null,
    ],
  );
}

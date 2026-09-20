import type { CallOutcome, CallStepEffect } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import { decideFirmMutation } from '../crm/authorization.ts';
import { loadFirmForUpdate } from '../crm/firms.ts';
import { readOpenOpportunity, setManualControlMode } from '../crm/pipeline.ts';
import { retireRoute } from '../crm/routes.ts';
import { acceptPolicy, refusePolicy, type PolicyResult } from '../policy/types.ts';
import { recordSuppression } from '../suppression/events.ts';
import type { SuppressionJournal } from '../suppression/journal.ts';
import { createCallback } from './callbacks.ts';
import { callOutcomeEffects, manualReasonFor } from './outcomes.ts';

/**
 * Logging a call and applying what it means (specification 9.1, Appendix A).
 *
 * "Call logging always records what occurred, even if no valid ticket exists; it
 * never refuses history."
 *
 * That sentence is about the *ticket*, not about authorization. A call placed from a
 * phone FSS never authorized is still a call that happened and is still worth
 * recording, so `ticketId`, `routeId` and `callingIdentityId` are all optional and
 * none of them is checked against a policy decision. Who may write the row is a
 * different question, and it is the CRM's usual one: `decideFirmMutation` under the
 * firm's row lock, because a salesperson writing history onto a colleague's firm is
 * Appendix G 7 and not history.
 *
 * The order is: lock the firm, write the log, then apply the effects. The log first
 * because it is the part that must survive — if suppressing the number fails, the
 * transaction rolls back and nothing is recorded, which is right; but if the log
 * came last it could be lost to a refusal in an effect that the person did not ask
 * for.
 */

export interface LogCallOutcomeInput {
  readonly firmId: string;
  readonly contactId?: string | undefined;
  readonly routeId?: string | undefined;
  readonly ticketId?: string | undefined;
  readonly callingIdentityId?: string | undefined;
  readonly outcome: CallOutcome;
  readonly occurredAt: string;
  readonly note?: string | undefined;
  /** The step's configured behaviour, consulted for `no_answer` and `busy` only. */
  readonly retryBehaviour?: 'advance' | 'retry_call' | undefined;
  /** Required by `callback_requested`: the instant the salesperson confirmed. */
  readonly callback?:
    | {
        readonly localDate: string;
        readonly localTime?: string | undefined;
        readonly dueAt: string;
        readonly sourceTimeZone: string;
      }
    | undefined;
  /** `do_not_call` suppresses the firm only when the request covered all Callie contact. */
  readonly doNotCallCoversAllContact?: boolean | undefined;
  readonly commandId?: string | undefined;
  /** Required whenever the outcome may suppress. The journal write precedes the row. */
  readonly journal?: SuppressionJournal | undefined;
}

export interface LoggedCall {
  readonly callLogId: string;
  readonly outcome: CallOutcome;
  readonly stepEffect: CallStepEffect;
  readonly setManual: boolean;
  /** Present when the outcome suggests a close the salesperson must confirm (9.1). */
  readonly suggestedStageKey: 'lost' | null;
  readonly suppressionEventIds: readonly string[];
  readonly retiredRouteId: string | null;
  readonly callbackId: string | null;
}

export async function logCallOutcome(
  context: RepositoryContext,
  input: LogCallOutcomeInput,
): Promise<PolicyResult<LoggedCall>> {
  const actor = context.scope.actor;
  if (actor.kind !== 'user') return refusePolicy('invalid_input');

  const firm = await loadFirmForUpdate(context, input.firmId);
  if (firm === null) return refusePolicy('firm_unknown');
  const permitted = decideFirmMutation(context, firm);
  if (!permitted.permitted) {
    return refusePolicy(permitted.reason === 'not_assigned' ? 'not_assigned' : 'firm_unknown');
  }

  const effects = callOutcomeEffects(input.outcome, input.retryBehaviour ?? 'advance');
  if (effects.createsCallbackOnConfirmation && input.callback === undefined) {
    // 9.1: the callback exists "after salesperson confirmation of the instant". No
    // confirmed instant, no callback — and the call is not recorded as one either,
    // because the outcome and its effect have to agree.
    return refusePolicy('invalid_input');
  }
  if (effects.suppressesNumber && input.journal === undefined) return refusePolicy('invalid_input');
  if (effects.retiresRoute && input.routeId === undefined) return refusePolicy('invalid_input');

  const opportunity = await readOpenOpportunity(context, input.firmId);
  const dialedNumber = input.routeId === undefined ? null : await readRouteNumber(context, input.routeId);

  const logged = await context.db.query<{ id: string }>(
    `INSERT INTO call_logs
       (workspace_id, firm_id, contact_id, opportunity_id, phone_route_id, calling_identity_id,
        ticket_id, outcome, step_effect, occurred_at, actor_user_id, command_id, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz, $11, $12, $13)
     RETURNING id`,
    [
      context.scope.workspaceId,
      input.firmId,
      input.contactId ?? null,
      opportunity?.id ?? null,
      input.routeId ?? null,
      input.callingIdentityId ?? null,
      input.ticketId ?? null,
      input.outcome,
      effects.stepEffect,
      input.occurredAt,
      actor.userId,
      input.commandId ?? null,
      input.note ?? null,
    ],
  );
  const callLogId = logged.rows[0]?.id;
  if (callLogId === undefined) return refusePolicy('invalid_input');

  // ---- the effects, in the order 9.1 lists them --------------------------
  let setManual = false;
  if (effects.setsManual && opportunity !== null && opportunity.control_mode !== 'manual') {
    const changed = await setManualControlMode(context, {
      opportunityId: opportunity.id,
      reason: manualReasonFor(input.outcome),
      ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
    });
    if (!changed.ok) return refusePolicy('invalid_input');
    setManual = true;
  }

  const suppressionEventIds: string[] = [];
  if (effects.suppressesNumber && input.journal !== undefined) {
    if (dialedNumber === null) return refusePolicy('invalid_input');
    // "Suppress the number immediately" — always. The number is what was asked about.
    const handle = await recordSuppression(context, {
      scope: 'handle',
      value: dialedNumber,
      firmId: input.firmId,
      source: 'prospect_do_not_call',
      ...(input.commandId === undefined ? {} : { commandId: `${input.commandId}:handle` }),
      journal: input.journal,
    });
    if (!handle.ok) return refusePolicy('invalid_input');
    suppressionEventIds.push(handle.value.eventId);

    // "Suppress the firm only when the request covers all Callie contact." The
    // salesperson says which; nothing infers it from the wording of a call.
    if (input.doNotCallCoversAllContact === true) {
      const firmWide = await recordSuppression(context, {
        scope: 'firm',
        firmId: input.firmId,
        source: 'prospect_do_not_call',
        ...(input.commandId === undefined ? {} : { commandId: `${input.commandId}:firm` }),
        journal: input.journal,
      });
      if (!firmWide.ok) return refusePolicy('invalid_input');
      suppressionEventIds.push(firmWide.value.eventId);
    }
  }

  let retiredRouteId: string | null = null;
  if (effects.retiresRoute && input.routeId !== undefined) {
    const retired = await retireRoute(context, {
      routeKind: 'phone',
      routeId: input.routeId,
      reason: 'wrong number, recorded on a call',
    });
    if (!retired.ok) return refusePolicy('invalid_input');
    retiredRouteId = input.routeId;
  }

  let callbackId: string | null = null;
  if (effects.createsCallbackOnConfirmation && input.callback !== undefined) {
    const created = await createCallback(context, {
      firmId: input.firmId,
      ...(input.contactId === undefined ? {} : { contactId: input.contactId }),
      ...(opportunity === null ? {} : { opportunityId: opportunity.id }),
      callLogId,
      assignedUserId: firm.assigned_user_id ?? actor.userId,
      localDate: input.callback.localDate,
      ...(input.callback.localTime === undefined ? {} : { localTime: input.callback.localTime }),
      sourceTimeZone: input.callback.sourceTimeZone,
      dueAt: input.callback.dueAt,
    });
    if (!created.ok) return refusePolicy(created.reason);
    callbackId = created.value.id;
  }

  await recordCrmAuditEvent(context, {
    action: 'call.logged',
    subjectKind: 'call_log',
    subjectId: callLogId,
    detail: {
      firmId: input.firmId,
      outcome: input.outcome,
      stepEffect: effects.stepEffect,
      setManual,
      suppressions: suppressionEventIds.length,
    },
  });

  return acceptPolicy({
    callLogId,
    outcome: input.outcome,
    stepEffect: effects.stepEffect,
    setManual,
    suggestedStageKey: effects.suggestsLost ? 'lost' : null,
    suppressionEventIds,
    retiredRouteId,
    callbackId,
  });
}

async function readRouteNumber(context: RepositoryContext, routeId: string): Promise<string | null> {
  const { rows } = await context.db.query<{ e164: string }>(
    'SELECT e164 FROM phone_routes WHERE workspace_id = $1 AND id = $2',
    [context.scope.workspaceId, routeId],
  );
  return rows[0]?.e164 ?? null;
}

export interface CallLogRow {
  readonly id: string;
  readonly firmId: string;
  readonly contactId: string | null;
  readonly outcome: CallOutcome;
  readonly stepEffect: CallStepEffect;
  readonly occurredAt: string;
  readonly actorUserId: string;
  /** Appendix F: only the assigned salesperson and admins see this. */
  readonly note: string | null;
}

export async function listCallLogs(
  context: RepositoryContext,
  options: { readonly firmId: string; readonly limit?: number },
): Promise<readonly CallLogRow[]> {
  const { rows } = await context.db.query<{
    id: string;
    firm_id: string;
    contact_id: string | null;
    outcome: CallOutcome;
    step_effect: CallStepEffect;
    occurred_at: Date;
    actor_user_id: string;
    note: string | null;
  }>(
    `SELECT id, firm_id, contact_id, outcome, step_effect, occurred_at, actor_user_id, note
       FROM call_logs
      WHERE workspace_id = $1 AND firm_id = $2
      ORDER BY occurred_at DESC, id
      LIMIT $3`,
    [context.scope.workspaceId, options.firmId, Math.trunc(options.limit ?? 100)],
  );
  return rows.map(row => ({
    id: row.id,
    firmId: row.firm_id,
    contactId: row.contact_id,
    outcome: row.outcome,
    stepEffect: row.step_effect,
    occurredAt: row.occurred_at.toISOString(),
    actorUserId: row.actor_user_id,
    note: row.note,
  }));
}

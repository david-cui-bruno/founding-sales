import {
  CALL_OCCURRED_AT_TOLERANCE_SECONDS,
  type CallFollowUp,
  type CallOutcome,
  type CallStepApplication,
  type CallStepEffect,
} from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import { decideFirmMutation } from '../crm/authorization.ts';
import { loadFirmForUpdate } from '../crm/firms.ts';
import { readOpenOpportunity, setManualControlMode } from '../crm/pipeline.ts';
import { retireRoute } from '../crm/routes.ts';
import { databaseNow } from '../policy/clock.ts';
import {
  acceptPolicy,
  refusePolicy,
  type PolicyRefusalCode,
  type PolicyResult,
} from '../policy/types.ts';
import { applyManualModeStop } from '../sequences/terminalStops.ts';
import { recordSuppression } from '../suppression/events.ts';
import type { SuppressionJournal } from '../suppression/journal.ts';
import { businessDateOf, completeTodayItemsByKey, readTodayItem, upsertTodayItem } from '../today/snapshots.ts';
import { callLogIdOfItemKey, callbackTimeNeededItemKey } from '../today/types.ts';
import { completeCallback, createCallback, resolveConfirmedInstant } from './callbacks.ts';
import { manualReasonFor } from './outcomes.ts';
import { applyCallToStep, effectsForBoundStep, loadBoundCallStep, type BoundStep } from './stepEffects.ts';

/**
 * Logging a call and applying what it means (specification 9.1, Appendix A "Log call
 * outcome"; lane g79).
 *
 * "Call logging always records what occurred, even if no valid ticket exists; it
 * never refuses history."
 *
 * ## Three phases, and why a refusal can only come from the first
 *
 * 1. **Decide.** Lock the firm and apply the CRM's assignment rule — a salesperson
 *    writing history onto a colleague's firm is Appendix G 7, not history. Then check
 *    every identity the request names against the firm it names: the contact is at
 *    this firm, the route is this firm's and this contact's (S15), the ticket is this
 *    workspace's, this firm's, this actor's and this route's (C16, S15), the calling
 *    identity is the actor's own, and the Today task is this firm's and — when it is a
 *    sequence step — a call step whose frozen configuration is read here, under the
 *    step's lock (C04). A contradiction is malformed input and is refused, and nothing
 *    has been written yet. A callback without a confirmed instant, or with one the
 *    server resolves differently (C18), is **not** a refusal: it becomes a follow-up.
 * 2. **Record.** Write the call log. From here on the call is history and the command
 *    is accepted. `occurred_at` is database time unless the person entered a past time
 *    (C15); `step_execution_id`, `ticket_id` and `calling_identity_id` are the ones the
 *    first phase resolved.
 * 3. **Apply.** Every effect runs inside one savepoint: the step's successor or retry,
 *    manual mode and the stop of every live enrollment at the firm, the suppression,
 *    the retired route, the completed callback, the new callback. If any of them is
 *    refused, the savepoint is rolled back — none of the effects happened — and the
 *    answer says so as an `effects_not_applied` follow-up beside the recorded call
 *    (C14). An exception is different: a journal that could not be written (10.2) or
 *    a broken statement propagates, and the whole command, call log included, rolls
 *    back to be retried under the same command id.
 *
 * What a person still has to do is said in `followUps` rather than by refusing: a
 * callback that needs a time goes on Today as its own task (C13), and a wrong number
 * or a do-not-call with no number named says that no number was acted on.
 */

export interface LogCallOutcomeInput {
  readonly firmId: string;
  readonly contactId?: string | undefined;
  readonly routeId?: string | undefined;
  readonly ticketId?: string | undefined;
  readonly callingIdentityId?: string | undefined;
  /** The Today task the call was placed from. Binds the call to its step or callback. */
  readonly itemId?: string | undefined;
  readonly outcome: CallOutcome;
  /** An entered past time. Absent means now, on the database's clock (C15). */
  readonly occurredAt?: string | undefined;
  readonly note?: string | undefined;
  /** For `callback_requested`: the wall clock the salesperson confirmed. */
  readonly callback?:
    | {
        readonly localDate: string;
        readonly localTime?: string | undefined;
        /** What the client resolved and showed. Checked against the server's resolution. */
        readonly dueAt?: string | undefined;
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
  readonly occurredAt: string;
  readonly setManual: boolean;
  /** Present when the outcome suggests a close the salesperson must confirm (9.1). */
  readonly suggestedStageKey: 'lost' | null;
  readonly suppressionEventIds: readonly string[];
  readonly retiredRouteId: string | null;
  /** The callback this call created. */
  readonly callbackId: string | null;
  /** The step execution this call was placed for, when it was placed from its task. */
  readonly stepExecutionId: string | null;
  readonly stepApplication: CallStepApplication | null;
  readonly successorExecutionId: string | null;
  /** The callback this call fulfilled (Appendix A "Callback confirm/complete"). */
  readonly completedCallbackId: string | null;
  readonly followUps: readonly CallFollowUp[];
}

interface RouteRow {
  readonly id: string;
  readonly firm_id: string;
  readonly contact_id: string | null;
  readonly e164: string;
  readonly [column: string]: unknown;
}

interface TicketRow {
  readonly firm_id: string;
  readonly contact_id: string | null;
  readonly phone_route_id: string;
  readonly calling_identity_id: string;
  readonly actor_user_id: string;
  readonly [column: string]: unknown;
}

/** Outcomes that fulfil a callback: somebody was reached, or a message was left. */
function fulfilsCallback(outcome: CallOutcome, engaged: boolean): boolean {
  return engaged || outcome === 'voicemail_left';
}

export async function logCallOutcome(
  context: RepositoryContext,
  input: LogCallOutcomeInput,
): Promise<PolicyResult<LoggedCall>> {
  const actor = context.scope.actor;
  if (actor.kind !== 'user') return refusePolicy('invalid_input');

  // ---- 1. Decide ----------------------------------------------------------
  const firm = await loadFirmForUpdate(context, input.firmId);
  if (firm === null) return refusePolicy('firm_unknown');
  const permitted = decideFirmMutation(context, firm);
  if (!permitted.permitted) {
    return refusePolicy(permitted.reason === 'not_assigned' ? 'not_assigned' : 'firm_unknown');
  }

  // C15: "just now" is the database's now. An entered time is history and may be
  // anything in the past; ahead of the clock by more than the tolerance it is a time
  // that has not happened, and inside the tolerance it is an unsynchronised clock.
  const now = await databaseNow(context);
  let occurredAt = now;
  if (input.occurredAt !== undefined) {
    const entered = Date.parse(input.occurredAt);
    if (!Number.isFinite(entered)) return refusePolicy('invalid_input');
    const serverNow = Date.parse(now);
    if (entered > serverNow + CALL_OCCURRED_AT_TOLERANCE_SECONDS * 1000) return refusePolicy('occurred_at_in_future');
    occurredAt = entered > serverNow ? now : new Date(entered).toISOString();
  }

  // C16 and S15: the ticket the call was placed with, and everything it binds.
  let ticket: TicketRow | null = null;
  if (input.ticketId !== undefined) {
    const { rows } = await context.db.query<TicketRow>(
      `SELECT firm_id, contact_id, phone_route_id, calling_identity_id, actor_user_id
         FROM dial_tickets WHERE workspace_id = $1 AND id = $2`,
      [context.scope.workspaceId, input.ticketId],
    );
    ticket = rows[0] ?? null;
    if (ticket === null || ticket.firm_id !== input.firmId || ticket.actor_user_id !== actor.userId) {
      return refusePolicy('ticket_mismatch');
    }
    if (input.routeId !== undefined && input.routeId !== ticket.phone_route_id) return refusePolicy('ticket_mismatch');
    if (input.callingIdentityId !== undefined && input.callingIdentityId !== ticket.calling_identity_id) {
      return refusePolicy('ticket_mismatch');
    }
  }
  const routeId = input.routeId ?? ticket?.phone_route_id;
  const callingIdentityId = input.callingIdentityId ?? ticket?.calling_identity_id;
  const contactId = input.contactId ?? ticket?.contact_id ?? undefined;

  if (contactId !== undefined) {
    const { rows } = await context.db.query(
      'SELECT 1 FROM contacts WHERE workspace_id = $1 AND id = $2 AND firm_id = $3',
      [context.scope.workspaceId, contactId, input.firmId],
    );
    if (rows.length === 0) return refusePolicy('contact_unknown');
  }

  // S15: the route is this firm's, and this contact's when both are named. Effects
  // below retire and suppress it, so a route from another firm must never get there.
  let route: RouteRow | null = null;
  if (routeId !== undefined) {
    const { rows } = await context.db.query<RouteRow>(
      'SELECT id, firm_id, contact_id, e164 FROM phone_routes WHERE workspace_id = $1 AND id = $2',
      [context.scope.workspaceId, routeId],
    );
    route = rows[0] ?? null;
    if (route === null || route.firm_id !== input.firmId) return refusePolicy('route_unknown');
    if (contactId !== undefined && route.contact_id !== null && route.contact_id !== contactId) {
      return refusePolicy('route_unknown');
    }
  }

  if (callingIdentityId !== undefined && ticket === null) {
    const { rows } = await context.db.query<{ owner_user_id: string | null }>(
      'SELECT owner_user_id FROM calling_identities WHERE workspace_id = $1 AND id = $2',
      [context.scope.workspaceId, callingIdentityId],
    );
    if (rows[0] === undefined || rows[0].owner_user_id !== actor.userId) return refusePolicy('identity_unknown');
  }

  // C04, C17, C13: the Today task the call was placed from, and what is behind it.
  let bound: BoundStep | null = null;
  let boundCallbackId: string | null = null;
  let boundNeedsTimeKey: string | null = null;
  if (input.itemId !== undefined) {
    const item = await readTodayItem(context, input.itemId);
    if (item === null || item.firmId !== input.firmId) return refusePolicy('item_unknown');
    if (item.sourceKind === 'step_execution' && item.sourceId !== null) {
      bound = await loadBoundCallStep(context, { stepExecutionId: item.sourceId, firmId: input.firmId });
      if (bound === null) return refusePolicy('item_unknown');
    } else if (item.sourceKind === 'callback' && item.sourceId !== null) {
      boundCallbackId = item.sourceId;
    } else if (callLogIdOfItemKey(item.itemKey) !== null) {
      boundNeedsTimeKey = item.itemKey;
    }
  }

  const effects = effectsForBoundStep(input.outcome, bound);
  const engaged = effects.setsManual;
  if (effects.suppressesNumber && input.journal === undefined) return refusePolicy('invalid_input');

  const followUps: CallFollowUp[] = [];
  let confirmedCallback: { readonly dueAt: string } | null = null;
  if (effects.createsCallbackOnConfirmation) {
    if (input.callback === undefined) {
      followUps.push({ kind: 'callback_time_needed', reason: 'no_instant' });
    } else {
      const resolved = resolveConfirmedInstant(input.callback);
      if (resolved.ok) confirmedCallback = { dueAt: resolved.dueAt };
      else {
        followUps.push({
          kind: 'callback_time_needed',
          reason: resolved.reason === 'callback_instant_mismatch' ? 'instant_mismatch' : 'instant_invalid',
        });
      }
    }
  }
  if ((effects.retiresRoute || effects.suppressesNumber) && route === null) {
    followUps.push({ kind: 'route_not_named', reason: input.outcome });
  }

  const opportunity = await readOpenOpportunity(context, input.firmId);

  // ---- 2. Record ----------------------------------------------------------
  const logged = await context.db.query<{ id: string }>(
    `INSERT INTO call_logs
       (workspace_id, firm_id, contact_id, opportunity_id, phone_route_id, calling_identity_id,
        ticket_id, step_execution_id, outcome, step_effect, occurred_at, actor_user_id, command_id, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz, $12, $13, $14)
     RETURNING id`,
    [
      context.scope.workspaceId,
      input.firmId,
      contactId ?? null,
      opportunity?.id ?? null,
      route?.id ?? null,
      callingIdentityId ?? null,
      input.ticketId ?? null,
      bound?.execution.id ?? null,
      input.outcome,
      effects.stepEffect,
      occurredAt,
      actor.userId,
      input.commandId ?? null,
      input.note ?? null,
    ],
  );
  const callLogId = logged.rows[0]?.id;
  if (callLogId === undefined) throw new Error('the call log insert returned no row');

  // ---- 3. Apply -----------------------------------------------------------
  const applied = await withinSavepoint(context, async (): Promise<PolicyResult<AppliedEffects>> => {
    let stepApplication: CallStepApplication | null = null;
    let successorExecutionId: string | null = null;
    if (bound !== null) {
      const step = await applyCallToStep(context, {
        bound,
        outcome: input.outcome,
        stepEffect: effects.stepEffect,
        engaged,
        occurredAt,
        now,
      });
      stepApplication = step.application;
      successorExecutionId = step.successorExecutionId;
    }

    let setManual = false;
    if (effects.setsManual && opportunity !== null && opportunity.control_mode !== 'manual') {
      const changed = await setManualControlMode(context, {
        opportunityId: opportunity.id,
        reason: manualReasonFor(input.outcome),
        origin: 'engaged_call',
        ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
      });
      if (!changed.ok) return refusePolicy(changed.reason === 'not_assigned' ? 'not_assigned' : 'invalid_input');
      setManual = true;
    }
    // 7.3 and Appendix G 26: an engaged call ends every live enrollment at the firm in
    // this transaction, so no successor anywhere survives it. The outbox drain does
    // the same later and finds nothing left to stop.
    if (engaged) await applyManualModeStop(context, { firmId: input.firmId, origin: 'engaged_call', cause: 'call.logged' });

    const suppressionEventIds: string[] = [];
    if (effects.suppressesNumber && input.journal !== undefined) {
      // "Suppress the number immediately" — the number that was dialed.
      if (route !== null) {
        const handle = await recordSuppression(context, {
          scope: 'handle',
          value: route.e164,
          firmId: input.firmId,
          source: 'prospect_do_not_call',
          ...(input.commandId === undefined ? {} : { commandId: `${input.commandId}:handle` }),
          journal: input.journal,
        });
        if (!handle.ok) return refusePolicy(asPolicyRefusal(handle.reason));
        suppressionEventIds.push(handle.value.eventId);
      }
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
        if (!firmWide.ok) return refusePolicy(asPolicyRefusal(firmWide.reason));
        suppressionEventIds.push(firmWide.value.eventId);
      }
    }

    let retiredRouteId: string | null = null;
    if (effects.retiresRoute && route !== null) {
      const retired = await retireRoute(context, {
        routeKind: 'phone',
        routeId: route.id,
        reason: 'wrong number, recorded on a call',
      });
      if (!retired.ok) return refusePolicy('route_unknown');
      retiredRouteId = route.id;
    }

    // C17: the callback this call was placed for is fulfilled by reaching somebody or
    // leaving a message; a missed call leaves it open to try again.
    let completedCallbackId: string | null = null;
    if (boundCallbackId !== null && fulfilsCallback(input.outcome, engaged)) {
      const completed = await completeCallback(context, { callbackId: boundCallbackId });
      if (completed.ok) completedCallbackId = completed.value.id;
      else if (completed.reason !== 'callback_not_open') return refusePolicy(completed.reason);
    }
    if (boundNeedsTimeKey !== null && fulfilsCallback(input.outcome, engaged)) {
      await completeTodayItemsByKey(context, { firmId: input.firmId, itemKey: boundNeedsTimeKey });
    }

    let callbackId: string | null = null;
    if (confirmedCallback !== null && input.callback !== undefined) {
      const created = await createCallback(context, {
        firmId: input.firmId,
        ...(contactId === undefined ? {} : { contactId }),
        ...(opportunity === null ? {} : { opportunityId: opportunity.id }),
        callLogId,
        assignedUserId: firm.assigned_user_id ?? actor.userId,
        localDate: input.callback.localDate,
        ...(input.callback.localTime === undefined ? {} : { localTime: input.callback.localTime }),
        sourceTimeZone: input.callback.sourceTimeZone,
        dueAt: confirmedCallback.dueAt,
      });
      if (!created.ok) return refusePolicy(created.reason);
      callbackId = created.value.id;
    }

    return acceptPolicy({
      stepApplication,
      successorExecutionId,
      setManual,
      suppressionEventIds,
      retiredRouteId,
      completedCallbackId,
      callbackId,
    });
  });

  const outcomes: AppliedEffects = applied.ok
    ? applied.value
    : {
        stepApplication: bound === null ? null : 'not_completed',
        successorExecutionId: null,
        setManual: false,
        suppressionEventIds: [],
        retiredRouteId: null,
        completedCallbackId: null,
        callbackId: null,
      };
  if (!applied.ok) followUps.push({ kind: 'effects_not_applied', reason: applied.reason });

  // C13: a recorded "call me back" with no callback goes on Today as "Callback — needs
  // a time", now, and the callback source carries it to each following day until a
  // time is set. Outside the savepoint: a rolled-back effect is exactly when it is
  // needed most.
  if (input.outcome === 'callback_requested' && outcomes.callbackId === null) {
    if (!followUps.some(entry => entry.kind === 'callback_time_needed')) {
      followUps.push({ kind: 'callback_time_needed', reason: 'not_created' });
    }
    await upsertTodayItem(context, {
      businessDate: await businessDateOf(context, now),
      firmId: input.firmId,
      ...(contactId === undefined ? {} : { contactId }),
      itemKey: callbackTimeNeededItemKey(callLogId),
      kind: 'callback',
      dueAt: now,
      sourceKind: 'callback',
    });
  }

  await recordCrmAuditEvent(context, {
    action: 'call.logged',
    subjectKind: 'call_log',
    subjectId: callLogId,
    detail: {
      firmId: input.firmId,
      outcome: input.outcome,
      stepEffect: effects.stepEffect,
      stepExecutionId: bound?.execution.id ?? null,
      stepApplication: outcomes.stepApplication,
      ticketId: input.ticketId ?? null,
      setManual: outcomes.setManual,
      suppressions: outcomes.suppressionEventIds.length,
      followUps: followUps.map(entry => `${entry.kind}:${entry.reason}`),
    },
  });

  return acceptPolicy({
    callLogId,
    outcome: input.outcome,
    stepEffect: effects.stepEffect,
    occurredAt,
    setManual: outcomes.setManual,
    suggestedStageKey: effects.suggestsLost ? 'lost' : null,
    suppressionEventIds: outcomes.suppressionEventIds,
    retiredRouteId: outcomes.retiredRouteId,
    callbackId: outcomes.callbackId,
    stepExecutionId: bound?.execution.id ?? null,
    stepApplication: outcomes.stepApplication,
    successorExecutionId: outcomes.successorExecutionId,
    completedCallbackId: outcomes.completedCallbackId,
    followUps,
  });
}

interface AppliedEffects {
  readonly stepApplication: CallStepApplication | null;
  readonly successorExecutionId: string | null;
  readonly setManual: boolean;
  readonly suppressionEventIds: readonly string[];
  readonly retiredRouteId: string | null;
  readonly completedCallbackId: string | null;
  readonly callbackId: string | null;
}

/** A suppression refusal, in this command's vocabulary. The code itself is kept in the audit. */
function asPolicyRefusal(reason: string): PolicyRefusalCode {
  return reason === 'not_assigned' || reason === 'firm_unknown' ? reason : 'invalid_input';
}

const EFFECTS_SAVEPOINT = 'call_outcome_effects';

/**
 * Run `work` so that a refusal undoes everything it wrote and nothing before it
 * (audit item C14).
 *
 * Inside a transaction — every command, through `runCommand` — this is a savepoint.
 * Outside one, which only a test calling the domain directly on an autocommit session
 * does, the effects are their own transaction, which gives the same answer: the call
 * log before them is committed either way, and the effects commit or vanish together.
 * An exception rolls the effects back and propagates, so the caller's transaction
 * rolls back the call log with them.
 */
async function withinSavepoint<T>(
  context: RepositoryContext,
  work: () => Promise<PolicyResult<T>>,
): Promise<PolicyResult<T>> {
  let nested = true;
  try {
    await context.db.query(`SAVEPOINT ${EFFECTS_SAVEPOINT}`);
  } catch (error) {
    // 25P01 no_active_sql_transaction: not inside a transaction block.
    if ((error as { code?: string }).code !== '25P01') throw error;
    nested = false;
    await context.db.query('BEGIN');
  }
  const undo = async (): Promise<void> => {
    if (nested) {
      await context.db.query(`ROLLBACK TO SAVEPOINT ${EFFECTS_SAVEPOINT}`);
      await context.db.query(`RELEASE SAVEPOINT ${EFFECTS_SAVEPOINT}`);
    } else {
      await context.db.query('ROLLBACK');
    }
  };
  let result: PolicyResult<T>;
  try {
    result = await work();
  } catch (error) {
    await undo();
    throw error;
  }
  if (result.ok) await context.db.query(nested ? `RELEASE SAVEPOINT ${EFFECTS_SAVEPOINT}` : 'COMMIT');
  else await undo();
  return result;
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

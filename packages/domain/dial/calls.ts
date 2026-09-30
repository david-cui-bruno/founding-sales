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
import { openOpportunity, readOpenOpportunity, reopenOpportunity, setManualControlMode } from '../crm/pipeline.ts';
import { grantFollowUpPermission } from '../sequences/followUpPermissions.ts';
import { retireRoute } from '../crm/routes.ts';
import { databaseNow } from '../policy/clock.ts';
import {
  acceptPolicy,
  refusePolicy,
  type PolicyRefusalCode,
  type PolicyResult,
} from '../policy/types.ts';
import { lockSendGateForStopFact } from '../policy/sendGate.ts';
import { enrollContact } from '../sequences/enrollments.ts';
import { readSequenceVersion } from '../sequences/rows.ts';
import { readTemplateVersion } from '../templates/templates.ts';
import { currentHolidayCalendar } from '../sequences/calendars.ts';
import { previewBasisHolds, type PreviewBasis } from './followUpPreview.ts';
import { applyManualModeStop } from '../sequences/terminalStops.ts';
import { recordSuppression } from '../suppression/events.ts';
import type { SuppressionJournal } from '../suppression/journal.ts';
import { businessDateOf, completeTodayItemsByKey, readTodayItem, upsertTodayItem } from '../today/snapshots.ts';
import { callLogIdOfItemKey, callbackTimeNeededItemKey } from '../today/types.ts';
import { completeCallback, createCallback, resolveConfirmedInstant } from './callbacks.ts';
import { manualReasonFor } from './outcomes.ts';
import { UNANSWERED_OUTCOMES, parkIfCadenceSpent } from '../calls/sessions.ts';
import { applyCallToStep, effectsForBoundStep, loadBoundCallStep, type BoundStep } from './stepEffects.ts';

/**
 * Logging a call and applying what it means (specification 9.1, Appendix A "Log call
 * outcome").
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
  /** The call session it was placed through (0028): its ticket is the call's ticket. */
  readonly callSessionId?: string | undefined;
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
  /**
   * The follow-up the salesperson agreed with the person on this call (migration 0025).
   *
   * David, 29 September 2026: *"'Email me an overview' permits that email, not an
   * automatic multi-week sequence. ... An agreed follow-up sequence can run within its
   * agreed scope."* So the choice belongs to the salesperson at the moment of recording
   * the outcome, and there are exactly three answers: one e-mail, a named sequence, or
   * nothing. Permitted only on `interested`, which is the outcome that means a
   * conversation happened.
   *
   * `callback_requested` is deliberately **not** one of them: "Call me Tuesday" means a
   * callback task, and this command already creates one. It grants no e-mail permission
   * of any kind.
   */
  readonly followUpPermission?:
    | { readonly scope: 'single_email'; readonly templateVersionId: string }
    | {
        readonly scope: 'agreed_sequence';
        readonly sequenceVersionId: string;
        /**
         * The schedule the card showed (review of S3, P1-3). The route always passes it —
         * the wire contract requires it — and a zone or calendar version that has changed
         * since is `stale_preview`. Absent only for a direct domain caller (tests), which
         * then enrols on the schedule as it is now.
         */
        readonly previewBasis?: PreviewBasis | undefined;
      }
    | undefined;
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
  /** The follow-up permission this outcome granted, if any (migration 0025). */
  readonly followUpPermissionId: string | null;
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
  //
  // The send gate first, before any row (P1-4 of the second review of PR 332). An
  // engaged call is a stop fact: it sets the opportunity manual and ends its
  // enrollments, and `policy/sendGate.ts` asks every stop-fact writer to take the gate
  // EXCLUSIVE before it locks anything. This function used to lock the firm first and
  // reach the gate only at step 3 — the opposite of the claim's gate-then-firm order, so
  // a claim waiting for the firm and a call waiting for the gate could deadlock. Taking
  // it here costs nothing: the same lock is taken a few statements later either way, and
  // a call that refuses releases it at the end of the caller's transaction.
  await lockSendGateForStopFact(context);
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

  // A call placed through a Twilio call session names the session; its ticket is the
  // call's ticket, and a session that is not this workspace's is the same mismatch.
  if (input.callSessionId !== undefined) {
    const { rows: sessions } = await context.db.query<{ ticket_id: string }>(
      'SELECT ticket_id FROM call_sessions WHERE workspace_id = $1 AND id = $2',
      [context.scope.workspaceId, input.callSessionId],
    );
    const sessionTicket = sessions[0]?.ticket_id;
    if (sessionTicket === undefined) return refusePolicy('ticket_mismatch');
    if (input.ticketId !== undefined && input.ticketId !== sessionTicket) return refusePolicy('ticket_mismatch');
    input = { ...input, ticketId: sessionTicket };
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
  // An agreement belongs to the outcome that means a conversation happened. Anything
  // else — a voicemail, a no-answer, "call me Tuesday" — agreed to nothing, and migration
  // 0025's `call_logs_agreement_needs_interest` says so in the database. Refused here so
  // a client that sends a stale field gets a code rather than a constraint violation.
  //
  // And an agreement needs a **person**: a permission is granted to somebody, and a log
  // with no contact is a call to a main line. Both are checked *before* the call log is
  // written, which is the third review of PR 332: the contact check used to sit inside
  // the savepoint that carries the engaged-call stop, so an agreement with no contact
  // rolled the stop back and the command still answered accepted — the sequences kept
  // running against a firm that had just had a conversation.
  if (input.followUpPermission !== undefined) {
    if (input.outcome !== 'interested') return refusePolicy('invalid_input');
    if (input.contactId === undefined && ticket?.contact_id == null) return refusePolicy('invalid_input');
    // Send-path v2 (slice S3): an agreed sequence names one **published** version of this
    // workspace's own sequences, checked here for the same reason as the two rules above —
    // before the call log exists, so a stale or foreign id is a code on the answer and
    // never a recorded conversation whose agreement could not be kept. The read is
    // workspace-scoped, so another workspace's version is `version_unknown`, exactly as a
    // version that never existed is.
    if (input.followUpPermission.scope === 'agreed_sequence') {
      const version = await readSequenceVersion(context, input.followUpPermission.sequenceVersionId);
      if (version === null) return refusePolicy('version_unknown');
      if (version.state !== 'published') return refusePolicy('version_not_published');
    }
  }

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
  //
  // What was agreed is not in this INSERT. Since send-path v2 (slice S3) the agreement
  // columns (`agreed_follow_up`, `agreed_template_version_id`,
  // `agreed_sequence_version_id`, migration 0025) are written by an UPDATE of this row in
  // a savepoint of its own after the effects (`recordAgreement` below), so nothing about
  // the agreement can take the history or the engaged-call stop down with it.
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
  // A call placed through a Twilio call session (0028) is linked to the outcome David
  // recorded for it: the session's ticket is the call log's ticket. First log wins.
  if (input.ticketId !== undefined) {
    const { rows: linkedSessions } = await context.db.query<{ id: string }>(
      `UPDATE call_sessions SET call_log_id = $3, updated_at = now()
        WHERE workspace_id = $1 AND ticket_id = $2 AND call_log_id IS NULL
        RETURNING id`,
      [context.scope.workspaceId, input.ticketId, callLogId],
    );
    // Slice C1: an unanswered outcome may be the attempt that spends the cadence, and the
    // firm is parked for review now rather than at the next call request.
    const linkedSession = linkedSessions[0]?.id;
    if (linkedSession !== undefined && UNANSWERED_OUTCOMES.has(input.outcome)) {
      await parkIfCadenceSpent(context, { firmId: input.firmId, sessionId: linkedSession });
    }
  }

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
      followUpPermissionId: null,
    });
  });

  // The follow-up the salesperson agreed to: three steps, in this order, each in a
  // savepoint of its **own** and all after the effects above (the third review of PR 332;
  // send-path v2, slice S3). The engaged-call stop is in the effects' savepoint and
  // nothing below can roll it back — the one effect of an interested call that must never
  // be lost, because a sequence still running after a conversation is exactly what
  // invariant 3 forbids.
  //
  //   1. **Record the agreement on the call log** (`recordAgreement`). The permission
  //      re-reads these columns on every step, so the log — not the permission — is where
  //      the agreement lives.
  //   2. **Grant the permission**, whose evidence is this very log: the kind, the scope
  //      and the bound version are the log's, never the caller's (P0-1). A failure costs
  //      the permission and says so: `follow_up_not_granted`.
  //   3. **Enrol** — `agreed_sequence` only — through `enrollContact`, with
  //      `origin_kind = 'follow_up'` and the permission just granted, which the
  //      enrollment binds. A refusal (or a throw) rolls back only this savepoint, so the
  //      permission stands, unbound, and the answer carries `follow_up_not_enrolled` with
  //      the refusal code; a person can still enrol from the firm page on it.
  //
  // Lock order: this command took the send gate EXCLUSIVE before the firm's row
  // (`lockSendGateForStopFact` at the top), and `enrollContact` takes the same gate and
  // then the firm, the opportunity and the contact — gate → firm → … in both, and both
  // re-entrant inside one transaction, so the enrolment adds no new order.
  //
  // A *thrown* refusal is caught at each step, for the reason the grant always was:
  // `grantFollowUpPermission` raises on evidence it cannot support and `enrollContact`
  // on a permission already bound (`FollowUpReuseError`), and the savepoint has been
  // rolled back by the time the error reaches here. Nothing about a follow-up is worth
  // losing a recorded conversation and its stop over.
  let followUpPermissionId: string | null = null;
  if (input.followUpPermission !== undefined && contactId !== undefined) {
    const agreed = await applyAgreedFollowUp(context, {
      firmId: input.firmId,
      contactId,
      callLogId,
      grantedByUserId: actor.userId,
      agreement: input.followUpPermission,
      opportunityId: opportunity?.id ?? null,
    });
    followUpPermissionId = agreed.permissionId;
    followUps.push(...agreed.followUps);
  }

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
        followUpPermissionId: null,
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
    // Not `outcomes`: the grant has a savepoint of its own now, so a rolled-back effect
    // does not erase a permission that was granted, and a refused grant does not erase
    // the effects.
    followUpPermissionId,
    followUps,
  });
}

/** How long after a call its agreement may still be recorded by `recordCallFollowUp`. */
export const CALL_FOLLOW_UP_WINDOW_MINUTES = 60;

export interface RecordCallFollowUpInput {
  readonly callLogId: string;
  readonly followUpPermission: AgreedFollowUp;
  readonly commandId?: string | undefined;
}

export interface RecordedCallFollowUp {
  readonly callLogId: string;
  readonly followUpPermissionId: string | null;
  readonly followUps: readonly CallFollowUp[];
}

/**
 * Record what an interested call agreed to, after the call itself was recorded
 * (`POST /calls/follow-up`; review of S3, round 2, P1-B).
 *
 * The card's recovery from `stale_preview`: the schedule changed between the preview the
 * person was read and the moment the call was recorded, so `logCallOutcome` wrote the
 * call and its stop and nothing else. The card fetches a fresh preview, the salesperson
 * reads the new dates, and "Record the agreed dates" sends this — the same payload and
 * basis — so starting the agreed sequence still needs no command of anybody's own.
 *
 * The call must be this workspace's, made by this actor (`not_call_actor` otherwise), an
 * `interested` call with a named person, that happened and was logged within the last
 * hour by the database's wall clock (`call_too_old`), with no agreement on it yet
 * (`agreement_exists`: one call, one agreement; two racing requests serialize on the
 * call log's row lock, and the second reads the first's agreement). Then exactly what
 * `logCallOutcome` does after its effects:
 * the same standing checks before any write, the agreement, the grant, the enrolment.
 * Lock order as there: the send gate, then the firm.
 */
export async function recordCallFollowUp(
  context: RepositoryContext,
  input: RecordCallFollowUpInput,
): Promise<PolicyResult<RecordedCallFollowUp>> {
  const actor = context.scope.actor;
  if (actor.kind !== 'user') return refusePolicy('invalid_input');
  await lockSendGateForStopFact(context);

  // Where the call is, then the firm's lock, then the call log's own row lock — the
  // order every command here keeps (gate → firm → the rows under it). Re-read under the
  // lock, so the actor, the agreement and the firm are the ones this command decides on.
  const { rows: located } = await context.db.query<{ firm_id: string }>(
    'SELECT firm_id FROM call_logs WHERE workspace_id = $1 AND id = $2',
    [context.scope.workspaceId, input.callLogId],
  );
  const firmId = located[0]?.firm_id;
  if (firmId === undefined) return refusePolicy('call_log_unknown');
  const firm = await loadFirmForUpdate(context, firmId);
  if (firm === null) return refusePolicy('firm_unknown');
  const permitted = decideFirmMutation(context, firm);
  if (!permitted.permitted) {
    return refusePolicy(permitted.reason === 'not_assigned' ? 'not_assigned' : 'firm_unknown');
  }
  const { rows } = await context.db.query<{
    firm_id: string;
    contact_id: string | null;
    outcome: string;
    agreed_follow_up: string | null;
    actor_user_id: string;
    occurred_at: Date;
    recorded_at: Date;
  }>(
    `SELECT firm_id, contact_id, outcome, agreed_follow_up, actor_user_id, occurred_at, recorded_at
       FROM call_logs WHERE workspace_id = $1 AND id = $2
       FOR UPDATE`,
    [context.scope.workspaceId, input.callLogId],
  );
  const log = rows[0];
  if (log === undefined || log.firm_id !== firmId) return refusePolicy('call_log_unknown');
  // The person who made the call records what was agreed on it — not whoever holds the
  // firm now, and not an administrator (review of S3, round 3, P1-F).
  if (log.actor_user_id !== actor.userId) return refusePolicy('not_call_actor');
  if (log.outcome !== 'interested' || log.contact_id === null) return refusePolicy('invalid_input');
  if (log.agreed_follow_up !== null) return refusePolicy('agreement_exists');
  // The wall clock, read in its own statement **after** the row lock was granted
  // (review of S3, rounds 3 and 4, P1-G): the transaction's `now()` predates the waits for
  // the gate, the firm and this row, and an expression projected inside the locking
  // SELECT can be computed before the lock wait. Both instants count: an entered past
  // `occurred_at` is a call that happened then, whenever it was logged.
  const { rows: clock } = await context.db.query<{ now: Date }>('SELECT clock_timestamp() AS now');
  const wallClock = (clock[0]?.now ?? new Date()).getTime();
  const windowMs = CALL_FOLLOW_UP_WINDOW_MINUTES * 60_000;
  if (wallClock - log.occurred_at.getTime() > windowMs || wallClock - log.recorded_at.getTime() > windowMs) {
    return refusePolicy('call_too_old');
  }
  if (input.followUpPermission.scope === 'agreed_sequence') {
    const version = await readSequenceVersion(context, input.followUpPermission.sequenceVersionId);
    if (version === null) return refusePolicy('version_unknown');
    if (version.state !== 'published') return refusePolicy('version_not_published');
  }

  const opportunity = await readOpenOpportunity(context, log.firm_id);
  const agreed = await applyAgreedFollowUp(context, {
    firmId: log.firm_id,
    contactId: log.contact_id,
    callLogId: input.callLogId,
    grantedByUserId: actor.userId,
    agreement: input.followUpPermission,
    opportunityId: opportunity?.id ?? null,
  });
  await recordCrmAuditEvent(context, {
    action: 'call.follow_up_recorded',
    subjectKind: 'call_log',
    subjectId: input.callLogId,
    detail: {
      firmId: log.firm_id,
      scope: input.followUpPermission.scope,
      followUps: agreed.followUps.map(entry => `${entry.kind}:${entry.reason}`),
    },
  });
  return acceptPolicy({ callLogId: input.callLogId, followUpPermissionId: agreed.permissionId, followUps: agreed.followUps });
}

interface AppliedEffects {
  readonly stepApplication: CallStepApplication | null;
  readonly successorExecutionId: string | null;
  readonly setManual: boolean;
  readonly suppressionEventIds: readonly string[];
  readonly retiredRouteId: string | null;
  readonly completedCallbackId: string | null;
  readonly callbackId: string | null;
  readonly followUpPermissionId: string | null;
}

/** A suppression refusal, in this command's vocabulary. The code itself is kept in the audit. */
function asPolicyRefusal(reason: string): PolicyRefusalCode {
  return reason === 'not_assigned' || reason === 'firm_unknown' ? reason : 'invalid_input';
}

type AgreedFollowUp = NonNullable<LogCallOutcomeInput['followUpPermission']>;

/**
 * What an interested call agreed to, applied to its recorded call log — by
 * `logCallOutcome` after the call's effects (the engaged-call stop), and by
 * `recordCallFollowUp` when the card records the agreed dates again after a stale
 * preview (review of S3, round 2, P1-B). In this order:
 *
 *   0. **Standing, before any write.** A single e-mail's template must still be this
 *      workspace's, approved and not retired (P1-4). An agreed sequence's preview basis
 *      must still be the schedule an enrolment started now would have (P1-A):
 *      the firm's zone, the calendar version, and every step on the same local day and
 *      within fifteen minutes of its shown instant (`previewBasisHolds`), recomputed
 *      at the transaction's sampled `now()` — the instant `enrollContact` anchors at in
 *      the same transaction. Either failing is `follow_up_not_granted` with the reason
 *      (`template_*`, `stale_preview`) and **nothing** is written: no agreement on the
 *      log, no permission — so no live permission is left for anything to start on a
 *      schedule nobody heard (P1-B).
 *   1. Record the agreement on the call log, in its own savepoint.
 *   2. Grant the permission from that log, in its own savepoint.
 *   3. For an agreed sequence, enrol (`enrolAgreedSequence`), in its own savepoint.
 */
async function applyAgreedFollowUp(
  context: RepositoryContext,
  input: {
    readonly firmId: string;
    readonly contactId: string;
    readonly callLogId: string;
    readonly grantedByUserId: string;
    readonly agreement: AgreedFollowUp;
    readonly opportunityId: string | null;
  },
): Promise<{ readonly permissionId: string | null; readonly followUps: readonly CallFollowUp[] }> {
  const { agreement } = input;
  const standing =
    agreement.scope === 'single_email'
      ? await templateStanding(context, agreement.templateVersionId)
      : await scheduleStanding(context, input.firmId, agreement);
  if (standing !== null) {
    return { permissionId: null, followUps: [{ kind: 'follow_up_not_granted', reason: standing }] };
  }

  const recorded = await withinSavepoint(context, async (): Promise<PolicyResult<true>> =>
    await recordAgreement(context, input.callLogId, agreement),
  ).catch(() => refusePolicy<true>('invalid_input'));
  if (!recorded.ok) {
    return { permissionId: null, followUps: [{ kind: 'follow_up_not_granted', reason: 'agreement_not_recorded' }] };
  }

  // The evidence is this very call log and `verifyFollowUpPermission` re-reads it before
  // every step: the log's firm must still be this firm, and, since it names a person,
  // still this person. The kind and the scope are not passed: the call log decides them,
  // because a caller that could name them could name a sequence over a callback (P0-1).
  const granted = await withinSavepoint(context, async (): Promise<PolicyResult<string>> => {
    const outcome = await grantFollowUpPermission(context, {
      firmId: input.firmId,
      contactId: input.contactId,
      callLogId: input.callLogId,
      grantedByUserId: input.grantedByUserId,
      note: 'agreed on the call',
    });
    return outcome.ok ? acceptPolicy(outcome.value.id) : refusePolicy('invalid_input');
  }).catch(() => refusePolicy<string>('invalid_input'));
  if (!granted.ok) {
    return { permissionId: null, followUps: [{ kind: 'follow_up_not_granted', reason: granted.reason }] };
  }
  if (agreement.scope !== 'agreed_sequence') return { permissionId: granted.value, followUps: [] };
  return {
    permissionId: granted.value,
    followUps: [
      await enrolAgreedSequence(context, {
        sequenceVersionId: agreement.sequenceVersionId,
        opportunityId: input.opportunityId,
        firmId: input.firmId,
        contactId: input.contactId,
        permissionId: granted.value,
        callLogId: input.callLogId,
      }),
    ],
  };
}

/**
 * `stale_preview` when the schedule an enrolment would start now is not the one the
 * card showed, or null. A direct domain caller with no basis is not checked.
 */
async function scheduleStanding(
  context: RepositoryContext,
  firmId: string,
  agreement: Extract<AgreedFollowUp, { scope: 'agreed_sequence' }>,
): Promise<string | null> {
  if (agreement.previewBasis === undefined) return null;
  const version = await readSequenceVersion(context, agreement.sequenceVersionId);
  if (version === null) return 'version_unknown';
  const { rows: firms } = await context.db.query<{ time_zone: string | null }>(
    'SELECT time_zone FROM firms WHERE workspace_id = $1 AND id = $2',
    [context.scope.workspaceId, firmId],
  );
  // `now()`, not `clock_timestamp()`: the transaction's own sampled start, which is the
  // instant `enrollContact` anchors the enrollment at later in this transaction.
  const holds = previewBasisHolds(agreement.previewBasis, {
    steps: version.steps,
    now: await databaseNow(context),
    zone: firms[0]?.time_zone ?? null,
    calendar: await currentHolidayCalendar(context),
  });
  return holds ? null : 'stale_preview';
}

/**
 * Why a single e-mail's template cannot be promised, or null when it can: absent from
 * this workspace (`template_unknown`), never approved (`template_unapproved`), or retired
 * (`template_retired`).
 */
async function templateStanding(context: RepositoryContext, templateVersionId: string): Promise<string | null> {
  const template = await readTemplateVersion(context, templateVersionId);
  if (template === null) return 'template_unknown';
  if (template.approvedAt === null) return 'template_unapproved';
  if (template.retiredAt !== null) return 'template_retired';
  return null;
}

/**
 * Write what the person on the call agreed to onto the call log (migration 0025's three
 * columns). Only a log that agreed to nothing yet is updated, so a replayed or confused
 * caller can never turn one agreement into another; the CHECKs
 * `call_logs_agreement_names_what_was_agreed` and `call_logs_agreement_needs_interest`
 * stand behind it in the database.
 */
async function recordAgreement(
  context: RepositoryContext,
  callLogId: string,
  agreement: NonNullable<LogCallOutcomeInput['followUpPermission']>,
): Promise<PolicyResult<true>> {
  const updated = await context.db.query(
    `UPDATE call_logs
        SET agreed_follow_up = $3, agreed_template_version_id = $4, agreed_sequence_version_id = $5
      WHERE workspace_id = $1 AND id = $2 AND agreed_follow_up IS NULL`,
    [
      context.scope.workspaceId,
      callLogId,
      agreement.scope,
      agreement.scope === 'single_email' ? agreement.templateVersionId : null,
      agreement.scope === 'agreed_sequence' ? agreement.sequenceVersionId : null,
    ],
  );
  return (updated.rowCount ?? 0) === 1 ? acceptPolicy(true) : refusePolicy('invalid_input');
}

/**
 * Enrol the contact in the sequence they agreed to, on the permission the call just
 * granted, in a savepoint of its own (send-path v2, slice S3).
 *
 * The answer is always a follow-up entry: `agreed_sequence_enrolled` naming the
 * enrollment, or `follow_up_not_enrolled` whose reason is `enrollContact`'s refusal code
 * (`enrollment_failed` for a throw). A firm with no open opportunity gets one first, at
 * stage New, in the same savepoint. Either way the permission granted before it stands.
 */
async function enrolAgreedSequence(
  context: RepositoryContext,
  input: {
    readonly sequenceVersionId: string;
    readonly opportunityId: string | null;
    readonly firmId: string;
    readonly contactId: string;
    readonly permissionId: string;
    /** The interested call that agreed to it, named on an opportunity opened for it. */
    readonly callLogId: string;
  },
): Promise<CallFollowUp> {
  const refused: { reason: string } = { reason: 'enrollment_failed' };
  const enrolled = await withinSavepoint(context, async (): Promise<PolicyResult<string>> => {
    // A firm with no open opportunity — one added through `/crm/firms/add` or an import,
    // which open none — gets one here, at stage New, so starting what the person agreed
    // to never needs a command of its own (the coordinator's decision, 30 September
    // 2026). Inside this savepoint: a refused enrolment takes the new opportunity back
    // with it, so a refusal leaves nothing behind but the permission.
    let opportunityId = input.opportunityId;
    if (opportunityId === null) {
      const opened = await opportunityForAgreedSequence(context, input);
      if (!opened.ok) {
        refused.reason = opened.reason;
        return refusePolicy('invalid_input');
      }
      opportunityId = opened.value;
    }
    const outcome = await enrollContact(context, {
      originKind: 'follow_up',
      permissionId: input.permissionId,
      sequenceVersionId: input.sequenceVersionId,
      opportunityId,
      firmId: input.firmId,
      contactId: input.contactId,
    });
    if (outcome.ok) return acceptPolicy(outcome.value.enrollmentId);
    refused.reason = outcome.reason;
    return refusePolicy('invalid_input');
  }).catch(() => {
    refused.reason = 'enrollment_failed';
    return refusePolicy<string>('invalid_input');
  });
  if (enrolled.ok) return { kind: 'agreed_sequence_enrolled', reason: 'enrolled', enrollmentId: enrolled.value };
  return { kind: 'follow_up_not_enrolled', reason: refused.reason };
}

/**
 * The open opportunity an agreed sequence enrols against, for a firm that has none
 * (coordinator's decisions and the review of S3, 30 September 2026). Always stage New
 * (the first non-terminal stage), manual, origin `engaged_call` — exactly what the
 * engaged call would have made of an opportunity that was open — and audited with the
 * call named. Two ways, and never silently a third:
 *
 *   * **no history**: `openOpportunity` at stage New, then `setManualControlMode` with
 *     origin `engaged_call`, the path the call's own effects take;
 *   * **a closed history** (the last opportunity Won or Lost): the explicit reopen,
 *     `reopenOpportunity` — a new row linked by `reopened_from_opportunity_id`, in
 *     manual mode, with a reason naming the interested call — rather than an unlinked
 *     row that would hide the history (review P1-2). The reopen records no manual-mode
 *     origin (its NULL reads as a takeover, which would block the very follow-up this
 *     is for), so the origin is recorded here as the call's: `engaged_call`, only on
 *     the row just reopened and only while it is still unrecorded, and audited as
 *     `opportunity.manual` the way every origin change is.
 *
 * Runs inside the enrolment's savepoint: a refused enrolment takes the row back.
 */
async function opportunityForAgreedSequence(
  context: RepositoryContext,
  input: { readonly firmId: string; readonly callLogId: string; readonly sequenceVersionId: string },
): Promise<{ readonly ok: true; readonly value: string } | { readonly ok: false; readonly reason: string }> {
  const { rows: closed } = await context.db.query(
    `SELECT 1 FROM opportunities WHERE workspace_id = $1 AND firm_id = $2 AND status <> 'open' LIMIT 1`,
    [context.scope.workspaceId, input.firmId],
  );
  let opportunityId: string;
  let reopened = false;
  if (closed.length > 0) {
    const reopen = await reopenOpportunity(context, {
      firmId: input.firmId,
      reason: `interested call ${input.callLogId} agreed to a sequence`,
    });
    if (!reopen.ok) return { ok: false, reason: reopen.reason };
    opportunityId = reopen.value.opportunityId;
    reopened = true;
    const { rows: recorded } = await context.db.query<{ id: string }>(
      `UPDATE opportunities SET control_mode_origin = 'engaged_call', updated_at = now()
        WHERE workspace_id = $1 AND id = $2 AND control_mode = 'manual' AND control_mode_origin IS NULL
        RETURNING id`,
      [context.scope.workspaceId, opportunityId],
    );
    if (recorded[0] === undefined) return { ok: false, reason: 'invalid_input' };
    await recordCrmAuditEvent(context, {
      action: 'opportunity.manual',
      subjectKind: 'opportunity',
      subjectId: opportunityId,
      detail: { firmId: input.firmId, origin: 'engaged_call', callLogId: input.callLogId, reopened: true },
    });
  } else {
    const opened = await openOpportunity(context, { firmId: input.firmId, stageKey: 'new' });
    if (!opened.ok) return { ok: false, reason: opened.reason };
    opportunityId = opened.value.id;
    // Marked manual exactly as the engaged call marks an open opportunity: the same
    // `setManualControlMode`, origin `engaged_call`. That origin is a prospect signal, so
    // the agreed follow-up still runs under it (PR 332's rule, `controlModeSource`); its
    // stop event owes nothing, because the call's own stop already ended every live
    // enrollment at the firm and this one does not exist yet.
    const manual = await setManualControlMode(context, {
      opportunityId,
      reason: manualReasonFor('interested'),
      origin: 'engaged_call',
    });
    if (!manual.ok) return { ok: false, reason: manual.reason };
  }
  // `openOpportunity` / `reopenOpportunity` audit themselves; this names why.
  await recordCrmAuditEvent(context, {
    action: 'opportunity.opened_for_agreed_sequence',
    subjectKind: 'opportunity',
    subjectId: opportunityId,
    detail: {
      firmId: input.firmId,
      callLogId: input.callLogId,
      outcome: 'interested',
      sequenceVersionId: input.sequenceVersionId,
      reopened,
    },
  });
  return { ok: true, value: opportunityId };
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

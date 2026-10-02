import type {
  BlockedActionKind,
  EnrollmentOriginKind,
  HoldReasonCode,
  PauseChannel,
  StepChannel,
  SuppressionReaderChannel,
} from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { coverageRefusal, readMailboxCoverage } from '../mail/coverage.ts';
import { listApplicableHolds } from '../policy/holds.ts';
import { verifyFollowUpPermission } from './followUpPermissions.ts';
import type { StepExecutionRow } from './types.ts';

/**
 * The eligibility re-read (specification 11.2, Appendix G 3 and 6).
 *
 * "Before every external action, the worker re-reads inside the claiming
 * transaction: control mode; applicable holds; effective suppressions; ownership;
 * route eligibility and version; mailbox health and coverage; template approval;
 * policy; limits; time window; and prerequisites."
 *
 * Eleven questions owned by six lanes. This file composes them; it answers none of
 * them on its own except the three that are this lane's — the enrollment is live, the
 * execution is the next one, and the step's prerequisites are done.
 *
 * `StepEligibilitySource` is the interface every other lane's answer arrives through.
 * One interface rather than six, because the composition has to be *one read at one
 * instant*: asking suppression, then holds, then caps leaves three windows in which
 * the answer could change between two of the questions and be missed by both. A lane
 * supplies a source; the composition calls them in a fixed order and the first
 * refusal wins, the same shape `authorizeDial` uses for the eight steps of 9.2.
 *
 * The order is not alphabetical and is not negotiable:
 *
 *   1. suppression — the fact that must never be worked around;
 *   1a. the follow-up permission and the firm rule (migration 0025) — whether Callie
 *       may write to this person at all, and whether another contact at the firm is
 *       already being prospected;
 *   2. control mode — an opportunity a human is handling is not automated;
 *   3. the enrollment — live, and the execution still its own;
 *   4. holds — every reversible blocker, in one indexed statement;
 *   5. ownership and assignment;
 *   6. route eligibility and version;
 *   7. mailbox health and coverage;
 *   8. template approval;
 *   9. caps and the domain guard;
 *  10. the sending window.
 *
 * Suppression before assignment for the reason `docs/greenfield/policy.md` gives: an
 * unassigned salesperson should be told the firm is suppressed rather than that it is
 * not theirs, because the suppression is the more important fact.
 *
 * ## One implementation, asked twice
 *
 * The composition is asked when a due step is prepared (`runDueStepExecution`) and
 * again, by the sending lane, immediately before the dispatch claim
 * (`outbound/stepPermission.ts`), inside the claim's transaction and under the send
 * gate. Same sources, same order — never a second copy that can drift. The only thing
 * the second asking adds is `frozen`: by then a fence exists, and the questions that
 * were "is there a usable route" and "is the step's template approved" become "is *the
 * route this fence froze* still usable at the version it froze" and "is *the template
 * version these bytes came from* still approved". A fence prepared on Monday for a
 * route a bounce invalidated on Tuesday must not go on Wednesday merely because the
 * contact has some other usable address.
 */

export type StepEligibilityOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reasonCode: HoldReasonCode; readonly detail?: string | undefined };

/**
 * What a prepared fence froze (Appendix B's envelope), for the re-read at dispatch.
 *
 * Absent at preparation, when there is no fence yet.
 */
export interface FrozenEnvelope {
  /** `email_addresses.id` the fence names, or null for a fence with no route. */
  readonly routeId: string | null;
  /** The route's version when the fence was prepared. */
  readonly routeVersion: number | null;
  /** The template version the fence's bytes were rendered from. */
  readonly templateVersionId: string | null;
}

export interface StepEligibilityInput {
  readonly execution: StepExecutionRow;
  readonly opportunityId: string;
  readonly firmId: string;
  readonly contactId: string;
  readonly ownerUserId: string;
  readonly channel: StepChannel;
  readonly actionKind: BlockedActionKind;
  /** Database time. Nothing in an eligibility decision reads a host clock. */
  readonly now: string;
  /** The fence's frozen envelope, when a fence exists. See `FrozenEnvelope`. */
  readonly frozen?: FrozenEnvelope | undefined;
}

export interface StepEligibilitySource {
  readonly name: string;
  evaluate(
    context: RepositoryContext,
    input: StepEligibilityInput,
  ): Promise<StepEligibilityOutcome>;
}

/** The composed reader a claim calls. One question, one answer, one instant. */
export interface StepEligibility {
  evaluate(
    context: RepositoryContext,
    input: StepEligibilityInput,
  ): Promise<StepEligibilityOutcome>;
}

/** The action kind a channel's work is blocked under (4.3, and `hold_reason_codes`). */
export const CHANNEL_ACTION_KINDS: Readonly<Record<StepChannel, BlockedActionKind>> = Object.freeze({
  email: 'email_send',
  call_task: 'call_task',
});

/** The suppression channel a step's channel reads (migration 0037). */
export const SUPPRESSION_READER_CHANNELS: Readonly<Record<StepChannel, SuppressionReaderChannel>> = Object.freeze({
  email: 'email',
  call_task: 'phone',
});

/** The key a channel-scoped pause is stored under for a step's channel (10.1). */
export const CHANNEL_PAUSE_KEYS: Readonly<Record<StepChannel, PauseChannel>> = Object.freeze({
  email: 'email',
  call_task: 'call',
});

/**
 * Every applicable hold, as a source.
 *
 * This lane owns it, because `listApplicableHolds` is one statement over
 * `active_holds` and there is nothing lane-specific in the question. A hold blocking
 * `enrollment_advance` blocks every channel; a hold blocking only `email_send` blocks
 * the email step and lets the call step through, which is 10.1's "a sending pause
 * does not stop ... manual calling unless calling is separately paused" applied to a
 * sequence rather than to a dial.
 *
 * Every scope `active_holds` has is asked. Until then this source named no
 * mailbox and no channel, so an administrator's pause of the owner's mailbox, or of
 * the email channel, held nothing here — `openPause` writes both scopes, and the send
 * gate asked about the mailbox but not the channel. The owner's mailbox is the one the
 * work would use (12.1: one per owner), and a channel pause's key is 10.1's channel.
 */
export function holdSource(): StepEligibilitySource {
  return {
    name: 'holds',
    evaluate: async (context, input) => {
      const mailbox = await context.db.query<{ id: string }>(
        'SELECT id FROM mailboxes WHERE workspace_id = $1 AND owner_user_id = $2',
        [context.scope.workspaceId, input.ownerUserId],
      );
      const subject = {
        firmId: input.firmId,
        opportunityId: input.opportunityId,
        ownerUserId: input.ownerUserId,
        enrollmentId: input.execution.enrollmentId,
        ...(mailbox.rows[0] === undefined ? {} : { mailboxId: mailbox.rows[0].id }),
        channel: CHANNEL_PAUSE_KEYS[input.channel],
      };
      const holds = await listApplicableHolds(context, { actionKind: input.actionKind, ...subject });
      const advance = await listApplicableHolds(context, { actionKind: 'enrollment_advance', ...subject });
      const blocking = [...holds, ...advance];
      const first = blocking[0];
      return first === undefined ? { ok: true } : { ok: false, reasonCode: first.reasonCode };
    },
  };
}

/**
 * The origins of manual mode that are a prospect **signal** rather than a person's
 * decision (migration 0025; `MANUAL_MODE_ORIGINS` in `packages/domain/crm/events.ts`).
 *
 * Two of them are events 7.3 lists: a confirmed human reply and an engaged call
 * outcome. Each is the prospect doing something, and each is also — this is the whole of
 * the "reply means manual for ever" wall the verification document of 29 September
 * describes — exactly the kind of event that *grants* a follow-up permission. A
 * permitted follow-up must therefore not be blocked by the signal that permitted it.
 *
 * The third, `direct_send_keep_automation`, is **history** (send-path v2, slice S1): the
 * person's choice, recorded by the retired `POST /opportunities/keep-following-up`, to
 * let the follow-up automation continue after they wrote from Gmail themselves. Nothing
 * writes it any more; a stored one keeps the reading it was given.
 *
 * `direct_send` is **not** in this set (P1-1 of the GPT-6 review of PR 332), and it is
 * history as well: since send-path v2 a direct Gmail send is an update to the
 * conversation and never makes an opportunity manual (`applyDirectSendEffects`), so only
 * an opportunity that went manual on a direct send *before* that change carries it, and
 * it keeps blocking as it did — the reading of stored values does not change. Neither is
 * `salesperson_command`, the explicit takeover
 * (`POST /opportunities/manual`). And neither is an unrecorded origin — a NULL, which is
 * every opportunity that went manual before 0025 — because an unrecorded reason is not
 * evidence of a signal; an administrator classifies those one at a time
 * (`classifyControlModeOrigin`).
 */
const SIGNAL_MANUAL_MODE_ORIGINS: ReadonlySet<string> = new Set([
  'human_reply',
  'engaged_call',
  'direct_send_keep_automation',
]);

/**
 * The opportunity's control mode (7.3), and — since migration 0025 — which of the four
 * ways in it took.
 *
 * `manual` is entered by a confirmed human email reply, an engaged call outcome or a
 * salesperson's explicit command (a direct Gmail send did, before send-path v2; its
 * stored origin is still read), and "automation never reverses
 * manual mode". A manual opportunity is not a hold — there is no interval to shift by
 * and no control that clears it — so it is a refusal with its own reason code.
 *
 * **Prospecting and legacy steps are unchanged**: manual is manual, whatever put it
 * there. For a `follow_up` step the rule is David's: *"Use separate follow-up automation
 * to resolve the current 'reply means manual forever' behavior. Preserve explicit manual
 * takeover, suppression, and all pause switches."* A signal-set manual mode does not
 * block a follow-up whose permission rests on that very signal; an explicit takeover
 * does, and so does an unrecorded origin.
 *
 * Nothing here reverses manual mode. The opportunity stays `manual`, the card still
 * says so, and the only thing that changes is whether one evidenced follow-up step may
 * run beside it.
 */
export function controlModeSource(): StepEligibilitySource {
  return {
    name: 'control-mode',
    evaluate: async (context, input) => {
      const { rows } = await context.db.query<{
        control_mode: string;
        status: string;
        control_mode_origin: string | null;
      }>(
        `SELECT control_mode, status, control_mode_origin
           FROM opportunities WHERE workspace_id = $1 AND id = $2`,
        [context.scope.workspaceId, input.opportunityId],
      );
      const opportunity = rows[0];
      if (opportunity === undefined || opportunity.status !== 'open') {
        return { ok: false, reasonCode: 'opportunity_manual' };
      }
      if (opportunity.control_mode === 'automated') return { ok: true };
      const origin = await originKindOf(context, input.execution.enrollmentId);
      if (origin !== 'follow_up') return { ok: false, reasonCode: 'opportunity_manual' };
      return SIGNAL_MANUAL_MODE_ORIGINS.has(opportunity.control_mode_origin ?? '')
        ? { ok: true }
        : {
            ok: false,
            reasonCode: 'opportunity_manual',
            detail: `takeover:${opportunity.control_mode_origin ?? 'unrecorded'}`,
          };
    },
  };
}

/** One enrollment's `origin_kind`. Absent only for an enrollment that has gone. */
async function originKindOf(
  context: RepositoryContext,
  enrollmentId: string,
): Promise<EnrollmentOriginKind | null> {
  const { rows } = await context.db.query<{ origin_kind: EnrollmentOriginKind }>(
    'SELECT origin_kind FROM sequence_enrollments WHERE workspace_id = $1 AND id = $2',
    [context.scope.workspaceId, enrollmentId],
  );
  return rows[0]?.origin_kind ?? null;
}

/**
 * The enrollment's origin, and the permission behind it (migration 0025; David, 29
 * September 2026, item 1).
 *
 * > "The origin label alone must not authorize sending — the eligibility check re-reads
 * > the evidence."
 *
 * Three answers, one per `origin_kind`:
 *
 *   * `cold_legacy` — refuse, always, with no way back. Every enrollment that existed
 *     before 0025 is one of these (the column's DEFAULT is the backfill), and so is any
 *     row a future code path forgets to label. "History preserved, excluded from
 *     automatic sending forever, never revived."
 *   * `prospecting` — nothing to check here. A cold first touch needs no permission; it
 *     needs suppression, the firm rule and the pause switches, which are other sources.
 *   * `follow_up` — load the permission and **re-read its evidence**:
 *     `verifyFollowUpPermission` asks whether the call log or the inbound match still
 *     exists and still names this firm and this recipient, whether the permission is
 *     unrevoked and unexpired, and whether its scope still has room for this step.
 *
 * Placed immediately after `suppressionSource` in `defaultEligibilitySources`: a person
 * who asked to stop is the fact that must never be worked around, and after that the
 * next question is whether Callie may write to this person at all.
 */
export function followUpPermissionSource(): StepEligibilitySource {
  return {
    name: 'follow-up-permission',
    evaluate: async (context, input) => {
      const { rows } = await context.db.query<{
        origin_kind: EnrollmentOriginKind;
        permission_id: string | null;
        sequence_version_id: string;
        step_count: string;
        contact_id: string;
        template_version_id: string | null;
      }>(
        `SELECT n.origin_kind, n.permission_id, n.contact_id, n.sequence_version_id,
                (SELECT count(*) FROM sequence_steps s WHERE s.workspace_id = v.workspace_id
                                                         AND s.sequence_version_id = v.id) AS step_count,
                (SELECT s.template_version_id FROM sequence_steps s
                  WHERE s.workspace_id = e.workspace_id AND s.id = e.step_id) AS template_version_id
           FROM step_executions e
           JOIN sequence_enrollments n ON n.workspace_id = e.workspace_id AND n.id = e.enrollment_id
           JOIN sequence_versions v ON v.workspace_id = n.workspace_id AND v.id = n.sequence_version_id
          WHERE e.workspace_id = $1 AND e.id = $2`,
        [context.scope.workspaceId, input.execution.id],
      );
      const enrollment = rows[0];
      // No enrollment is `enrollmentSource`'s refusal to make, and it makes it two
      // sources later. Refusing here would name the wrong reason.
      if (enrollment === undefined) return { ok: true };
      if (enrollment.origin_kind === 'cold_legacy') {
        return { ok: false, reasonCode: 'cold_legacy' };
      }
      if (enrollment.origin_kind === 'prospecting') return { ok: true };

      const permissionId = enrollment.permission_id;
      // Unrepresentable since 0025 (`sequence_enrollments_follow_up_has_permission`),
      // and still answered: a CHECK is not a reason to read a column as non-null.
      if (permissionId === null) {
        return { ok: false, reasonCode: 'follow_up_not_permitted', detail: 'no_permission' };
      }
      // The recipient compared against the permission is **the enrollment's own
      // contact**, not `input.contactId`. In the product the two are the same person:
      // `runEmailStep` addresses the enrollment's contact and the fence carries it, and
      // `enrollContact` verified this very permission against this very contact before
      // the enrollment existed. The enrollment's column is the one the permission was
      // granted about, and reading it here means the answer does not depend on which of
      // the two askings is doing the asking. The fence's own recipient address is
      // checked by `suppressionSource` (which unions every address of the fence's
      // contact) and by `frozenRouteOutcome`.
      const verdict = await verifyFollowUpPermission(context, permissionId, {
        firmId: input.firmId,
        contactId: enrollment.contact_id,
        now: input.now,
        sequenceVersionId: enrollment.sequence_version_id,
        enrollmentId: input.execution.enrollmentId,
        stepCount: Number(enrollment.step_count),
        // The bytes this step would send: the frozen fence's template version at the
        // dispatch asking, the step's own at preparation. A `single_email` permission
        // is the agreed overview and not whatever approved template was picked (P0-2).
        templateVersionId: input.frozen?.templateVersionId ?? enrollment.template_version_id,
      });
      return verdict.ok ? { ok: true } : { ok: false, reasonCode: verdict.refusal, detail: verdict.detail };
    },
  };
}

/**
 * A prospecting e-mail has no transport yet (send-path v2, slice S4; David, 30
 * September 2026).
 *
 * > "Zero currently due emails is insufficient: creating an enrollment must not enable
 * > cold Gmail outreach."
 *
 * With the 28 September decision that cold outreach uses a non-Google mailbox, the only
 * dispatch path FSS has — the owner's Gmail mailbox, `outbound/send.ts` — is a
 * conversation path, and a first touch to a stranger must not leave through it. So an
 * e-mail step of a `prospecting` enrollment is refused here with
 * `cold_outreach_mailbox_required`, which `runDueStepExecution` stores as the step's
 * `hold_reason_code`: the step stays visible, held, on the card, and `listStepWakes`
 * keeps waking it so the hold is re-read rather than forgotten.
 *
 * **Unconditional, deliberately.** The question is not "is the owner's mailbox labelled
 * `cold_outreach`" (migration 0026 admits the label, and nothing sends through such a
 * mailbox): a label must never authorise the Gmail path as cold outreach (P0-5 of the
 * plan review). Until a real cold-outreach transport exists, nothing clears this; the
 * code is recoverable because the transport, when it comes, is what will.
 *
 * `follow_up` enrollments pass (David's permitted conversation), `cold_legacy` never
 * reaches here (`followUpPermissionSource` refused it one source earlier), and a call
 * task passes: calling a prospect is a person dialling, not Gmail.
 *
 * Asked after suppression and the follow-up permission, before the firm rule: a
 * prospecting e-mail with no transport is held for that reason whichever contact at the
 * firm is first, and the firm row is not locked for work that cannot go anyway.
 *
 * The dispatch claim asks its own version of the question about the fence it is about
 * to send (`outbound/stepPermission.ts`, `coldOutreachDispatchRefusal`), so a fence
 * prepared before this rule, or held and returning through dispatch, is refused there
 * too.
 */
export function coldOutreachTransportSource(): StepEligibilitySource {
  return {
    name: 'cold-outreach-transport',
    evaluate: async (context, input) => {
      if (input.channel !== 'email') return { ok: true };
      const origin = await originKindOf(context, input.execution.enrollmentId);
      return origin === 'prospecting' ? { ok: false, reasonCode: 'cold_outreach_mailbox_required' } : { ok: true };
    },
  };
}

/**
 * One live prospecting contact per firm, asked again immediately before the send
 * (David, 29 September 2026, item 2: *"Enforce the rule at enrollment and immediately
 * before sending, including concurrent-worker behavior."*).
 *
 * `enrollContact` refuses a second prospecting enrollment at a firm under the firm's
 * row lock, and that is the half that stops the state from being created. This is the
 * other half, and it is the one that matters tonight: the rows that already exist were
 * created when the schema deliberately permitted two people at one firm
 * (`docs/greenfield/sequences.md`, Appendix G 33), so an enrollment-time refusal alone
 * would leave those parallel threads running.
 *
 * **The lock.** `SELECT … FROM firms … FOR UPDATE` — the same lock `enrollContact`
 * takes, in the same order — so two workers deciding two contacts of one firm in the
 * same tick serialise on the firm row, and the second reads what the first committed.
 * At preparation this runs in the step's own transaction; at the dispatch claim it runs
 * inside the claim's, under the send gate, which is the transaction Appendix B says the
 * decision must be made in.
 *
 * **The winner is deterministic**: the live prospecting enrollment with the earliest
 * `started_at`, and its id breaks a tie. Two steps due in the same tick therefore agree
 * about which of them may go, rather than each refusing the other or both proceeding.
 *
 * **Follow-ups are exempt**, and that is David's own exception: *"This restriction
 * applies to prospecting; it must not prevent ordinary customer conversations involving
 * multiple people."* Follow-up permissions to several people at a customer firm are not
 * limited by it.
 */
export function firmExclusivitySource(): StepEligibilitySource {
  return {
    name: 'firm-exclusivity',
    evaluate: async (context, input) => {
      const { rows: mine } = await context.db.query<{ origin_kind: EnrollmentOriginKind }>(
        'SELECT origin_kind FROM sequence_enrollments WHERE workspace_id = $1 AND id = $2',
        [context.scope.workspaceId, input.execution.enrollmentId],
      );
      const enrollment = mine[0];
      if (enrollment === undefined || enrollment.origin_kind !== 'prospecting') return { ok: true };

      // The firm row, locked: the serialisation point the rule needs, and nothing is
      // read from it. `enrollContact` locks the same row before it counts.
      await context.db.query('SELECT id FROM firms WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [
        context.scope.workspaceId,
        input.firmId,
      ]);
      // The comparison instant is read in SQL rather than passed in. A JavaScript `Date`
      // has milliseconds and `timestamptz` has microseconds, so a round trip through the
      // driver rounds the value *down*, and a competitor started in the same millisecond
      // then compares as later than itself and is missed. The tied-`started_at` case in
      // `test/outbound/firmExclusivityAtSend.test.ts` is exactly that (P1-4).
      const { rows: others } = await context.db.query<{ id: string }>(
        `SELECT id FROM sequence_enrollments
          WHERE workspace_id = $1
            AND firm_id = $2
            AND id <> $3
            AND ended_at IS NULL
            AND origin_kind = 'prospecting'
            AND (started_at, id) < (SELECT started_at, id FROM sequence_enrollments
                                     WHERE workspace_id = $1 AND id = $3)
          ORDER BY started_at, id
          LIMIT 1`,
        [context.scope.workspaceId, input.firmId, input.execution.enrollmentId],
      );
      const earlier = others[0];
      return earlier === undefined
        ? { ok: true }
        : { ok: false, reasonCode: 'firm_already_enrolled', detail: earlier.id };
    },
  };
}

/**
 * The enrollment (11.2, 4.3).
 *
 * `runDueStepExecution` asks this before it asks anything else and answers
 * `nothing_to_do` for an ended enrollment, so at preparation this source only ever
 * sees a live one. It is in the composition for the *second* asking: between the
 * preparation and the dispatch claim a confirmed reply, a Won stage or an admin's stop
 * may have ended the enrollment, and the fence it left behind must not go.
 *
 * There is no section 15 code for "the enrollment ended", because an ended enrollment
 * is not a hold — nothing clears it. `scoped_pause` is the code 15 gives an
 * administrative stop, and it is the honest one here: automation for this work has
 * been stopped by somebody, and the end reason on the enrollment says who. A review
 * the enrollment is waiting on is `long_hold_review`, which is what it is.
 */
export function enrollmentSource(): StepEligibilitySource {
  return {
    name: 'enrollment',
    evaluate: async (context, input) => {
      const { rows } = await context.db.query<{
        state: string;
        ended_at: Date | null;
        execution_state: string | null;
      }>(
        `SELECT n.state, n.ended_at, e.state AS execution_state
           FROM sequence_enrollments n
           LEFT JOIN step_executions e
             ON e.workspace_id = n.workspace_id AND e.id = $3 AND e.enrollment_id = n.id
          WHERE n.workspace_id = $1 AND n.id = $2`,
        [context.scope.workspaceId, input.execution.enrollmentId, input.execution.id],
      );
      const enrollment = rows[0];
      if (enrollment === undefined) return { ok: false, reasonCode: 'scoped_pause', detail: 'enrollment_missing' };
      if (enrollment.ended_at !== null) return { ok: false, reasonCode: 'scoped_pause', detail: 'enrollment_ended' };
      if (enrollment.state !== 'active') {
        return { ok: false, reasonCode: 'scoped_pause', detail: `enrollment_${enrollment.state}` };
      }
      // The execution must still be this enrollment's, and not finished: a cancelled
      // execution is one a stop already took back.
      const execution = enrollment.execution_state;
      if (execution === null || execution === 'cancelled' || execution === 'completed') {
        return { ok: false, reasonCode: 'scoped_pause', detail: `execution_${execution ?? 'missing'}` };
      }
      return { ok: true };
    },
  };
}

/**
 * The effective suppression view (10.2).
 *
 * Firm-wide and handle, in one statement over G4's `effective_suppressions`. The
 * handle arm covers every email address of this contact, not only the one the step
 * would use: a prospect who asked to stop has asked about themselves, not about one
 * of their addresses.
 *
 * The channel is the step's (migration 0037): an e-mail step is refused by an `email` or
 * `all` stop, a call-task step by a `phone` or `all` stop. The key set is the same union
 * for both, so a stop on a person's number covers their addresses when it is `all`, and
 * a stop on an address covers their numbers when it is `all`.
 */
export function suppressionSource(): StepEligibilitySource {
  return {
    name: 'suppression',
    evaluate: async (context, input) => {
      const { rows } = await context.db.query<{ scope: string }>(
        `SELECT e.scope
           FROM effective_suppressions e
          WHERE e.workspace_id = $1
            AND e.channel IN ($4::text, 'all')
            AND (
              (e.scope = 'firm' AND e.canonical_key = $2::text)
              OR (e.scope = 'handle' AND e.canonical_key IN (
                    SELECT a.address FROM email_addresses a
                     WHERE a.workspace_id = $1 AND a.contact_id = $3
                    UNION ALL
                    SELECT p.e164 FROM phone_routes p
                     WHERE p.workspace_id = $1 AND p.contact_id = $3
                  ))
            )
          LIMIT 1`,
        [context.scope.workspaceId, input.firmId, input.contactId, SUPPRESSION_READER_CHANNELS[input.channel]],
      );
      const scope = rows[0]?.scope;
      if (scope === undefined) return { ok: true };
      return { ok: false, reasonCode: scope === 'firm' ? 'firm_suppressed' : 'handle_suppressed' };
    },
  };
}

/** Ownership (5.2: a salesperson may contact only assigned firms). */
export function assignmentSource(): StepEligibilitySource {
  return {
    name: 'assignment',
    evaluate: async (context, input) => {
      const { rows } = await context.db.query<{ assigned_user_id: string | null }>(
        'SELECT assigned_user_id FROM firms WHERE workspace_id = $1 AND id = $2',
        [context.scope.workspaceId, input.firmId],
      );
      const assigned = rows[0]?.assigned_user_id ?? null;
      return assigned === null || assigned !== input.ownerUserId
        ? { ok: false, reasonCode: 'reassignment' }
        : { ok: true };
    },
  };
}

/**
 * The email route (7.2, 12.4).
 *
 * A step with no usable route holds rather than failing: 12.4's bounce path leaves
 * later email steps "ineligible until another usable route exists", which is a hold
 * with a recovery, not a stop. Non-email channels have no route question here; the
 * call step's route is `authorizeDial`'s business at the moment of dialing.
 */
export function emailRouteSource(): StepEligibilitySource {
  return {
    name: 'email-route',
    evaluate: async (context, input) => {
      if (input.channel !== 'email') return { ok: true };
      if (input.frozen !== undefined) return await frozenRouteOutcome(context, input.frozen);
      const { rows } = await context.db.query<{ eligibility: string }>(
        `SELECT eligibility FROM email_addresses
          WHERE workspace_id = $1 AND contact_id = $2 AND retired_at IS NULL
          ORDER BY CASE eligibility WHEN 'usable' THEN 0 ELSE 1 END, created_at
          LIMIT 1`,
        [context.scope.workspaceId, input.contactId],
      );
      const eligibility = rows[0]?.eligibility;
      if (eligibility === undefined) return { ok: false, reasonCode: 'route_missing' };
      if (eligibility === 'usable') return { ok: true };
      if (eligibility === 'candidate') return { ok: false, reasonCode: 'route_candidate' };
      if (eligibility === 'invalid') return { ok: false, reasonCode: 'route_invalid' };
      return { ok: false, reasonCode: 'route_retired' };
    },
  };
}

/**
 * The route a fence froze, re-read at dispatch (7.2, 12.4, Appendix B).
 *
 * `usable` and nothing else: a `candidate` was never cleared to receive automated
 * mail. And the *version* must be the one the fence froze. A route
 * whose eligibility changed bumps its version (`email_addresses_version_increases`), so
 * a different version is a route that has been re-decided since these bytes were
 * addressed — invalidated by a bounce and restored, say — and the decision the fence
 * carries is no longer the route's. It holds as `route_invalid`, the code a stale
 * frozen route has always been, with the reason in the detail.
 */
async function frozenRouteOutcome(
  context: RepositoryContext,
  frozen: FrozenEnvelope,
): Promise<StepEligibilityOutcome> {
  if (frozen.routeId === null) return { ok: false, reasonCode: 'route_missing', detail: 'no_frozen_route' };
  const { rows } = await context.db.query<{ eligibility: string; version: number; retired_at: Date | null }>(
    'SELECT eligibility, version, retired_at FROM email_addresses WHERE workspace_id = $1 AND id = $2',
    [context.scope.workspaceId, frozen.routeId],
  );
  const route = rows[0];
  if (route === undefined) return { ok: false, reasonCode: 'route_missing', detail: 'frozen_route_gone' };
  if (route.retired_at !== null || route.eligibility === 'retired') return { ok: false, reasonCode: 'route_retired' };
  if (route.eligibility === 'invalid') return { ok: false, reasonCode: 'route_invalid' };
  if (route.eligibility === 'candidate') return { ok: false, reasonCode: 'route_candidate' };
  if (route.eligibility !== 'usable') return { ok: false, reasonCode: 'route_invalid', detail: route.eligibility };
  if (frozen.routeVersion === null || Number(route.version) !== frozen.routeVersion) {
    return {
      ok: false,
      reasonCode: 'route_invalid',
      detail: `version:${String(frozen.routeVersion)}->${String(route.version)}`,
    };
  }
  return { ok: true };
}

/**
 * The mailbox (12.6: "While a mailbox grant is revoked or coverage unhealthy, every
 * automated step kind for that owner is held").
 *
 * Owner-scoped, because the mail lane's hold is. The query is deliberately about the
 * *mailbox row* rather than about the hold: the hold answers through `holdSource`,
 * and this catches the case of an owner who has never connected a mailbox at all,
 * which no hold covers because nothing ever opened one.
 *
 * Coverage is *proven* coverage: `ready` and a watermark no older than
 * `COVERAGE_FRESHNESS_SECONDS`. A mailbox that stays `ready` while every sync is rate
 * limited is exactly the unhealthy coverage 12.6 holds for, and `mail/coverage.ts` is
 * the one place that says what fresh means.
 */
export function mailboxSource(): StepEligibilitySource {
  return {
    name: 'mailbox',
    evaluate: async (context, input) => {
      if (input.channel !== 'email') return { ok: true };
      const refusal = coverageRefusal(await readMailboxCoverage(context, { ownerUserId: input.ownerUserId }));
      return refusal === null ? { ok: true } : { ok: false, reasonCode: refusal.reason, detail: refusal.detail };
    },
  };
}

/**
 * The template's standing approval (11.1, 12.2).
 *
 * At dispatch the question is about the version the fence's bytes were rendered from,
 * which is `frozen.templateVersionId`: an approval withdrawn after the bytes
 * were decided withdraws the bytes too.
 */
export function templateApprovalSource(): StepEligibilitySource {
  return {
    name: 'template-approval',
    evaluate: async (context, input) => {
      if (input.channel !== 'email') return { ok: true };
      if (input.frozen !== undefined) {
        if (input.frozen.templateVersionId === null) return { ok: false, reasonCode: 'template_unapproved' };
        const frozen = await context.db.query<{ approved_at: Date | null; retired_at: Date | null }>(
          'SELECT approved_at, retired_at FROM template_versions WHERE workspace_id = $1 AND id = $2',
          [context.scope.workspaceId, input.frozen.templateVersionId],
        );
        const version = frozen.rows[0];
        if (version === undefined || version.approved_at === null || version.retired_at !== null) {
          return { ok: false, reasonCode: 'template_unapproved' };
        }
        return { ok: true };
      }
      const { rows } = await context.db.query<{ approved_at: Date | null; retired_at: Date | null }>(
        `SELECT t.approved_at, t.retired_at
           FROM step_executions e
           JOIN sequence_steps s ON s.workspace_id = e.workspace_id AND s.id = e.step_id
           JOIN template_versions t ON t.workspace_id = s.workspace_id AND t.id = s.template_version_id
          WHERE e.workspace_id = $1 AND e.id = $2`,
        [context.scope.workspaceId, input.execution.id],
      );
      const template = rows[0];
      if (template === undefined || template.approved_at === null) {
        return { ok: false, reasonCode: 'template_unapproved' };
      }
      return template.retired_at === null ? { ok: true } : { ok: false, reasonCode: 'template_unapproved' };
    },
  };
}

/** The sources this lane can answer from its own tables and its neighbours' views. */
export function defaultEligibilitySources(): readonly StepEligibilitySource[] {
  return [
    suppressionSource(),
    followUpPermissionSource(),
    coldOutreachTransportSource(),
    firmExclusivitySource(),
    controlModeSource(),
    enrollmentSource(),
    holdSource(),
    assignmentSource(),
    emailRouteSource(),
    mailboxSource(),
    templateApprovalSource(),
  ];
}

/**
 * Compose the sources. First refusal wins, and the order is the one above.
 *
 * Caps, the domain guard and the sending window are deliberately not sources: they
 * belong to the sending lane, they are re-read inside its fence, and asking them here
 * as well would be a second answer that can disagree with the one that matters.
 * `runDueStepExecution` turns the sending lane's refusal into the same hold this
 * composition would have produced.
 */
export function composeEligibility(
  sources: readonly StepEligibilitySource[] = defaultEligibilitySources(),
): StepEligibility {
  return {
    evaluate: async (context, input) => {
      for (const source of sources) {
        const outcome = await source.evaluate(context, input);
        if (!outcome.ok) return outcome;
      }
      return { ok: true };
    },
  };
}

/** Everything is eligible. For tests about timing and hand-off rather than about gates. */
export function allowAllEligibility(): StepEligibility {
  return { evaluate: async () => await Promise.resolve({ ok: true as const }) };
}

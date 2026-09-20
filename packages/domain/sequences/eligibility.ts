import type { BlockedActionKind, HoldReasonCode } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { listApplicableHolds } from '../policy/index.ts';
import type { StepChannel, StepExecutionRow } from './types.ts';

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
 *   2. control mode — an opportunity a human is handling is not automated;
 *   3. holds — every reversible blocker, in one indexed statement;
 *   4. ownership and assignment;
 *   5. route eligibility and version;
 *   6. mailbox health and coverage;
 *   7. template approval;
 *   8. caps and the domain guard;
 *   9. the sending window.
 *
 * Suppression before assignment for the reason `docs/greenfield/policy.md` gives: an
 * unassigned salesperson should be told the firm is suppressed rather than that it is
 * not theirs, because the suppression is the more important fact.
 */

export type StepEligibilityOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reasonCode: HoldReasonCode };

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
  linkedin_task: 'linkedin_task',
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
 */
export function holdSource(): StepEligibilitySource {
  return {
    name: 'holds',
    evaluate: async (context, input) => {
      const holds = await listApplicableHolds(context, {
        actionKind: input.actionKind,
        firmId: input.firmId,
        opportunityId: input.opportunityId,
        ownerUserId: input.ownerUserId,
        enrollmentId: input.execution.enrollmentId,
      });
      const advance = await listApplicableHolds(context, {
        actionKind: 'enrollment_advance',
        firmId: input.firmId,
        opportunityId: input.opportunityId,
        ownerUserId: input.ownerUserId,
        enrollmentId: input.execution.enrollmentId,
      });
      const blocking = [...holds, ...advance];
      const first = blocking[0];
      return first === undefined ? { ok: true } : { ok: false, reasonCode: first.reasonCode };
    },
  };
}

/**
 * The opportunity's control mode (7.3).
 *
 * "`manual` is entered by a confirmed human email reply, user-recorded LinkedIn
 * reply, engaged call outcome, or direct Gmail send ... Automation never reverses
 * manual mode." A manual opportunity is not a hold — there is no interval to shift by
 * and no control that clears it — so it is a refusal with its own reason code.
 */
export function controlModeSource(): StepEligibilitySource {
  return {
    name: 'control-mode',
    evaluate: async (context, input) => {
      const { rows } = await context.db.query<{ control_mode: string; status: string }>(
        'SELECT control_mode, status FROM opportunities WHERE workspace_id = $1 AND id = $2',
        [context.scope.workspaceId, input.opportunityId],
      );
      const opportunity = rows[0];
      if (opportunity === undefined || opportunity.status !== 'open') {
        return { ok: false, reasonCode: 'opportunity_manual' };
      }
      return opportunity.control_mode === 'automated'
        ? { ok: true }
        : { ok: false, reasonCode: 'opportunity_manual' };
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
 */
export function suppressionSource(): StepEligibilitySource {
  return {
    name: 'suppression',
    evaluate: async (context, input) => {
      const { rows } = await context.db.query<{ scope: string }>(
        `SELECT e.scope
           FROM effective_suppressions e
          WHERE e.workspace_id = $1
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
        [context.scope.workspaceId, input.firmId, input.contactId],
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
 * The mailbox (12.6: "While a mailbox grant is revoked or coverage unhealthy, every
 * automated step kind for that owner is held").
 *
 * Owner-scoped, because the mail lane's hold is. The query is deliberately about the
 * *mailbox row* rather than about the hold: the hold answers through `holdSource`,
 * and this catches the case of an owner who has never connected a mailbox at all,
 * which no hold covers because nothing ever opened one.
 */
export function mailboxSource(): StepEligibilitySource {
  return {
    name: 'mailbox',
    evaluate: async (context, input) => {
      if (input.channel !== 'email') return { ok: true };
      const { rows } = await context.db.query<{ status: string; sync_state: string }>(
        'SELECT status, sync_state FROM mailboxes WHERE workspace_id = $1 AND owner_user_id = $2',
        [context.scope.workspaceId, input.ownerUserId],
      );
      const mailbox = rows[0];
      if (mailbox === undefined) return { ok: false, reasonCode: 'mailbox_disconnected' };
      if (mailbox.status !== 'connected') return { ok: false, reasonCode: 'mailbox_disconnected' };
      if (mailbox.sync_state !== 'ready') return { ok: false, reasonCode: 'coverage_incomplete' };
      return { ok: true };
    },
  };
}

/** The template's standing approval (11.1, 12.2). */
export function templateApprovalSource(): StepEligibilitySource {
  return {
    name: 'template-approval',
    evaluate: async (context, input) => {
      if (input.channel !== 'email') return { ok: true };
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
    controlModeSource(),
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

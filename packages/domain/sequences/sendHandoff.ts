import type { RepositoryContext } from '../db/workspaceScope.ts';

/**
 * The seam between a due email step and the send (specification 11.2, 12.2, 12.5,
 * Appendix B).
 *
 * Lane G7-2 owns `outbound_messages`, the at-most-once fence, the Gmail call, the
 * reputation ramp and the domain guard. This lane owns everything up to the moment
 * the bytes are decided, and hands them over.
 *
 * The division is not arbitrary. 11.1 says "Missing required variables hold the
 * step", so substitution has to happen *before* a fence exists — a fence prepared for
 * a body containing `Hi ,` would be a fence that must never dispatch, and the honest
 * shape is that it is never created. So this lane renders, and passes finished bytes
 * together with the template version id and its content hash; the sending lane
 * re-checks the hash against `template_versions` and freezes the envelope. The footer
 * is already inside the approved body (migration 0009's CHECK), so nothing is
 * appended at send time.
 *
 * `prepare` is idempotent by `stepExecutionId`, which is Appendix B's first row:
 * "Before fence creation | Retry; uniqueness creates or reuses one fence". A second
 * call returns the same fence with `created: false` rather than a second one.
 *
 * `readOutcome` is how the cadence learns what the fence became. It is a read rather
 * than a callback because the fence changes state in a worker this lane does not run
 * in — and because a callback would have to be registered by whoever happened to
 * dispatch, which is the failure mode `docs/decisions/g3a-domain-event-outbox.md`
 * rejected for terminal stops.
 *
 * The reverse direction — "delivered, continue the successor from the original
 * dispatch time" and "skipped, terminally stop the enrollment" (Appendix B) — is
 * `completeEmailStep` in `executions.ts`, a function G7-2 calls. It is not a port,
 * because it is this lane's own business rule and a port would let somebody supply a
 * different one.
 */

export interface OutboundEmailRequest {
  readonly enrollmentId: string;
  readonly stepExecutionId: string;
  readonly opportunityId: string;
  readonly firmId: string;
  readonly contactId: string;
  /** Whose mailbox sends: the firm's assigned salesperson (12.1). */
  readonly ownerUserId: string;
  readonly templateVersionId: string;
  /** The bytes the approval approved, so the sender can refuse a mismatch. */
  readonly templateContentHash: string;
  /** The route frozen on the fence, so a bounce invalidates the right one (12.4). */
  readonly emailAddressId: string;
  readonly toAddress: string;
  /** Rendered. A missing variable never reaches here; it holds the step. */
  readonly subject: string;
  /** Rendered, footer included. */
  readonly body: string;
  /** Where the window rule placed it (11.2, Appendix D). UTC. */
  readonly sendAt: string;
  readonly sourceZone: string;
  /** The delay rule and holiday-calendar version that produced the due instant. */
  readonly ruleVersion: string;
}

/**
 * Why a send refused to prepare a fence. Section 15's closed vocabulary, restricted
 * to the codes that belong to the sending lane; everything this lane can decide for
 * itself it decides before calling.
 */
export const SEND_HANDOFF_REFUSALS = [
  'scoped_pause',
  'mailbox_disconnected',
  'coverage_incomplete',
  'template_unapproved',
  'daily_cap',
  'domain_cap',
  'route_missing',
  'route_candidate',
  'route_invalid',
  'route_retired',
  'outside_email_window',
  'firm_suppressed',
  'handle_suppressed',
  'opportunity_manual',
  'provider_refusal',
  'send_unknown_reconciling',
  'restore_in_progress',
] as const;
export type SendHandoffRefusal = (typeof SEND_HANDOFF_REFUSALS)[number];

export type PrepareSendOutcome =
  | { readonly ok: true; readonly outboundMessageId: string; readonly created: boolean }
  | { readonly ok: false; readonly reason: SendHandoffRefusal };

/** Appendix B's state machine, as this lane needs to read it. */
export const OUTBOUND_FENCE_STATES = [
  'absent',
  'prepared',
  'dispatching',
  'reconciling',
  'sent',
  'held',
  'unknown_terminal',
] as const;
export type OutboundFenceState = (typeof OUTBOUND_FENCE_STATES)[number];

export interface OutboundFenceOutcome {
  readonly state: OutboundFenceState;
  /** When the irreversible `prepared → dispatching` transition happened, if it has. */
  readonly dispatchedAt: string | null;
  readonly heldReason: string | null;
}

export interface SendHandoff {
  prepare(context: RepositoryContext, request: OutboundEmailRequest): Promise<PrepareSendOutcome>;
  readOutcome(context: RepositoryContext, stepExecutionId: string): Promise<OutboundFenceOutcome>;
}

export interface RecordingSendHandoff extends SendHandoff {
  /** Every request handed over, in order. */
  readonly prepared: readonly OutboundEmailRequest[];
  /** What the next `prepare` answers. Defaults to accepting. */
  answerWith(outcome: PrepareSendOutcome): void;
  /** What `readOutcome` answers for a step execution. */
  setOutcome(stepExecutionId: string, outcome: OutboundFenceOutcome): void;
}

/**
 * The fake this lane tests against, and the one G7-2's adapter is checked against.
 *
 * It records rather than asserts, because the interesting assertions are about the
 * *content* of a request — that the subject has no unsubstituted variable left in it,
 * that the content hash is the approved one — and a fake that asserted would have to
 * know those rules, which would make it a second implementation of them.
 */
export function recordingSendHandoff(): RecordingSendHandoff {
  const prepared: OutboundEmailRequest[] = [];
  const fences = new Map<string, OutboundFenceOutcome>();
  let nextOutcome: PrepareSendOutcome | null = null;
  let counter = 0;

  return {
    prepared,
    answerWith(outcome) {
      nextOutcome = outcome;
    },
    setOutcome(stepExecutionId, outcome) {
      fences.set(stepExecutionId, outcome);
    },
    prepare: async (_context, request) => {
      await Promise.resolve();
      const answer = nextOutcome;
      nextOutcome = null;
      if (answer !== null && !answer.ok) return answer;
      const existing = prepared.find(
        candidate => candidate.stepExecutionId === request.stepExecutionId,
      );
      if (existing !== undefined) {
        // Appendix B: uniqueness reuses one fence rather than creating a second.
        return { ok: true, outboundMessageId: `fence-${request.stepExecutionId}`, created: false };
      }
      prepared.push(request);
      counter += 1;
      fences.set(request.stepExecutionId, {
        state: 'prepared',
        dispatchedAt: null,
        heldReason: null,
      });
      return {
        ok: true,
        outboundMessageId: answer?.ok === true ? answer.outboundMessageId : `fence-${String(counter)}`,
        created: true,
      };
    },
    readOutcome: async (_context, stepExecutionId) => {
      await Promise.resolve();
      return fences.get(stepExecutionId) ?? { state: 'absent', dispatchedAt: null, heldReason: null };
    },
  };
}

/**
 * The hand-off that refuses everything, for a deployment with no sending lane wired.
 *
 * `scoped_pause` rather than a throw: 4.2's rule is that a system which cannot send
 * holds, and a step held with a reason a salesperson can read is a better outcome
 * than an exception in a worker log.
 */
export function unavailableSendHandoff(): SendHandoff {
  return {
    prepare: async () => await Promise.resolve({ ok: false, reason: 'scoped_pause' as const }),
    readOutcome: async () =>
      await Promise.resolve({ state: 'absent' as const, dispatchedAt: null, heldReason: null }),
  };
}

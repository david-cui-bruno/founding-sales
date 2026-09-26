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
 * The fence's *state machine* is G7-2's; driving it is not. Appendix C has no send job
 * kind, so `sequence.action` calls `dispatch` as well — after the step's transaction
 * has committed, and only while the fence still reads `prepared`. See
 * `docs/decisions/g8-this-lane-dispatches.md`.
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
  /**
   * The workspace business date `sendAt` falls on, `YYYY-MM-DD` (Appendix D).
   *
   * It travels with the request rather than being derived at the far end because the
   * daily cap counts per business date, and the date a placement belongs to is the
   * one the placement rule used. Two lanes deriving it from the same instant and two
   * zone lookups is two answers that can disagree about a send at midnight.
   */
  readonly businessDate: string;
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
  /**
   * The fence's own id, once one exists (lane g82).
   *
   * A step woken again — its cap cleared, its pause released, or its worker died between
   * the step's transaction and the claim (audit C02, C03) — already has a fence, and the
   * dispatch it is owed names that fence. Optional so that a hand-off written before
   * this lane still type-checks; without it the engine falls back to asking `prepare`,
   * which reuses the one fence.
   */
  readonly outboundMessageId?: string | null | undefined;
  /**
   * An administrator's answer to an `unknown_terminal` fence (12.5, Appendix B; lane g82).
   *
   * `delivered` continues the sequence from the original dispatch time, `skipped` stops
   * the enrollment. Absent or null while nobody has answered.
   */
  readonly adminResolution?: 'delivered' | 'skipped' | null | undefined;
}

export type DispatchSendOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: SendHandoffRefusal };

export interface SendHandoff {
  prepare(context: RepositoryContext, request: OutboundEmailRequest): Promise<PrepareSendOutcome>;
  /**
   * Drive a prepared fence through `prepared → dispatching` and the provider call.
   *
   * Appendix C has no send job kind, so nobody picks a prepared fence up on its own:
   * the lane that prepared it is the lane that dispatches it. This is called *after*
   * the step's transaction commits, because the transition and the Gmail call after it
   * cannot be rolled back, and `dispatchPreparedStep` only calls it while the fence
   * still reads `prepared`.
   */
  dispatch(
    context: RepositoryContext,
    input: { readonly outboundMessageId: string; readonly stepExecutionId: string },
  ): Promise<DispatchSendOutcome>;
  readOutcome(context: RepositoryContext, stepExecutionId: string): Promise<OutboundFenceOutcome>;
}

export interface RecordingSendHandoff extends SendHandoff {
  /** Every request handed over, in order. */
  readonly prepared: readonly OutboundEmailRequest[];
  /** Every outbound message id dispatched, in order. A second entry is a double send. */
  readonly dispatched: readonly string[];
  /** What the next `prepare` answers. Defaults to accepting. */
  answerWith(outcome: PrepareSendOutcome): void;
  /** What the next `dispatch` answers. Defaults to accepting. */
  answerDispatchWith(outcome: DispatchSendOutcome): void;
  /** What the fence becomes once dispatched. Defaults to `sent`. */
  dispatchesTo(stepExecutionId: string, outcome: OutboundFenceOutcome): void;
  /** What `readOutcome` answers right now, without a dispatch. */
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
  const dispatched: string[] = [];
  const fences = new Map<string, OutboundFenceOutcome>();
  const fenceIds = new Map<string, string>();
  const afterDispatch = new Map<string, OutboundFenceOutcome>();
  let nextOutcome: PrepareSendOutcome | null = null;
  let nextDispatch: DispatchSendOutcome | null = null;
  let counter = 0;

  return {
    prepared,
    dispatched,
    answerWith(outcome) {
      nextOutcome = outcome;
    },
    answerDispatchWith(outcome) {
      nextDispatch = outcome;
    },
    dispatchesTo(stepExecutionId, outcome) {
      afterDispatch.set(stepExecutionId, outcome);
    },
    setOutcome(stepExecutionId, outcome) {
      fences.set(stepExecutionId, outcome);
      if (typeof outcome.outboundMessageId === 'string') fenceIds.set(stepExecutionId, outcome.outboundMessageId);
    },
    prepare: async (_context, request) => {
      await Promise.resolve();
      const answer = nextOutcome;
      nextOutcome = null;
      if (answer !== null && !answer.ok) return answer;
      const existing = fenceIds.get(request.stepExecutionId);
      if (existing !== undefined) {
        // Appendix B: uniqueness reuses one fence rather than creating a second.
        return { ok: true, outboundMessageId: existing, created: false };
      }
      prepared.push(request);
      counter += 1;
      const outboundMessageId = answer?.ok === true ? answer.outboundMessageId : `fence-${String(counter)}`;
      fenceIds.set(request.stepExecutionId, outboundMessageId);
      fences.set(request.stepExecutionId, {
        state: 'prepared',
        dispatchedAt: null,
        heldReason: null,
      });
      return { ok: true, outboundMessageId, created: true };
    },
    dispatch: async (_context, input) => {
      await Promise.resolve();
      const answer = nextDispatch;
      nextDispatch = null;
      if (answer !== null && !answer.ok) return answer;
      dispatched.push(input.outboundMessageId);
      fences.set(
        input.stepExecutionId,
        afterDispatch.get(input.stepExecutionId) ?? {
          state: 'sent',
          dispatchedAt: null,
          heldReason: null,
        },
      );
      return { ok: true };
    },
    readOutcome: async (_context, stepExecutionId) => {
      await Promise.resolve();
      const fence = fences.get(stepExecutionId);
      if (fence === undefined) return { state: 'absent', dispatchedAt: null, heldReason: null, outboundMessageId: null };
      return { outboundMessageId: fenceIds.get(stepExecutionId) ?? null, ...fence };
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
    dispatch: async () => await Promise.resolve({ ok: false, reason: 'scoped_pause' as const }),
    readOutcome: async () =>
      await Promise.resolve({ state: 'absent' as const, dispatchedAt: null, heldReason: null }),
  };
}

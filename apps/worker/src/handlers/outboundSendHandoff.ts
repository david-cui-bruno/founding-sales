import {
  dispatchOutboundMessage,
  holdReasonForRefusal,
  prepareOutboundMessage,
  readOutboundOutcome,
  type OutboundSendDeps,
} from '@fss/domain/outbound';
import { SEND_HANDOFF_REFUSALS, type SendHandoff, type SendHandoffRefusal } from '@fss/domain/sequences';

/**
 * G8's `SendHandoff`, over G7-2's fence (specification 11.2, 12.2, 12.5, Appendix B).
 *
 * This file is composition and nothing else. Every decision it looks like it is
 * making is made on one side or the other: the fence decides whether a send may be
 * prepared and whether it may leave, and the cadence decides what a refusal does to
 * the step. What is here is the wiring between two lanes that were built beside each
 * other, and the mapping between their two refusal vocabularies — which is
 * `holdReasonForRefusal`, G7-2's own, so there is one table and not two.
 *
 * ## Why `dispatch` is in the seam at all
 *
 * Appendix C has no send job kind. Nobody claims a fence in state `prepared`, so the
 * lane that prepares one has to be the lane that sends it — after its own transaction
 * commits, and only while the fence still says `prepared`. See
 * `docs/decisions/g8-this-lane-dispatches.md`.
 *
 * ## A deployment with no Gmail configuration
 *
 * `prepare` and `readOutcome` are database reads and writes and are always real.
 * `dispatch` needs a Gmail client, an OAuth configuration and an envelope cipher, and
 * this release hands the worker none of them — the change that reads a deployment's
 * client secret and KMS key is reviewed on its own, which is why `mailHandlers` is
 * given `undefined` here too.
 *
 * So `deps` is optional and an absent one refuses with `mailbox_disconnected`, which
 * is the truth rather than a placeholder: there is no connected mailbox in such a
 * deployment, and in practice `prepareOutboundMessage` says so first, because a fence
 * needs a mailbox to name and refuses `mailbox_unknown` without one. The step holds
 * with a reason a salesperson can read, which is 4.2's rule.
 */

export interface OutboundSendHandoffOptions {
  /** Absent until the credentialed bootstrap lands. Dispatch refuses without it. */
  readonly deps?: OutboundSendDeps | undefined;
}

export function outboundSendHandoff(options: OutboundSendHandoffOptions = {}): SendHandoff {
  const deps = options.deps;
  return {
    prepare: async (context, request) => {
      const prepared = await prepareOutboundMessage(context, request);
      if (!prepared.ok) return { ok: false, reason: refusalFor(prepared.reason) };
      return {
        ok: true,
        outboundMessageId: prepared.value.outboundMessageId,
        created: prepared.value.created,
      };
    },
    dispatch: async (context, input) => {
      if (deps === undefined) return { ok: false, reason: 'mailbox_disconnected' };
      const report = await dispatchOutboundMessage(context, deps, {
        outboundMessageId: input.outboundMessageId,
      });
      // `held`, `reconciling` and `already_terminal` are all states the cadence reads
      // off the fence a moment later, so they are not refusals here: reporting them
      // twice, once as a refusal and once as a state, is how the two sides come to
      // disagree. Only a refusal that names a reason is passed back.
      if (report.refusal !== undefined) return { ok: false, reason: refusalFor(report.refusal, report.detail) };
      return { ok: true };
    },
    readOutcome: async (context, stepExecutionId) => {
      const outcome = await readOutboundOutcome(context, stepExecutionId);
      return {
        state: outcome.state,
        dispatchedAt: outcome.dispatchedAt,
        heldReason: outcome.heldReason,
        // Lane g82: the fence a woken step re-dispatches, and the admin's answer to an
        // `unknown_terminal` one, which is what continues or stops the sequence.
        outboundMessageId: outcome.outboundMessageId,
        adminResolution: outcome.adminResolution,
      };
    },
  };
}

/**
 * One of G7-2's refusal codes as one of section 15's hold reasons.
 *
 * `holdReasonForRefusal` is the table, and it is theirs. The two it does not answer
 * for are the two that are not about this send: a fence or mailbox that does not
 * exist is a mailbox that is not connected, and everything else left — automated
 * sending switched off, no sending domain, a fence somebody else owns — is an
 * administrative state that stops sending, which is what `scoped_pause` names.
 *
 * `step_ineligible` (lane g77) is the step's own eligibility refusing at the claim, and
 * its detail begins with the section 15 code that refused: that code is the step's
 * reason when the hand-off vocabulary has it, and `scoped_pause` otherwise.
 */
function refusalFor(reason: string, detail?: string): SendHandoffRefusal {
  if (reason === 'mailbox_unknown') return 'mailbox_disconnected';
  if (reason === 'step_ineligible') {
    const code = detail?.split(':')[0];
    const known: readonly string[] = SEND_HANDOFF_REFUSALS;
    return code !== undefined && known.includes(code) ? (code as SendHandoffRefusal) : 'scoped_pause';
  }
  return holdReasonForRefusal(reason) ?? 'scoped_pause';
}

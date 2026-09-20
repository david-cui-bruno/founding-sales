import type { RepositoryContext } from '../db/workspaceScope.ts';
import { openHold } from '../policy/holds.ts';
import { accessForMailbox, type EnvelopeCipher, type GmailClient, type GmailOAuthConfig } from '../mail/index.ts';
import {
  beginReconciling,
  claimForDispatch,
  holdFence,
  readFence,
  recordSent,
  releaseFence,
  type OutboundFenceRow,
} from './fence.ts';
import { decideSend, holdReasonForRefusal, type SendGateDeps } from './gate.ts';
import { countAutomatedSend } from './ramp.ts';
import { RECONCILE_WINDOW_HOURS, type SendRefusalCode } from './types.ts';

/**
 * The dispatch path: the only code in FSS that sends an email (specification 12.5,
 * Appendix B, Appendix G 5, 12, 33).
 *
 * The whole file is one ordered sequence, and the order is the safety property.
 *
 *   1. Read the fence. If it is `held`, try to release it — a hold that has expired
 *      (yesterday's cap, last night's window) should not need a person.
 *   2. Run the gate. Every refusal lands here, before anything irreversible.
 *   3. Count the send against the day's cap, conditionally, in the database.
 *   4. Claim the fence: the atomic `prepared → dispatching` that mints the token.
 *   5. Call Gmail. Exactly once, ever, for this fence.
 *   6. Record the outcome.
 *
 * Steps 3 and 4 are in that order on purpose. The cap increment is reversible and
 * the claim is not, so a process that dies between them has over-counted the day by
 * one — a mailbox sends 4 instead of 5 — while the reverse order would leave a
 * claimed fence that never got counted, and a claimed fence can never be re-sent.
 * Losing one send is recoverable; losing the count is how a cap stops being a cap.
 *
 * ## The one call
 *
 * Between `claimForDispatch` and the next database write there is exactly one
 * `await gmail.sendMessage`. That single statement is the whole of FSS's outbound
 * surface area, and everything else in this package exists to make it reachable at
 * most once per fence.
 *
 * Its three outcomes are handled as Appendix B's failure table requires:
 *
 *   * `ok` — record `sent` with the provider ids, under the token.
 *   * `refused` — Gmail answered no, so provably nothing left. Appendix B's third
 *     row would say `held`, but the fence is already `dispatching` by then and
 *     `dispatching` never goes back. So it enters `reconciling`, where the Sent
 *     search will confirm the absence and the observation will expire into
 *     `unknown_terminal`. That is slower than a hold and it is the honest state:
 *     we asked Gmail to send and cannot prove it did not.
 *   * `indeterminate` — `reconciling`, immediately, and never a retry.
 */

export interface OutboundSendDeps extends SendGateDeps {
  readonly gmail: GmailClient;
  readonly oauth: GmailOAuthConfig;
  readonly cipher: EnvelopeCipher;
  /** Identifies this worker in the fence's ledger. Never a credential. */
  readonly actor?: string | undefined;
  readonly reconcileWindowHours?: number | undefined;
}

export type SendOutcome =
  | 'sent'
  | 'held'
  | 'reconciling'
  | 'already_terminal'
  | 'fence_unknown'
  | 'not_ready';

export interface SendReport {
  readonly outcome: SendOutcome;
  readonly outboundMessageId: string;
  readonly refusal?: SendRefusalCode | undefined;
  readonly detail?: string | undefined;
  readonly providerMessageId?: string | undefined;
}

/**
 * Dispatch one prepared fence.
 *
 * Called by G8's `sequence.action` handler, inside the runner's transaction, which is
 * what Appendix C means by giving that kind the protection `outbound_fence`: the
 * handler's at-most-once guarantee is this function's, not the job runner's.
 */
export async function dispatchOutboundMessage(
  context: RepositoryContext,
  deps: OutboundSendDeps,
  input: { readonly outboundMessageId: string },
): Promise<SendReport> {
  const initial = await readFence(context, input.outboundMessageId);
  if (initial === null) {
    return { outcome: 'fence_unknown', outboundMessageId: input.outboundMessageId };
  }
  if (initial.state === 'sent' || initial.state === 'unknown_terminal') {
    return { outcome: 'already_terminal', outboundMessageId: initial.id };
  }
  if (initial.state === 'dispatching' || initial.state === 'reconciling') {
    // Somebody else owns this fence, or owned it and died. Either way this process
    // must not send. The reconciliation sweep is what finishes it.
    return { outcome: 'not_ready', outboundMessageId: initial.id, detail: initial.state };
  }

  let fence: OutboundFenceRow = initial;
  if (fence.state === 'held') {
    // A held fence never reached Gmail, so re-preparing it is safe. Whether it may
    // now go out is the gate's decision, made below on the released fence.
    //
    // The hold this fence opened last time is released first, and that is not a
    // convenience: the gate is about to re-decide every one of those questions from
    // the database, so last attempt's answer is stale by definition. Leaving it
    // would mean a fence held by Monday's cap could never send again, because the
    // hold it opened would be the reason the gate refused it on Tuesday.
    await context.db.query(
      `UPDATE active_holds
          SET released_at = now()
        WHERE workspace_id = $1
          AND source_event_kind = 'outbound_message'
          AND source_event_id = $2
          AND released_at IS NULL
          -- A fence in doubt is not a held fence, and its holds are not this
          -- attempt's to clear. Only an admin's answer ends those.
          AND reason_code NOT IN ('send_unknown_reconciling', 'send_unknown_terminal')`,
      [context.scope.workspaceId, fence.id],
    );
    const released = await releaseFence(context, {
      outboundMessageId: fence.id,
      ...(deps.actor === undefined ? {} : { actor: deps.actor }),
    });
    if (!released.ok) return { outcome: 'not_ready', outboundMessageId: fence.id };
    fence = released.value;
  }

  const gate = await decideSend(context, fence, deps);
  if (!gate.ok) return await hold(context, deps, fence, gate.reason, gate.detail);
  const plan = gate.value;

  // The cap, taken before the irreversible step and by a conditional UPDATE rather
  // than a read-then-write, so two workers racing the last slot of the day cannot
  // both win it (Appendix G 33).
  const counted = await countAutomatedSend(context, {
    mailboxId: plan.mailbox.id,
    businessDate: plan.day.businessDate,
    cap: plan.cap,
  });
  if (!counted) return await hold(context, deps, fence, 'daily_cap', `${String(plan.cap)}`);

  const access = await accessForMailbox(
    context,
    { gmail: deps.gmail, oauth: deps.oauth, cipher: deps.cipher },
    plan.mailbox.id,
  );
  if (!access.ok) {
    // The grant went while we were deciding. Nothing has been dispatched, so the
    // fence may be held — and the day's count is released with it, because no
    // message left.
    await releaseCount(context, plan.mailbox.id, plan.day.businessDate);
    return await hold(context, deps, fence, 'grant_revoked', access.reason);
  }

  const claim = await claimForDispatch(context, {
    outboundMessageId: fence.id,
    ...(deps.actor === undefined ? {} : { actor: deps.actor }),
  });
  if (!claim.ok) {
    await releaseCount(context, plan.mailbox.id, plan.day.businessDate);
    return { outcome: 'not_ready', outboundMessageId: fence.id, refusal: claim.reason };
  }

  // ------------------------------------------------------------- the one call
  const sent = await deps.gmail.sendMessage(access.access, {
    to: fence.recipientAddress,
    from: plan.mailbox.address,
    subject: fence.subject,
    body: fence.body,
    rfcMessageId: fence.providerMessageIdHeader,
  });

  if (sent.ok) {
    const recorded = await recordSent(context, {
      outboundMessageId: fence.id,
      attemptToken: claim.value.attemptToken,
      providerMessageId: sent.messageId,
      providerThreadId: sent.threadId,
      ...(deps.actor === undefined ? {} : { actor: deps.actor }),
    });
    if (!recorded.ok) {
      // The fence moved under us between the send and the record, which can only
      // happen if something else reconciled it. Gmail has the message either way.
      return { outcome: 'not_ready', outboundMessageId: fence.id, refusal: recorded.reason };
    }
    return { outcome: 'sent', outboundMessageId: fence.id, providerMessageId: sent.messageId };
  }

  // Appendix B: "Any request bytes may have left ... Never resend; enter reconciling."
  // A `refused` outcome is included, because by the time we learn of it the fence is
  // already `dispatching` and `dispatching` never returns to `prepared`.
  const detail = sent.outcome === 'refused' ? `refused:${sent.reason}` : sent.detail;
  await beginReconciling(context, {
    outboundMessageId: fence.id,
    detail,
    windowHours: deps.reconcileWindowHours ?? RECONCILE_WINDOW_HOURS,
    ...(deps.actor === undefined ? {} : { actor: deps.actor }),
  });
  // The step is held while the fence is in doubt, so no successor runs on a maybe.
  await openHold(context, {
    scopeKind: 'firm',
    scopeKey: fence.firmId,
    reasonCode: 'send_unknown_reconciling',
    blockedActionKinds: ['email_send', 'enrollment_advance'],
    sourceEventKind: 'outbound_message',
    sourceEventId: fence.id,
  });
  return {
    outcome: 'reconciling',
    outboundMessageId: fence.id,
    ...(sent.outcome === 'refused' ? { refusal: refusalOf(sent.reason) } : {}),
    detail,
  };
}

function refusalOf(reason: string): SendRefusalCode {
  switch (reason) {
    case 'grant_revoked':
      return 'grant_revoked';
    case 'rate_limited':
      return 'rate_limited';
    case 'recipient_rejected':
      return 'recipient_rejected';
    default:
      return 'provider_refusal';
  }
}

/**
 * Give back the slot a send did not use.
 *
 * Only ever called before `claimForDispatch`, which is the last moment at which
 * "nothing was attempted" is still provable. After the claim the count stands
 * whatever happened, because the message may have gone.
 */
async function releaseCount(
  context: RepositoryContext,
  mailboxId: string,
  businessDate: string,
): Promise<void> {
  await context.db.query(
    `UPDATE mailbox_send_days
        SET automated_sent = greatest(automated_sent - 1, 0), updated_at = now()
      WHERE workspace_id = $1 AND mailbox_id = $2 AND business_date = $3::date`,
    [context.scope.workspaceId, mailboxId, businessDate],
  );
}

/**
 * Hold the fence and, where the reason is one a step should wait on, the step.
 *
 * The fence hold and the `active_holds` row say different things and both are needed:
 * the fence records why *this email* is waiting, and the hold blocks the automation
 * that would otherwise keep producing more of them.
 */
async function hold(
  context: RepositoryContext,
  deps: OutboundSendDeps,
  fence: OutboundFenceRow,
  reason: SendRefusalCode,
  detail?: string,
): Promise<SendReport> {
  await holdFence(context, {
    outboundMessageId: fence.id,
    reason,
    ...(deps.actor === undefined ? {} : { actor: deps.actor }),
  });

  const holdReason = holdReasonForRefusal(reason);
  if (holdReason !== null) {
    await openHold(context, {
      // Firm-scoped, including the domain guard.
      //
      // 12.6 says reaching the guard "holds further affected sends", and *affected*
      // is the operative word: a recipient who is not on personal Gmail is not
      // covered by Google's bulk-sender rule, and a workspace-scoped hold would stop
      // them too — an outage on traffic nobody objected to. The enforcement of
      // "cannot be bypassed with extra mailboxes" is not this hold's scope but
      // `decideDomainGuard`, which counts the whole domain and runs on every send.
      // The hold's job is to stop the automation churning and to be visible.
      scopeKind: 'firm',
      scopeKey: fence.firmId,
      reasonCode: holdReason,
      blockedActionKinds: ['email_send'],
      sourceEventKind: 'outbound_message',
      sourceEventId: fence.id,
      // `recovery_action` is a closed vocabulary in migration 0001, not free text,
      // because it is what a control offers a person as a *button*. Most of these
      // refusals have no button: a cap, a window and the domain guard lift when time
      // passes, and offering "release" for them would be offering to break the rule.
      // The fence's own `held_reason` carries the detail an operator reads.
      ...(holdReason === 'mailbox_disconnected' || holdReason === 'coverage_incomplete'
        ? { recoveryAction: 'reconnect_mailbox' as const }
        : {}),
    });
  }
  return { outcome: 'held', outboundMessageId: fence.id, refusal: reason, ...(detail === undefined ? {} : { detail }) };
}

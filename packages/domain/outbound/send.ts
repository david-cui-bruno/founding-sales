import type { RepositoryContext } from '../db/workspaceScope.ts';
import { openHold } from '../policy/holds.ts';
import { lockSendGateForDispatch } from '../policy/sendGate.ts';
import type { EnvelopeCipher } from '../mail/envelope.ts';
import type { GmailClient, GmailOAuthConfig } from '../mail/gmailClient.ts';
import { accessForMailbox } from '../mail/sync.ts';
import {
  beginReconciling,
  claimForDispatch,
  holdFence,
  lockFenceForClaim,
  readFence,
  recordSent,
  releaseFence,
  type OutboundFenceRow,
} from './fence.ts';
import { decideSend, holdReasonForRefusal, type SendGateDeps, type SendPlan } from './gate.ts';
import { countAutomatedSend, recordDaySignal } from './ramp.ts';
import { RECONCILE_WINDOW_HOURS, type SendRefusalCode } from './types.ts';

/**
 * The dispatch path: the only code in FSS that sends an email (specification 12.5,
 * Appendix B, Appendix G 3, 5, 6, 12, 33).
 *
 * The whole file is one ordered sequence, and the order is the safety property.
 *
 *   1. Read the fence. If it is `held`, try to release it — a hold that has expired
 *      (yesterday's cap, last night's window) should not need a person.
 *   2. Precheck: run the gate once, outside any transaction, so that everything that
 *      can be refused without Gmail is refused without Gmail.
 *   3. OAuth: exchange the refresh token for an access token. The one slow, networked
 *      step before the send, and it happens *before* the claim transaction opens, so
 *      no lock is ever held across a network call.
 *   4. Recheck and claim, in **one transaction**:
 *        a. take the send gate SHARED (`policy/sendGate.ts`) — every reply, opt-out,
 *           hold and manual-mode change takes it EXCLUSIVE before it commits;
 *        b. lock the fence and its enrollment `FOR UPDATE`;
 *        c. run the gate again — the complete eligibility, proven coverage, the
 *           holiday-aware window and the cap on *today's* business date;
 *        d. reserve the day's capacity: the conditional increment of the counter for
 *           the business date of the claim;
 *        e. claim: the atomic `prepared → dispatching` that mints the token and
 *           records that same business date on the fence;
 *      and commit. A refusal in (c) or (d) holds the fence in the same transaction.
 *   5. Call Gmail. Exactly once, ever, for this fence.
 *   6. Record the outcome.
 *
 * ## Why the recheck and the claim share a transaction and a lock
 *
 * Four autocommit statements with a token refresh in the middle would let a reply that
 * committed during the refresh go unread while the claim succeeded anyway: Appendix
 * G 3 with a real window (`packages/domain/test/outbound/dispatchRace.test.ts`). Inside
 * one transaction the recheck sees everything committed before the gate was granted, and
 * nothing that stops a send can commit between the recheck and the claim, because
 * committing one needs the gate the claim is holding.
 *
 * ## The reservation is the claim's
 *
 * The counter used to be incremented before OAuth and given back by hand on the two
 * failure paths anybody had thought of; a process that died between the increment and
 * the claim left a count no fence explained. Now the increment and the claim commit
 * together or not at all, so every unit of `automated_sent` for a business date is a
 * fence claimed on that date (`claimedAutomatedSends` in `ramp.ts` derives it), and a
 * crash anywhere before the commit leaves neither. After the commit the count stands
 * whatever Gmail says, because the message may have left.
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
 * Called by G8's `sequence.action` handler *after* the step's own transaction has
 * committed, which is what Appendix C means by giving that kind the protection
 * `outbound_fence`: the handler's at-most-once guarantee is this function's, not the
 * job runner's. It opens its own claiming transaction, and refuses to run inside a
 * caller's (`assertOutsideTransaction`): a claim that did not commit before Gmail was
 * called would be a claim a rollback could erase after the email had left.
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

  // ------------------------------------------------------------- 2. precheck
  const precheck = await decideSend(context, fence, deps);
  if (!precheck.ok) return await hold(context, deps, fence, precheck.reason, precheck.detail);

  // ------------------------------------------------------------- 3. OAuth first
  // Before the claim transaction, never inside it: the send gate is not held across a
  // network call, and a grant that went while we were deciding holds the fence with
  // nothing counted, because nothing has been.
  const access = await accessForMailbox(
    context,
    { gmail: deps.gmail, oauth: deps.oauth, cipher: deps.cipher },
    precheck.value.mailbox.id,
  );
  if (!access.ok) return await hold(context, deps, fence, 'grant_revoked', access.reason);

  // -------------------------------------------------- 4. recheck and claim, atomically
  const claimed = await recheckAndClaim(context, deps, fence.id, precheck.value);
  if (claimed.kind === 'not_ready') {
    return {
      outcome: 'not_ready',
      outboundMessageId: fence.id,
      ...(claimed.refusal === undefined ? {} : { refusal: claimed.refusal }),
      ...(claimed.detail === undefined ? {} : { detail: claimed.detail }),
    };
  }
  if (claimed.kind === 'held') {
    // The fence went `held` inside the claiming transaction, with the decision. The
    // step's hold is opened now, outside it: `openHold` takes the send gate exclusive,
    // and asking for that while holding it shared is how two claims deadlock.
    await openStepHold(context, claimed.fence, claimed.reason);
    return {
      outcome: 'held',
      outboundMessageId: fence.id,
      refusal: claimed.reason,
      ...(claimed.detail === undefined ? {} : { detail: claimed.detail }),
    };
  }
  const { plan, claim } = claimed;
  // The bytes are the claimed row's, not the ones read before OAuth: a `prepared`
  // fence may still be re-rendered (migration 0010's trigger freezes the envelope only
  // once the token exists), and what the recheck approved is what the claim locked.
  const envelope = claim.fence;

  // ------------------------------------------------------------- the one call
  const sent = await deps.gmail.sendMessage(access.access, {
    to: envelope.recipientAddress,
    from: plan.mailbox.address,
    subject: envelope.subject,
    body: envelope.body,
    rfcMessageId: envelope.providerMessageIdHeader,
  });

  if (sent.ok) {
    const recorded = await recordSent(context, {
      outboundMessageId: fence.id,
      attemptToken: claim.attemptToken,
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
  // 12.7: "The ramp advances only with ... no provider rate-limit or reputation
  // warning". This is the only place in FSS that hears from the provider at all, so
  // it is where the day learns it. Counted whether Gmail refused or went quiet: the
  // ramp's question is whether the day went well, and a day whose sends went into
  // doubt did not. The counter feeds `rampHealthFailure`'s `provider_warning`, which
  // is why that rule takes `providerErrors` and not only a boolean.
  await recordDaySignal(context, {
    mailboxId: plan.mailbox.id,
    businessDate: plan.day.businessDate,
    signal: 'provider_error',
  });
  await beginReconciling(context, {
    outboundMessageId: fence.id,
    detail,
    windowHours: deps.reconcileWindowHours ?? RECONCILE_WINDOW_HOURS,
    ...(deps.actor === undefined ? {} : { actor: deps.actor }),
  });
  // The step is held while the fence is in doubt, so no successor runs on a maybe.
  await openHold(context, {
    scopeKind: 'firm',
    scopeKey: envelope.firmId,
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

type ClaimOutcome =
  | {
      readonly kind: 'claimed';
      readonly plan: SendPlan;
      readonly claim: { readonly fence: OutboundFenceRow; readonly attemptToken: string };
    }
  | {
      readonly kind: 'held';
      readonly fence: OutboundFenceRow;
      readonly reason: SendRefusalCode;
      readonly detail?: string | undefined;
    }
  | { readonly kind: 'not_ready'; readonly refusal?: SendRefusalCode | undefined; readonly detail?: string | undefined };

/**
 * Step 4: the recheck, the reservation and the claim, in one transaction under the
 * send gate. See the file header for why each is here.
 *
 * The locks, in order: the gate (shared), the fence, the enrollment. Nothing is locked
 * before the gate, which is the order every stop-fact writer is asked to keep
 * (`policy/sendGate.ts`). A refusal holds the fence inside the transaction, so the
 * decision and the `held` it produces commit together; the transaction then commits
 * rather than rolls back, and the counter was never touched on that path. Every other
 * way out before COMMIT — a claim that loses, a thrown error, a process that dies — is
 * a rollback, and takes the reservation with it.
 */
async function recheckAndClaim(
  context: RepositoryContext,
  deps: OutboundSendDeps,
  outboundMessageId: string,
  precheck: SendPlan,
): Promise<ClaimOutcome> {
  await assertOutsideTransaction(context);
  await context.db.query('BEGIN');
  try {
    await lockSendGateForDispatch(context);
    const fence = await lockFenceForClaim(context, outboundMessageId);
    if (fence === null || fence.state !== 'prepared') {
      await context.db.query('ROLLBACK');
      return { kind: 'not_ready', refusal: fence === null ? 'fence_unknown' : 'fence_not_ready', detail: fence?.state };
    }

    // The recheck. `precheck` is the answer from before the token refresh, and it is
    // not an answer to act on: a reply may have committed since. It is consulted for
    // one thing only, below — which mailbox the access token was minted for.
    const gate = await decideSend(context, fence, deps);
    if (!gate.ok) {
      const held = await holdFence(context, {
        outboundMessageId: fence.id,
        reason: gate.reason,
        ...(deps.actor === undefined ? {} : { actor: deps.actor }),
      });
      await context.db.query('COMMIT');
      return { kind: 'held', fence: held.ok ? held.value : fence, reason: gate.reason, detail: gate.detail };
    }
    const plan = gate.value;
    if (plan.mailbox.id !== precheck.mailbox.id) {
      // A `prepared` fence's envelope is still mutable, its mailbox included, and the
      // token in hand belongs to the mailbox the precheck named. Sending another
      // mailbox's fence with it would send from the wrong account.
      await context.db.query('ROLLBACK');
      return { kind: 'not_ready', refusal: 'fence_not_ready', detail: 'mailbox_changed' };
    }

    // The reservation: a conditional UPDATE rather than a read-then-write, so two
    // workers racing the last slot of the day cannot both win it (Appendix G 33), on
    // the business date of *this* decision (S05).
    const reserved = await countAutomatedSend(context, {
      mailboxId: plan.mailbox.id,
      businessDate: plan.day.businessDate,
      cap: plan.cap,
    });
    if (!reserved) {
      const held = await holdFence(context, {
        outboundMessageId: fence.id,
        reason: 'daily_cap',
        ...(deps.actor === undefined ? {} : { actor: deps.actor }),
      });
      await context.db.query('COMMIT');
      return { kind: 'held', fence: held.ok ? held.value : fence, reason: 'daily_cap', detail: String(plan.cap) };
    }

    const claim = await claimForDispatch(context, {
      outboundMessageId: fence.id,
      businessDate: plan.day.businessDate,
      // The audit line of which attestation admitted this send.
      detail: { releaseAdmission: plan.release },
      ...(deps.actor === undefined ? {} : { actor: deps.actor }),
    });
    if (!claim.ok) {
      // Unreachable while the row lock is held; a rollback takes the reservation back.
      await context.db.query('ROLLBACK');
      return { kind: 'not_ready', refusal: claim.reason, detail: claim.detail };
    }
    await context.db.query('COMMIT');
    return { kind: 'claimed', plan, claim: claim.value };
  } catch (error) {
    await context.db.query('ROLLBACK');
    throw error;
  }
}

/**
 * Refuse to run inside a caller's transaction.
 *
 * `SAVEPOINT` is an error outside a transaction block (SQLSTATE 25P01) and a no-op
 * inside one, which makes it the one question PostgreSQL answers directly. A `BEGIN`
 * issued inside a caller's transaction would only warn, and the `COMMIT` after it would
 * commit the caller's work and leave the claim's durability up to whoever called.
 */
async function assertOutsideTransaction(context: RepositoryContext): Promise<void> {
  try {
    await context.db.query('SAVEPOINT fss_dispatch_outside_probe');
  } catch (error) {
    if ((error as { readonly code?: unknown }).code === '25P01') return;
    throw error;
  }
  await context.db.query('RELEASE SAVEPOINT fss_dispatch_outside_probe');
  throw new Error(
    'dispatchOutboundMessage must run outside any transaction: its claim commits before Gmail is called (Appendix B)',
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
  await openStepHold(context, fence, reason);
  return { outcome: 'held', outboundMessageId: fence.id, refusal: reason, ...(detail === undefined ? {} : { detail }) };
}

/** The `active_holds` row a refusal opens, when it opens one (`holdReasonForRefusal`). */
async function openStepHold(
  context: RepositoryContext,
  fence: OutboundFenceRow,
  reason: SendRefusalCode,
): Promise<void> {
  const holdReason = holdReasonForRefusal(reason);
  if (holdReason !== null) {
    await openHold(context, {
      // Firm-scoped: the hold's job is to stop the automation churning on this firm
      // and to be visible, not to stop sends nobody objected to.
      scopeKind: 'firm',
      scopeKey: fence.firmId,
      reasonCode: holdReason,
      blockedActionKinds: ['email_send'],
      sourceEventKind: 'outbound_message',
      sourceEventId: fence.id,
      // `recovery_action` is a closed vocabulary in migration 0001, not free text,
      // because it is what a control offers a person as a *button*. Most of these
      // refusals have no button: a cap and a window lift when time passes, and
      // offering "release" for them would be offering to break the rule.
      // The fence's own `held_reason` carries the detail an operator reads.
      ...(holdReason === 'mailbox_disconnected' || holdReason === 'coverage_incomplete'
        ? { recoveryAction: 'reconnect_mailbox' as const }
        : {}),
    });
  }
}

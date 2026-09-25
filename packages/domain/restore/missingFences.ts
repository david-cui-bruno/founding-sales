import type { RepositoryContext } from '../db/workspaceScope.ts';
import {
  insertSentTombstone,
  readFenceByStepExecution,
  readFenceForSentMessage,
  markPreDispatchFenceSent,
  type SentFolderMessage,
} from '../outbound/index.ts';
import { completeEmailStep, nextUnfinishedExecution } from '../sequences/index.ts';
import { businessDateOf } from '../today/index.ts';

/**
 * Appendix E step 3's missing fences: what one FSS send found in a Sent folder means to
 * the restored database (lane g73).
 *
 * A point-in-time restore loses every write after the restore point, and a send is two
 * things only one of which a restore can lose: the fence, in PostgreSQL, and the message,
 * in Gmail. A send made after the point is therefore a message with no fence, and the
 * sequence step it belonged to is back to pending in the restored copy. Nothing in the
 * sender would stop it going again: the sender's dedupe key is the fence for the step
 * execution (`outbound_messages_one_per_step_execution`, read by
 * `prepareOutboundMessage`), and that fence is exactly what was lost.
 *
 * So each FSS message the Sent-folder scan (`scanSentFolder`) finds is answered here, in
 * one transaction, with one of five outcomes:
 *
 *   * `present` — the restored copy has its fence in a dispatched or terminal state.
 *     The in-doubt ones are the existing reconciliation's (`reconcileOutboundMessage`),
 *     which step 3 runs first; nothing to do.
 *   * `pre_dispatch_marked_sent` — the copy has the fence, but still `prepared` or
 *     `held`: the restore point fell between preparation and dispatch. It is recorded as
 *     sent from Gmail's evidence, or the dispatch path would send it a second time.
 *   * `tombstoned` — no fence, and the send is attributable to exactly one step: the
 *     message's recipient is a route of exactly one live enrollment's contact, that
 *     enrollment belongs to the mailbox's owner, and its next unfinished step is an email
 *     step with no fence. A `sent` fence is inserted for that step under the lost fence's
 *     own id and Message-ID, and the step is completed from the original send instant,
 *     which is what `dispatchPreparedStep` would have done on seeing it sent.
 *   * `unmatched` — no fence, and no live enrollment could send to that recipient at
 *     all: the prospect, or their enrollment, was created after the restore point too.
 *     Nothing in the restored copy can repeat the send, so it is reported and left.
 *   * `unattached` — no fence, and something could send to that recipient, but no single
 *     step can be named: two live enrollments reach the address, the one enrollment's
 *     next step is not an email or already has a fence under another Message-ID, or the
 *     To header is not one readable address. There is no row a
 *     tombstone could hang from without guessing — the table requires an origin — so the
 *     restore report lists it as an unresolved exception and step 9 refuses to release
 *     the restore holds until an operator has dealt with it. Fail closed, never guess.
 *
 * Two lost sends of one enrollment are the ordinary case of the same rule, because the
 * messages are answered oldest first: the first completes its step, which creates the
 * next, and the second finds that next step unfinished and fence-less.
 *
 * The attribution uses the recipient and the mailbox, never the subject or the body, and
 * the marker is what makes the message FSS's in the first place. The recipient is
 * unambiguous in the case that matters: FSS sends to one address, a contact has at most
 * one live enrollment (`sequence_enrollments_one_active_per_contact`), and an
 * enrollment's successor step does not exist until its predecessor completes.
 *
 * Idempotent by construction: a second pass finds each tombstone by its id and answers
 * `present`. See `docs/decisions/g73-missing-fences-are-recovered-from-sent.md`.
 */

/**
 * How far before the restore point the Sent folder is read: Appendix E.3's "restore
 * point minus ten minutes".
 *
 * The folder is dated by Gmail and the fence by PostgreSQL, and the fence is written
 * after the one Gmail call returns. A message Gmail stamped a few seconds before the
 * restore point can therefore belong to a fence whose `sent` the restored copy never saw,
 * or never had at all. Ten minutes covers that gap, the skew between Gmail's clock and
 * the database's, and the up-to-five-minute lag of RDS's latest restorable point behind
 * the instant the operator reads (spec 4.1), with room to spare. Reading earlier costs
 * nothing but metadata reads: every message before the point finds its fence `present`.
 */
export const RESTORE_SENT_SCAN_SKEW_SECONDS = 600;

/** Why a send could not be tied to one step. */
export type UnattachedReason =
  | 'recipient_unreadable'
  | 'several_live_enrollments'
  | 'assignee_not_mailbox_owner'
  | 'no_open_email_step'
  | 'open_step_has_fence';

export type SentMessageRecovery =
  | {
      readonly outcome: 'present';
      readonly outboundMessageId: string;
      readonly state: string;
    }
  | {
      readonly outcome: 'pre_dispatch_marked_sent';
      readonly outboundMessageId: string;
      readonly stepExecutionId: string | null;
      readonly stepCompleted: boolean;
    }
  | {
      readonly outcome: 'tombstoned';
      readonly outboundMessageId: string;
      readonly stepExecutionId: string;
      readonly enrollmentId: string;
      readonly stepCompleted: boolean;
    }
  | { readonly outcome: 'unmatched'; readonly reason: 'no_live_enrollment' }
  | { readonly outcome: 'unattached'; readonly reason: UnattachedReason; readonly firmIds: readonly string[] };

export interface RecoverSentMessageInput {
  readonly mailbox: { readonly id: string; readonly ownerUserId: string };
  readonly message: SentFolderMessage;
  /** Who the ledger says did it. Never a credential. */
  readonly actor?: string | undefined;
}

interface LiveEnrollment {
  readonly id: string;
  readonly firmId: string;
  readonly contactId: string;
  readonly opportunityId: string;
  readonly assignedUserId: string;
}

/**
 * Every live enrollment whose contact has an email route at this address — whatever its
 * eligibility and whoever it is assigned to, because any of them is a sequence that could
 * write to this person again.
 */
async function liveEnrollmentsReaching(context: RepositoryContext, address: string): Promise<readonly LiveEnrollment[]> {
  const { rows } = await context.db.query<{
    id: string;
    firm_id: string;
    contact_id: string;
    opportunity_id: string;
    assigned_user_id: string;
  }>(
    `SELECT DISTINCT n.id, n.firm_id, n.contact_id, n.opportunity_id, n.assigned_user_id
       FROM sequence_enrollments n
       JOIN email_addresses a
         ON a.workspace_id = n.workspace_id AND a.contact_id = n.contact_id
      WHERE n.workspace_id = $1 AND n.ended_at IS NULL AND a.address = $2
      ORDER BY n.id`,
    [context.scope.workspaceId, address],
  );
  return rows.map(row => ({
    id: row.id,
    firmId: row.firm_id,
    contactId: row.contact_id,
    opportunityId: row.opportunity_id,
    assignedUserId: row.assigned_user_id,
  }));
}

/** The contact's route at this address, the one a send would have frozen: live first. */
async function routeAt(
  context: RepositoryContext,
  contactId: string,
  address: string,
): Promise<{ readonly id: string; readonly version: number } | null> {
  const { rows } = await context.db.query<{ id: string; version: number }>(
    `SELECT id, version FROM email_addresses
      WHERE workspace_id = $1 AND contact_id = $2 AND address = $3
      ORDER BY (retired_at IS NULL) DESC, created_at, id
      LIMIT 1`,
    [context.scope.workspaceId, contactId, address],
  );
  const row = rows[0];
  return row === undefined ? null : { id: row.id, version: row.version };
}

/**
 * The holds a pre-dispatch fence opened while it waited — a cap, a window — which its
 * send has made moot. The same statement the dispatch path runs before it re-decides a
 * held fence, and the same exception: a fence in doubt is not this pass's to clear.
 */
async function releaseHoldsOfFence(context: RepositoryContext, outboundMessageId: string): Promise<void> {
  await context.db.query(
    `UPDATE active_holds
        SET released_at = now()
      WHERE workspace_id = $1
        AND source_event_kind = 'outbound_message'
        AND source_event_id = $2
        AND released_at IS NULL
        AND reason_code NOT IN ('send_unknown_reconciling', 'send_unknown_terminal')`,
    [context.scope.workspaceId, outboundMessageId],
  );
}

/** Complete the step a recovered send belongs to, from the instant it left. */
async function completeFromSend(
  context: RepositoryContext,
  stepExecutionId: string,
  sentAt: string,
): Promise<boolean> {
  const completed = await completeEmailStep(context, { stepExecutionId, result: 'sent', at: sentAt });
  return completed.ok;
}

export async function recoverSentFolderMessage(
  context: RepositoryContext,
  input: RecoverSentMessageInput,
): Promise<SentMessageRecovery> {
  const { message, mailbox } = input;
  const fence = await readFenceForSentMessage(context, {
    fenceId: message.fenceId,
    mailboxId: mailbox.id,
    rfcMessageId: message.rfcMessageId,
  });

  if (fence !== null) {
    if (fence.state !== 'prepared' && fence.state !== 'held') {
      return { outcome: 'present', outboundMessageId: fence.id, state: fence.state };
    }
    const marked = await markPreDispatchFenceSent(context, {
      outboundMessageId: fence.id,
      providerMessageId: message.providerMessageId,
      providerThreadId: message.providerThreadId,
      sentAt: message.sentAt,
      ...(input.actor === undefined ? {} : { actor: input.actor }),
    });
    if (!marked.ok) {
      // Something moved it between the read and the claim — a live dispatch, which then
      // owns it. Whatever it became, it is no longer a fence this pass can send twice.
      const reread = await readFenceForSentMessage(context, {
        fenceId: message.fenceId,
        mailboxId: mailbox.id,
        rfcMessageId: message.rfcMessageId,
      });
      return { outcome: 'present', outboundMessageId: fence.id, state: reread?.state ?? fence.state };
    }
    await releaseHoldsOfFence(context, fence.id);
    const stepCompleted =
      fence.stepExecutionId === null ? false : await completeFromSend(context, fence.stepExecutionId, message.sentAt);
    return {
      outcome: 'pre_dispatch_marked_sent',
      outboundMessageId: fence.id,
      stepExecutionId: fence.stepExecutionId,
      stepCompleted,
    };
  }

  // No fence at all: the send happened after the restore point.
  if (message.recipientAddress === null) {
    return { outcome: 'unattached', reason: 'recipient_unreadable', firmIds: [] };
  }
  const recipient = message.recipientAddress;
  const enrollments = await liveEnrollmentsReaching(context, recipient);
  const firmIds = [...new Set(enrollments.map(enrollment => enrollment.firmId))];
  const only = enrollments[0];
  if (only === undefined) return { outcome: 'unmatched', reason: 'no_live_enrollment' };
  if (enrollments.length > 1) return { outcome: 'unattached', reason: 'several_live_enrollments', firmIds };
  if (only.assignedUserId !== mailbox.ownerUserId) {
    return { outcome: 'unattached', reason: 'assignee_not_mailbox_owner', firmIds };
  }

  const execution = await nextUnfinishedExecution(context, only.id);
  if (execution === null || execution.channel !== 'email') {
    return { outcome: 'unattached', reason: 'no_open_email_step', firmIds };
  }
  if ((await readFenceByStepExecution(context, execution.id)) !== null) {
    return { outcome: 'unattached', reason: 'open_step_has_fence', firmIds };
  }

  const route = await routeAt(context, only.contactId, recipient);
  const inserted = await insertSentTombstone(context, {
    fenceId: message.fenceId,
    mailboxId: mailbox.id,
    enrollmentId: only.id,
    stepExecutionId: execution.id,
    firmId: only.firmId,
    contactId: only.contactId,
    opportunityId: only.opportunityId,
    recipientAddress: recipient,
    recipientRouteId: route?.id ?? null,
    recipientRouteVersion: route?.version ?? null,
    subject: message.subject,
    rfcMessageId: message.rfcMessageId,
    providerMessageId: message.providerMessageId,
    providerThreadId: message.providerThreadId,
    sentAt: message.sentAt,
    businessDate: await businessDateOf(context, message.sentAt),
    ...(input.actor === undefined ? {} : { actor: input.actor }),
  });
  if (!inserted.ok) {
    // A racing pass inserted it first: that pass's tombstone is this send's.
    const raced = await readFenceForSentMessage(context, {
      fenceId: message.fenceId,
      mailboxId: mailbox.id,
      rfcMessageId: message.rfcMessageId,
    });
    return { outcome: 'present', outboundMessageId: raced?.id ?? message.fenceId, state: raced?.state ?? 'sent' };
  }
  return {
    outcome: 'tombstoned',
    outboundMessageId: inserted.value.id,
    stepExecutionId: execution.id,
    enrollmentId: only.id,
    stepCompleted: await completeFromSend(context, execution.id, message.sentAt),
  };
}

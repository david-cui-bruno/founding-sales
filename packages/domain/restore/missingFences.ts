import { hasOptOutLink } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import {
  insertSentTombstone,
  readFenceByStepExecution,
  readFenceForSentMessage,
  markPreDispatchFenceSent,
} from '../outbound/fence.ts';
import type { SentFolderMessage } from '../outbound/sentFolder.ts';
import { completeEmailStep } from '../sequences/executions.ts';
import { nextUnfinishedExecution } from '../sequences/rows.ts';
import { businessDateOf } from '../today/snapshots.ts';
import {readMessage,recordMessage} from '../mail/messages.ts';
import {directSendTargetOf,recordMatches} from '../mail/matching.ts';
import {applyDirectSendEffects} from '../mail/effects.ts';
import {readMailbox} from '../mail/mailboxes.ts';
import {readFirm} from '../crm/firms.ts';
import {humanReplySourceIdOfMessageId} from '../outbound/types.ts';
import {lockSendGateForStopFact} from '../policy/sendGate.ts';
import {applyHumanReplyDelivery} from '../replies/delivery.ts';

/**
 * The missing fences after a point-in-time restore: what one FSS send found in a Sent
 * folder means to the restored database (lane g73; `docs/greenfield/runbooks/restore.md`).
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
 *     which `fss admin mailbox reconcile-sent` runs first; nothing to do.
 *   * `pre_dispatch_marked_sent` — the copy has the fence, but still `prepared` or
 *     `held`: the restore point fell between preparation and dispatch. It is recorded as
 *     sent from Gmail's evidence, or the dispatch path would send it a second time. The
 *     bytes it records are the ones Gmail holds when `readSentBytes` can read them —
 *     since lane W3-F the footer is composed at the claim, so a restored body can
 *     predate the rewrite that left — and when they cannot be read the fence is still
 *     marked sent and the recovery reports `sentBytesVerified: false` for the human step.
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
 *     tombstone could hang from without guessing — the table requires an origin — so
 *     `fss admin mailbox reconcile-sent` lists it and refuses to finish until an operator
 *     has dealt with it, and the runbook does not restart the services before then. Fail
 *     closed, never guess.
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
 * How far before the restore point the Sent folder is read: "restore point minus ten
 * minutes" (the runbook's `--since`).
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
  | 'human_reply_unresolved'
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
      /**
       * Whether the bytes now recorded on the fence are the bytes Gmail holds.
       *
       * False when they could not be read — no reader supplied, the grant gone, the body
       * truncated. The fence is still marked `sent`, because the alternative is sending
       * it a second time; what is unresolved is *what it said*, and the restore report
       * lists it for the human step (review of PR 296, P1).
       */
      readonly sentBytesVerified: boolean;
      /**
       * Why they are not, when the reason is not simply that nobody could read them:
       * `optout_link` means Gmail's own bytes carry a visible opt-out link, which
       * `outbound_messages_no_optout_link` refuses (migration 0024). The fence is still
       * marked `sent` — the send happened — with the bytes it already stored.
       */
      readonly sentBytesUnverifiedReason?: 'optout_link' | undefined;
    }
  | {
      readonly outcome: 'tombstoned';
      readonly outboundMessageId: string;
      readonly stepExecutionId: string | null;
      readonly enrollmentId: string | null;
      readonly stepCompleted: boolean;
    }
  | { readonly outcome: 'unmatched'; readonly reason: 'no_live_enrollment' }
  | {
      readonly outcome: 'unattached';
      readonly reason: UnattachedReason;
      readonly firmIds: readonly string[];
      /** The live enrollments that reach the recipient: what a person settles it among. */
      readonly enrollmentIds: readonly string[];
    };

export interface RecoverSentMessageInput {
  readonly mailbox: { readonly id: string; readonly ownerUserId: string };
  readonly message: SentFolderMessage;
  /** Who the ledger says did it. Never a credential. */
  readonly actor?: string | undefined;
  /**
   * Reads the bytes Gmail actually holds for this message
   * (`readSentMessageBytes` in `packages/domain/outbound/sentFolder.ts`).
   *
   * Called for one case only: a fence the restored database still holds as `prepared` or
   * `held`, which is about to be recorded `sent`. Since the footer is composed at the
   * claim, the restored row's body may predate the rewrite that actually went out, so
   * the recovery reads what left and records that. Absent or null, the fence is still
   * marked sent — never twice — and the recovery says its bytes are unverified.
   */
  readonly readSentBytes?: ((message: SentFolderMessage) => Promise<{ readonly body: string } | null>) | undefined;
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
  const humanSourceId = humanReplySourceIdOfMessageId(message.rfcMessageId);
  if(humanSourceId !== null) await lockSendGateForStopFact(context);
  const fence = await readFenceForSentMessage(context, {
    fenceId: message.fenceId,
    mailboxId: mailbox.id,
    rfcMessageId: message.rfcMessageId,
  });

  if (fence !== null) {
    if(humanSourceId !== null && (fence.originKind !== 'draft' || fence.draftId !== humanSourceId || fence.mailboxId !== mailbox.id)) {
      return {outcome:'unattached',reason:'human_reply_unresolved',firmIds:[],enrollmentIds:[]};
    }
    if(fence.originKind === 'draft') await lockSendGateForStopFact(context);
    if (fence.state !== 'prepared' && fence.state !== 'held') {
      return { outcome: 'present', outboundMessageId: fence.id, state: fence.state };
    }
    // What left, when it can be proven. **Both** halves or neither: the scan admits a
    // message with no Subject header, and recording a body Gmail returned beside a
    // subject the restored row happened to hold would be a verified claim about bytes
    // nobody checked (review of PR 296, second round). The subject comes from the
    // metadata the scan already has; the body needs Gmail, and only for this one case.
    const sentSubject = message.subject?.trim() ?? '';
    const actualBody =
      input.readSentBytes === undefined || sentSubject.length === 0 ? null : await input.readSentBytes(message);
    const read = actualBody === null ? undefined : { subject: sentSubject, body: actualBody.body };
    // Bytes this table would refuse are not bytes this pass may record. The fence still
    // becomes `sent`, from what it already stores, and the operator is told why the
    // verified copy was not taken (review of PR 311, second round).
    // The fence is the one that refuses them — it is the guard over that column — and
    // this asks the same question so the report can say *why* the bytes were not taken.
    const refusedBytes = read !== undefined && (hasOptOutLink(read.subject) || hasOptOutLink(read.body));
    const verifiedBytes = read;
    const marked = await markPreDispatchFenceSent(context, {
      outboundMessageId: fence.id,
      providerMessageId: message.providerMessageId,
      providerThreadId: message.providerThreadId,
      sentAt: message.sentAt,
      ...(input.actor === undefined ? {} : { actor: input.actor }),
      ...(verifiedBytes === undefined ? {} : { verifiedBytes }),
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
    if(fence.originKind === 'draft') await applyHumanReplyDelivery(context,fence.id);
    return {
      outcome: 'pre_dispatch_marked_sent',
      outboundMessageId: fence.id,
      stepExecutionId: fence.stepExecutionId,
      stepCompleted,
      sentBytesVerified: verifiedBytes !== undefined && !refusedBytes,
      ...(refusedBytes ? { sentBytesUnverifiedReason: 'optout_link' as const } : {}),
    };
  }

  if(humanSourceId !== null){
    const source=await readMessage(context,humanSourceId),target=source?await directSendTargetOf(context,source.id):undefined;
    const firm=target?await readFirm(context,target.firmId):null;
    const envelope=message.humanReplyEnvelope,mailboxRow=await readMailbox(context,mailbox.id);
    if(!source||source.direction!=='incoming'||source.mailboxId!==mailbox.id||source.providerThreadId!==message.providerThreadId||!target?.contactId||!firm||firm.status!=='active'||firm.assigned_user_id!==mailbox.ownerUserId||!message.recipientAddress||source.headerFrom!==message.recipientAddress||!envelope||envelope.from!==mailboxRow?.emailAddress||envelope.to.length!==1||envelope.to[0]!==message.recipientAddress||envelope.cc.length>10||new Set([...envelope.to,...envelope.cc]).size!==envelope.to.length+envelope.cc.length||envelope.inReplyTo!==source.rfcMessageId){
      return {outcome:'unattached',reason:'human_reply_unresolved',firmIds:firm?[firm.id]:[],enrollmentIds:[]};
    }
    const recipients=[...envelope.to,...envelope.cc];
    const recipientRows=(await context.db.query<{address:string;contact_id:string}>(`SELECT e.address,e.contact_id FROM email_addresses e JOIN contacts c ON c.workspace_id=e.workspace_id AND c.id=e.contact_id AND c.firm_id=e.firm_id WHERE e.workspace_id=$1 AND e.firm_id=$2 AND e.address=ANY($3::text[]) AND e.eligibility<>'retired' AND NOT EXISTS(SELECT 1 FROM mailboxes b WHERE b.workspace_id=e.workspace_id AND b.email_address=e.address)`,[context.scope.workspaceId,firm.id,recipients])).rows;
    if(recipients.some(address=>recipientRows.filter(row=>row.address===address).length!==1))return {outcome:'unattached',reason:'human_reply_unresolved',firmIds:[firm.id],enrollmentIds:[]};
    const route=await routeAt(context,target.contactId,message.recipientAddress);
    const inserted=await insertSentTombstone(context,{draftId:source.id,fenceId:message.fenceId,mailboxId:mailbox.id,firmId:firm.id,contactId:target.contactId,opportunityId:target.opportunityId,recipientAddress:message.recipientAddress,recipientRouteId:route?.id??null,recipientRouteVersion:route?.version??null,subject:message.subject,rfcMessageId:message.rfcMessageId,providerMessageId:message.providerMessageId,providerThreadId:message.providerThreadId,sentAt:message.sentAt,businessDate:await businessDateOf(context,message.sentAt),...(input.actor===undefined?{}:{actor:input.actor})});
    if(!inserted.ok)return {outcome:'unattached',reason:'human_reply_unresolved',firmIds:[firm.id],enrollmentIds:[]};
    const stored=await recordMessage(context,{mailboxId:mailbox.id,metadata:{providerMessageId:message.providerMessageId,providerThreadId:message.providerThreadId,rfcMessageId:message.rfcMessageId.replace(/^<|>$/gu,''),direction:'outgoing',internalDate:message.sentAt,headerFrom:envelope.from,headerTo:envelope.to,headerCc:envelope.cc,subject:message.subject,referenceMessageIds:envelope.referenceIds.slice(0,100),inReplyTo:envelope.inReplyTo,autoSubmitted:null,listId:null,labelIds:['SENT'],attachments:[]}});
    await recordMatches(context,{messageId:stored.message.id,candidates:[target]});
    await applyDirectSendEffects(context,{message:stored.message,candidate:target});
    return {outcome:'tombstoned',outboundMessageId:inserted.value.id,stepExecutionId:null,enrollmentId:null,stepCompleted:false};
  }

  // No fence at all: the send happened after the restore point.
  if (message.recipientAddress === null) {
    return { outcome: 'unattached', reason: 'recipient_unreadable', firmIds: [], enrollmentIds: [] };
  }
  const recipient = message.recipientAddress;
  const enrollments = await liveEnrollmentsReaching(context, recipient);
  const firmIds = [...new Set(enrollments.map(enrollment => enrollment.firmId))];
  const enrollmentIds = enrollments.map(enrollment => enrollment.id);
  const only = enrollments[0];
  if (only === undefined) return { outcome: 'unmatched', reason: 'no_live_enrollment' };
  if (enrollments.length > 1) return { outcome: 'unattached', reason: 'several_live_enrollments', firmIds, enrollmentIds };
  if (only.assignedUserId !== mailbox.ownerUserId) {
    return { outcome: 'unattached', reason: 'assignee_not_mailbox_owner', firmIds, enrollmentIds };
  }

  const execution = await nextUnfinishedExecution(context, only.id);
  if (execution === null || execution.channel !== 'email') {
    return { outcome: 'unattached', reason: 'no_open_email_step', firmIds, enrollmentIds };
  }
  if ((await readFenceByStepExecution(context, execution.id)) !== null) {
    return { outcome: 'unattached', reason: 'open_step_has_fence', firmIds, enrollmentIds };
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

import { recordCrmAuditEvent } from '../crm/audit.ts';
import { decideFirmMutation } from '../crm/authorization.ts';
import { readFirm, setManualControlMode } from '../crm/index.ts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { createCallback } from '../dial/index.ts';
import { listMatches, readMessage } from '../mail/index.ts';
import { recordDaySignal } from '../outbound/ramp.ts';
import { releaseHoldsOfEvent } from '../policy/holds.ts';
import { recordSuppression, type SuppressionJournal } from '../suppression/index.ts';
import { businessDateOf, completeTodayItem } from '../today/index.ts';
import type { ReplyDisposition } from '../src/rules/replyClassification.ts';
import { REPLY_DISPOSITIONS } from '../src/rules/replyClassification.ts';
import { listClassifications, proposedDispositionOf } from './store.ts';
import {
  acceptClassification,
  refuseClassification,
  type ClassificationResult,
} from './types.ts';

/**
 * Confirming or correcting a disposition (specification 8.3, 7.3, 12.4, Appendix A
 * "Confirm disposition", Appendix G 35).
 *
 * This is the other half of the authority boundary. The model may label; a person
 * decides, and this command is what a person deciding looks like. Everything
 * consequential 8.3 lists happens here or not at all:
 *
 * | Consequence | When |
 * |---|---|
 * | The opportunity becomes manual | Always. Every one of the six dispositions is a human reply, and 7.3 says a confirmed human reply sets manual. |
 * | The holds this message opened are released | Always, and only this message's, through `releaseHoldsOfEvent` (4.3: "clearing one hold never clears another"). |
 * | A callback is committed | Only when the person supplied the instant. 12.4 forbids the model committing one, and a "confirm" that silently used the model's proposal would be the model committing it through a person's click. |
 * | A suppression is recorded | Only on the `opt_out` disposition, and only through G4's `recordSuppression`, which writes the object-locked journal first (10.2). |
 * | The opportunity closes | **Never.** 9.1: "Not interested — set manual and suggest Lost; salesperson confirms closure." The result says `suggestsLost`; the stage command is somebody's separate, deliberate click. |
 *
 * ## Why releasing the hold is not "resuming automation"
 *
 * 12.4 forbids the model resuming automation, and this command releases holds. The
 * two do not collide, because the same transaction sets the opportunity to manual:
 * automation is eligible only when the opportunity is automated *and* no applicable
 * hold exists (4.3), so after this command the first clause is false for ever —
 * "automation never reverses manual mode" (7.3). Releasing the hold is what makes
 * `active_holds` honest about an uncertainty that is no longer uncertain, not what
 * lets a sequence run.
 *
 * ## Why an unresolved ambiguity is refused
 *
 * 12.3 resolves an ambiguous message on to one conversation before anything acts on
 * it. A confirmation against one of several plausible opportunities would set the
 * wrong firm to manual and release the wrong holds, and both are the kind of mistake
 * nothing later can tell happened. `ambiguity_unresolved` sends the person to
 * `/messages/resolve-ambiguity` first, which is what the card's `nextAction`
 * already told them.
 */

export interface ReplyConfirmationRow {
  readonly id: string;
  readonly messageId: string;
  readonly firmId: string;
  readonly opportunityId: string;
  readonly disposition: ReplyDisposition;
  readonly suggestedDisposition: ReplyDisposition | null;
  readonly suggestedBy: 'deterministic' | 'model' | 'none';
  readonly corrected: boolean;
  readonly confirmedByUserId: string;
  readonly consequences: readonly string[];
  readonly callbackId: string | null;
  readonly note: string | null;
  readonly createdAt: string;
}

interface ConfirmationDbRow {
  readonly id: string;
  readonly mail_message_id: string;
  readonly firm_id: string;
  readonly opportunity_id: string;
  readonly disposition: ReplyDisposition;
  readonly suggested_disposition: ReplyDisposition | null;
  readonly suggested_by: 'deterministic' | 'model' | 'none';
  readonly corrected: boolean;
  readonly confirmed_by_user_id: string;
  readonly consequences: string[];
  readonly callback_id: string | null;
  readonly note: string | null;
  readonly created_at: Date;
  readonly [column: string]: unknown;
}

const CONFIRMATION_COLUMNS = `id, mail_message_id, firm_id, opportunity_id, disposition,
  suggested_disposition, suggested_by, corrected, confirmed_by_user_id, consequences, callback_id,
  note, created_at`;

function toConfirmation(row: ConfirmationDbRow): ReplyConfirmationRow {
  return {
    id: row.id,
    messageId: row.mail_message_id,
    firmId: row.firm_id,
    opportunityId: row.opportunity_id,
    disposition: row.disposition,
    suggestedDisposition: row.suggested_disposition,
    suggestedBy: row.suggested_by,
    corrected: row.corrected,
    confirmedByUserId: row.confirmed_by_user_id,
    consequences: row.consequences,
    callbackId: row.callback_id,
    note: row.note,
    createdAt: row.created_at.toISOString(),
  };
}

export async function readConfirmation(
  context: RepositoryContext,
  messageId: string,
): Promise<ReplyConfirmationRow | null> {
  const { rows } = await context.db.query<ConfirmationDbRow>(
    `SELECT ${CONFIRMATION_COLUMNS} FROM mail_reply_confirmations
      WHERE workspace_id = $1 AND mail_message_id = $2`,
    [context.scope.workspaceId, messageId],
  );
  const row = rows[0];
  return row === undefined ? null : toConfirmation(row);
}

/** The instant a person typed, with the local wall clock it came from (Appendix D). */
export interface ConfirmedCallback {
  readonly localDate: string;
  readonly localTime?: string | undefined;
  readonly sourceTimeZone: string;
  readonly dueAt: string;
}

export interface ConfirmReplyDispositionInput {
  readonly messageId: string;
  readonly disposition: ReplyDisposition;
  /**
   * The callback the person confirmed. Required for `follow_up_later` when the card
   * carried a proposal, and refused for every other disposition: committing one is a
   * consequence of a person choosing to, not of a model having proposed it.
   */
  readonly callback?: ConfirmedCallback | undefined;
  /**
   * Whether the opt-out covers every kind of contact with the firm, or only the
   * address that wrote. 9.1's do-not-call row draws the same distinction and the
   * person answers it the same way; nothing infers it from the wording.
   */
  readonly firmWideOptOut?: boolean | undefined;
  readonly note?: string | undefined;
  /** 10.2's object-locked journal. Every suppression is written to it before its row. */
  readonly journal: SuppressionJournal;
}

export interface ConfirmReplyDispositionOutcome {
  readonly confirmation: ReplyConfirmationRow;
  /** 9.1: "Not interested — ... suggest Lost; salesperson confirms closure." */
  readonly suggestsLost: boolean;
  readonly releasedHoldIds: readonly string[];
}

export async function confirmReplyDisposition(
  context: RepositoryContext,
  input: ConfirmReplyDispositionInput,
): Promise<ClassificationResult<ConfirmReplyDispositionOutcome>> {
  const actor = context.scope.actor;
  // The boundary, in one line: the worker acts for the system, and the system does
  // not get to confirm anything. `mail_reply_confirmations.confirmed_by_user_id` is
  // NOT NULL and references a membership, so the database refuses it too.
  if (actor.kind !== 'user') return refuseClassification('invalid_input');
  if (!(REPLY_DISPOSITIONS as readonly string[]).includes(input.disposition)) {
    return refuseClassification('invalid_input');
  }

  const message = await readMessage(context, input.messageId);
  if (message === null) return refuseClassification('message_unknown');

  const matches = await listMatches(context, input.messageId);
  if (matches.length === 0) return refuseClassification('message_unknown');
  if (matches.length > 1 && matches.every(match => match.selected === null)) {
    return refuseClassification('ambiguity_unresolved');
  }
  const chosen = matches.find(match => match.selected === true) ?? matches[0];
  if (chosen === undefined) return refuseClassification('message_unknown');

  const firm = await readFirm(context, chosen.firmId);
  if (firm === null) return refuseClassification('message_unknown');
  const permission = decideFirmMutation(context, firm);
  if (!permission.permitted) {
    return refuseClassification(permission.reason === 'not_assigned' ? 'not_assigned' : 'invalid_input');
  }

  if (await readConfirmation(context, input.messageId) !== null) {
    return refuseClassification('already_confirmed');
  }

  const classifications = await listClassifications(context, input.messageId);
  const deterministic = classifications.find(row => row.layer === 'deterministic');
  const model = classifications.find(row => row.layer === 'model');
  if (deterministic === undefined) return refuseClassification('not_classified');
  // The same rule the card used to preselect it, so `corrected` is about what the
  // person was actually shown rather than about what this function would have
  // chosen. See `proposedDispositionOf`.
  const proposal = proposedDispositionOf(deterministic, model);
  const suggestedBy = proposal.by;
  const suggested = proposal.disposition;

  const callback = input.callback;
  if (callback !== undefined && input.disposition !== 'follow_up_later') {
    // A callback on any other disposition would be a date nobody asked for.
    return refuseClassification('callback_not_permitted');
  }
  if (
    callback === undefined &&
    input.disposition === 'follow_up_later' &&
    model?.callbackProposal != null
  ) {
    // The card showed a proposal and the person did not commit an instant. 12.4
    // forbids the model committing one, so the command refuses rather than reading
    // the proposal itself. A person who means "later, no date" clears the proposal
    // on the card and the client sends no callback — which is a different request.
    return refuseClassification('callback_required');
  }

  const consequences: string[] = [];

  // 7.3: a confirmed human reply sets manual. Before anything irreversible, because
  // a manual opportunity is the state in which nothing automated can happen next.
  const manual = await setManualControlMode(context, {
    opportunityId: chosen.opportunityId,
    reason: `confirmed reply disposition: ${input.disposition}`,
  });
  if (!manual.ok) {
    return refuseClassification(manual.reason === 'not_assigned' ? 'not_assigned' : 'invalid_input');
  }
  consequences.push('opportunity_manual');

  let suppressionRecorded: string | null = null;
  if (input.disposition === 'opt_out') {
    // 10.2 and 12.4: an opt-out a person confirmed is as effective as an explicit
    // one. It goes through G4's command, which writes the journal before the row,
    // and it is `prospect_opt_out` rather than `salesperson_manual` because the
    // prospect is who asked — so it is terminal at once and has no ten-minute
    // correction window, which is exactly right for a request from a prospect.
    const address = message.headerFrom;
    if (address === null) return refuseClassification('invalid_input');
    const handle = await recordSuppression(context, {
      scope: 'handle',
      value: address,
      source: 'prospect_opt_out',
      commandId: `reply-confirmation:${input.messageId}:handle`,
      journal: input.journal,
    });
    if (!handle.ok) return refuseClassification('suppression_failed');
    suppressionRecorded = handle.value.eventId;
    consequences.push('handle_suppressed');

    // 12.7's ramp reads the day's opt-outs, and a confirmed `opt_out` is one
    // (lane G15). Counted here rather than inside `recordSuppression`, because most
    // suppressions have no mailbox and no day: an import and a do-not-call from a
    // phone call are not deliverability signals about a mailbox's sending.
    //
    // Once per message, because this whole command is one transaction and
    // `mail_reply_confirmations_one_per_message` refuses the second, so a replay
    // rolls the count back with it.
    await recordDaySignal(context, {
      mailboxId: message.mailboxId,
      businessDate: await businessDateOf(context, message.internalDate),
      signal: 'opt_out',
    });

    if (input.firmWideOptOut === true) {
      const firmWide = await recordSuppression(context, {
        scope: 'firm',
        firmId: chosen.firmId,
        source: 'prospect_opt_out',
        commandId: `reply-confirmation:${input.messageId}:firm`,
        journal: input.journal,
      });
      if (!firmWide.ok) return refuseClassification('suppression_failed');
      consequences.push('firm_suppressed');
    }
  }

  let callbackId: string | null = null;
  if (callback !== undefined) {
    const created = await createCallback(context, {
      firmId: chosen.firmId,
      ...(chosen.contactId === null ? {} : { contactId: chosen.contactId }),
      opportunityId: chosen.opportunityId,
      assignedUserId: firm.assigned_user_id ?? actor.userId,
      localDate: callback.localDate,
      ...(callback.localTime === undefined ? {} : { localTime: callback.localTime }),
      sourceTimeZone: callback.sourceTimeZone,
      dueAt: callback.dueAt,
    });
    if (!created.ok) return refuseClassification('invalid_input');
    callbackId = created.value.id;
    consequences.push('callback_committed');
  }

  // Only the holds this message opened, and only its own reason codes. A pause, a
  // mailbox hold or a suppression review on the same opportunity keeps its hold.
  const released = [
    ...(await releaseHoldsOfEvent(context, { sourceEventId: input.messageId, reasonCode: 'uncertain_reply' })),
    ...(await releaseHoldsOfEvent(context, { sourceEventId: input.messageId, reasonCode: 'ambiguous_match' })),
  ];
  if (released.length > 0) consequences.push('holds_released');

  const completed = await completeReplyItem(context, input.messageId);
  if (completed) consequences.push('today_item_completed');

  const corrected = suggested !== input.disposition;
  const { rows } = await context.db.query<ConfirmationDbRow>(
    `INSERT INTO mail_reply_confirmations
       (workspace_id, mail_message_id, firm_id, opportunity_id, disposition, suggested_disposition,
        suggested_by, corrected, confirmed_by_user_id, consequences, callback_id, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::text[], $11, $12)
     RETURNING ${CONFIRMATION_COLUMNS}`,
    [
      context.scope.workspaceId,
      input.messageId,
      chosen.firmId,
      chosen.opportunityId,
      input.disposition,
      suggested,
      suggestedBy,
      corrected,
      actor.userId,
      consequences,
      callbackId,
      input.note?.trim() === '' ? null : (input.note ?? null),
    ],
  );
  const row = rows[0];
  if (row === undefined) return refuseClassification('invalid_input');

  // 12.4: "A false-positive or corrected classification is audited." Both are: the
  // action name distinguishes them so a drift report can count corrections without
  // reading every row's two disposition columns.
  await recordCrmAuditEvent(context, {
    action: corrected ? 'reply.disposition_corrected' : 'reply.disposition_confirmed',
    subjectKind: 'mail_message',
    subjectId: input.messageId,
    detail: {
      firmId: chosen.firmId,
      opportunityId: chosen.opportunityId,
      disposition: input.disposition,
      suggestedDisposition: suggested,
      suggestedBy,
      modelName: model?.modelName ?? null,
      promptVersion: model?.promptVersion ?? null,
      confidence: model?.confidence ?? null,
      consequences,
      suppressionEventId: suppressionRecorded,
    },
  });

  return acceptClassification({
    confirmation: toConfirmation(row),
    // Suggest, never do. The close is `changeStage`, and it is a separate click.
    suggestsLost: input.disposition === 'not_interested' || input.disposition === 'opt_out',
    releasedHoldIds: released.map(hold => hold.id),
  });
}

/**
 * Finish the reply lane's today item for this message, if it is still open.
 *
 * The key is G6's `reply-message:<id>`, the same string the mail lane's
 * `replyItemKey` writes. It is spelled here rather than imported from
 * `@fss/domain/mail` because this lane reads the item and that lane writes it, and
 * `packages/domain/test/classification/cards.test.ts` compares the two constants so
 * a drift is a failing string comparison rather than a task nobody can close.
 */
async function completeReplyItem(context: RepositoryContext, messageId: string): Promise<boolean> {
  const { rows } = await context.db.query<{ id: string }>(
    `SELECT id FROM today_items
      WHERE workspace_id = $1 AND item_key = $2 AND status IN ('open', 'snoozed')
      ORDER BY snapshot_date DESC
      LIMIT 1`,
    [context.scope.workspaceId, `reply-message:${messageId}`],
  );
  const id = rows[0]?.id;
  if (id === undefined) return false;
  return (await completeTodayItem(context, { itemId: id })) !== null;
}

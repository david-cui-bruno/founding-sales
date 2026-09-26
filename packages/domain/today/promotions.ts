import type { RepositoryContext } from '../db/workspaceScope.ts';
import { businessDateOf, completeTodayItem, upsertTodayItem } from './snapshots.ts';

/**
 * Event-driven promotion (specification 8.2, Appendix A).
 *
 * "Event-driven reply and callback promotions commit with their source event."
 *
 * There are two shapes of hook here, and the difference is which lane owns the file
 * the event is written in.
 *
 * **Callbacks are a trigger.** `callbacks_today_promotion` in migration 0008 fires
 * inside G4's `createCallback` transaction. Nothing in this package is called and
 * nothing in G4's package knows Today exists; the promotion commits with the callback
 * or not at all, which is the whole of the sentence above. The Today tests prove it by
 * rolling the callback back and finding no entry.
 *
 * **Replies are `promoteReply`**, called in the same transaction as the message and
 * its holds — Appendix A's "Record uncertain or ambiguous reply" row commits "message,
 * candidates, independent active holds, Today entries, audit" together, and this is
 * the fourth of those. A deterministic `item_key` means a replayed command or a
 * handler run twice produces one task rather than two — the upsert's key, not this
 * function's care.
 */

export interface PromoteReplyInput {
  readonly firmId: string;
  readonly contactId?: string | undefined;
  /** The message the reply arrived as. Its id is the task's identity. */
  readonly messageId: string;
  /** Database time, or the instant the message arrived. The reply lane sorts on it. */
  readonly receivedAt: string;
}

/**
 * The reply lane's promotion, named (8.2, 8.3).
 *
 * "A firm-wide reply hides canceled automated work and presents the contact
 * conversations that require action." The hiding is the cancellation G7 performs on
 * the enrollments; what this does is put the firm in lane 1, which by precedence is
 * ahead of every callback, every due send and every new firm on the card.
 *
 * Uncertain and ambiguous messages use this too. 8.2 says lane 1 is "Replies,
 * including uncertain and ambiguous messages", so there is deliberately no second
 * kind for them: the card's classification content is 8.3's, and it arrives with the
 * classification lane. The lane and the shell are here.
 */
export async function promoteReply(context: RepositoryContext, input: PromoteReplyInput): Promise<string> {
  return await upsertTodayItem(context, {
    businessDate: await businessDateOf(context, input.receivedAt),
    firmId: input.firmId,
    ...(input.contactId === undefined ? {} : { contactId: input.contactId }),
    itemKey: `reply-message:${input.messageId}`,
    kind: 'reply',
    dueAt: input.receivedAt,
    sourceKind: 'reply_message',
  });
}

export { completeTodayItem };

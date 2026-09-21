import type { RepositoryContext } from '../db/workspaceScope.ts';
import { fenceForOutgoingMessage } from '../outbound/fence.ts';
import { countDirectSend, effectiveDailyCap, ensureRamp } from '../outbound/ramp.ts';
import type { SuppressionJournal } from '../suppression/index.ts';
import { businessDateOf } from '../today/snapshots.ts';
import { classifyReply } from '../src/rules/replyClassification.ts';
import {
  applyClassificationEffects,
  applyDirectSendEffects,
  recordDeterministicClassification,
} from './effects.ts';
import type { EnvelopeCipher } from './envelope.ts';
import type { GmailAccessGrant, GmailClient, GmailOAuthConfig } from './gmailClient.ts';
import { findMatchCandidates, recordMatches } from './matching.ts';
import { normalizeMetadata, recordMessage, storeMessageBody } from './messages.ts';
import type { ReplyPromoter } from './replyLane.ts';
import { METADATA_HEADERS, type MailMessageRow, type MailboxRow } from './types.ts';

/**
 * What happens to one batch of Gmail message ids, whichever job found them
 * (specification 12.3, 12.4).
 *
 * `mail.sync` finds ids by reading history from the cursor and `mail.recover` finds
 * them by listing a bounded interval, and from that point on the two are the same
 * four steps: metadata with the allowlist, match, a body only if it matched, then the
 * deterministic effects. Sharing the body rather than the call sites is deliberate —
 * "fetches a body only after a plausible FSS match" is the rule most easily broken by
 * a second copy of the loop, and there is only one copy.
 */

export interface MessagePipelineDeps {
  readonly gmail: GmailClient;
  readonly oauth: GmailOAuthConfig;
  readonly cipher: EnvelopeCipher;
  readonly journal: SuppressionJournal;
  readonly replyPromoter: ReplyPromoter;
}

export interface MessagePipelineReport {
  readonly messagesSeen: number;
  readonly messagesRecorded: number;
  readonly bodiesFetched: number;
  readonly matched: number;
  readonly ambiguous: number;
  readonly holdsOpened: number;
  readonly suppressionsRecorded: number;
  readonly directSendsSwitchedToManual: number;
  /** Outgoing messages counted against 12.7's operational headroom (lane G15). */
  readonly directSendsCounted: number;
  /** Outgoing messages this import matched to a fence FSS had already counted. */
  readonly automatedSendsRecognised: number;
  /** The newest `internalDate` seen, which is what a coverage watermark may claim. */
  readonly newestInternalDate: string | null;
}

export const EMPTY_PIPELINE_REPORT: MessagePipelineReport = Object.freeze({
  messagesSeen: 0,
  messagesRecorded: 0,
  bodiesFetched: 0,
  matched: 0,
  ambiguous: 0,
  holdsOpened: 0,
  suppressionsRecorded: 0,
  directSendsSwitchedToManual: 0,
  directSendsCounted: 0,
  automatedSendsRecognised: 0,
  newestInternalDate: null,
});

/**
 * Count one imported outgoing message against 12.7's operational headroom (lane G15).
 *
 * "All outgoing Gmail messages, including direct sends, count toward operational
 * headroom. Automated capacity is conservatively reserved so sync lag cannot approach
 * Google's account ceiling." `countDirectSend` is the `direct_sent` column and it is
 * deliberately *not* the automated cap: the cap is FSS's own restraint and a person
 * writing their own email is not FSS.
 *
 * A message with a fence is one FSS sent, and `countAutomatedSend` counted it before
 * it left. Counting it here as well would double every sequence email in the day's
 * headroom, so the fence lookup is the guard and `stored.inserted` is the other half:
 * a duplicate push or a recovery pass re-reading the same id inserts no message row
 * and therefore counts nothing.
 *
 * Returns whether it counted, for the report.
 */
async function countOutgoingAgainstHeadroom(
  context: RepositoryContext,
  message: MailMessageRow,
): Promise<boolean> {
  const fenceId = await fenceForOutgoingMessage(context, {
    mailboxId: message.mailboxId,
    rfcMessageId: message.rfcMessageId,
    providerMessageId: message.providerMessageId,
  });
  if (fenceId !== null) return false;
  const ramp = await ensureRamp(context, message.mailboxId);
  await countDirectSend(context, {
    mailboxId: message.mailboxId,
    businessDate: await businessDateOf(context, message.internalDate),
    cap: effectiveDailyCap(ramp),
  });
  return true;
}

export async function processMessageIds(
  context: RepositoryContext,
  deps: MessagePipelineDeps,
  input: {
    readonly mailbox: MailboxRow;
    readonly access: GmailAccessGrant;
    readonly messageIds: readonly string[];
  },
): Promise<MessagePipelineReport> {
  let messagesSeen = 0;
  let messagesRecorded = 0;
  let bodiesFetched = 0;
  let matched = 0;
  let ambiguous = 0;
  let holdsOpened = 0;
  let suppressionsRecorded = 0;
  let directSendsSwitchedToManual = 0;
  let directSendsCounted = 0;
  let automatedSendsRecognised = 0;
  let newestInternalDate: string | null = null;

  for (const providerMessageId of input.messageIds) {
    // Step 1: metadata only, and only the allowlist (12.3).
    const metadata = await deps.gmail.getMetadata(input.access, providerMessageId, METADATA_HEADERS);
    // A message that vanished between the listing and the read is gone rather than
    // broken: Gmail deletions are real, and the next listing will not mention it.
    if (metadata === null) continue;
    messagesSeen += 1;

    const normalized = normalizeMetadata(metadata);
    const stored = await recordMessage(context, { mailboxId: input.mailbox.id, metadata: normalized });
    if (stored.inserted) messagesRecorded += 1;
    if (newestInternalDate === null || stored.message.internalDate > newestInternalDate) {
      newestInternalDate = stored.message.internalDate;
    }

    // 12.7: "All outgoing Gmail messages, including direct sends, count toward
    // operational headroom." Before the match, because the headroom is a fact about
    // the mailbox and an outgoing message nobody could match still left the account.
    if (stored.message.direction === 'outgoing' && stored.inserted) {
      if (await countOutgoingAgainstHeadroom(context, stored.message)) directSendsCounted += 1;
    }

    // Step 2: match, in 12.3's order, first rule that finds anything winning.
    const candidates = await findMatchCandidates(context, {
      mailboxId: input.mailbox.id,
      messageId: stored.message.id,
      metadata: normalized,
    });
    if (candidates.length === 0) continue;

    const matches = await recordMatches(context, { messageId: stored.message.id, candidates });
    matched += 1;
    if (matches.ambiguous) ambiguous += 1;
    holdsOpened += matches.holdIds.length;

    if (stored.message.direction === 'outgoing') {
      // 12.2 and Appendix G 19, and the fence lookup the comment here used to promise
      // (lane G15). 7.3 makes a *direct* Gmail send enter manual mode; a sequence step
      // FSS sent itself is not one, and switching its own opportunity to manual would
      // terminally stop the enrollment that had just sent step one.
      const fenceId = await fenceForOutgoingMessage(context, {
        mailboxId: input.mailbox.id,
        rfcMessageId: stored.message.rfcMessageId,
        providerMessageId: stored.message.providerMessageId,
      });
      if (fenceId === null) {
        const outcome = await applyDirectSendEffects(context, { message: stored.message, candidates });
        directSendsSwitchedToManual += outcome.switchedToManual.length;
      } else {
        automatedSendsRecognised += 1;
      }
      continue;
    }

    // Step 3: now, and only now, a body.
    const body = await deps.gmail.getBody(input.access, providerMessageId);
    if (body !== null) {
      bodiesFetched += 1;
      await storeMessageBody(context, {
        messageId: stored.message.id,
        text: body.text,
        truncated: body.truncated,
      });
    }

    // Step 4: the deterministic classification and its effects. The LLM layer is
    // G7b's and writes a second row; nothing here reads it.
    const classification = classifyReply({
      id: stored.message.id,
      headers: {
        ...(normalized.autoSubmitted === null ? {} : { autoSubmitted: normalized.autoSubmitted }),
        ...(normalized.listId === null ? {} : { listId: normalized.listId }),
        ...(normalized.headerFrom === null ? {} : { from: normalized.headerFrom }),
        ...(normalized.subject === null ? {} : { subject: normalized.subject }),
      },
      bodyParts: body === null ? [] : [{ text: body.text, truncated: body.truncated }],
    });
    await recordDeterministicClassification(context, { messageId: stored.message.id, classification });
    const applied = await applyClassificationEffects(context, {
      message: stored.message,
      classification,
      candidates,
      journal: deps.journal,
      replyPromoter: deps.replyPromoter,
    });
    holdsOpened += applied.holdIds.length;
    suppressionsRecorded += applied.suppressionEventIds.length;
  }

  return {
    messagesSeen,
    messagesRecorded,
    bodiesFetched,
    matched,
    ambiguous,
    holdsOpened,
    suppressionsRecorded,
    directSendsSwitchedToManual,
    directSendsCounted,
    automatedSendsRecognised,
    newestInternalDate,
  };
}

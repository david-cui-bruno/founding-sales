import type { RepositoryContext } from '../db/workspaceScope.ts';
import { fenceForOutgoingMessage } from '../outbound/fence.ts';
import type { SuppressionJournal } from '../suppression/journal.ts';
import { classifyReply } from '../src/rules/replyClassification.ts';
import {
  applyClassificationEffects,
  applyDirectSendEffects,
  recordDeterministicClassification,
} from './effects.ts';
import type { EnvelopeCipher } from './envelope.ts';
import type { GmailAccessGrant, GmailClient, GmailOAuthConfig } from './gmailClient.ts';
import { directSendTargetOf, findMatchCandidates, recordMatchesForImport } from './matching.ts';
import { normalizeMetadata, recordMessage, storeMessageBody } from './messages.ts';
import type { ReplyPromoter } from './replyLane.ts';
import { METADATA_HEADERS, type MailboxRow, type MailMessageRow } from './types.ts';

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
  /**
   * Direct Gmail sends recorded as an update to the conversation (send-path v2). Not a
   * count of opportunities made manual: a direct send no longer makes one manual.
   */
  readonly directSendsRecorded: number;
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
  directSendsRecorded: 0,
  automatedSendsRecognised: 0,
  newestInternalDate: null,
});

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
  let directSendsRecorded = 0;
  let automatedSendsRecognised = 0;
  let newestInternalDate: string | null = null;

  // ---- The network phase: every Gmail call this batch makes, before any send gate. --
  //
  // Send-path v2, S1 review round 5: the runner keeps the whole job in one transaction,
  // and the gated section below takes the workspace's EXCLUSIVE send gate (a direct
  // send's freeze and effect, an ambiguity hold, a classification effect). A Gmail call
  // made after that — the next message's metadata, a body — would hold every dispatch
  // claim and every stop writer in the workspace for as long as Gmail took to answer.
  // So the calls happen first, in the same order and number as before: metadata for
  // each message, then its body exactly when a match is plausible. Nothing in this
  // phase takes the gate — recording the message and reading its candidates do not.
  //
  // "Plausible" is judged here before the gated phase records any match, so a message
  // whose only match would come from an earlier message *of this batch* — the same
  // thread, or a reference to one of its outgoing messages — is counted as plausible
  // from the batch itself. That is a superset of what the gated phase will find, so
  // every body it needs is already fetched; a body fetched for a message the gated
  // phase then does not match is not stored.
  const fetched: {
    readonly normalized: ReturnType<typeof normalizeMetadata>;
    readonly message: MailMessageRow;
    readonly body: Awaited<ReturnType<GmailClient['getBody']>>;
  }[] = [];
  const plausibleThreads = new Set<string>();
  const plausibleOutgoingIds = new Set<string>();
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

    const known = await findMatchCandidates(context, {
      mailboxId: input.mailbox.id,
      messageId: stored.message.id,
      metadata: normalized,
    });
    const plausible =
      known.length > 0 ||
      plausibleThreads.has(stored.message.providerThreadId) ||
      stored.message.referenceMessageIds.some(reference => plausibleOutgoingIds.has(reference));
    if (plausible) {
      plausibleThreads.add(stored.message.providerThreadId);
      if (stored.message.direction === 'outgoing' && stored.message.rfcMessageId !== null) {
        plausibleOutgoingIds.add(stored.message.rfcMessageId);
      }
    }
    // Step 3's fetch, done here: a body only after a plausible match, and never for an
    // outgoing message (12.3 matches it, it does not read it).
    const body =
      plausible && stored.message.direction === 'incoming'
        ? await deps.gmail.getBody(input.access, providerMessageId)
        : null;
    fetched.push({ normalized, message: stored.message, body });
  }

  // ---- The gated phase: matching, effects, classification. No Gmail call below. ---
  for (const { normalized, message: storedMessage, body } of fetched) {
    const stored = { message: storedMessage };
    // Step 2: match, in 12.3's order, first rule that finds anything winning.
    const candidates = await findMatchCandidates(context, {
      mailboxId: input.mailbox.id,
      messageId: stored.message.id,
      metadata: normalized,
    });
    if (candidates.length === 0) continue;

    // An outgoing message is FSS's own send when a fence names it. One that is not — the
    // salesperson's direct send — has its To/Cc checked against the rule that matched it
    // before the match is recorded, so a recipient at another firm makes the match
    // ambiguous rather than updating the wrong conversation (S1 review, P1-1).
    let fenceId: string | null = null;
    if (stored.message.direction === 'outgoing') {
      fenceId = await fenceForOutgoingMessage(context, {
        mailboxId: input.mailbox.id,
        rfcMessageId: stored.message.rfcMessageId,
        providerMessageId: stored.message.providerMessageId,
      });
    }

    // Once the direct-send effect has been applied — either marker — the message's
    // candidate set is frozen (P1-D); the gate is taken before the marker is read (P1-H).
    const matches = await recordMatchesForImport(context, {
      messageId: stored.message.id,
      candidates,
      metadata: normalized,
      directSend: stored.message.direction === 'outgoing' && fenceId === null,
    });
    if (matches.frozen) {
      matched += 1;
      continue;
    }
    matched += 1;
    if (matches.ambiguous) ambiguous += 1;
    holdsOpened += matches.holdIds.length;

    if (stored.message.direction === 'outgoing') {
      // A *direct* Gmail send is an update to the conversation (send-path v2); a
      // sequence step FSS sent itself is not one, and is recognised by its fence.
      if (fenceId === null) {
        // Only a match resolved to one opportunity, and the *stored* match set decides
        // (S1 review P1-A): a replay may find fewer candidates than the first import did
        // — an address retired since — but an ambiguity a person has not resolved is
        // still unresolved, and applying the effect to the one candidate left would
        // spend the message's once-only marker on a firm nobody chose. So: a stored
        // selection is the firm; one stored, unambiguous match is the firm; anything
        // else waits for `resolveAmbiguity`, which applies it to the one selected.
        const only = await directSendTargetOf(context, stored.message.id);
        if (only !== undefined) {
          const outcome = await applyDirectSendEffects(context, { message: stored.message, candidate: only });
          if (outcome.recorded) directSendsRecorded += 1;
        }
      } else {
        automatedSendsRecognised += 1;
      }
      continue;
    }

    // Step 3: the body the network phase fetched, stored now that the match is recorded.
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
    directSendsRecorded,
    automatedSendsRecognised,
    newestInternalDate,
  };
}

import type { GmailMessageMetadata } from './gmailClient.ts';
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
import { headerValue, type GmailAccessGrant, type GmailClient, type GmailOAuthConfig,type GmailIncidentMetadata } from './gmailClient.ts';
import type { MailLog } from './log.ts';
import { directSendTargetOf, findMatchCandidates, recordMatchesForImport } from './matching.ts';
import { normalizeMetadata, recordMessage, storeMessageBody } from './messages.ts';
import type { ReplyPromoter } from './replyLane.ts';
import { METADATA_HEADERS, type MailboxRow } from './types.ts';
import { GmailClientError } from './gmailClient.ts';

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
 *
 * **A failed Gmail read stops the batch; it does not throw** (send-path v2, S1 review
 * round 7). The job runner keeps the whole job in one transaction, so a throw for
 * message N would roll back what messages 1 to N-1 wrote — a direct send's consumed
 * follow-up permission and ended enrollments among them — and release the send gate
 * with the fulfilled follow-up still claimable until the retry. So the loop stops at N
 * and reports how many leading ids it finished (`processedMessages`) and which read
 * failed (`readFailure`). `mail.sync` moves its cursor only to just before N, the job
 * commits 1 to N-1, and N remains unread. Both sync and recovery persist the coded
 * incident with this prefix. A verified transient deadline permits a fresh read;
 * unknown evidence stays held. Recovery uses the recorded rows as its position and
 * never claims complete coverage from the interrupted batch.
 *
 * **An RFC Message-ID collision never raises** (C2B-A1): `recordMessage` returns a proven
 * duplicate as the recorded message, whose effects are not run again, and records any
 * other colliding message without the id, which this loop then processes on its own
 * metadata. What N itself wrote before its body read failed is undone by a savepoint, so N
 * is retried whole. Only a Gmail read is caught: a database error still throws, and the
 * runner still rolls the job back.
 */

export type BusinessMailMetadataReceipt={readonly ok:true;readonly conversationId:string}|{readonly ok:false;readonly reason:'outside_review_window'|'metadata_deleted'|'metadata_observation_unavailable'};
export interface BusinessMailMetadataObserver {
  observe(context: RepositoryContext, input: { readonly mailboxId:string; readonly ownerUserId:string; readonly providerAccountId:string; readonly generation:number; readonly metadata:GmailMessageMetadata; readonly acquisitionOrigin?:{readonly importId:string} }):Promise<void|BusinessMailMetadataReceipt>;
}
export interface MessagePipelineDeps {
  /** Absent in production; the observation carries the run's captured binding. */
  readonly businessMailObserver?:BusinessMailMetadataObserver|undefined;
  readonly gmail: GmailClient;
  readonly oauth: GmailOAuthConfig;
  readonly cipher: EnvelopeCipher;
  readonly journal: SuppressionJournal;
  readonly replyPromoter: ReplyPromoter;
  /** Where an RFC Message-ID conflict is logged. Stdout unless a test records it. */
  readonly log?: MailLog | undefined;
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
  /**
   * Second copies of a message already recorded under the same RFC Message-ID, proven
   * the same message (direction, From, Subject, `Date`): treated as recorded, no effect
   * re-run.
   */
  readonly duplicateRfcId: number;
  /**
   * Messages whose RFC Message-ID another, different message in the mailbox already
   * holds: recorded without it and processed as new, with their own metadata.
   */
  readonly rfcIdConflicts: number;
  /**
   * Ids whose metadata read found no message: deleted between the listing (or history
   * page) and the read. Processed, and gone.
   */
  readonly vanishedMessages: number;
  /** The newest `internalDate` seen, which is what a coverage watermark may claim. */
  readonly newestInternalDate: string | null;
  /**
   * How many of the input's ids, from the front, were finished. Equal to the input's
   * length unless a Gmail read failed; then it is the failed message's index, and no id
   * at or after it was processed.
   */
  readonly processedMessages: number;
  /** The Gmail read that stopped the batch, or null when every id was processed. */
  readonly readFailure: PipelineReadFailure | null;
}

export interface PipelineReadFailure {
  readonly incident?: GmailIncidentMetadata | undefined;
  readonly providerMessageId: string;
  readonly read: 'metadata' | 'body';
  /** Bounded, and never the client's message text: a code and a status, nothing else. */
  readonly detail: string;
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
  duplicateRfcId: 0,
  rfcIdConflicts: 0,
  vanishedMessages: 0,
  newestInternalDate: null,
  processedMessages: 0,
  readFailure: null,
});

type GmailRead<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly detail: string;readonly incident?:GmailIncidentMetadata|undefined };

/** A Gmail read, with a throw turned into a value the loop can stop on. */
async function gmailRead<T>(read: () => Promise<T>): Promise<GmailRead<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    if (error instanceof GmailClientError) {
      return { ok: false, detail: error.status === undefined ? error.code : `${error.code} ${String(error.status)}`,...(error.incident===undefined?{}:{incident:error.incident}) };
    }
    return { ok: false, detail: 'unexpected' };
  }
}

const MESSAGE_SAVEPOINT = 'mail_pipeline_message';

/** The duplicate-proof read failed; the message stops the batch as a failed metadata read. */
class ProofReadFailed extends Error {
  constructor(readonly detail: string,readonly incident?:GmailIncidentMetadata) {
    super('the duplicate-proof metadata read failed');
  }
}

/**
 * A savepoint for one message's writes, or false outside a transaction — only a test
 * calling the domain directly on an autocommit session — where each statement is its
 * own and there is nothing to undo. The pattern is `research/enqueue.ts`'s.
 */
async function openMessageSavepoint(context: RepositoryContext): Promise<boolean> {
  try {
    await context.db.query(`SAVEPOINT ${MESSAGE_SAVEPOINT}`);
    return true;
  } catch (error) {
    // 25P01 no_active_sql_transaction: not inside a transaction block.
    if ((error as { code?: string }).code !== '25P01') throw error;
    return false;
  }
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
  let directSendsRecorded = 0;
  let automatedSendsRecognised = 0;
  let duplicateRfcId = 0;
  let rfcIdConflicts = 0;
  let vanishedMessages = 0;
  let newestInternalDate: string | null = null;

  let processedMessages = 0;
  let readFailure: PipelineReadFailure | null = null;
  const completedMetadata: GmailMessageMetadata[]=[];

  for (const [index, providerMessageId] of input.messageIds.entries()) {
    // Step 1: metadata only, and only the allowlist (12.3).
    const metadataRead = await gmailRead(() =>
      deps.gmail.getMetadata(input.access, providerMessageId, METADATA_HEADERS),
    );
    if (!metadataRead.ok) {
      readFailure = { providerMessageId, read: 'metadata', detail: metadataRead.detail,...(metadataRead.incident===undefined?{}:{incident:metadataRead.incident}) };
      break;
    }
    const metadata = metadataRead.value;
    // A message that vanished between the listing and the read is gone rather than
    // broken: Gmail deletions are real, and the next listing will not mention it.
    if (metadata === null) {
      vanishedMessages += 1;
      processedMessages = index + 1;
      continue;
    }

    // The counters are the ones the report returns, so they are kept per message and
    // only added once the message is finished: a message undone by its savepoint was
    // not seen, recorded or matched as far as this run's report is concerned.
    const before = {
      messagesSeen,
      messagesRecorded,
      bodiesFetched,
      matched,
      ambiguous,
      holdsOpened,
      suppressionsRecorded,
      directSendsRecorded,
      automatedSendsRecognised,
      duplicateRfcId,
      rfcIdConflicts,
      newestInternalDate,
    };
    const nested = await openMessageSavepoint(context);
    const step = await (async (): Promise<
      'done' | { readonly ok: false; readonly read: 'metadata' | 'body'; readonly detail: string;readonly incident?:GmailIncidentMetadata|undefined }
    > => {
      messagesSeen += 1;

      const normalized = normalizeMetadata(metadata);
      let stored;
      try {
        stored = await recordMessage(context, {
          mailboxId: input.mailbox.id,
          metadata: normalized,
          // An RFC Message-ID collision is a proven duplicate only if the other message's
          // `Date` header is this one's too. The table keeps no `Date`, so the other
          // message's metadata is read again, with the same allowlist; a message Gmail no
          // longer has proves nothing. The read goes through `gmailRead` (fold 2): a
          // failure is this message's stopped read, like any other, so `mail.sync`
          // commits the prefix before it and `mail.recover` takes its whole-job retry.
          sameDateAs: async existing => {
            const other = await gmailRead(() =>
              deps.gmail.getMetadata(input.access, existing.providerMessageId, METADATA_HEADERS),
            );
            if (!other.ok) throw new ProofReadFailed(other.detail,other.incident);
            const mine = headerValue(metadata.headers, 'Date')?.trim();
            const theirs = other.value === null ? undefined : headerValue(other.value.headers, 'Date')?.trim();
            return mine !== undefined && mine !== '' && mine === theirs;
          },
          ...(deps.log === undefined ? {} : { log: deps.log }),
        });
      } catch (error) {
        if (error instanceof ProofReadFailed) return { ok: false, read: 'metadata', detail: error.detail,...(error.incident===undefined?{}:{incident:error.incident}) };
        throw error;
      }
      if (stored.inserted) messagesRecorded += 1;
      // Read through a local: the closure's view of the outer `let` is narrowed to its
      // initialiser, and a comparison against it would not type-check.
      const newestSoFar = newestInternalDate as string | null;
      if (newestSoFar === null || normalized.internalDate > newestSoFar) {
        newestInternalDate = normalized.internalDate;
      }
      // A proven second copy of a recorded message is that message: nothing is matched,
      // classified or applied again.
      if (stored.outcome === 'duplicate_rfc_id') {
        duplicateRfcId += 1;
        return 'done';
      }
      // A conflict was recorded as its own row, without the RFC Message-ID another
      // message holds; from here on it is processed as the new message it is, on its own
      // metadata: `stored.message` is its row, and its own RFC Message-ID is below.
      if (stored.outcome === 'rfc_id_conflict') rfcIdConflicts += 1;

      // Step 2: match, in 12.3's order, first rule that finds anything winning.
      const candidates = await findMatchCandidates(context, {
        mailboxId: input.mailbox.id,
        messageId: stored.message.id,
        metadata: normalized,
      });
      if (candidates.length === 0) return 'done';

      // An outgoing message is FSS's own send when a fence names it. One that is not — the
      // salesperson's direct send — has its To/Cc checked against the rule that matched it
      // before the match is recorded, so a recipient at another firm makes the match
      // ambiguous rather than updating the wrong conversation (S1 review, P1-1).
      let fenceId: string | null = null;
      if (stored.message.direction === 'outgoing') {
        fenceId = await fenceForOutgoingMessage(context, {
          mailboxId: input.mailbox.id,
          // The stored row's Message-ID (fold 2): a conflict's row holds none, so a
          // conflict — first import or replay — is looked up by its own Gmail id only and
          // can never inherit the fence of the message that owns the colliding id.
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
        return 'done';
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
            // Only an active meeting draft needs outgoing content to prove fulfillment.
            // Other outgoing mail retains the existing metadata-only import behavior.
            const meetingDraft = (await context.db.query(`SELECT p.id FROM meeting_follow_through p
              WHERE p.workspace_id=$1 AND p.firm_id=$2 AND p.status NOT IN ('cancelled','completed')
              AND p.created_at<=$3 LIMIT 1`, [context.scope.workspaceId,only.firmId,stored.message.internalDate])).rows[0];
            if (meetingDraft !== undefined) {
              const read = await gmailRead(() => deps.gmail.getBody(input.access,providerMessageId));
              if (!read.ok) return { ok:false,read:'body',detail:read.detail };
              if (read.value !== null) {
                bodiesFetched += 1;
                await storeMessageBody(context,{messageId:stored.message.id,text:read.value.text,truncated:read.value.truncated});
              }
            }
            const outcome = await applyDirectSendEffects(context, { message: stored.message, candidate: only });
            if (outcome.recorded) directSendsRecorded += 1;
          }
        } else {
          automatedSendsRecognised += 1;
        }
        return 'done';
      }

      // Step 3: now, and only now, a body.
      const bodyRead = await gmailRead(() => deps.gmail.getBody(input.access, providerMessageId));
      if (!bodyRead.ok) return { ok: false, read: 'body', detail: bodyRead.detail,...(bodyRead.incident===undefined?{}:{incident:bodyRead.incident}) };
      const body = bodyRead.value;
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
      return 'done';
    })();
    if (step !== 'done') {
      // The body read failed after this message's metadata was recorded and matched.
      // Undo exactly that, so the next run reads the message whole, and stop here.
      if (nested) {
        await context.db.query(`ROLLBACK TO SAVEPOINT ${MESSAGE_SAVEPOINT}`);
        await context.db.query(`RELEASE SAVEPOINT ${MESSAGE_SAVEPOINT}`);
      }
      ({
        messagesSeen,
        messagesRecorded,
        bodiesFetched,
        matched,
        ambiguous,
        holdsOpened,
        suppressionsRecorded,
        directSendsRecorded,
        automatedSendsRecognised,
        duplicateRfcId,
        rfcIdConflicts,
        newestInternalDate,
      } = before);
      readFailure = { providerMessageId, read: step.read, detail: step.detail,...(step.incident===undefined?{}:{incident:step.incident}) };
      break;
    }
    if (nested) await context.db.query(`RELEASE SAVEPOINT ${MESSAGE_SAVEPOINT}`);
    processedMessages = index + 1;
    if(metadata.id===providerMessageId) completedMetadata.push(metadata);
  }

  // Publish metadata observations only after the operational prefix has acquired its locks.
  // Failed messages never enter this list; bodies and effects keep their original savepoints.
  for(const metadata of completedMetadata) {
    if(deps.businessMailObserver && input.mailbox.providerAccountId!==null) await deps.businessMailObserver.observe(context,{mailboxId:input.mailbox.id,ownerUserId:input.mailbox.ownerUserId,providerAccountId:input.mailbox.providerAccountId,generation:input.mailbox.generation,metadata});
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
    duplicateRfcId,
    rfcIdConflicts,
    vanishedMessages,
    newestInternalDate,
    processedMessages,
    readFailure,
  };
}

/**
 * Two consecutive batches' reports as one: counts add, the newest date is the later,
 * and the processed prefix and any read failure are the second batch's on top of the
 * first's. Used by a recovery that processes its ids in budgeted slices.
 */
export function combinePipelineReports(
  first: MessagePipelineReport,
  second: MessagePipelineReport,
): MessagePipelineReport {
  const newest =
    first.newestInternalDate === null
      ? second.newestInternalDate
      : second.newestInternalDate === null || first.newestInternalDate > second.newestInternalDate
        ? first.newestInternalDate
        : second.newestInternalDate;
  return {
    messagesSeen: first.messagesSeen + second.messagesSeen,
    messagesRecorded: first.messagesRecorded + second.messagesRecorded,
    bodiesFetched: first.bodiesFetched + second.bodiesFetched,
    matched: first.matched + second.matched,
    ambiguous: first.ambiguous + second.ambiguous,
    holdsOpened: first.holdsOpened + second.holdsOpened,
    suppressionsRecorded: first.suppressionsRecorded + second.suppressionsRecorded,
    directSendsRecorded: first.directSendsRecorded + second.directSendsRecorded,
    automatedSendsRecognised: first.automatedSendsRecognised + second.automatedSendsRecognised,
    duplicateRfcId: first.duplicateRfcId + second.duplicateRfcId,
    rfcIdConflicts: first.rfcIdConflicts + second.rfcIdConflicts,
    vanishedMessages: first.vanishedMessages + second.vanishedMessages,
    newestInternalDate: newest,
    processedMessages: first.processedMessages + second.processedMessages,
    readFailure: second.readFailure ?? first.readFailure,
  };
}

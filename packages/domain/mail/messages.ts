import type { RepositoryContext } from '../db/workspaceScope.ts';
import { directionOfLabels, headerValue, type GmailMessageMetadata } from './gmailClient.ts';
import { stdoutMailLog, type MailLog } from './log.ts';
import {
  normalizeAddress,
  normalizeAddressList,
  normalizeMessageId,
  normalizeMessageIdList,
  type MailMessageRow,
} from './types.ts';

/**
 * `mail_messages` and `mail_message_bodies` (specification 12.3, 10.3).
 *
 * The mapping from a Gmail metadata read to a row is here and nowhere else, so the
 * header allowlist is applied once. Anything outside it is dropped on the way in
 * rather than stored and ignored: a column that does not exist cannot be read by a
 * later lane that did not know it was not supposed to have it.
 *
 * `recordMessage` is an insert that tolerates finding the row already there, because
 * `mail.sync` is at least once and a replayed history page is the ordinary case, not
 * an error. It returns whether it was the one that wrote the row, which is what lets
 * the caller count what a page actually did.
 */

const MESSAGE_COLUMNS = `id, mailbox_id, provider_message_id, provider_thread_id, rfc_message_id, direction,
  internal_date, header_from, header_to, header_cc, subject, reference_message_ids, in_reply_to,
  auto_submitted, list_id, matched, metadata_only`;

interface MessageDbRow {
  readonly id: string;
  readonly mailbox_id: string;
  readonly provider_message_id: string;
  readonly provider_thread_id: string;
  readonly rfc_message_id: string | null;
  readonly direction: 'incoming' | 'outgoing';
  readonly internal_date: Date;
  readonly header_from: string | null;
  readonly header_to: string[];
  readonly header_cc: string[];
  readonly subject: string | null;
  readonly reference_message_ids: string[];
  readonly in_reply_to: string | null;
  readonly auto_submitted: string | null;
  readonly list_id: string | null;
  readonly matched: boolean;
  readonly metadata_only: boolean;
  readonly [column: string]: unknown;
}

function toMessage(row: MessageDbRow): MailMessageRow {
  return {
    id: row.id,
    mailboxId: row.mailbox_id,
    providerMessageId: row.provider_message_id,
    providerThreadId: row.provider_thread_id,
    rfcMessageId: row.rfc_message_id,
    direction: row.direction,
    internalDate: row.internal_date.toISOString(),
    headerFrom: row.header_from,
    headerTo: row.header_to,
    headerCc: row.header_cc,
    subject: row.subject,
    referenceMessageIds: row.reference_message_ids,
    inReplyTo: row.in_reply_to,
    autoSubmitted: row.auto_submitted,
    listId: row.list_id,
    matched: row.matched,
    metadataOnly: row.metadata_only,
  };
}

/** `mail_messages_recipients_bounded`: at most this many To and this many Cc addresses. */
const MAIL_RECIPIENTS_PER_HEADER_LIMIT = 200;
/** The references, labels and attachment references bounds of migration 0009. */
const MAIL_LIST_LIMIT = 100;

/** Everything the allowlisted headers say, normalized, before a row exists. */
export interface NormalizedMetadata {
  readonly providerMessageId: string;
  readonly providerThreadId: string;
  readonly rfcMessageId: string | null;
  readonly direction: 'incoming' | 'outgoing';
  readonly internalDate: string;
  readonly headerFrom: string | null;
  readonly headerTo: readonly string[];
  readonly headerCc: readonly string[];
  readonly subject: string | null;
  readonly referenceMessageIds: readonly string[];
  readonly inReplyTo: string | null;
  readonly autoSubmitted: string | null;
  readonly listId: string | null;
  readonly labelIds: readonly string[];
  readonly attachments: readonly { readonly filename: string; readonly mimeType: string; readonly sizeBytes: number; readonly attachmentId: string }[];
}

/**
 * Normalize one metadata read.
 *
 * The References list carries `In-Reply-To` as well, deduplicated, because 12.3
 * matches "Message-ID references against FSS fences" and a reply that names the fence
 * only in `In-Reply-To` is the same match as one that names it in `References`.
 *
 * The subject is truncated rather than refused: a 1,200-character subject is a real
 * message, and refusing it would lose a reply. The address headers are the opposite —
 * an address that does not normalize is dropped, because a half-read address is worse
 * than a missing one for matching.
 *
 * Every list is cut to the bound `mail_messages` holds it to (migration 0009's
 * `*_bounded` CHECKs), for the same reason as the subject: a mail merge to 250
 * addresses is a real message, and a CHECK violation would fail the whole sync page it
 * arrived on. A recipient past the 200th is not matched on; the first 200 are.
 */
export function normalizeMetadata(metadata: GmailMessageMetadata): NormalizedMetadata {
  const headers = metadata.headers;
  const references = normalizeMessageIdList(headerValue(headers, 'References'));
  const inReplyTo = normalizeMessageId(headerValue(headers, 'In-Reply-To'));
  const allReferences = inReplyTo === null || references.includes(inReplyTo) ? references : [...references, inReplyTo];
  const subject = headerValue(headers, 'Subject');
  return {
    providerMessageId: metadata.id,
    providerThreadId: metadata.threadId,
    rfcMessageId: normalizeMessageId(headerValue(headers, 'Message-ID')),
    direction: directionOfLabels(metadata.labelIds),
    internalDate: new Date(metadata.internalDateEpochMilliseconds).toISOString(),
    headerFrom: normalizeAddress(headerValue(headers, 'From')),
    headerTo: normalizeAddressList(headerValue(headers, 'To')).slice(0, MAIL_RECIPIENTS_PER_HEADER_LIMIT),
    headerCc: normalizeAddressList(headerValue(headers, 'Cc')).slice(0, MAIL_RECIPIENTS_PER_HEADER_LIMIT),
    subject: subject === undefined ? null : subject.slice(0, 998),
    referenceMessageIds: allReferences.slice(0, MAIL_LIST_LIMIT),
    inReplyTo,
    autoSubmitted: headerValue(headers, 'Auto-Submitted')?.slice(0, 200) ?? null,
    listId: headerValue(headers, 'List-Id')?.slice(0, 200) ?? null,
    labelIds: metadata.labelIds.slice(0, MAIL_LIST_LIMIT),
    attachments: metadata.attachments.slice(0, MAIL_LIST_LIMIT),
  };
}

export type RecordOutcome =
  /** This call wrote the row. */
  | 'inserted'
  /** The row for this Gmail id was already there: a replayed page, not a second message. */
  | 'replayed'
  /**
   * Another Gmail message in this mailbox already holds this RFC Message-ID and is
   * proven to be the same message — same direction, From, Subject and `Date` — so this
   * copy is treated as already recorded: the existing row is returned and no effect runs
   * again.
   */
  | 'duplicate_rfc_id'
  /**
   * Another Gmail message holds this RFC Message-ID and is *not* proven the same. This
   * one is recorded with no RFC Message-ID and processed as the new message it is.
   */
  | 'rfc_id_conflict';

export interface RecordedMessage {
  /** The row the caller processes. For `duplicate_rfc_id`, the existing message's. */
  readonly message: MailMessageRow;
  /** True when this call wrote a row (`inserted` and `rfc_id_conflict`). */
  readonly inserted: boolean;
  readonly outcome: RecordOutcome;
}

export interface RecordMessageInput {
  readonly mailboxId: string;
  readonly metadata: NormalizedMetadata;
  /**
   * Whether the message already holding this RFC Message-ID carries the same `Date`
   * header as this one. `mail_messages` does not keep the header, so the pipeline reads
   * the existing message's metadata again to answer; without an answer nothing is
   * proven and the collision is a conflict.
   */
  readonly sameDateAs?: ((existing: MailMessageRow) => Promise<boolean>) | undefined;
  readonly log?: MailLog | undefined;
}

const INSERT_MESSAGE = `INSERT INTO mail_messages (workspace_id, mailbox_id, provider_message_id, provider_thread_id,
                                rfc_message_id, direction, internal_date, header_from, header_to, header_cc,
                                subject, reference_message_ids, in_reply_to, auto_submitted, list_id,
                                label_ids, attachment_references)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10::text[], $11, $12::text[], $13, $14, $15,
             $16::text[], $17::jsonb)
     ON CONFLICT DO NOTHING
     RETURNING ${MESSAGE_COLUMNS}`;

/**
 * Write one message, or find the one already written.
 *
 * `ON CONFLICT DO NOTHING` absorbs both of the table's uniqueness rules, and which one
 * held is then read back:
 *
 * * `mail_messages_one_per_provider_id` is the "message uniqueness" half of Appendix
 *   C's protection for `mail.sync`: the same Gmail message again is a replay.
 * * `mail_messages_one_per_rfc_id` is a *different* Gmail message with the same RFC
 *   Message-ID. A proven duplicate is treated as already recorded. Anything else is a
 *   conflict: this message is recorded with no RFC Message-ID, so neither row is lost
 *   and neither can wedge the sync or the recovery, and the caller processes it with
 *   its own metadata — an opt-out that reuses an outgoing message's id is still read.
 */
export async function recordMessage(
  context: RepositoryContext,
  input: RecordMessageInput,
): Promise<RecordedMessage> {
  const m = input.metadata;
  const parameters = (rfcMessageId: string | null): unknown[] => [
    context.scope.workspaceId,
    input.mailboxId,
    m.providerMessageId,
    m.providerThreadId,
    rfcMessageId,
    m.direction,
    m.internalDate,
    m.headerFrom,
    [...m.headerTo],
    [...m.headerCc],
    m.subject,
    [...m.referenceMessageIds],
    m.inReplyTo,
    m.autoSubmitted,
    m.listId,
    [...m.labelIds],
    JSON.stringify(m.attachments),
  ];
  const inserted = await context.db.query<MessageDbRow>(INSERT_MESSAGE, parameters(m.rfcMessageId));
  const row = inserted.rows[0];
  if (row !== undefined) return { message: toMessage(row), inserted: true, outcome: 'inserted' };

  const replayed = await messageByProviderId(context, input.mailboxId, m.providerMessageId);
  if (replayed !== null) return { message: replayed, inserted: false, outcome: 'replayed' };

  const existing =
    m.rfcMessageId === null ? null : await messageByRfcId(context, input.mailboxId, m.rfcMessageId);
  if (existing === null) throw new Error('a message insert conflicted with a row that is not there');

  const proven =
    !(await hasRecordedDraft(context, input.mailboxId, existing.providerMessageId)) &&
    existing.direction === m.direction &&
    existing.headerFrom === m.headerFrom &&
    existing.subject === m.subject &&
    (input.sameDateAs === undefined ? false : await input.sameDateAs(existing));
  if (proven) return { message: existing, inserted: false, outcome: 'duplicate_rfc_id' };

  const conflicted = await context.db.query<MessageDbRow>(INSERT_MESSAGE, parameters(null));
  const conflictRow = conflicted.rows[0];
  if (conflictRow === undefined) {
    // Another run recorded this Gmail message in the meantime: a replay after all.
    const now = await messageByProviderId(context, input.mailboxId, m.providerMessageId);
    if (now === null) throw new Error('a message insert conflicted with a row that is not there');
    return { message: now, inserted: false, outcome: 'replayed' };
  }
  // Identifiers only: no body, no address, no subject.
  (input.log ?? stdoutMailLog)('warn', 'mail.rfc_id_conflict', {
    mailboxId: input.mailboxId,
    providerMessageId: m.providerMessageId,
    existingProviderMessageId: existing.providerMessageId,
    rfcMessageId: m.rfcMessageId,
  });
  return { message: toMessage(conflictRow), inserted: true, outcome: 'rfc_id_conflict' };
}

async function messageByProviderId(
  context: RepositoryContext,
  mailboxId: string,
  providerMessageId: string,
): Promise<MailMessageRow | null> {
  const { rows } = await context.db.query<MessageDbRow>(
    `SELECT ${MESSAGE_COLUMNS} FROM mail_messages
      WHERE workspace_id = $1 AND mailbox_id = $2 AND provider_message_id = $3`,
    [context.scope.workspaceId, mailboxId, providerMessageId],
  );
  const row = rows[0];
  return row === undefined ? null : toMessage(row);
}

async function messageByRfcId(
  context: RepositoryContext,
  mailboxId: string,
  rfcMessageId: string,
): Promise<MailMessageRow | null> {
  const { rows } = await context.db.query<MessageDbRow>(
    `SELECT ${MESSAGE_COLUMNS} FROM mail_messages
      WHERE workspace_id = $1 AND mailbox_id = $2 AND rfc_message_id = $3`,
    [context.scope.workspaceId, mailboxId, rfcMessageId],
  );
  const row = rows[0];
  return row === undefined ? null : toMessage(row);
}

/**
 * Which of these Gmail ids this mailbox already has a row for: one query per recovery
 * listing page, which is how a recovery resumes by recorded ids rather than by a page
 * position that shifts when a message is deleted.
 */
export async function recordedProviderMessageIds(
  context: RepositoryContext,
  input: { readonly mailboxId: string; readonly providerMessageIds: readonly string[] },
): Promise<ReadonlySet<string>> {
  if (input.providerMessageIds.length === 0) return new Set();
  const { rows } = await context.db.query<{ provider_message_id: string }>(
    `SELECT provider_message_id FROM mail_messages
      WHERE workspace_id = $1 AND mailbox_id = $2 AND provider_message_id = ANY($3::text[])`,
    [context.scope.workspaceId, input.mailboxId, [...input.providerMessageIds]],
  );
  return new Set(rows.map(row => row.provider_message_id));
}

export async function readMessage(context: RepositoryContext, messageId: string): Promise<MailMessageRow | null> {
  const { rows } = await context.db.query<MessageDbRow>(
    `SELECT ${MESSAGE_COLUMNS} FROM mail_messages WHERE workspace_id = $1 AND id = $2`,
    [context.scope.workspaceId, messageId],
  );
  const row = rows[0];
  return row === undefined ? null : toMessage(row);
}

/** Mark a message as matched. The column is what `mail_messages_body_needs_match` reads. */
export async function markMessageMatched(context: RepositoryContext, messageId: string): Promise<void> {
  await context.db.query('UPDATE mail_messages SET matched = true WHERE workspace_id = $1 AND id = $2', [
    context.scope.workspaceId,
    messageId,
  ]);
}

/**
 * Store a body, and record that the message is no longer metadata only.
 *
 * Refuses a message that has not matched, because 12.3 permits a body fetch only
 * after a plausible match and a body that reached this function for an unmatched
 * message means the caller lost track of its own rule. The database would refuse it
 * too (`mail_messages_body_needs_match`); this says so in a sentence.
 */
export async function storeMessageBody(
  context: RepositoryContext,
  input: { readonly messageId: string; readonly text: string; readonly truncated: boolean },
): Promise<void> {
  const message = await readMessage(context, input.messageId);
  if (message === null) throw new Error('a body was offered for a message in another workspace');
  if (!message.matched) throw new Error('a body may not be stored for a message that has not matched');
  await context.db.query(
    `INSERT INTO mail_message_bodies (workspace_id, mail_message_id, body_text, truncated)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (workspace_id, mail_message_id)
     DO UPDATE SET body_text = EXCLUDED.body_text, truncated = EXCLUDED.truncated, fetched_at = now()`,
    [context.scope.workspaceId, input.messageId, input.text.slice(0, 200000), input.truncated],
  );
  await context.db.query(
    'UPDATE mail_messages SET metadata_only = false WHERE workspace_id = $1 AND id = $2',
    [context.scope.workspaceId, input.messageId],
  );
}

export async function readMessageBody(
  context: RepositoryContext,
  messageId: string,
): Promise<{ readonly text: string; readonly truncated: boolean } | null> {
  const { rows } = await context.db.query<{ body_text: string; truncated: boolean }>(
    'SELECT body_text, truncated FROM mail_message_bodies WHERE workspace_id = $1 AND mail_message_id = $2',
    [context.scope.workspaceId, messageId],
  );
  const row = rows[0];
  return row === undefined ? null : { text: row.body_text, truncated: row.truncated };
}

/**
 * 12.4: "Out-of-office bodies are not retained." The fact is kept as a classification
 * signal; the words are removed.
 */
export async function discardMessageBody(context: RepositoryContext, messageId: string): Promise<void> {
  await context.db.query(
    'DELETE FROM mail_message_bodies WHERE workspace_id = $1 AND mail_message_id = $2',
    [context.scope.workspaceId, messageId],
  );
  await context.db.query(
    'UPDATE mail_messages SET metadata_only = true WHERE workspace_id = $1 AND id = $2',
    [context.scope.workspaceId, messageId],
  );
}

/** The correspondence on one opportunity, newest first. The message view reads this. */
export async function listMessagesForOpportunity(
  context: RepositoryContext,
  input: { readonly opportunityId: string; readonly limit?: number | undefined },
): Promise<readonly MailMessageRow[]> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const { rows } = await context.db.query<MessageDbRow>(
    `SELECT ${MESSAGE_COLUMNS.split(', ')
      .map(column => `m.${column}`)
      .join(', ')}
       FROM mail_messages AS m
       JOIN mail_message_matches AS x
         ON x.workspace_id = m.workspace_id AND x.mail_message_id = m.id
      WHERE m.workspace_id = $1 AND x.opportunity_id = $2
      ORDER BY m.internal_date DESC, m.id
      LIMIT ${String(limit)}`,
    [context.scope.workspaceId, input.opportunityId],
  );
  return rows.map(toMessage);
}

/** Historical drafts remain immutable evidence; fresh labels cannot promote their retained row. */
export async function hasRecordedDraft(
  context: RepositoryContext,
  mailboxId: string,
  providerMessageId: string,
): Promise<boolean> {
  const result = await context.db.query(`SELECT 1 FROM mail_messages
    WHERE workspace_id=$1 AND mailbox_id=$2 AND provider_message_id=$3 AND 'DRAFT'=ANY(label_ids)`,
    [context.scope.workspaceId, mailboxId, providerMessageId]);
  return result.rows.length !== 0;
}

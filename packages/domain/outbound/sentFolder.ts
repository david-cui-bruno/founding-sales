import type { RepositoryContext } from '../db/workspaceScope.ts';
import type { EnvelopeCipher } from '../mail/envelope.ts';
import { GmailClientError, headerValue, type GmailClient, type GmailOAuthConfig } from '../mail/gmailClient.ts';
import { readMailbox } from '../mail/mailboxes.ts';
import { accessForMailbox } from '../mail/sync.ts';
import { normalizeAddressList } from '../mail/types.ts';
import { fssFenceIdOfSentMessage } from './types.ts';

/**
 * Listing one mailbox's Sent folder for the sends FSS made (Appendix E step 3).
 *
 * Appendix E.3: "Search every mailbox Sent folder from the restore point minus ten
 * minutes for FSS Message-IDs; insert sent tombstones for missing fences." Until this
 * lane the restore tool did the first half only for fences the restored copy still had:
 * it asked Gmail about each `dispatching` or `reconciling` fence by its Message-ID. A
 * send made *after* the restore point has no fence in the restored copy, so nothing
 * asked about it, and the restored sequence would have sent it again.
 *
 * This file is the Gmail half of the fix and nothing else. It lists the folder over a
 * window, reads each message's metadata with a three-header allowlist, and keeps the
 * ones carrying FSS's marker for this mailbox (`fssFenceIdOfSentMessage`). It writes
 * nothing. What each message means to the restored database — a fence that is present,
 * one that is missing and whose step is known, one nobody can attribute — is
 * `@fss/domain/restore`'s decision, because it reads sequence state this package does
 * not import.
 *
 * ## Why metadata and never a body
 *
 * The marker, the recipient, the subject and Gmail's own instant are all a tombstone
 * needs, and all four are headers or envelope fields. `getBody` stays behind 12.3's
 * rule — a body only after a plausible match — and a restore does not need one.
 */

/** The headers the scan reads. The Message-ID is the marker; the rest fill the tombstone. */
export const SENT_SCAN_HEADERS: readonly string[] = Object.freeze(['Message-ID', 'To', 'Subject']);

/** Gmail's own page size for a listing. */
export const SENT_SCAN_PAGE_SIZE = 500;

/**
 * How many pages one scan reads before it reports the folder `truncated`.
 *
 * Twenty thousand messages in the window. A mailbox that sent more than that in the
 * minutes or hours since a restore point is not one this pass should pretend to have
 * read, so the scan says it did not, and the restore report lists the mailbox as an
 * unresolved exception rather than as scanned.
 */
export const SENT_SCAN_PAGE_LIMIT = 40;

/** One FSS send, as the Sent folder records it. */
export interface SentFolderMessage {
  readonly providerMessageId: string;
  readonly providerThreadId: string;
  /** The Message-ID header exactly as the message carries it, brackets included. */
  readonly rfcMessageId: string;
  /** The fence uuid inside it. */
  readonly fenceId: string;
  /** The one recipient, normalized; null when the To header is not exactly one address. */
  readonly recipientAddress: string | null;
  readonly subject: string | null;
  /** Gmail's internal date: the instant the message left. */
  readonly sentAt: string;
}

/**
 * `message_vanished`: the listing named a message whose metadata Gmail no longer returns
 * (deleted between the two reads). The folder was not read to the end, because that
 * message is exactly one nobody can now say was or was not FSS's; the messages that were
 * read are still returned, and a rerun lists the folder again without it.
 *
 * `malformed_response`: a listing page or a metadata read Gmail answered 200 with
 * something that is not one (no JSON object, an entry without an id, no usable internal
 * date). The folder was not read, and an unreadable page is never zero messages.
 */
export type SentFolderScanOutcome =
  | 'scanned'
  | 'grant_revoked'
  | 'rate_limited'
  | 'truncated'
  | 'mailbox_unknown'
  | 'message_vanished'
  | 'malformed_response';

export interface SentFolderScan {
  readonly outcome: SentFolderScanOutcome;
  /** Every message the listing returned inside the window, FSS's or not. */
  readonly listed: number;
  /** The ones carrying FSS's marker for this mailbox, oldest first. */
  readonly messages: readonly SentFolderMessage[];
  /** Listed ids whose metadata read found nothing (`message_vanished`). */
  readonly vanished: number;
}

export interface SentFolderScanDeps {
  readonly gmail: GmailClient;
  readonly oauth: GmailOAuthConfig;
  readonly cipher: EnvelopeCipher;
}

/**
 * The FSS sends in one mailbox's Sent folder whose Gmail internal date is in
 * `[since, until]`, oldest first.
 *
 * The listing is asked for a window one second wider on each side, because Gmail's
 * `after:` and `before:` work in whole seconds, and the exact bounds are then applied to
 * the internal date in milliseconds: a message one millisecond before `since` is out, a
 * message at `since` is in. Oldest first because a restore can lose two sends of one
 * enrollment, and the earlier is the earlier step.
 */
export async function scanSentFolder(
  context: RepositoryContext,
  deps: SentFolderScanDeps,
  input: { readonly mailboxId: string; readonly since: string; readonly until: string },
): Promise<SentFolderScan> {
  const mailbox = await readMailbox(context, input.mailboxId);
  if (mailbox === null) return { outcome: 'mailbox_unknown', listed: 0, messages: [], vanished: 0 };
  const access = await accessForMailbox(context, deps, mailbox.id);
  if (!access.ok) return { outcome: 'grant_revoked', listed: 0, messages: [], vanished: 0 };

  const sinceMs = Date.parse(input.since);
  const untilMs = Date.parse(input.until);
  const request = {
    afterEpochSeconds: Math.floor(sinceMs / 1000) - 1,
    beforeEpochSeconds: Math.floor(untilMs / 1000) + 2,
    maxResults: SENT_SCAN_PAGE_SIZE,
  };

  const ids: string[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  for (;;) {
    if (pages >= SENT_SCAN_PAGE_LIMIT) return { outcome: 'truncated', listed: ids.length, messages: [], vanished: 0 };
    const page = await unlessMalformed(
      deps.gmail.listSentMessageIds(access.access, { ...request, ...(pageToken === undefined ? {} : { pageToken }) }),
    );
    if (page === MALFORMED) return { outcome: 'malformed_response', listed: ids.length, messages: [], vanished: 0 };
    if (!page.ok) return { outcome: page.reason, listed: ids.length, messages: [], vanished: 0 };
    ids.push(...page.messageIds);
    pages += 1;
    if (page.nextPageToken === null) break;
    pageToken = page.nextPageToken;
  }

  let listed = 0;
  let vanished = 0;
  const messages: SentFolderMessage[] = [];
  const settle = (outcome: SentFolderScanOutcome): SentFolderScan => {
    messages.sort(
      (left, right) =>
        Date.parse(left.sentAt) - Date.parse(right.sentAt) || left.providerMessageId.localeCompare(right.providerMessageId),
    );
    return { outcome, listed, messages, vanished };
  };
  for (const id of [...new Set(ids)]) {
    const metadata = await unlessMalformed(deps.gmail.getMetadata(access.access, id, SENT_SCAN_HEADERS));
    if (metadata === MALFORMED) return settle('malformed_response');
    // Deleted between the listing and the read: Gmail no longer has it to vouch for, so
    // the folder was not read to the end (`message_vanished`), and the scan says so.
    if (metadata === null) {
      vanished += 1;
      continue;
    }
    const at = metadata.internalDateEpochMilliseconds;
    // No usable internal date is not "outside the window": it is a message nobody can
    // place, so the folder was not read.
    if (!Number.isFinite(at) || at <= 0) return settle('malformed_response');
    if (!(at >= sinceMs && at <= untilMs)) continue;
    listed += 1;
    const header = (headerValue(metadata.headers, 'Message-ID') ?? '').trim();
    const fenceId = fssFenceIdOfSentMessage(header, mailbox.emailAddress);
    if (fenceId === null) continue;
    const recipients = normalizeAddressList(headerValue(metadata.headers, 'To'));
    messages.push({
      providerMessageId: metadata.id,
      providerThreadId: metadata.threadId,
      rfcMessageId: header,
      fenceId,
      recipientAddress: recipients.length === 1 ? (recipients[0] ?? null) : null,
      subject: headerValue(metadata.headers, 'Subject') ?? null,
      sentAt: new Date(at).toISOString(),
    });
  }
  return settle(vanished > 0 ? 'message_vanished' : 'scanned');
}

const MALFORMED = Symbol('malformed_response');

/** A Gmail answer, or `MALFORMED` when the client refused its shape; any other error propagates. */
async function unlessMalformed<T>(pending: Promise<T>): Promise<T | typeof MALFORMED> {
  try {
    return await pending;
  } catch (error) {
    if (error instanceof GmailClientError && error.code === 'malformed_response') return MALFORMED;
    throw error;
  }
}

import type { RepositoryContext } from '../db/workspaceScope.ts';
import type { EnvelopeCipher } from './envelope.ts';
import type { GmailAccessGrant, GmailClient, GmailOAuthConfig } from './gmailClient.ts';
import {
  advanceCursor,
  advanceGeneration,
  markMailboxDisconnected,
  openMailboxHold,
  readMailbox,
  recordSyncError,
  releaseMailboxHold,
  setSyncState,
} from './mailboxes.ts';
import {
  EMPTY_PIPELINE_REPORT,
  processMessageIds,
  type MessagePipelineDeps,
  type MessagePipelineReport,
} from './pipeline.ts';
import { readRefreshToken } from './tokens.ts';
import { startRecovery, type RecoveryFloorSource } from './recover.ts';
import { RECOVERY_OVERLAP_SECONDS, type MailboxRow } from './types.ts';

/**
 * `mail.sync` (specification 12.3, Appendix A "Mail-sync page", Appendix C,
 * Appendix G 3, 4, 6, 10, 13, 15 and 19).
 *
 * One run does four things, in this order and no other:
 *
 * 1. **Get a token, or hold.** A revoked grant is not an error to retry; it is 12.6's
 *    "every automated step kind for that owner is held", and a mailbox marked revoked.
 * 2. **Read history from the cursor.** Metadata first, through `processMessageIds`,
 *    which is the one place that decides what is read and in which order.
 * 3. **Match, then fetch a body only for what matched** — in the shared pipeline.
 * 4. **Advance the cursor and the watermark by compare-and-set, together.** If the
 *    compare fails, another run got there first and this one stops.
 *
 * An expired cursor is step 2's defined failure and is not a retry either: the
 * mailbox's generation advances, a bounded recovery starts for the new generation,
 * and a `coverage_incomplete` hold blocks the owner's automated work until the
 * recovery proves the whole interval (Appendix G 13).
 *
 * **The run is bounded.** `maxMessages` caps how many messages one job processes, and
 * a run that hits the cap reports `moreToDo` and stops. The handler runs inside the
 * job runner's transaction — Appendix C protects `mail.sync` by business uniqueness —
 * and a transaction that stays open for a thousand Gmail round trips holds locks for
 * minutes. The backlog is picked up by the one-minute reconciliation source, which is
 * 12.3's safety net doing the job it already exists for. See
 * `docs/decisions/g7-sync-transaction-shape.md`.
 */

export const DEFAULT_SYNC_MESSAGE_LIMIT = 50;
export const DEFAULT_SYNC_PAGE_LIMIT = 20;

export interface MailSyncDeps extends MessagePipelineDeps {
  readonly maxMessages?: number | undefined;
  readonly maxPages?: number | undefined;
  /** 12.3's "oldest unresolved outbound message or active enrollment". G7-2 and G8. */
  readonly recoveryFloor?: RecoveryFloorSource | undefined;
}

export type MailSyncOutcome =
  | 'synced'
  | 'mailbox_unknown'
  | 'mailbox_inactive'
  | 'grant_revoked'
  | 'baseline_started'
  | 'recovery_started'
  | 'cursor_moved'
  | 'rate_limited';

export interface MailSyncReport extends MessagePipelineReport {
  readonly outcome: MailSyncOutcome;
  readonly mailboxId: string;
  readonly cursorFrom: string | null;
  readonly cursorTo: string | null;
  readonly coverageWatermarkAt: string | null;
  /** True when the cap was reached: the next reconciliation pass continues. */
  readonly moreToDo: boolean;
}

function report(
  mailboxId: string,
  outcome: MailSyncOutcome,
  cursorFrom: string | null,
  pipeline: MessagePipelineReport = EMPTY_PIPELINE_REPORT,
  extra: Partial<MailSyncReport> = {},
): MailSyncReport {
  return {
    ...pipeline,
    outcome,
    mailboxId,
    cursorFrom,
    cursorTo: null,
    coverageWatermarkAt: null,
    moreToDo: false,
    ...extra,
  };
}

/**
 * Exchange the stored refresh token for an access token, or decide the grant is gone.
 *
 * The plaintext exists here and is handed straight to the client. It is never
 * returned, never logged and never put in a report.
 */
export async function accessForMailbox(
  context: RepositoryContext,
  deps: { readonly gmail: GmailClient; readonly oauth: GmailOAuthConfig; readonly cipher: EnvelopeCipher },
  mailboxId: string,
): Promise<
  { readonly ok: true; readonly access: GmailAccessGrant } | { readonly ok: false; readonly reason: 'grant_revoked' }
> {
  const refreshToken = await readRefreshToken(context, { mailboxId, cipher: deps.cipher });
  if (refreshToken === null) return { ok: false, reason: 'grant_revoked' };
  const outcome = await deps.gmail.refreshAccessToken(deps.oauth, refreshToken);
  if (!outcome.ok) return { ok: false, reason: 'grant_revoked' };
  return { ok: true, access: outcome.grant };
}

/** 12.6 and 4.2: the grant is gone, so everything automated for that owner holds. */
export async function holdForRevokedGrant(context: RepositoryContext, mailbox: MailboxRow): Promise<void> {
  await markMailboxDisconnected(context, {
    mailboxId: mailbox.id,
    status: 'revoked',
    reason: 'the Gmail grant was revoked',
  });
  await openMailboxHold(context, {
    mailboxId: mailbox.id,
    ownerUserId: mailbox.ownerUserId,
    reasonCode: 'mailbox_disconnected',
  });
}

export async function runMailSync(
  context: RepositoryContext,
  deps: MailSyncDeps,
  input: { readonly mailboxId: string; readonly historyIdHint?: string | null | undefined },
): Promise<MailSyncReport> {
  const mailbox = await readMailbox(context, input.mailboxId);
  if (mailbox === null) return report(input.mailboxId, 'mailbox_unknown', null);
  if (mailbox.status !== 'connected') {
    await openMailboxHold(context, {
      mailboxId: mailbox.id,
      ownerUserId: mailbox.ownerUserId,
      reasonCode: 'mailbox_disconnected',
    });
    return report(mailbox.id, 'mailbox_inactive', mailbox.historyId);
  }

  const access = await accessForMailbox(context, deps, mailbox.id);
  if (!access.ok) {
    await holdForRevokedGrant(context, mailbox);
    return report(mailbox.id, 'grant_revoked', mailbox.historyId);
  }

  // 12.3: "A newly connected mailbox completes a bounded baseline ... before
  // automation begins." No cursor is the same situation as a baseline that has not
  // finished, and both are a recovery rather than a history read.
  if (mailbox.historyId === null || mailbox.syncState === 'baseline_pending') {
    await openMailboxHold(context, {
      mailboxId: mailbox.id,
      ownerUserId: mailbox.ownerUserId,
      reasonCode: 'coverage_incomplete',
    });
    await startRecovery(context, {
      mailbox,
      reason: 'baseline',
      ...(deps.recoveryFloor === undefined ? {} : { floor: deps.recoveryFloor }),
    });
    return report(mailbox.id, 'baseline_started', mailbox.historyId);
  }

  const maxMessages = deps.maxMessages ?? DEFAULT_SYNC_MESSAGE_LIMIT;
  const maxPages = deps.maxPages ?? DEFAULT_SYNC_PAGE_LIMIT;

  // ---- Step 2: history, bounded, ids only. ----------------------------------
  const seen = new Map<string, string>();
  let pageToken: string | undefined;
  let latestHistoryId = mailbox.historyId;
  let moreToDo = false;

  for (let page = 0; page < maxPages; page += 1) {
    const outcome = await deps.gmail.listHistory(access.access, {
      startHistoryId: mailbox.historyId,
      ...(pageToken === undefined ? {} : { pageToken }),
    });
    if (!outcome.ok) {
      if (outcome.reason === 'history_expired') {
        return await beginRecoveryForExpiredCursor(context, mailbox, deps.recoveryFloor);
      }
      if (outcome.reason === 'grant_revoked') {
        await holdForRevokedGrant(context, mailbox);
        return report(mailbox.id, 'grant_revoked', mailbox.historyId);
      }
      await recordSyncError(context, { mailboxId: mailbox.id, error: 'the Gmail history read was rate limited' });
      return report(mailbox.id, 'rate_limited', mailbox.historyId);
    }

    for (const record of outcome.records) {
      if (record.kind === 'message_deleted') continue;
      if (!seen.has(record.messageId)) seen.set(record.messageId, record.historyId);
    }
    latestHistoryId = outcome.historyId;
    if (seen.size >= maxMessages) {
      moreToDo = true;
      break;
    }
    if (outcome.nextPageToken === null) break;
    pageToken = outcome.nextPageToken;
    if (page === maxPages - 1) moreToDo = true;
  }

  // A capped run must not claim coverage past what it processed, so the cursor it
  // writes is the highest history id among the messages it took rather than the
  // mailbox's current one.
  const taken = [...seen.entries()].slice(0, maxMessages);
  const cursorTo = moreToDo
    ? taken.reduce((highest, [, id]) => (Number(id) > Number(highest) ? id : highest), mailbox.historyId)
    : latestHistoryId;

  // ---- Step 3: the shared pipeline. -----------------------------------------
  const pipeline = await processMessageIds(context, deps, {
    mailbox,
    access: access.access,
    messageIds: taken.map(([messageId]) => messageId),
  });

  // ---- Step 4: cursor and watermark, together, by compare-and-set. ----------
  //
  // The watermark is only raised when the run finished the history it asked for. A
  // capped run has read every message it took, but it has not read the mailbox, and a
  // watermark is a claim about the mailbox.
  const watermark = moreToDo ? undefined : (pipeline.newestInternalDate ?? new Date().toISOString());
  const advanced = await advanceCursor(context, {
    mailboxId: mailbox.id,
    expectedHistoryId: mailbox.historyId,
    historyId: cursorTo,
    ...(watermark === undefined ? {} : { coverageWatermarkAt: watermark }),
    syncError: null,
  });
  if (!advanced.advanced) return report(mailbox.id, 'cursor_moved', mailbox.historyId, pipeline);

  if (!moreToDo) {
    // Coverage is proved for this cursor, so a coverage hold may go.
    // `releaseMailboxHold` re-reads the row and refuses unless the mailbox is
    // `ready`, which is 4.2's "never after one successful API call".
    await releaseMailboxHold(context, { mailboxId: mailbox.id, reasonCode: 'coverage_incomplete' });
  }
  // A capped run does *not* re-arm its own job here. It cannot: the handler runs
  // inside the runner's transaction and its own row is still `running`, so an upsert
  // would merge into a row that is about to be marked `done` and the re-arm would be
  // lost. The one-minute reconciliation source is what picks the backlog up, which is
  // 12.3's "One-minute reconciliation repairs delayed or dropped notifications" doing
  // the job it already exists for. The cost is up to a minute of latency on a mailbox
  // with a backlog, and the alternative is a job that re-arms itself into a loop no
  // operator can stop.

  return report(mailbox.id, 'synced', mailbox.historyId, pipeline, {
    cursorTo: advanced.historyId,
    coverageWatermarkAt: advanced.coverageWatermarkAt,
    moreToDo,
  });
}

/**
 * 12.3 and Appendix G 13: an expired history cursor starts a bounded full
 * synchronization, and the health hold blocks the owner's automated work until the
 * whole interval is processed.
 *
 * The generation advances first. Anything still in flight for the old one — a watch
 * renewal, an earlier recovery — can no longer write, which is what makes
 * `mail-recover:{mailbox}:{generation}` a usable idempotency key.
 */
async function beginRecoveryForExpiredCursor(
  context: RepositoryContext,
  mailbox: MailboxRow,
  floor: RecoveryFloorSource | undefined,
): Promise<MailSyncReport> {
  const generation = await advanceGeneration(context, mailbox.id);
  await setSyncState(context, { mailboxId: mailbox.id, syncState: 'recovering' });
  await openMailboxHold(context, {
    mailboxId: mailbox.id,
    ownerUserId: mailbox.ownerUserId,
    reasonCode: 'coverage_incomplete',
  });
  const watermark = mailbox.coverageWatermarkAt ?? mailbox.baselineFromAt ?? new Date().toISOString();
  await startRecovery(context, {
    mailbox: { ...mailbox, generation },
    reason: 'history_expired',
    // "From the earlier of watermark minus one hour and the oldest unresolved
    // outbound message or active enrollment" (12.3). The overlap is the half that
    // Appendix G 13 turns into a test: "a reply just outside nominal bounds is
    // recovered by overlap".
    fromAt: new Date(Date.parse(watermark) - RECOVERY_OVERLAP_SECONDS * 1000).toISOString(),
    ...(floor === undefined ? {} : { floor }),
  });
  return report(mailbox.id, 'recovery_started', mailbox.historyId);
}

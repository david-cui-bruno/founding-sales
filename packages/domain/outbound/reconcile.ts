import type { Queryable } from '../db/queryable.ts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { openHold, releaseHoldsOfEvent } from '../policy/holds.ts';
import { type EnvelopeCipher } from '../mail/envelope.ts';
import { type GmailClient, type GmailOAuthConfig } from '../mail/gmailClient.ts';
import { accessForMailbox } from '../mail/sync.ts';
import {
  beginReconciling,
  markUnknownTerminal,
  readFence,
  recordReconciledSent,
  recordReconcileMiss,
} from './fence.ts';
import { RECONCILE_WINDOW_HOURS, reconcileBackoffSeconds } from './types.ts';

/**
 * Sent-folder reconciliation (Appendix B, Appendix G 5 and 12).
 *
 * "Sent reconciliation uses `rfc822msgid:` search on the sending mailbox."
 *
 * This is the half of the fence that runs when nobody knows what happened. A fence
 * reaches `reconciling` because the request may have left — a timeout, a dead worker,
 * a dropped response — and the only authority that can settle it is Gmail's own Sent
 * folder, searched for the deterministic Message-ID FSS wrote before it sent.
 *
 * Three rules, each from a row of Appendix B's failure table.
 *
 * **A miss is not an answer.** "Sent search finds nothing | Remain reconciling for a
 * bounded 24-hour observation window with backoff." Gmail's Sent index takes seconds
 * and sometimes minutes, so the first miss means nothing at all. Only the *window*
 * ends the question.
 *
 * **A hit is authoritative, and it back-dates.** The message was sent when dispatch
 * began, not when this sweep noticed, because 12.5 computes the successor's delay
 * "from the original dispatch time".
 *
 * **Expiry is terminal and never a resend.** "Observation expires | `unknown_terminal`;
 * admin marks delivered or skipped; never resend."
 *
 * The sweep also adopts fences abandoned in `dispatching`. A worker that died
 * mid-send leaves one, and `dispatching` is the one state with no observation
 * scheduled — so a fence that has been dispatching for longer than any send could
 * take is moved to `reconciling` here, which is the move Appendix B permits a
 * replacement worker and the only one it permits.
 */

export interface ReconcileDeps {
  readonly gmail: GmailClient;
  readonly oauth: GmailOAuthConfig;
  readonly cipher: EnvelopeCipher;
  readonly actor?: string | undefined;
  readonly windowHours?: number | undefined;
  /** How long a `dispatching` fence may sit before the sweep adopts it. */
  readonly adoptAfterSeconds?: number | undefined;
  readonly now?: (() => Date) | undefined;
}

/** No send takes five minutes. Longer than that and the process that owned it is gone. */
export const DEFAULT_ADOPT_AFTER_SECONDS = 300;

export type ReconcileOutcome =
  | 'sent'
  | 'still_unknown'
  | 'unknown_terminal'
  | 'adopted'
  | 'not_reconciling'
  | 'fence_unknown'
  | 'grant_revoked'
  | 'rate_limited';

export interface ReconcileReport {
  readonly outcome: ReconcileOutcome;
  readonly outboundMessageId: string;
  readonly attempts: number;
  readonly nextAttemptInSeconds?: number | undefined;
}

export async function reconcileOutboundMessage(
  context: RepositoryContext,
  deps: ReconcileDeps,
  input: { readonly outboundMessageId: string },
): Promise<ReconcileReport> {
  const now = deps.now?.() ?? new Date();
  const fence = await readFence(context, input.outboundMessageId);
  if (fence === null) {
    return { outcome: 'fence_unknown', outboundMessageId: input.outboundMessageId, attempts: 0 };
  }

  if (fence.state === 'dispatching') {
    const startedAt = fence.dispatchStartedAt === null ? 0 : Date.parse(fence.dispatchStartedAt);
    const age = (now.getTime() - startedAt) / 1000;
    if (age < (deps.adoptAfterSeconds ?? DEFAULT_ADOPT_AFTER_SECONDS)) {
      // Somebody may still be inside the one call. Adopting now would be the sweep
      // racing a live send, and there is nothing to gain: the fence is safe where it
      // is, because no second send can ever be authorized for it.
      return { outcome: 'not_reconciling', outboundMessageId: fence.id, attempts: fence.reconcileAttempts };
    }
    const adopted = await beginReconciling(context, {
      outboundMessageId: fence.id,
      detail: 'adopted from dispatching after the owning process went quiet',
      windowHours: deps.windowHours ?? RECONCILE_WINDOW_HOURS,
      ...(deps.actor === undefined ? {} : { actor: deps.actor }),
    });
    if (!adopted.ok) {
      return { outcome: 'not_reconciling', outboundMessageId: fence.id, attempts: fence.reconcileAttempts };
    }
    return { outcome: 'adopted', outboundMessageId: fence.id, attempts: adopted.value.reconcileAttempts };
  }

  if (fence.state !== 'reconciling') {
    return { outcome: 'not_reconciling', outboundMessageId: fence.id, attempts: fence.reconcileAttempts };
  }

  const access = await accessForMailbox(
    context,
    { gmail: deps.gmail, oauth: deps.oauth, cipher: deps.cipher },
    fence.mailboxId,
  );
  if (!access.ok) {
    // Without a grant there is no way to look. The fence stays reconciling and the
    // window keeps running, which is right: a mailbox nobody can read is exactly the
    // case where "we do not know" is the truthful answer.
    return { outcome: 'grant_revoked', outboundMessageId: fence.id, attempts: fence.reconcileAttempts };
  }

  const search = await deps.gmail.searchSentByMessageId(access.access, fence.providerMessageIdHeader);
  if (!search.ok) {
    const attempts = await recordReconcileMiss(context, fence.id);
    return {
      outcome: search.reason === 'grant_revoked' ? 'grant_revoked' : 'rate_limited',
      outboundMessageId: fence.id,
      attempts,
      nextAttemptInSeconds: reconcileBackoffSeconds(attempts),
    };
  }

  if (search.found !== null) {
    const recorded = await recordReconciledSent(context, {
      outboundMessageId: fence.id,
      providerMessageId: search.found.messageId,
      providerThreadId: search.found.threadId,
      ...(deps.actor === undefined ? {} : { actor: deps.actor }),
    });
    if (recorded.ok) {
      // The doubt is over, so the hold the doubt opened comes off. Only that one:
      // `releaseHoldsOfEvent` releases what this fence opened and nothing else, so a
      // suppression or a cap hold on the same firm survives.
      await releaseHoldsOfEvent(context, {
        sourceEventId: fence.id,
        reasonCode: 'send_unknown_reconciling',
      });
    }
    return {
      outcome: 'sent',
      outboundMessageId: fence.id,
      attempts: fence.reconcileAttempts + 1,
    };
  }

  const attempts = await recordReconcileMiss(context, fence.id);
  const deadline = fence.reconcileDeadlineAt === null ? 0 : Date.parse(fence.reconcileDeadlineAt);
  if (deadline > now.getTime()) {
    return {
      outcome: 'still_unknown',
      outboundMessageId: fence.id,
      attempts,
      nextAttemptInSeconds: reconcileBackoffSeconds(attempts),
    };
  }

  const terminal = await markUnknownTerminal(context, {
    outboundMessageId: fence.id,
    ...(deps.actor === undefined ? {} : { actor: deps.actor }),
  });
  if (!terminal.ok) {
    return { outcome: 'still_unknown', outboundMessageId: fence.id, attempts };
  }
  // The reconciling hold becomes a terminal one, which an admin can clear by
  // answering the question 12.5 puts to them. `send_unknown_terminal` *is*
  // recoverable, unlike `send_unknown_reconciling`: a person deciding is precisely
  // how it is meant to end.
  await releaseHoldsOfEvent(context, { sourceEventId: fence.id, reasonCode: 'send_unknown_reconciling' });
  await openHold(context, {
    scopeKind: 'firm',
    scopeKey: fence.firmId,
    reasonCode: 'send_unknown_terminal',
    blockedActionKinds: ['email_send', 'enrollment_advance'],
    sourceEventKind: 'outbound_message',
    sourceEventId: fence.id,
    // 12.5's two answers, and the one recovery action migration 0001 names for them.
    recoveryAction: 'mark_delivered_or_skipped',
  });
  return { outcome: 'unknown_terminal', outboundMessageId: fence.id, attempts };
}

/**
 * Every fence in one mailbox that is owed an observation now.
 *
 * The backoff is expressed as a comparison on `reconcile_last_attempt_at` rather than
 * a stored next-attempt instant, so changing `RECONCILE_BACKOFF_SECONDS` takes effect
 * for fences already in flight — which is what an operator tuning a sweep expects.
 */
export async function listFencesToReconcile(
  db: Queryable,
  options: { readonly adoptAfterSeconds?: number | undefined; readonly limit?: number | undefined } = {},
): Promise<readonly { readonly workspaceId: string; readonly mailboxId: string; readonly outboundMessageId: string }[]> {
  const { rows } = await db.query<{ workspace_id: string; mailbox_id: string; id: string }>(
    `SELECT workspace_id, mailbox_id, id
       FROM outbound_messages
      WHERE (
        state = 'reconciling'
        AND (
          reconcile_last_attempt_at IS NULL
          OR reconcile_last_attempt_at < now() - make_interval(
               secs => least(30 * power(2, least(reconcile_attempts, 7))::integer, 3600))
        )
      )
      OR (
        state = 'dispatching'
        AND dispatch_started_at < now() - make_interval(secs => $1::integer)
      )
      ORDER BY coalesce(reconcile_last_attempt_at, dispatch_started_at)
      LIMIT $2`,
    [options.adoptAfterSeconds ?? DEFAULT_ADOPT_AFTER_SECONDS, options.limit ?? 200],
  );
  return rows.map(row => ({
    workspaceId: row.workspace_id,
    mailboxId: row.mailbox_id,
    outboundMessageId: row.id,
  }));
}

/** Every mailbox with at least one fence owed an observation. The sweep's unit. */
export async function listMailboxesToReconcile(
  db: Queryable,
  options: { readonly adoptAfterSeconds?: number | undefined } = {},
): Promise<readonly { readonly workspaceId: string; readonly mailboxId: string }[]> {
  const { rows } = await db.query<{ workspace_id: string; mailbox_id: string }>(
    `SELECT DISTINCT workspace_id, mailbox_id
       FROM outbound_messages
      WHERE state = 'reconciling'
         OR (state = 'dispatching' AND dispatch_started_at < now() - make_interval(secs => $1::integer))
      ORDER BY workspace_id, mailbox_id`,
    [options.adoptAfterSeconds ?? DEFAULT_ADOPT_AFTER_SECONDS],
  );
  return rows.map(row => ({ workspaceId: row.workspace_id, mailboxId: row.mailbox_id }));
}

/** Reconcile every fence owed an observation in one mailbox. The handler's body. */
export async function reconcileMailbox(
  context: RepositoryContext,
  deps: ReconcileDeps,
  input: { readonly mailboxId: string; readonly limit?: number | undefined },
): Promise<readonly ReconcileReport[]> {
  const { rows } = await context.db.query<{ id: string }>(
    `SELECT id FROM outbound_messages
      WHERE workspace_id = $1 AND mailbox_id = $2
        AND state IN ('reconciling', 'dispatching')
      ORDER BY dispatch_started_at
      LIMIT $3`,
    [context.scope.workspaceId, input.mailboxId, input.limit ?? 50],
  );
  const reports: ReconcileReport[] = [];
  for (const row of rows) {
    reports.push(await reconcileOutboundMessage(context, deps, { outboundMessageId: row.id }));
  }
  return reports;
}

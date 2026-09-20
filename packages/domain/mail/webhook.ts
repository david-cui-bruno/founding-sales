import type { Queryable } from '../db/queryable.ts';
import { repositoryContext, workspaceScope } from '../db/workspaceScope.ts';
import { coalesceMailSync, type CoalesceOutcome } from './coalesce.ts';
import {
  decidePushToken,
  readGmailNotification,
  type GmailNotification,
  type PushTokenPolicy,
  type PushTokenRefusal,
  type PushTokenVerifier,
} from './pushToken.ts';

/**
 * The Gmail Pub/Sub webhook (specification 4.1, 12.3, Appendix G 10 and 27).
 *
 * "The webhook validates signature, issuer, exact audience, service-account email,
 * `email_verified`, expiration, and issued-at bounds; deduplicates message IDs;
 * rejects unknown or inactive mailboxes; coalesces repeated notifications into one
 * mailbox sync stream; and acknowledges only after durable recording or enqueueing."
 *
 * Eight clauses, in that order, first refusal winning. The order is not arbitrary:
 * nothing about the notification's contents is read until the token has proved who
 * sent it, and no row is written until the mailbox has resolved. So an attacker with
 * a forged token cannot cause a database write, and a notification for a mailbox FSS
 * does not know cannot create one.
 *
 * **The mailbox lookup is by address and is not workspace-scoped**, because the
 * notification carries an address and nothing else — there is no authenticated caller
 * and no workspace to scope to. That is the one deliberately unscoped read in this
 * lane, and it is the same shape as G2's `oidc_authorization_requests` lookup for the
 * same reason. Two consequences are handled explicitly:
 *
 *   * a single Gmail account connected in two workspaces is refused, not doubled
 *     (`mailbox_ambiguous`), because syncing both would let one workspace's push
 *     drive another's reads, and a shared personal mailbox is a misconfiguration that
 *     must be visible;
 *   * everything after the lookup runs inside the resolved workspace's scope, so the
 *     dedupe row and the job are that workspace's and Appendix G 8 still holds.
 *
 * **Rejection does not acknowledge.** An unknown or inactive mailbox answers with a
 * refusal and no `200`, so Pub/Sub retries and then drops the notification at its
 * retention boundary rather than FSS quietly swallowing pushes for a mailbox that is
 * about to be reconnected. `docs/decisions/g7-webhook-rejection.md` has the argument,
 * and the counted outcome below is what makes a revoked mailbox that keeps receiving
 * push visible on the dashboard rather than silent.
 */

export const WEBHOOK_REFUSALS = [
  'token_missing',
  'token_unreadable',
  'body_unreadable',
  'mailbox_unknown',
  'mailbox_inactive',
  'mailbox_ambiguous',
] as const;
export type WebhookRefusal = (typeof WEBHOOK_REFUSALS)[number] | PushTokenRefusal;

export type WebhookOutcome =
  | {
      readonly accepted: true;
      readonly workspaceId: string;
      readonly mailboxId: string;
      /** False when this Pub/Sub message id had already been recorded. */
      readonly firstDelivery: boolean;
      readonly coalesced: CoalesceOutcome;
      readonly jobId: string;
      readonly notification: GmailNotification;
    }
  | { readonly accepted: false; readonly refusal: WebhookRefusal };

export interface WebhookDeps {
  readonly verifier: PushTokenVerifier;
  readonly policy: PushTokenPolicy;
  readonly now?: (() => Date) | undefined;
}

export interface WebhookRequest {
  /** The bearer value of the `Authorization` header Pub/Sub sends. */
  readonly token: string | null;
  readonly body: unknown;
}

interface MailboxLookupRow {
  readonly workspace_id: string;
  readonly id: string;
  readonly status: string;
  readonly [column: string]: unknown;
}

export async function receivePushNotification(
  db: Queryable,
  deps: WebhookDeps,
  request: WebhookRequest,
): Promise<WebhookOutcome> {
  // 1 and 2. The signature, then the six claims. Nothing is read from the body until
  // both have passed.
  if (request.token === null || request.token.length === 0) {
    return { accepted: false, refusal: 'token_missing' };
  }
  const claims = await deps.verifier.verify(request.token);
  if (claims === null) return { accepted: false, refusal: 'signature_invalid' };
  const nowEpochSeconds = Math.floor((deps.now ?? ((): Date => new Date()))().getTime() / 1000);
  const decision = decidePushToken(claims, deps.policy, nowEpochSeconds);
  if (!decision.accepted) return { accepted: false, refusal: decision.refusal };

  // 3. The notification: an email address and a history id, and never business state.
  const notification = readGmailNotification(request.body);
  if (notification === null) return { accepted: false, refusal: 'body_unreadable' };

  // 4. The mailbox. The one unscoped read, and the only thing it may do is decide
  // which workspace the rest of this runs in.
  const { rows } = await db.query<MailboxLookupRow>(
    'SELECT workspace_id, id, status FROM mailboxes WHERE email_address = $1 ORDER BY workspace_id',
    [notification.emailAddress],
  );
  if (rows.length === 0) return { accepted: false, refusal: 'mailbox_unknown' };
  if (rows.length > 1) return { accepted: false, refusal: 'mailbox_ambiguous' };
  const mailbox = rows[0];
  if (mailbox === undefined) return { accepted: false, refusal: 'mailbox_unknown' };
  if (mailbox.status !== 'connected') return { accepted: false, refusal: 'mailbox_inactive' };

  const context = repositoryContext(
    workspaceScope(mailbox.workspace_id, { kind: 'system', component: 'worker' }),
    db,
  );

  // 5. Dedupe on the Pub/Sub message id, per workspace. Appendix G 10: "duplicate
  // push notifications ... yield one activity".
  const recorded = await context.db.query<{ id: string }>(
    `INSERT INTO gmail_push_notifications (workspace_id, mailbox_id, provider_message_id, history_id, published_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT ON CONSTRAINT gmail_push_notifications_one_per_message DO NOTHING
     RETURNING id`,
    [
      context.scope.workspaceId,
      mailbox.id,
      notification.providerMessageId,
      notification.historyId,
      notification.publishedAt,
    ],
  );
  const firstDelivery = recorded.rows[0] !== undefined;

  // 6 and 7. Coalesce into the mailbox's single sync stream, merging the high-water
  // history id. A duplicate still coalesces: the second delivery of a notification
  // must not leave the stream behind the first one's history id.
  const coalesced = await coalesceMailSync(context.db, {
    workspaceId: context.scope.workspaceId,
    mailboxId: mailbox.id,
    historyId: notification.historyId,
  });

  // 8. Record which job this notification became, so "acknowledged only after durable
  // enqueue" is checkable after the fact rather than asserted in a comment.
  await context.db.query(
    `UPDATE gmail_push_notifications
        SET job_id = $4
      WHERE workspace_id = $1 AND mailbox_id = $2 AND provider_message_id = $3 AND job_id IS NULL`,
    [context.scope.workspaceId, mailbox.id, notification.providerMessageId, coalesced.jobId],
  );

  return {
    accepted: true,
    workspaceId: mailbox.workspace_id,
    mailboxId: mailbox.id,
    firstDelivery,
    coalesced: coalesced.outcome,
    jobId: coalesced.jobId,
    notification,
  };
}

import type { Queryable } from '../db/queryable.ts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import type { EnvelopeCipher } from './envelope.ts';
import type { GmailClient, GmailOAuthConfig } from './gmailClient.ts';
import { openMailboxHold, readMailbox } from './mailboxes.ts';
import { accessForMailbox, holdForRevokedGrant } from './sync.ts';
import { WATCH_EXPIRY_ALARM_HOURS, WATCH_RENEWAL_INTERVAL_HOURS } from './types.ts';

/**
 * Gmail `watch` and its daily renewal (specification 12.3, 13.3, Appendix C).
 *
 * "Gmail watch is renewed daily; an alarm fires within two days of expiry." Gmail
 * expires a watch after seven days, so a daily renewal has six days of slack and the
 * alarm has two — which is the shape you want, because the alarm should fire while
 * there is still time to fix the thing rather than after push has already stopped.
 *
 * **The watch generation is its own counter, not the mailbox's.** `mailboxes
 * .generation` is the coverage generation: it advances when a cursor expires and a
 * recovery starts, and advancing it invalidates recoveries in flight. A daily watch
 * renewal must not do that. So `mailbox_watches.generation` counts renewals, and
 * Appendix C's `watch:{mailbox}:{generation}` names the renewal that is about to
 * happen — which also makes the key naturally different every day, so the job row can
 * be a fresh one rather than something to re-arm.
 *
 * **A renewal is cancel-then-insert in one transaction.**
 * `mailbox_watches_one_current` is a partial unique index over the uncancelled rows,
 * so two live watches for one mailbox is a database error rather than a duplicate
 * notification stream nobody notices.
 *
 * **A stale renewal writes nothing.** The handler is protected by a fencing token
 * (Appendix C) and additionally refuses when the generation it was given is not the
 * next one, so a job that sat in the queue through two renewals cannot overwrite the
 * newer watch with an older expiry.
 */

export interface WatchRow {
  readonly id: string;
  readonly mailboxId: string;
  readonly generation: number;
  readonly topicName: string;
  readonly expiresAt: string;
  readonly registeredAt: string;
}

interface WatchDbRow {
  readonly id: string;
  readonly mailbox_id: string;
  readonly generation: number;
  readonly topic_name: string;
  readonly expires_at: Date;
  readonly registered_at: Date;
  readonly [column: string]: unknown;
}

const toWatch = (row: WatchDbRow): WatchRow => ({
  id: row.id,
  mailboxId: row.mailbox_id,
  generation: row.generation,
  topicName: row.topic_name,
  expiresAt: row.expires_at.toISOString(),
  registeredAt: row.registered_at.toISOString(),
});

export async function readCurrentWatch(
  context: RepositoryContext,
  mailboxId: string,
): Promise<WatchRow | null> {
  const { rows } = await context.db.query<WatchDbRow>(
    `SELECT id, mailbox_id, generation, topic_name, expires_at, registered_at
       FROM mailbox_watches
      WHERE workspace_id = $1 AND mailbox_id = $2 AND cancelled_at IS NULL`,
    [context.scope.workspaceId, mailboxId],
  );
  const row = rows[0];
  return row === undefined ? null : toWatch(row);
}

/** The renewal number a `watch:{mailbox}:{generation}` key should name next. */
export async function nextWatchGeneration(context: RepositoryContext, mailboxId: string): Promise<number> {
  const { rows } = await context.db.query<{ generation: number | null }>(
    'SELECT max(generation) AS generation FROM mailbox_watches WHERE workspace_id = $1 AND mailbox_id = $2',
    [context.scope.workspaceId, mailboxId],
  );
  return (rows[0]?.generation ?? 0) + 1;
}

export interface WatchRenewalDeps {
  readonly gmail: GmailClient;
  readonly oauth: GmailOAuthConfig;
  readonly cipher: EnvelopeCipher;
  /** The fully qualified Pub/Sub topic `infra/modules/pubsub` outputs. */
  readonly topicName: string;
}

export type WatchRenewalOutcome =
  | 'renewed'
  | 'mailbox_unknown'
  | 'mailbox_inactive'
  | 'generation_superseded'
  | 'grant_revoked'
  | 'provider_refusal';

export interface WatchRenewalReport {
  readonly outcome: WatchRenewalOutcome;
  readonly mailboxId: string;
  readonly generation: number;
  readonly expiresAt: string | null;
}

export async function renewWatch(
  context: RepositoryContext,
  deps: WatchRenewalDeps,
  input: { readonly mailboxId: string; readonly generation: number },
): Promise<WatchRenewalReport> {
  const mailbox = await readMailbox(context, input.mailboxId);
  if (mailbox === null) {
    return { outcome: 'mailbox_unknown', mailboxId: input.mailboxId, generation: input.generation, expiresAt: null };
  }
  if (mailbox.status !== 'connected') {
    await openMailboxHold(context, {
      mailboxId: mailbox.id,
      ownerUserId: mailbox.ownerUserId,
      reasonCode: 'mailbox_disconnected',
    });
    return { outcome: 'mailbox_inactive', mailboxId: mailbox.id, generation: input.generation, expiresAt: null };
  }

  // The generation is the fence. A renewal that was queued two renewals ago must not
  // register a watch and then record an expiry that is older than the live one.
  const expected = await nextWatchGeneration(context, mailbox.id);
  if (input.generation !== expected) {
    return {
      outcome: 'generation_superseded',
      mailboxId: mailbox.id,
      generation: input.generation,
      expiresAt: null,
    };
  }

  const access = await accessForMailbox(context, deps, mailbox.id);
  if (!access.ok) {
    await holdForRevokedGrant(context, mailbox);
    return { outcome: 'grant_revoked', mailboxId: mailbox.id, generation: input.generation, expiresAt: null };
  }

  const registered = await deps.gmail.watch(access.access, { topicName: deps.topicName });
  if (!registered.ok) {
    if (registered.reason === 'grant_revoked') {
      await holdForRevokedGrant(context, mailbox);
      return { outcome: 'grant_revoked', mailboxId: mailbox.id, generation: input.generation, expiresAt: null };
    }
    return { outcome: 'provider_refusal', mailboxId: mailbox.id, generation: input.generation, expiresAt: null };
  }

  const expiresAt = new Date(registered.watch.expiresAtEpochMilliseconds).toISOString();
  await context.db.query(
    `UPDATE mailbox_watches
        SET cancelled_at = now(), cancelled_reason = 'renewed'
      WHERE workspace_id = $1 AND mailbox_id = $2 AND cancelled_at IS NULL`,
    [context.scope.workspaceId, mailbox.id],
  );
  await context.db.query(
    `INSERT INTO mailbox_watches (workspace_id, mailbox_id, generation, topic_name, provider_history_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      context.scope.workspaceId,
      mailbox.id,
      input.generation,
      deps.topicName,
      registered.watch.historyId,
      expiresAt,
    ],
  );

  return { outcome: 'renewed', mailboxId: mailbox.id, generation: input.generation, expiresAt };
}

/** Stop the watch and cancel the row. Called by disconnect and by departure. */
export async function cancelWatch(
  context: RepositoryContext,
  input: { readonly mailboxId: string; readonly reason: string },
): Promise<void> {
  await context.db.query(
    `UPDATE mailbox_watches
        SET cancelled_at = now(), cancelled_reason = $3
      WHERE workspace_id = $1 AND mailbox_id = $2 AND cancelled_at IS NULL`,
    [context.scope.workspaceId, input.mailboxId, input.reason.slice(0, 200)],
  );
}

export interface WatchDueRow {
  readonly workspaceId: string;
  readonly mailboxId: string;
  readonly generation: number;
  readonly expiresAt: string | null;
}

/**
 * Every connected mailbox whose watch needs renewing: none registered, or one within
 * `WATCH_RENEWAL_INTERVAL_HOURS` of expiry.
 *
 * The generation returned is the *next* one, so the scheduler's key is
 * `watch:{mailbox}:{next}` and a pass that repeats inside the same minute composes
 * the same key and inserts nothing twice.
 */
export async function listWatchesDue(db: Queryable, nowIso: string): Promise<readonly WatchDueRow[]> {
  const { rows } = await db.query<{
    workspace_id: string;
    mailbox_id: string;
    next_generation: number;
    expires_at: Date | null;
  }>(
    `SELECT m.workspace_id,
            m.id AS mailbox_id,
            coalesce(max(w.generation), 0) + 1 AS next_generation,
            max(w.expires_at) FILTER (WHERE w.cancelled_at IS NULL) AS expires_at
       FROM mailboxes AS m
       LEFT JOIN mailbox_watches AS w ON w.workspace_id = m.workspace_id AND w.mailbox_id = m.id
      WHERE m.status = 'connected'
      GROUP BY m.workspace_id, m.id
     HAVING max(w.expires_at) FILTER (WHERE w.cancelled_at IS NULL) IS NULL
         OR max(w.expires_at) FILTER (WHERE w.cancelled_at IS NULL)
            <= $1::timestamptz + make_interval(hours => $2::integer)
      ORDER BY m.id`,
    [nowIso, WATCH_RENEWAL_INTERVAL_HOURS],
  );
  return rows.map(row => ({
    workspaceId: row.workspace_id,
    mailboxId: row.mailbox_id,
    generation: row.next_generation,
    expiresAt: row.expires_at?.toISOString() ?? null,
  }));
}

/**
 * The hours until the soonest watch expiry, across every connected mailbox, or null
 * when there is nothing to watch.
 *
 * This is `GmailWatchHoursToExpiry` (13.3), and the alarm in
 * `infra/modules/alerts/main.tf` fires below `var.gmail_watch_expiry_hours`. A
 * mailbox that is connected and has *no* watch at all reports zero rather than
 * nothing: no watch is the state the alarm most needs to fire on, and "no data" is
 * treated as not breaching.
 */
export async function hoursToSoonestWatchExpiry(db: Queryable): Promise<number | null> {
  const { rows } = await db.query<{ hours: string | null; unwatched: string }>(
    `SELECT extract(epoch FROM min(w.expires_at) - now()) / 3600 AS hours,
            count(*) FILTER (WHERE w.id IS NULL)::text AS unwatched
       FROM mailboxes AS m
       LEFT JOIN mailbox_watches AS w
         ON w.workspace_id = m.workspace_id AND w.mailbox_id = m.id AND w.cancelled_at IS NULL
      WHERE m.status = 'connected'`,
  );
  const row = rows[0];
  if (row === undefined) return null;
  if (Number(row.unwatched) > 0) return 0;
  return row.hours === null ? null : Number(row.hours);
}

export { WATCH_EXPIRY_ALARM_HOURS, WATCH_RENEWAL_INTERVAL_HOURS };

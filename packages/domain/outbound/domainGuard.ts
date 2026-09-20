import type { RepositoryContext } from '../db/workspaceScope.ts';
import { DEFAULT_PERSONAL_GMAIL_GUARD, DOMAIN_GUARD_WINDOW_HOURS, isPersonalGmailAddress } from './types.ts';

/**
 * The rolling primary-domain guard (specification 12.6).
 *
 * "Because Google's bulk-sender rules can require one-click unsubscribe for
 * promotional traffic near 5,000 daily personal-Gmail recipients from a primary
 * domain, FSS enforces a rolling primary-domain guard at 4,000 personal-Gmail
 * recipients per 24 hours while reply-only opt-out remains configured. Reaching the
 * guard holds further affected sends and requires a reviewed product-policy change;
 * it cannot be bypassed with extra mailboxes."
 *
 * Four decisions follow from that paragraph, and each is easy to get subtly wrong.
 *
 * **The count is per domain, across every mailbox.** The query below groups by
 * nothing: it counts every `sent` fence in the workspace whose recipient is a
 * personal Gmail address, inside the window. Connecting a second mailbox adds sends
 * to the same total. That is the whole of "cannot be bypassed with extra mailboxes",
 * and the reason the guard lives on `sending_domains` rather than on `mailboxes`.
 *
 * **Rolling, not daily.** The window is the last 24 hours from *now*, not the
 * business date. A guard that reset at midnight could be circumvented by sending
 * 4,000 at 23:00 and 4,000 at 01:00, which is 8,000 in two hours and exactly the
 * traffic shape Google's rule is about.
 *
 * **Messages, not distinct recipients.** Two messages to the same personal Gmail
 * address count twice. Google counts recipients, so this over-counts — deliberately.
 * A guard that under-counted would be no guard at all, and the cost of the
 * conservative reading is that the hold arrives slightly early.
 *
 * **It only applies while reply-only opt-out is configured.** 12.6 says so in the
 * same sentence, and the flag is on the domain row, because the day FSS offers a
 * one-click unsubscribe is the day this guard stops being the right rule — and that
 * day is a reviewed product-policy change, which is what `reply_only_opt_out` records.
 */

export interface SendingDomainRow {
  readonly id: string;
  readonly domain: string;
  readonly isPrimary: boolean;
  readonly spfPass: boolean;
  readonly dkimPass: boolean;
  readonly dmarcPass: boolean;
  readonly postmasterReviewedAt: string | null;
  readonly automatedSendingEnabled: boolean;
  readonly personalGmailGuardPer24h: number;
  readonly replyOnlyOptOut: boolean;
}

type DomainDbRow = {
  id: string;
  domain: string;
  is_primary: boolean;
  spf_pass: boolean;
  dkim_pass: boolean;
  dmarc_pass: boolean;
  postmaster_reviewed_at: Date | null;
  automated_sending_enabled: boolean;
  personal_gmail_guard_per_24h: number;
  reply_only_opt_out: boolean;
};

const DOMAIN_COLUMNS =
  `id, domain, is_primary, spf_pass, dkim_pass, dmarc_pass, postmaster_reviewed_at,
   automated_sending_enabled, personal_gmail_guard_per_24h, reply_only_opt_out`;

function toDomain(row: DomainDbRow): SendingDomainRow {
  return {
    id: row.id,
    domain: row.domain,
    isPrimary: row.is_primary,
    spfPass: row.spf_pass,
    dkimPass: row.dkim_pass,
    dmarcPass: row.dmarc_pass,
    postmasterReviewedAt: row.postmaster_reviewed_at?.toISOString() ?? null,
    automatedSendingEnabled: row.automated_sending_enabled,
    personalGmailGuardPer24h: row.personal_gmail_guard_per_24h,
    replyOnlyOptOut: row.reply_only_opt_out,
  };
}

export async function readPrimarySendingDomain(
  context: RepositoryContext,
): Promise<SendingDomainRow | null> {
  const { rows } = await context.db.query<DomainDbRow>(
    `SELECT ${DOMAIN_COLUMNS} FROM sending_domains WHERE workspace_id = $1 AND is_primary`,
    [context.scope.workspaceId],
  );
  const row = rows[0];
  return row === undefined ? null : toDomain(row);
}

export async function readSendingDomain(
  context: RepositoryContext,
  domain: string,
): Promise<SendingDomainRow | null> {
  const { rows } = await context.db.query<DomainDbRow>(
    `SELECT ${DOMAIN_COLUMNS} FROM sending_domains WHERE workspace_id = $1 AND domain = $2`,
    [context.scope.workspaceId, domain.toLowerCase()],
  );
  const row = rows[0];
  return row === undefined ? null : toDomain(row);
}

/**
 * How many personal-Gmail recipients this workspace's primary domain has written to
 * in the rolling window.
 *
 * Two sources are summed, because 12.7 is explicit that "All outgoing Gmail messages,
 * including direct sends, count toward operational headroom": the fences FSS sent,
 * and the outgoing messages the mail sync imported that FSS did not send. Counting
 * only the first would let a salesperson's own bulk mail-merge push the domain past
 * Google's threshold with FSS reporting plenty of headroom.
 *
 * The direct half is deliberately imprecise about the recipient: `mail_messages`
 * keeps the header allowlist, so the normalized `header_to` array is what there is,
 * and a message is counted once when *any* of its recipients is on personal Gmail.
 * A direct send that FSS also has a fence for is excluded, so the two halves cannot
 * double-count the same message when the sync imports something FSS sent.
 */
export async function personalGmailRecipientsInWindow(
  context: RepositoryContext,
  options: { readonly windowHours?: number | undefined } = {},
): Promise<{ readonly automated: number; readonly direct: number; readonly total: number }> {
  const hours = options.windowHours ?? DOMAIN_GUARD_WINDOW_HOURS;
  const automated = await context.db.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM outbound_messages
      WHERE workspace_id = $1
        AND state = 'sent'
        AND sent_at > now() - make_interval(hours => $2::integer)
        AND (split_part(recipient_address, '@', 2) = ANY ($3::text[]))`,
    [context.scope.workspaceId, hours, ['gmail.com', 'googlemail.com']],
  );
  const direct = await context.db.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM mail_messages AS m
       JOIN mailboxes AS b ON b.workspace_id = m.workspace_id AND b.id = m.mailbox_id
      WHERE m.workspace_id = $1
        AND m.direction = 'outgoing'
        AND m.internal_date > now() - make_interval(hours => $2::integer)
        AND EXISTS (
          SELECT 1 FROM unnest(m.header_to) AS recipient
           WHERE split_part(lower(recipient), '@', 2) = ANY ($3::text[])
        )
        AND NOT EXISTS (
          SELECT 1 FROM outbound_messages AS o
           WHERE o.workspace_id = m.workspace_id
             AND o.provider_message_id = m.provider_message_id
        )`,
    [context.scope.workspaceId, hours, ['gmail.com', 'googlemail.com']],
  );
  const automatedCount = Number(automated.rows[0]?.count ?? '0');
  const directCount = Number(direct.rows[0]?.count ?? '0');
  return { automated: automatedCount, direct: directCount, total: automatedCount + directCount };
}

export interface DomainGuardDecision {
  readonly allowed: boolean;
  readonly applies: boolean;
  readonly used: number;
  readonly guard: number;
  readonly headroom: number;
}

/**
 * Whether one more personal-Gmail recipient may be written to.
 *
 * `applies` is false for a recipient who is not on personal Gmail, and the guard is
 * not consulted for them at all — a Workspace mailbox on a customer's own domain is
 * not covered by Google's bulk-sender rule and holding it would be a self-inflicted
 * outage on traffic nobody objected to.
 */
export async function decideDomainGuard(
  context: RepositoryContext,
  input: {
    readonly recipientAddress: string;
    readonly domain: SendingDomainRow;
    readonly windowHours?: number | undefined;
  },
): Promise<DomainGuardDecision> {
  const applies = isPersonalGmailAddress(input.recipientAddress) && input.domain.replyOnlyOptOut;
  const guard = input.domain.personalGmailGuardPer24h ?? DEFAULT_PERSONAL_GMAIL_GUARD;
  if (!applies) {
    return { allowed: true, applies: false, used: 0, guard, headroom: guard };
  }
  const counted = await personalGmailRecipientsInWindow(context, {
    ...(input.windowHours === undefined ? {} : { windowHours: input.windowHours }),
  });
  return {
    allowed: counted.total < guard,
    applies: true,
    used: counted.total,
    guard,
    headroom: Math.max(guard - counted.total, 0),
  };
}

/** The admin checklist of 12.7, as one question. */
export function authenticationPasses(domain: SendingDomainRow): boolean {
  return domain.spfPass && domain.dkimPass && domain.dmarcPass && domain.postmasterReviewedAt !== null;
}

export type ChecklistOutcome =
  | { readonly ok: true; readonly domain: SendingDomainRow }
  | { readonly ok: false; readonly reason: 'domain_unknown' | 'authentication_incomplete' };

/**
 * Record the admin's DNS checklist.
 *
 * The application never queries DNS. These three booleans are a person saying they
 * looked, and the row records who and when, because that is the only evidence that
 * exists for a claim nothing in this process can verify.
 */
export async function recordAuthenticationChecklist(
  context: RepositoryContext,
  input: {
    readonly domain: string;
    readonly adminUserId: string;
    readonly spfPass: boolean;
    readonly dkimPass: boolean;
    readonly dmarcPass: boolean;
    readonly postmasterReviewed: boolean;
  },
): Promise<ChecklistOutcome> {
  const { rows } = await context.db.query<DomainDbRow>(
    `UPDATE sending_domains
        SET spf_pass = $3, dkim_pass = $4, dmarc_pass = $5,
            authentication_checked_at = now(),
            authentication_checked_by_user_id = $6,
            postmaster_reviewed_at = CASE WHEN $7 THEN now() ELSE NULL END,
            -- Sending is disabled the moment any leg of the checklist stops passing.
            -- 12.7 makes authentication a precondition, not a one-time ceremony.
            automated_sending_enabled = CASE
              WHEN $3 AND $4 AND $5 AND $7 THEN automated_sending_enabled ELSE false END,
            automated_sending_enabled_at = CASE
              WHEN $3 AND $4 AND $5 AND $7 THEN automated_sending_enabled_at ELSE NULL END,
            updated_at = now()
      WHERE workspace_id = $1 AND domain = $2
      RETURNING ${DOMAIN_COLUMNS}`,
    [
      context.scope.workspaceId,
      input.domain.toLowerCase(),
      input.spfPass,
      input.dkimPass,
      input.dmarcPass,
      input.adminUserId,
      input.postmasterReviewed,
    ],
  );
  const row = rows[0];
  if (row === undefined) return { ok: false, reason: 'domain_unknown' };
  return { ok: true, domain: toDomain(row) };
}

/**
 * Enable automated sending for a domain (12.7's gate).
 *
 * The CHECK on the table refuses this when the checklist is incomplete, so the
 * refusal here is the friendly half of a rule the database would enforce anyway —
 * which is the right order: the database is what makes it true, the function is what
 * makes it legible.
 */
export async function setAutomatedSendingEnabled(
  context: RepositoryContext,
  input: { readonly domain: string; readonly enabled: boolean },
): Promise<ChecklistOutcome> {
  const existing = await readSendingDomain(context, input.domain);
  if (existing === null) return { ok: false, reason: 'domain_unknown' };
  if (input.enabled && !authenticationPasses(existing)) {
    return { ok: false, reason: 'authentication_incomplete' };
  }
  const { rows } = await context.db.query<DomainDbRow>(
    `UPDATE sending_domains
        SET automated_sending_enabled = $3,
            automated_sending_enabled_at = CASE WHEN $3 THEN now() ELSE NULL END,
            updated_at = now()
      WHERE workspace_id = $1 AND domain = $2
      RETURNING ${DOMAIN_COLUMNS}`,
    [context.scope.workspaceId, input.domain.toLowerCase(), input.enabled],
  );
  const row = rows[0];
  if (row === undefined) return { ok: false, reason: 'domain_unknown' };
  return { ok: true, domain: toDomain(row) };
}

/**
 * Change the guard itself. 12.6: "requires a reviewed product-policy change".
 *
 * There is no command surface for this in G7-2 and that is deliberate: the value is
 * a column so that a change is an audited UPDATE rather than a release, but making
 * it a button would turn "reviewed product-policy change" into "an admin in a hurry".
 * An operator changes it with a migration-style script and a record of the review.
 */
export async function setPersonalGmailGuard(
  context: RepositoryContext,
  input: { readonly domain: string; readonly guard: number; readonly reviewReference: string },
): Promise<ChecklistOutcome> {
  if (input.reviewReference.trim().length === 0) return { ok: false, reason: 'domain_unknown' };
  const { rows } = await context.db.query<DomainDbRow>(
    `UPDATE sending_domains SET personal_gmail_guard_per_24h = $3, updated_at = now()
      WHERE workspace_id = $1 AND domain = $2 RETURNING ${DOMAIN_COLUMNS}`,
    [context.scope.workspaceId, input.domain.toLowerCase(), input.guard],
  );
  const row = rows[0];
  if (row === undefined) return { ok: false, reason: 'domain_unknown' };
  return { ok: true, domain: toDomain(row) };
}

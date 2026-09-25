import type { RepositoryContext } from '../db/workspaceScope.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import {
  DEFAULT_PERSONAL_GMAIL_GUARD,
  DOMAIN_GUARD_WINDOW_HOURS,
  PERSONAL_GMAIL_DOMAINS,
  isPersonalGmailAddress,
} from './types.ts';

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
 * **Recipient exposure, never fewer than Google could count** (lane g87, audit S08).
 * Every personal-Gmail recipient of every message counts once per message: two
 * messages to the same address count twice, and one direct message to five Gmail
 * addresses counts five. Google counts recipients, so across messages this
 * over-counts — deliberately. An FSS send counts from the moment it is claimed, not
 * from the moment it is proved sent: a fence in `dispatching`, `reconciling` or
 * `unknown_terminal` may have left, so it is reserved against the guard exactly as a
 * sent one is. A guard that under-counted would be no guard at all, and the cost of
 * the conservative reading is that the hold arrives slightly early.
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
 * How a sending domain comes to exist (lane g57).
 *
 * Until this function nothing inserted into `sending_domains` outside the tests and the
 * rehearsal's drill-evidence seed: `recordAuthenticationChecklist`,
 * `setAutomatedSendingEnabled` and `setPersonalGmailGuard` are all `UPDATE`s, so a
 * production workspace with a connected mailbox read "No sending domain is configured."
 * in Administration and had nowhere to record 12.7's checklist — the UPDATE answered
 * `domain_unknown` for a row nobody had written. Three callers now reach this:
 *
 *   * `mailbox_connect` — the Gmail callback registers the connected address's domain,
 *     which is the zero-step path: the mailbox a person connected *is* the domain FSS
 *     sends from;
 *   * `operator` — `fss admin workspace bootstrap --sending-domain`, for a workspace
 *     whose mailbox connected before this function existed;
 *   * `admin` — `POST /outbound/domain`, for a future desktop control.
 *
 * ## What it never does
 *
 * **It never changes a row that exists.** A re-registration returns the row as it is.
 * The checklist columns are a person's recorded confirmation and the enable is 12.7's
 * gate; a mailbox reconnect or a bootstrap re-run that reset either would silently
 * close sending, or worse, and neither caller has any business deciding that. `ON
 * CONFLICT DO NOTHING` rather than `DO UPDATE` is the structural form of that sentence.
 *
 * **It never moves the primary.** A new row is primary only when the workspace has no
 * primary at all; otherwise it is registered beside it. Which domain the 12.6 guard
 * counts against is not something a reconnect may change as a side effect.
 *
 * **It never registers personal Gmail.** `gmail.com` and `googlemail.com` are the
 * recipient class 12.6's guard exists for, not a domain whose DNS anybody at Callie
 * can attest to; a sending-domain row for one would be a checklist nobody can
 * truthfully tick.
 */
export type SendingDomainRegistrar = 'mailbox_connect' | 'operator' | 'admin';

export type SendingDomainRefusal = 'domain_invalid' | 'personal_gmail_domain';

export type RegisterSendingDomainOutcome =
  | { readonly ok: true; readonly outcome: 'created' | 'existing'; readonly domain: SendingDomainRow }
  | { readonly ok: false; readonly reason: SendingDomainRefusal };

/** The shape `sending_domains_domain_shape` (migration 0010) accepts, spelled the same way. */
const DOMAIN_SHAPE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/u;
const MAX_DOMAIN_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;

/**
 * A domain as the table stores it, or the reason it is not one.
 *
 * Lower-cased and trimmed, then held to the CHECK's own pattern so a refusal names the
 * rule rather than arriving as a constraint violation. Two things the CHECK does not
 * say are refused here as well: a label longer than DNS allows, and an all-digit last
 * label, which is an IPv4 address rather than a host a mailbox can be on. A value with
 * an `@`, a scheme or a path fails the pattern, which is the point — the caller passes
 * a domain, and an address is the connect path's to split.
 */
export function normalizeSendingDomain(
  value: string,
): { readonly ok: true; readonly domain: string } | { readonly ok: false; readonly reason: SendingDomainRefusal } {
  const domain = value.trim().toLowerCase();
  if (domain.length === 0 || domain.length > MAX_DOMAIN_LENGTH || !DOMAIN_SHAPE.test(domain)) {
    return { ok: false, reason: 'domain_invalid' };
  }
  const labels = domain.split('.');
  if (labels.some(label => label.length > MAX_LABEL_LENGTH) || /^[0-9]+$/u.test(labels[labels.length - 1] ?? '')) {
    return { ok: false, reason: 'domain_invalid' };
  }
  if (PERSONAL_GMAIL_DOMAINS.has(domain)) return { ok: false, reason: 'personal_gmail_domain' };
  return { ok: true, domain };
}

/**
 * How many times a registration re-reads after an insert that inserted nothing.
 *
 * `ON CONFLICT DO NOTHING` answers two different races with the same empty result: a
 * concurrent registration of *this* domain won (the next read returns its row), or a
 * concurrent registration of *another* domain took the primary between the `NOT
 * EXISTS` and the insert (the next insert computes `false` and succeeds). Each race
 * costs one pass; three is two more than a single-user workspace will ever need.
 */
const REGISTRATION_PASSES = 3;

export async function registerSendingDomain(
  context: RepositoryContext,
  input: { readonly domain: string; readonly registeredBy: SendingDomainRegistrar },
): Promise<RegisterSendingDomainOutcome> {
  const normalized = normalizeSendingDomain(input.domain);
  if (!normalized.ok) return normalized;
  const domain = normalized.domain;

  for (let pass = 0; pass < REGISTRATION_PASSES; pass += 1) {
    const existing = await readSendingDomain(context, domain);
    if (existing !== null) return { ok: true, outcome: 'existing', domain: existing };

    // Every checklist column takes its default — false, null — so
    // `sending_domains_passes_are_checked` holds without anybody having looked, and
    // the enable stays closed until an admin records all four.
    const { rows } = await context.db.query<DomainDbRow>(
      `INSERT INTO sending_domains (workspace_id, domain, is_primary)
       VALUES ($1::uuid, $2::text, NOT EXISTS (
         SELECT 1 FROM sending_domains WHERE workspace_id = $1::uuid AND is_primary
       ))
       ON CONFLICT DO NOTHING
       RETURNING ${DOMAIN_COLUMNS}`,
      [context.scope.workspaceId, domain],
    );
    const row = rows[0];
    if (row === undefined) continue;

    const created = toDomain(row);
    await recordCrmAuditEvent(context, {
      action: 'sending_domain.registered',
      subjectKind: 'sending_domain',
      subjectId: created.id,
      detail: { domain: created.domain, isPrimary: created.isPrimary, registeredBy: input.registeredBy },
    });
    return { ok: true, outcome: 'created', domain: created };
  }
  throw new Error(`the registration of a sending domain did not settle in ${String(REGISTRATION_PASSES)} passes`);
}

/**
 * The connect path's half: the domain of the address a mailbox just connected.
 *
 * The address has already been through the Gmail profile and, in every deployment,
 * through `completeGmailGrant`'s hosted-domain check, so the split cannot meet an
 * address without an `@`; it is still refused as `domain_invalid` rather than
 * assumed, because the next caller of this may not have made that check.
 */
export async function registerMailboxSendingDomain(
  context: RepositoryContext,
  input: { readonly emailAddress: string },
): Promise<RegisterSendingDomainOutcome> {
  const address = input.emailAddress.trim();
  const at = address.lastIndexOf('@');
  if (at <= 0 || at === address.length - 1) return { ok: false, reason: 'domain_invalid' };
  return await registerSendingDomain(context, { domain: address.slice(at + 1), registeredBy: 'mailbox_connect' });
}

/** The fence states in which an FSS send may have reached Gmail: every state after the claim. */
const CLAIMED_STATES = ['dispatching', 'reconciling', 'sent', 'unknown_terminal'] as const;

/**
 * How many personal-Gmail recipients this workspace's primary domain has written to
 * in the rolling window.
 *
 * Two sources are summed, because 12.7 is explicit that "All outgoing Gmail messages,
 * including direct sends, count toward operational headroom": the fences FSS claimed,
 * and the outgoing messages the mail sync imported that FSS did not send. Counting
 * only the first would let a salesperson's own bulk mail-merge push the domain past
 * Google's threshold with FSS reporting plenty of headroom.
 *
 * **`automated`** is every fence to a personal-Gmail address whose dispatch began in
 * the window, in any state after the claim (lane g87, S08). Until g87 only `sent`
 * counted, so a fence in doubt — which may well have been delivered — left the guard
 * the moment Gmail went quiet, and the next claim saw room that was not there. Its
 * instant is the later of the claim and the proven send, so a fence stays in the
 * window at least as long as either says. A fence carries exactly one recipient.
 *
 * **`direct`** is every personal-Gmail recipient on the `To` and `Cc` of every
 * imported outgoing message, counted once per message (lane g87, S08). Until g87 a
 * direct message counted one however many Gmail recipients it named, so a mail merge
 * sent as one message to forty addresses moved the guard by one. `Bcc` is not in 12.3's
 * header allowlist and so is not in `mail_messages`; it is the one recipient this
 * count cannot see, named in the decision record.
 *
 * A message FSS sent is excluded from `direct` exactly when its fence is counted in
 * `automated`: a claimed fence in the same mailbox with the message's Gmail id or its
 * deterministic `Message-ID` (the pair `fenceForOutgoingMessage` matches on). So the
 * sync importing FSS's own send cannot count it twice, and a fence that never reached
 * the claim cannot hide a message from both halves.
 *
 * The answer keeps the shape the desktop parses (`{ automated, direct, total }`,
 * `personalGmailRecipientsSchema` in `@fss/contracts`); the in-doubt part is inside
 * `automated`, not beside it.
 */
export async function personalGmailRecipientsInWindow(
  context: RepositoryContext,
  options: { readonly windowHours?: number | undefined } = {},
): Promise<{ readonly automated: number; readonly direct: number; readonly total: number }> {
  const hours = options.windowHours ?? DOMAIN_GUARD_WINDOW_HOURS;
  const personal = [...PERSONAL_GMAIL_DOMAINS];
  const automated = await context.db.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM outbound_messages
      WHERE workspace_id = $1
        AND state = ANY ($4::text[])
        AND greatest(dispatch_started_at, sent_at) > now() - make_interval(hours => $2::integer)
        AND lower(substring(recipient_address from '@([^@]*)$')) = ANY ($3::text[])`,
    [context.scope.workspaceId, hours, personal, CLAIMED_STATES],
  );
  const direct = await context.db.query<{ count: string }>(
    `SELECT coalesce(sum(exposure.recipients), 0)::text AS count
       FROM mail_messages AS m
       CROSS JOIN LATERAL (
         SELECT count(DISTINCT lower(recipient)) AS recipients
           FROM unnest(m.header_to || m.header_cc) AS recipient
          WHERE lower(substring(recipient from '@([^@]*)$')) = ANY ($3::text[])
       ) AS exposure
      WHERE m.workspace_id = $1
        AND m.direction = 'outgoing'
        AND m.internal_date > now() - make_interval(hours => $2::integer)
        AND NOT EXISTS (
          SELECT 1 FROM outbound_messages AS o
           WHERE o.workspace_id = m.workspace_id
             AND o.mailbox_id = m.mailbox_id
             AND o.state = ANY ($4::text[])
             AND (o.provider_message_id = m.provider_message_id
                  OR (m.rfc_message_id IS NOT NULL
                      AND o.provider_message_id_header = '<' || m.rfc_message_id || '>'))
        )`,
    [context.scope.workspaceId, hours, personal, CLAIMED_STATES],
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
 * Serialize the guard's decisions for one workspace, for the rest of the transaction
 * (lane g87, S08).
 *
 * Every dispatch claim takes the send gate *shared*, so two claims to personal Gmail
 * from two mailboxes run side by side, each counts the other's fence as not yet
 * claimed, and both take the last place under the guard. Counting a claimed fence as
 * reserved only helps once the next decision can see it, and this lock is what makes
 * it see it: the claim holds it from its count to its commit, the next claim's count
 * waits, and then reads the fence in `dispatching`.
 *
 * Taken after every row lock the claim already holds (the ramp, the day) and by
 * nothing but a claim, so it adds no lock-order cycle: two claims on one mailbox have
 * already queued on the day's row, and claims on different mailboxes wait only here.
 * Outside a transaction — the precheck — it is held for the one statement and gone,
 * which is harmless.
 */
export async function lockDomainGuard(context: RepositoryContext): Promise<void> {
  await context.db.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('fss.domain-guard:' || $1::text, 0))",
    [context.scope.workspaceId],
  );
}

/**
 * Whether one more personal-Gmail recipient may be written to.
 *
 * `applies` is false for a recipient who is not on personal Gmail, and the guard is
 * not consulted for them at all — a Workspace mailbox on a customer's own domain is
 * not covered by Google's bulk-sender rule and holding it would be a self-inflicted
 * outage on traffic nobody objected to.
 *
 * `serialize` is the dispatch gate's: it takes `lockDomainGuard` before counting, so
 * the decision and the claim it licenses are one step as far as every other claim is
 * concerned. A read-only caller — the status route's headroom — leaves it off.
 */
export async function decideDomainGuard(
  context: RepositoryContext,
  input: {
    readonly recipientAddress: string;
    readonly domain: SendingDomainRow;
    readonly windowHours?: number | undefined;
    readonly serialize?: boolean | undefined;
  },
): Promise<DomainGuardDecision> {
  const applies = isPersonalGmailAddress(input.recipientAddress) && input.domain.replyOnlyOptOut;
  const guard = input.domain.personalGmailGuardPer24h ?? DEFAULT_PERSONAL_GMAIL_GUARD;
  if (!applies) {
    return { allowed: true, applies: false, used: 0, guard, headroom: guard };
  }
  if (input.serialize === true) await lockDomainGuard(context);
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

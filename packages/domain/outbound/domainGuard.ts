import type { RepositoryContext } from '../db/workspaceScope.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import { PERSONAL_GMAIL_DOMAINS } from './types.ts';

/**
 * The workspace's sending domains (specification 12.7): the DNS checklist, the
 * automated-sending enable, and how a domain comes to exist.
 *
 * The rolling personal-Gmail guard and its recipient count lived here until 26
 * September 2026. With one mailbox, a hard ceiling of 100 automated sends a day could
 * never approach 4,000 personal-Gmail recipients, so the guard was deleted; its two
 * columns stay on `sending_domains` until a later migration drops them.
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
};

const DOMAIN_COLUMNS =
  'id, domain, is_primary, spf_pass, dkim_pass, dmarc_pass, postmaster_reviewed_at, automated_sending_enabled';

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
 * primary at all; otherwise it is registered beside it. Which domain the send gate
 * checks is not something a reconnect may change as a side effect.
 *
 * **It never registers personal Gmail.** `gmail.com` and `googlemail.com` are not
 * domains whose DNS anybody at Callie can attest to; a sending-domain row for one
 * would be a checklist nobody can truthfully tick.
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

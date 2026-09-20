/**
 * What the mail commands share (specification 12.1 to 12.4, 15).
 *
 * The same shape as the CRM's `CrmResult` and the policy lane's `PolicyResult`, and
 * for the same reason: a refusal is a value the command receipt can record, never an
 * exception that would roll the receipt back with the mutation.
 */

export const MAIL_REFUSAL_CODES = [
  'admin_only',
  'not_assigned',
  'invalid_input',
  'mailbox_unknown',
  'mailbox_inactive',
  'mailbox_already_connected',
  'mailbox_address_taken',
  'authorization_request_unknown',
  'grant_refused',
  'grant_revoked',
  'provider_refusal',
  'coverage_incomplete',
  'cursor_moved',
  'message_unknown',
  'match_unknown',
  'already_resolved',
] as const;
export type MailRefusalCode = (typeof MAIL_REFUSAL_CODES)[number];

export type MailResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: MailRefusalCode };

export function acceptMail<T>(value: T): MailResult<T> {
  return { ok: true, value };
}

export function refuseMail<T>(reason: MailRefusalCode): MailResult<T> {
  return { ok: false, reason };
}

/**
 * The two scopes FSS asks Google for, and nothing else (2, "Gmail: `gmail.readonly`
 * and `gmail.send` only").
 *
 * `gmail.readonly` rather than `gmail.metadata` is deliberate and Appendix B says
 * why: Sent-folder reconciliation uses an `rfc822msgid:` search, and the `q`
 * parameter is not available under `gmail.metadata`. A design that asked for the
 * narrower scope could not prove a send happened, which is the whole of at-most-once.
 */
export const GMAIL_SCOPES: readonly string[] = Object.freeze([
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
]);

/**
 * The header allowlist of 12.3. A metadata read asks for these and no others, so a
 * message FSS never matched leaves behind the smallest record that can still be
 * matched later.
 */
export const METADATA_HEADERS: readonly string[] = Object.freeze([
  'From',
  'To',
  'Cc',
  'Subject',
  'Date',
  'Message-ID',
  'References',
  'In-Reply-To',
  'Auto-Submitted',
  'List-Id',
]);

/** 12.3: "500 IDs per page, and every page." */
export const RECOVERY_PAGE_SIZE = 500;

/** 12.3: the bounded full synchronization starts at "watermark minus one hour". */
export const RECOVERY_OVERLAP_SECONDS = 3600;

/**
 * The recent-history interval a newly connected mailbox baselines over when nothing
 * older needs covering. Configuration in 12.3 ("the configured recent-history
 * interval"); this is its default, and `connectMailbox` takes an override.
 */
export const DEFAULT_BASELINE_DAYS = 30;

/** 13.3: "Gmail watch within two days of expiry" is the alarm. */
export const WATCH_EXPIRY_ALARM_HOURS = 48;

/** Gmail expires a watch after seven days; the renewal runs daily (12.3). */
export const WATCH_RENEWAL_INTERVAL_HOURS = 24;

/** The version stamped on every deterministic classification row. */
export const DETERMINISTIC_RULES_VERSION = 'reply.1';

export type MailboxStatus = 'connected' | 'disconnected' | 'revoked';
export type MailboxSyncState = 'baseline_pending' | 'ready' | 'recovering';
export type MailDirection = 'incoming' | 'outgoing';
export type MailMatchRule = 'thread' | 'message_id_reference' | 'participant';
export type MailClassificationLayer = 'deterministic' | 'model';

export const MAIL_EFFECT_KINDS = [
  'hold_opened',
  'opportunity_manual',
  'route_invalidated',
  'handle_suppressed',
  'firm_suppressed',
  'reply_lane_entry',
  'direct_send_manual',
  'no_effect',
] as const;
export type MailEffectKind = (typeof MAIL_EFFECT_KINDS)[number];

export interface MailboxRow {
  readonly id: string;
  readonly ownerUserId: string;
  readonly emailAddress: string;
  readonly providerAccountId: string | null;
  readonly status: MailboxStatus;
  readonly generation: number;
  readonly syncState: MailboxSyncState;
  readonly historyId: string | null;
  readonly coverageWatermarkAt: string | null;
  readonly baselineFromAt: string | null;
  readonly baselineCompletedAt: string | null;
  readonly lastSyncedAt: string | null;
  readonly lastSyncError: string | null;
}

export interface MailMessageRow {
  readonly id: string;
  readonly mailboxId: string;
  readonly providerMessageId: string;
  readonly providerThreadId: string;
  readonly rfcMessageId: string | null;
  readonly direction: MailDirection;
  readonly internalDate: string;
  readonly headerFrom: string | null;
  readonly headerTo: readonly string[];
  readonly headerCc: readonly string[];
  readonly subject: string | null;
  readonly referenceMessageIds: readonly string[];
  readonly inReplyTo: string | null;
  readonly autoSubmitted: string | null;
  readonly listId: string | null;
  readonly matched: boolean;
  readonly metadataOnly: boolean;
}

/**
 * A normalized email address. Lower-cased and stripped of any display name, which is
 * the same spelling `email_addresses.address` and the suppression canonicalizer both
 * produce, so a participant match needs no second rule.
 *
 * Returns null for anything that is not one address: a header FSS cannot read is not
 * a match it should guess at.
 */
export function normalizeAddress(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const angled = /<([^<>]+)>/.exec(raw);
  const candidate = (angled?.[1] ?? raw).trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(candidate) || candidate.length > 320) return null;
  return candidate;
}

/** Every address on a header line, normalized, in order, without duplicates. */
export function normalizeAddressList(raw: string | null | undefined): readonly string[] {
  if (raw === null || raw === undefined) return [];
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const address = normalizeAddress(part);
    if (address !== null) seen.add(address);
  }
  return [...seen];
}

/**
 * An RFC 5322 Message-ID without its angle brackets, or null.
 *
 * Stored unbracketed everywhere — on `mail_messages.rfc_message_id`, in
 * `reference_message_ids`, and on the outbound fence G7-2 adds — so that a
 * References header and a deterministic Message-ID compare as strings.
 */
export function normalizeMessageId(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim().replace(/^</, '').replace(/>$/, '').trim();
  if (trimmed.length === 0 || trimmed.length > 998 || /[<>\s]/.test(trimmed)) return null;
  return trimmed;
}

/** Every Message-ID on a References or In-Reply-To header, unbracketed, deduplicated. */
export function normalizeMessageIdList(raw: string | null | undefined): readonly string[] {
  if (raw === null || raw === undefined) return [];
  const seen = new Set<string>();
  for (const part of raw.split(/\s+/)) {
    const id = normalizeMessageId(part);
    if (id !== null) seen.add(id);
  }
  return [...seen];
}

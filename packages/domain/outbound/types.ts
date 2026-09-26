/**
 * The vocabulary of at-most-once sending (specification 12.5 to 12.7, Appendix B).
 *
 * Two ideas are worth having in mind before reading anything else in this package.
 *
 * **A refusal is a value.** Every reason a send does not happen — a cap, a window, a
 * hold, a guard, a suppression, an unapproved template — is a `SendRefusalCode` on a
 * returned object, not an exception. Sending is the one operation in this system
 * that cannot be undone, so the code that decides *not* to send is the code that
 * matters most, and it must be as easy to enumerate as a list.
 *
 * **`indeterminate` is not a failure.** It is the state Appendix B was written for:
 * the request may have arrived. Every type here that could collapse it into "failed"
 * deliberately does not.
 */

/** Appendix B's state machine, exactly. There is no seventh state. */
export const OUTBOUND_STATES = [
  'prepared',
  'held',
  'dispatching',
  'reconciling',
  'sent',
  'unknown_terminal',
] as const;
export type OutboundState = (typeof OUTBOUND_STATES)[number];

/** What `readOutboundOutcome` reports when no fence exists for an origin at all. */
export type OutboundOutcomeState = OutboundState | 'absent';

/** The states from which nothing further will ever be sent for this fence. */
export const TERMINAL_OUTBOUND_STATES: ReadonlySet<OutboundState> = new Set<OutboundState>([
  'sent',
  'unknown_terminal',
]);

/**
 * Why a send did not happen. Every one of these sets the fence `held` and leaves it
 * able to try again later.
 */
export const SEND_REFUSAL_CODES = [
  'fence_unknown',
  'fence_not_ready',
  'mailbox_unknown',
  'mailbox_inactive',
  'grant_revoked',
  'coverage_incomplete',
  'automated_sending_disabled',
  /**
   * 16.2's other half: the workspace attestation, or the deployment flag, says no.
   *
   * `automated_sending_disabled` is the *domain*'s answer — SPF, DKIM, DMARC and the
   * Postmaster review, on `sending_domains`. This one is the *release*'s answer:
   * `workspace_settings.sending_enabled` naming the rehearsal gate whose digests match
   * what is deployed, ANDed with the deployment's own flag. They are deliberately two
   * codes, because the two are fixed by different people doing different things, and a
   * single code would send an operator to the DNS records when the answer is that
   * nobody has enabled the release. See docs/decisions/g12-the-send-gate-reads-both-switches.md.
   */
  'workspace_sending_not_attested',
  'sending_domain_unknown',
  'template_unapproved',
  'template_mismatch',
  'route_invalid',
  'firm_suppressed',
  'handle_suppressed',
  'outside_email_window',
  'daily_cap',
  'rate_limited',
  'recipient_rejected',
  'provider_refusal',
  /**
   * The step's own eligibility said no at the last moment (lane g77): a reply's hold, a
   * pause, manual mode, a stopped enrollment, a reassignment. The detail is section
   * 15's code. It opens no hold of its own, because whatever refused already is one —
   * see `sendRefusalForIneligibility` in `stepPermission.ts`.
   */
  'step_ineligible',
] as const;
export type SendRefusalCode = (typeof SEND_REFUSAL_CODES)[number];

export type SendResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly reason: SendRefusalCode; readonly detail?: string | undefined };

export const acceptSend = <Value>(value: Value): SendResult<Value> => ({ ok: true, value });
export const refuseSend = <Value>(
  reason: SendRefusalCode,
  detail?: string,
): SendResult<Value> => ({ ok: false, reason, ...(detail === undefined ? {} : { detail }) });

/**
 * 12.7's ramp, as the specification writes it.
 *
 * | Healthy sending period | Daily automated cap |
 * |---|---:|
 * | First 5 sending days | 5 |
 * | Next 5 sending days | 10 |
 * | Next 5 sending days | 15 |
 * | Next 5 sending days | 25 |
 * | Weeks 5–6 | 35 |
 * | After six healthy weeks | 50 |
 *
 * "Weeks 5–6" is read as sending days 21 through 30 and "after six healthy weeks" as
 * day 31 onwards, because every other row of the table counts sending days and a
 * table that changed unit halfway would be a different table. Five sending days is a
 * week of weekdays, so the two readings agree.
 */
export const RAMP_SCHEDULE: readonly { readonly throughDay: number; readonly cap: number }[] =
  Object.freeze([
    { throughDay: 5, cap: 5 },
    { throughDay: 10, cap: 10 },
    { throughDay: 15, cap: 15 },
    { throughDay: 20, cap: 25 },
    { throughDay: 30, cap: 35 },
  ]);

/** What the schedule settles at. 12.7: "After six healthy weeks | 50". */
export const RAMP_SETTLED_CAP = 50;

/** 12.7: "version one has a hard automated ceiling of 100 per mailbox per business day". */
export const RAMP_HARD_CEILING = 100;

/** 12.7: "they may raise a mailbox to 75". The most an admin may set without a release. */
export const RAMP_ADMIN_RAISE_LIMIT = 75;

/**
 * Personal Gmail, `gmail.com` and its historical alias `googlemail.com`: never a
 * sending domain, because nobody at Callie can attest to its DNS.
 */
export const PERSONAL_GMAIL_DOMAINS: ReadonlySet<string> = new Set(['gmail.com', 'googlemail.com']);

/** Appendix B: "a bounded 24-hour observation window with backoff". */
export const RECONCILE_WINDOW_HOURS = 24;

/**
 * How long a reconciliation waits before looking again.
 *
 * Gmail's Sent index is usually current within seconds and occasionally takes
 * minutes, so the first few observations are close together and then back off. The
 * last entry repeats until the window expires.
 */
export const RECONCILE_BACKOFF_SECONDS: readonly number[] = Object.freeze([
  30, 60, 300, 900, 1800, 3600,
]);

export function reconcileBackoffSeconds(attempt: number): number {
  const index = Math.min(Math.max(attempt, 1), RECONCILE_BACKOFF_SECONDS.length) - 1;
  return RECONCILE_BACKOFF_SECONDS[index] ?? 3600;
}

/** The rule version recorded on a fence's placement, so a change is legible later. */
export const PLACEMENT_RULE_VERSION = 'email-window.1';

/** The `Message-ID` FSS writes, derived from the fence id and the sending domain. */
export function deterministicMessageId(outboundMessageId: string, sendingDomain: string): string {
  return `<fss.${outboundMessageId}@${sendingDomain}>`;
}

/** The fence id inside a deterministic Message-ID, or null if it is not one of ours. */
export function fenceIdOfMessageId(header: string): string | null {
  const match = /^<fss\.([0-9a-f-]{36})@[^<>@]+>$/.exec(header.trim());
  return match?.[1] ?? null;
}

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * The fence id a message in one mailbox's Sent folder carries, if FSS sent it from that
 * mailbox, or null (Appendix E step 3, lane g73).
 *
 * The marker is the *whole* deterministic Message-ID, not a prefix of it:
 * `<fss.{fence uuid}@{the sending mailbox's domain}>`, exactly as
 * `deterministicMessageId` writes it from the mailbox `prepareOutboundMessage` resolved.
 * Every FSS send carries it, because the header is written into the fence before the
 * one Gmail call and the MIME builder copies it verbatim; nothing else Gmail or a person
 * sends does, because Gmail mints `<CA…@mail.gmail.com>` ids for everything it composes.
 *
 * The domain is part of the marker for the step that reads it. A message in this
 * mailbox's Sent folder whose id has the `fss.<uuid>` shape but another domain was not
 * written by FSS for this mailbox — a copy, a forward that kept the header, another
 * system's scheme — and step 3 must not turn it into a tombstone that stops a real step
 * from sending. Never a subject or body heuristic: those are what a person types.
 */
export function fssFenceIdOfSentMessage(header: string, mailboxAddress: string): string | null {
  const trimmed = header.trim();
  const fenceId = fenceIdOfMessageId(trimmed);
  // A fence id is a canonical uuid, because `gen_random_uuid()` minted it. The looser
  // shape `fenceIdOfMessageId` accepts would let thirty-six hyphens reach a uuid cast
  // and stop a restore with an exception instead of ignoring a message that is not ours.
  if (fenceId === null || !CANONICAL_UUID.test(fenceId)) return null;
  const domain = trimmed.slice(trimmed.lastIndexOf('@') + 1, -1).toLowerCase();
  const sendingDomain = mailboxAddress.slice(mailboxAddress.lastIndexOf('@') + 1).trim().toLowerCase();
  return domain === sendingDomain ? fenceId : null;
}

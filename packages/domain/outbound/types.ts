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
 * Why a send did not happen.
 *
 * Every one of these sets the fence `held` and leaves it able to try again later,
 * except `domain_guard`, which 12.6 says "requires a reviewed product-policy change".
 * The fence is still held rather than terminal — the guard is a rolling window and
 * will pass — but the hold it opens is not in `RECOVERABLE_HOLD_REASON_CODES`, so no
 * control can clear it early.
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
  'domain_guard',
  'rate_limited',
  'recipient_rejected',
  'provider_refusal',
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

/** 12.6's rolling primary-domain guard. */
export const DEFAULT_PERSONAL_GMAIL_GUARD = 4000;
export const DOMAIN_GUARD_WINDOW_HOURS = 24;

/**
 * The recipient domains 12.6's guard counts.
 *
 * Google's bulk-sender rules are about "personal Gmail accounts", which are
 * `gmail.com` and its historical alias `googlemail.com`. A Workspace mailbox on a
 * customer's own domain is not one, and counting it would make the guard fire on
 * traffic the rule does not cover.
 */
export const PERSONAL_GMAIL_DOMAINS: ReadonlySet<string> = new Set(['gmail.com', 'googlemail.com']);

export function isPersonalGmailAddress(address: string): boolean {
  const at = address.lastIndexOf('@');
  return at > 0 && PERSONAL_GMAIL_DOMAINS.has(address.slice(at + 1).toLowerCase());
}

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

/**
 * `POST /outbound/status` as the API answers it (lane g69).
 *
 * Every key the route in `apps/api/src/routes/outbound.ts` sends, with a value of the
 * type it sends — including the parts the desktop does not read (`guard`, `doubt`,
 * `fence`, `replyOnlyOptOut`) — because a fixture that carries only what the client
 * expects proves only that the client agrees with itself. That is how 1.0.2 and 1.0.3
 * shipped a parser that failed on every real answer: this fixture said
 * `personalGmailRecipients: 1`, the parser said `z.number()`, and the route has always
 * sent `{ automated, direct, total }` (release.md 8.0ae).
 *
 * This file cannot import the route — the desktop package depends on `@fss/contracts`
 * alone, and the route publishes no schema there — so the release suite holds it to the
 * route instead: `test/release/sendingSection.check.ts` runs the real route against a
 * real database and asserts that its answer has exactly this shape, key for key and type
 * for type. A field the route adds, drops or retypes turns that check red before it can
 * turn a desktop parser red in production.
 *
 * Fictional data only: `example.test` is reserved by RFC 6761.
 */

export interface OutboundStatusAnswerOptions {
  /** Null for a workspace with no sending domain, as the route answers it. */
  readonly domain?: Readonly<Record<string, unknown>> | null;
  readonly personalGmailRecipients?: { readonly automated: number; readonly direct: number; readonly total: number };
  /** Null for the no-argument read; an object when a `mailboxId` was named. */
  readonly ramp?: Readonly<Record<string, unknown>> | null;
}

/** `describeDomain` in the route: the checklist, the enable, the guard and the opt-out rule. */
export function outboundDomainAnswer(overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return {
    domain: 'sending.example.test',
    spfPass: true,
    dkimPass: true,
    dmarcPass: false,
    postmasterReviewedAt: null,
    authenticationPasses: false,
    automatedSendingEnabled: false,
    personalGmailGuardPer24h: 4000,
    replyOnlyOptOut: true,
    ...overrides,
  };
}

/** The ramp of one mailbox, as the route answers a read that names it. */
export function outboundRampAnswer(mailboxId: string, overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return {
    mailboxId,
    healthySendingDays: 0,
    effectiveCap: 5,
    adminDailyCap: null,
    raisedDailyCap: null,
    lastHealthFailure: null,
    ...overrides,
  };
}

export function outboundStatusAnswer(options: OutboundStatusAnswerOptions = {}): Readonly<Record<string, unknown>> {
  const domain = options.domain === undefined ? outboundDomainAnswer() : options.domain;
  return {
    domain,
    // `decideDomainGuard` for a personal-Gmail recipient, or null with no domain.
    guard: domain === null ? null : { allowed: true, applies: true, used: 0, guard: 4000, headroom: 4000 },
    // `personalGmailRecipientsInWindow`: FSS's own sends, the direct ones the sync
    // imported, and their sum. An object, never a number.
    personalGmailRecipients: options.personalGmailRecipients ?? { automated: 0, direct: 0, total: 0 },
    // `outboundDoubtCounts`.
    doubt: { reconciling: 0, unresolvedTerminal: 0 },
    ramp: options.ramp ?? null,
    // Only when an `outboundMessageId` was named; the desktop never names one.
    fence: null,
  };
}

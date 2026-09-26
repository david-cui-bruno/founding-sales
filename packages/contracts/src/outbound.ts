import { z } from 'zod';
import { instant, uuid } from './foundationRows.ts';

/**
 * `POST /outbound/status`, the sending posture Administration shows (specification
 * 12.6, 12.7; lanes g69 and g78).
 *
 * The route builds its body inline in `apps/api/src/routes/outbound.ts`, and until lane
 * g78 this contract did not exist: the Mac declared the parts it read in
 * `apps/desktop/src/main/settingsBridge.ts`, `.loose()` all the way down so that an
 * unchecked field could ride along. That is the parser that read
 * `personalGmailRecipients` as a number for two releases (release.md 8.0ae). The whole
 * answer is declared here instead — the parts the desktop shows and the parts it does
 * not — and the route's test holds its real answer to it through `wireDrift`.
 */

/** Appendix B's state machine (`OUTBOUND_STATES`, `packages/domain/outbound/types.ts`). */
export const OUTBOUND_STATES = ['prepared', 'held', 'dispatching', 'reconciling', 'sent', 'unknown_terminal'] as const;
export type OutboundState = (typeof OUTBOUND_STATES)[number];

/** `describeDomain` in the route: the checklist and the enable. */
export const sendingDomainStatusSchema = z.object({
  domain: z.string().min(1).max(253),
  spfPass: z.boolean(),
  dkimPass: z.boolean(),
  dmarcPass: z.boolean(),
  postmasterReviewedAt: instant.nullable(),
  authenticationPasses: z.boolean(),
  automatedSendingEnabled: z.boolean(),
  /**
   * @deprecated The personal-Gmail guard was deleted on 26 Sep 2026; the API sends the
   * constant 4000. Kept because desktops up to 1.0.10 parse it as required. Remove in
   * wave 2, after desktop 1.0.11 (which must read it as optional) is in use.
   */
  personalGmailGuardPer24h: z.number().int().min(0),
  /** @deprecated Always `true`; see `personalGmailGuardPer24h`. */
  replyOnlyOptOut: z.boolean(),
});
export type SendingDomainStatus = z.infer<typeof sendingDomainStatusSchema>;

/**
 * @deprecated The guard was deleted on 26 Sep 2026; the API answers a constant decision
 * that always allows. Kept for desktops up to 1.0.10; remove in wave 2.
 */
export const domainGuardDecisionSchema = z.object({
  allowed: z.boolean(),
  applies: z.boolean(),
  used: z.number().int().min(0),
  guard: z.number().int().min(0),
  headroom: z.number().int(),
});

/**
 * @deprecated The recipient count went with the guard on 26 Sep 2026; the API answers
 * zeros. Kept for desktops up to 1.0.10; remove in wave 2.
 */
export const personalGmailRecipientsSchema = z.object({
  automated: z.number().int().min(0),
  direct: z.number().int().min(0),
  total: z.number().int().min(0),
});

/** `outboundDoubtCounts`. */
export const outboundDoubtSchema = z.object({
  reconciling: z.number().int().min(0),
  unresolvedTerminal: z.number().int().min(0),
});

/** One mailbox's ramp, present only when the read named a `mailboxId`. */
export const mailboxRampStatusSchema = z.object({
  mailboxId: uuid,
  healthySendingDays: z.number().int().min(0),
  effectiveCap: z.number().int().min(0),
  adminDailyCap: z.number().int().min(0).nullable(),
  raisedDailyCap: z.number().int().min(0).nullable(),
  lastHealthFailure: z.string().nullable(),
});
export type MailboxRampStatus = z.infer<typeof mailboxRampStatusSchema>;

/** One fence, present only when the read named an `outboundMessageId`. Never a subject or body. */
export const outboundFenceStatusSchema = z.object({
  id: uuid,
  state: z.enum(OUTBOUND_STATES),
  recipientAddress: z.string(),
  dispatchStartedAt: instant.nullable(),
  sentAt: instant.nullable(),
  heldReason: z.string().nullable(),
  adminResolution: z.enum(['delivered', 'skipped']).nullable(),
  reconcileAttempts: z.number().int().min(0),
  events: z.array(
    z.object({
      sequenceNumber: z.number().int().min(1),
      fromState: z.enum(OUTBOUND_STATES).nullable(),
      toState: z.enum(OUTBOUND_STATES),
      actor: z.string(),
      occurredAt: instant,
    }),
  ),
});

export const outboundStatusResponseSchema = z.object({
  /** Null for a workspace with no sending domain. */
  domain: sendingDomainStatusSchema.nullable(),
  /** @deprecated A constant; null exactly when `domain` is. Remove in wave 2. */
  guard: domainGuardDecisionSchema.nullable(),
  /** @deprecated Zeros. Remove in wave 2. */
  personalGmailRecipients: personalGmailRecipientsSchema,
  doubt: outboundDoubtSchema,
  ramp: mailboxRampStatusSchema.nullable(),
  fence: outboundFenceStatusSchema.nullable(),
});
export type OutboundStatusResponse = z.infer<typeof outboundStatusResponseSchema>;

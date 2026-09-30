import { z } from 'zod';
import { instant, uuid } from './foundationRows.ts';

/**
 * The wire contract of the Gmail grant (specification 5.1, 12.1, 12.6).
 *
 * Four paths, served by `apps/api/src/routes/gmail.ts`: `POST /gmail/connect`,
 * `GET /gmail/status`, `POST /gmail/disconnect` and the browser's
 * `GET /oauth/gmail/callback`. The Mac calls the first two from the main process — the
 * "This Mac" card's Mailbox row, `apps/desktop/src/main/mailboxBridge.ts` — so the
 * shapes are here, where both sides import them, rather than in the route file.
 *
 * Until 24 September 2026 the command schemas lived in `apps/api/src/routes/mailSupport.ts`
 * with a note that they would move "in the pull request that adds the screen", because a
 * contract nobody on the other side reads is a contract that drifts. Nobody added the
 * screen: desktop 1.0.0 shipped with no way to connect a mailbox, and the first real
 * sign-in to production found the gap (docs/greenfield/release.md 8.0x). This file is
 * the move. The envelope is kept exactly as the route accepted it, so nothing a client
 * already sends changes meaning.
 */

/** The 5.3 envelope as the mail routes have always parsed it. */
export const MAIL_COMMAND_ENVELOPE = Object.freeze({
  commandId: z.string().uuid(),
  clientVersion: z.string().min(1).max(32),
});

/**
 * `POST /gmail/connect`: the envelope, and optionally `switchTo`. The scopes are not a
 * parameter.
 *
 * `switchTo` (call-to-booking A2, 30 Sep 2026) is the owner saying "replace my mailbox
 * with this account". It goes into the signed grant state and becomes Google's
 * `login_hint`. The callback switches the mailbox row to a different Google account only
 * when the state carries this intent and the chosen account is the expected one; a
 * re-consent that lands on another account without it is refused
 * (`mailbox_switch_not_requested`) instead of switching silently.
 */
export const connectMailboxCommandSchema = z
  .object({
    ...MAIL_COMMAND_ENVELOPE,
    switchTo: z.email().max(320).optional(),
  })
  .strict();

/**
 * Why a switch was refused, at `POST /gmail/connect` or at the callback. The desktop
 * shows a sentence for each (`reasonText.ts`), never the code alone.
 */
export const MAILBOX_SWITCH_REFUSAL_CODES = [
  'mailbox_switch_not_requested',
  'mailbox_switch_address_mismatch',
  'mailbox_switch_same_address',
  'mailbox_switch_wrong_domain',
  'mailbox_switch_pending_sends',
] as const;
export type MailboxSwitchRefusalCode = (typeof MAILBOX_SWITCH_REFUSAL_CODES)[number];

/**
 * The grant refusals the Mac can learn about from `/gmail/status`: the callback is a
 * browser page, so the outcome of a refused grant reaches the Mac only through the
 * `lastGrantRefusal` field below.
 */
export const GRANT_REFUSAL_CODES = [
  ...MAILBOX_SWITCH_REFUSAL_CODES,
  'grant_refused',
  'mailbox_address_taken',
  'authorization_request_unknown',
] as const;
export type GrantRefusalCode = (typeof GRANT_REFUSAL_CODES)[number];

/** `POST /gmail/disconnect`. Not offered by the Mac: see `docs/greenfield/mail.md`, the thirty-day rule. */
export const disconnectMailboxCommandSchema = z
  .object({
    ...MAIL_COMMAND_ENVELOPE,
    mailboxId: z.string().uuid(),
    reason: z.string().trim().min(1).max(200),
  })
  .strict();

/**
 * What an accepted `connect_mailbox` command returns: Google's consent URL, which the
 * Mac opens in the system browser, and the instant the signed state inside it expires.
 * After that instant the callback refuses the grant, so it is also how long the Mac
 * waits for the connection to appear.
 */
export const gmailConnectResultSchema = z.object({
  authorizationUrl: z.url(),
  expiresAt: instant,
  /**
   * This grant attempt, carried inside the signed state (call-to-booking A2). A refusal at
   * the callback is reported by `/gmail/status` with the same id, so the Mac can tell
   * "this attempt was refused" from "an earlier one was". Optional so a desktop newer than
   * the API still parses; the API always sends it.
   */
  attemptId: uuid.optional(),
});

export const MAILBOX_STATUSES = ['connected', 'disconnected', 'revoked'] as const;

/** 12.3: a new mailbox proves a bounded baseline before automation begins. */
export const MAILBOX_SYNC_STATES = ['baseline_pending', 'ready', 'recovering'] as const;

/**
 * `GET /gmail/status`: the caller's own mailbox, or null when they have never connected
 * one. `connected` is true only for a mailbox whose status is `connected`; a revoked or
 * disconnected one is reported with its address and is not connected.
 *
 * Appendix F: the owner sees their own diagnostics, so `lastSyncError` is here. Nothing
 * here is a credential; the refresh token's existence is never reported at all.
 */
export const gmailStatusSchema = z.object({
  connected: z.boolean(),
  mailbox: z
    .object({
      id: uuid,
      emailAddress: z.string().min(3).max(320),
      status: z.enum(MAILBOX_STATUSES),
      syncState: z.enum(MAILBOX_SYNC_STATES),
      coverageWatermarkAt: instant.nullable(),
      lastSyncedAt: instant.nullable(),
      lastSyncError: z.string().max(500).nullable(),
      /**
       * The current generation's baseline or recovery, so the Mac can say "reading the
       * last 30 days: N messages so far". Null when there is none. Optional so a desktop
       * older than the API keeps parsing; the API always sends it.
       */
      baseline: z
        .object({
          pagesCompleted: z.number().int().nonnegative(),
          messagesSeen: z.number().int().nonnegative(),
          completedAt: instant.nullable(),
        })
        .nullable()
        .optional(),
    })
    .nullable(),
  /**
   * The latest refused grant for this user after their latest successful connect or
   * switch, or null. Optional for the same reason as `baseline`.
   */
  lastGrantRefusal: z
    .object({
      reason: z.enum(GRANT_REFUSAL_CODES),
      at: instant,
      attemptId: uuid.nullable(),
    })
    .nullable()
    .optional(),
});
export type GmailStatus = z.infer<typeof gmailStatusSchema>;

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

/** `POST /gmail/connect`: the envelope and nothing else. The scopes are not a parameter. */
export const connectMailboxCommandSchema = z.object(MAIL_COMMAND_ENVELOPE).strict();

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
    })
    .nullable(),
});
export type GmailStatus = z.infer<typeof gmailStatusSchema>;

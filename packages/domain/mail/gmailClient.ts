import type { MailDirection } from './types.ts';

/**
 * The Gmail API, as a seam (specification 12.2, 12.3, Appendix B).
 *
 * Every call FSS makes to Google goes through this interface and nothing else, so
 * the whole of the mail lane is testable against a recorded fixture and no test can
 * reach the network by accident. `gmailClientFake.ts` is that fixture fake;
 * `gmailClientHttp.ts` is the one implementation that speaks HTTP, and it takes an
 * injected `fetch` for the same reason G2's `googleClient.ts` does.
 *
 * Two shapes are deliberate.
 *
 * **Expected failures are values, not throws.** An expired history cursor is
 * `{ ok: false, reason: 'history_expired' }`, because 12.3 gives it a defined
 * recovery; a revoked grant is `grant_revoked`, because 12.6 gives it a defined
 * hold. Only something nobody planned for throws `GmailClientError`, and the job
 * runner's retry ladder is what handles that.
 *
 * **A read never returns a body unless it was asked for one.** `getMetadata` takes
 * the header allowlist and returns no body at all, so "fetches a body only after a
 * plausible FSS match" is enforced by the shape of the call rather than by
 * remembering to ignore a field.
 *
 * G7-2 added `sendMessage` and `searchSentByMessageId` — the `rfc822msgid:`
 * Sent-folder search of Appendix B — and nothing about the read surface changed.
 *
 * Those two deserve their own note, because they are the only methods here whose
 * failure modes are not symmetrical.
 *
 * **`sendMessage` may fail in a way that still sent the message.** A timeout, a
 * dropped connection, a 5xx: the request bytes may have left. So its outcome type
 * distinguishes `refused` — Gmail answered, and answered no, and nothing was sent —
 * from `indeterminate`, which is Appendix B's "any request bytes may have left" and
 * is never retried. A client implementation that reports a timeout as `refused` would
 * defeat the entire fence, so the distinction is documented on the type rather than
 * left to a reviewer.
 *
 * **`searchSentByMessageId` is the only read that is allowed to be authoritative
 * about a send.** It is what turns an indeterminate dispatch into `sent` or, after
 * the observation window, into `unknown_terminal`. Appendix B: "Sent reconciliation
 * uses `rfc822msgid:` search on the sending mailbox. The `q` parameter requires
 * `gmail.readonly`; `gmail.metadata` would be insufficient."
 */

export class GmailClientError extends Error {
  constructor(
    readonly code: 'transport' | 'malformed_response' | 'unexpected_status',
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'GmailClientError';
  }
}

/** An access token and how long it is good for. Never logged, never persisted. */
export interface GmailAccessGrant {
  readonly accessToken: string;
  readonly expiresAtEpochSeconds: number;
}

export interface GmailAuthorizationGrant extends GmailAccessGrant {
  /** Present the first time a user consents; absent when Google re-issues silently. */
  readonly refreshToken: string | null;
  readonly grantedScopes: readonly string[];
}

export interface GmailOAuthConfig {
  readonly clientId: string;
  /** From the injected secret provider. Never a file, a log, a fixture or a literal. */
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly revocationEndpoint: string;
  readonly apiBaseUrl: string;
}

export interface GmailProfile {
  readonly emailAddress: string;
  readonly historyId: string;
}

export interface GmailWatchRegistration {
  readonly historyId: string;
  readonly expiresAtEpochMilliseconds: number;
}

/** One message as `format=metadata` with the header allowlist returns it. */
export interface GmailMessageMetadata {
  readonly id: string;
  readonly threadId: string;
  readonly internalDateEpochMilliseconds: number;
  readonly labelIds: readonly string[];
  /** Header name to raw value, as Gmail spells them. Only the allowlist is present. */
  readonly headers: Readonly<Record<string, string>>;
  readonly attachments: readonly GmailAttachmentReference[];
  readonly sizeEstimate: number;
}

/** Metadata only. 10.3: "Attachments are not copied into FSS." */
export interface GmailAttachmentReference {
  readonly filename: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly attachmentId: string;
}

export interface GmailMessageBody {
  readonly text: string;
  /** A body the fetch truncated cannot prove an opt-out: the sentence may continue. */
  readonly truncated: boolean;
}

/** One message one history record changed, in the ways FSS asks `history.list` for. */
export interface GmailHistoryChange {
  readonly messageId: string;
  readonly threadId: string;
  /** `messageAdded` for a new message either way; the direction comes from the labels. */
  readonly kind: 'message_added' | 'label_added' | 'label_removed' | 'message_deleted';
  readonly labelIds: readonly string[];
}

/**
 * One Gmail history record: Google's `History` resource.
 *
 * Its id is the resource's own `id` ("the mailbox sequence ID"), not `historyId`,
 * which is a field of the `Message` resource. One record can change several messages
 * ("Each history change may affect multiple messages in multiple ways"), and a record
 * is the smallest unit a cursor can stand on: `startHistoryId` returns the records
 * after an id, never the rest of one. So `mail.sync` takes whole records or none of a
 * record (`docs/decisions/g76-history-records-are-the-unit-of-progress.md`).
 */
export interface GmailHistoryRecord {
  /** `History.id`: a uint64 as a decimal string. Compare with `compareHistoryIds`. */
  readonly id: string;
  readonly changes: readonly GmailHistoryChange[];
}

export type GmailHistoryOutcome =
  | {
      readonly ok: true;
      /** In the order Gmail returned them, which is ascending by id. */
      readonly records: readonly GmailHistoryRecord[];
      readonly nextPageToken: string | null;
      /** `ListHistoryResponse.historyId`: the mailbox's current history record. */
      readonly historyId: string;
    }
  | { readonly ok: false; readonly reason: 'history_expired' | 'grant_revoked' | 'rate_limited' };

export type GmailListOutcome =
  | {
      readonly ok: true;
      readonly messageIds: readonly string[];
      readonly nextPageToken: string | null;
    }
  | { readonly ok: false; readonly reason: 'grant_revoked' | 'rate_limited' };

export type GmailTokenOutcome =
  | { readonly ok: true; readonly grant: GmailAuthorizationGrant }
  | { readonly ok: false; readonly reason: 'grant_refused' | 'grant_revoked' };

export type GmailAccessOutcome =
  | { readonly ok: true; readonly grant: GmailAccessGrant }
  | { readonly ok: false; readonly reason: 'grant_refused' | 'grant_revoked' };

export type GmailWatchOutcome =
  | { readonly ok: true; readonly watch: GmailWatchRegistration }
  | { readonly ok: false; readonly reason: 'grant_revoked' | 'provider_refusal' };

export interface GmailHistoryRequest {
  readonly startHistoryId: string;
  readonly pageToken?: string | undefined;
}

export interface GmailListRequest {
  /** Epoch seconds. Appendix D: "Gmail recovery queries: epoch seconds, never
   *  ambiguous date strings." */
  readonly afterEpochSeconds: number;
  readonly beforeEpochSeconds: number;
  readonly pageToken?: string | undefined;
  readonly maxResults: number;
}

export interface GmailClient {
  /** The consent URL the salesperson's browser opens. Pure; reaches nothing. */
  authorizationUrl(
    config: GmailOAuthConfig,
    input: {
      readonly state: string;
      readonly codeChallenge: string;
      readonly scopes: readonly string[];
      readonly loginHint?: string | undefined;
    },
  ): string;
  exchangeAuthorizationCode(
    config: GmailOAuthConfig,
    input: { readonly code: string; readonly codeVerifier: string },
  ): Promise<GmailTokenOutcome>;
  refreshAccessToken(config: GmailOAuthConfig, refreshToken: string): Promise<GmailAccessOutcome>;
  /** Best effort; a revoked grant is already revoked and is not an error. */
  revokeRefreshToken(config: GmailOAuthConfig, refreshToken: string): Promise<void>;
  getProfile(access: GmailAccessGrant): Promise<GmailProfile>;
  watch(access: GmailAccessGrant, input: { readonly topicName: string }): Promise<GmailWatchOutcome>;
  stopWatch(access: GmailAccessGrant): Promise<void>;
  listHistory(access: GmailAccessGrant, request: GmailHistoryRequest): Promise<GmailHistoryOutcome>;
  listMessageIds(access: GmailAccessGrant, request: GmailListRequest): Promise<GmailListOutcome>;
  getMetadata(
    access: GmailAccessGrant,
    messageId: string,
    headers: readonly string[],
  ): Promise<GmailMessageMetadata | null>;
  /** Only ever called after a plausible match (12.3). */
  getBody(access: GmailAccessGrant, messageId: string): Promise<GmailMessageBody | null>;
  /**
   * Send one already-rendered message. Called at most once per fence, by the one
   * process holding that fence's attempt token (Appendix B).
   */
  sendMessage(access: GmailAccessGrant, request: GmailSendRequest): Promise<GmailSendOutcome>;
  /**
   * `rfc822msgid:` search of the sending mailbox's Sent folder (Appendix B).
   *
   * Returns null when the search ran and found nothing, which is a real answer and
   * not an error: a message can take minutes to index, so "not yet" and "never" are
   * the same observation made at different times, and only the observation window
   * tells them apart.
   */
  searchSentByMessageId(
    access: GmailAccessGrant,
    rfcMessageId: string,
  ): Promise<GmailSentSearchOutcome>;
  /**
   * The ids of the messages in the mailbox's Sent folder whose Gmail internal date falls
   * in `[after, before)`, epoch seconds, trashed ones included (Appendix E step 3, lane
   * g73).
   *
   * `searchSentByMessageId` asks about a fence the database knows. After a
   * point-in-time restore the database may not know the fence at all — the send happened
   * after the restore point — and the only way to find such a send is to list the folder
   * and read each message's Message-ID. Ids only, like `listMessageIds`; the caller reads
   * metadata for each with the header allowlist and never a body.
   */
  listSentMessageIds(access: GmailAccessGrant, request: GmailListRequest): Promise<GmailListOutcome>;
}

export interface GmailSendRequest {
  /** Canonical, lower-cased. One recipient: FSS never sends to a list. */
  readonly to: string;
  readonly from: string;
  readonly subject: string;
  /** Plain text. FSS sends no HTML part and no tracking pixel (12.7). */
  readonly body: string;
  /** The deterministic `<...>` header the Sent search will look for. */
  readonly rfcMessageId: string;
  /** Set on a reply so Gmail threads it. Absent on a first touch. */
  readonly inReplyTo?: string | undefined;
  readonly references?: readonly string[] | undefined;
}

/**
 * Three outcomes, and the middle one is the reason this type is not a boolean.
 *
 * `sent` — Gmail answered with an id. The message went.
 * `refused` — Gmail answered, and answered no. Provably nothing was sent, so the
 *   fence may be held and the step retried later.
 * `indeterminate` — anything else at all: a timeout, a connection loss, a 5xx, a
 *   response that could not be parsed. Appendix B: "Never resend; enter reconciling."
 */
export type GmailSendOutcome =
  | { readonly ok: true; readonly messageId: string; readonly threadId: string }
  | {
      readonly ok: false;
      readonly outcome: 'refused';
      readonly reason: 'grant_revoked' | 'rate_limited' | 'recipient_rejected' | 'provider_refusal';
    }
  | { readonly ok: false; readonly outcome: 'indeterminate'; readonly detail: string };

export type GmailSentSearchOutcome =
  | { readonly ok: true; readonly found: null }
  | { readonly ok: true; readonly found: { readonly messageId: string; readonly threadId: string } }
  | { readonly ok: false; readonly reason: 'grant_revoked' | 'rate_limited' };

/**
 * Whether Gmail's label set says the message left this mailbox.
 *
 * `SENT` is the one that matters: a direct send by the salesperson and an FSS send
 * both carry it, and 12.3's outgoing rules apply to both.
 */
export function directionOfLabels(labelIds: readonly string[]): MailDirection {
  return labelIds.includes('SENT') ? 'outgoing' : 'incoming';
}

/** Header lookup that does not care how Gmail capitalized the name. */
export function headerValue(
  headers: Readonly<Record<string, string>>,
  name: string,
): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

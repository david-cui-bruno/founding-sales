import {
  GmailClientError,
  type GmailAccessGrant,
  type GmailAccessOutcome,
  type GmailAttachmentReference,
  type GmailClient,
  type GmailHistoryChange,
  type GmailHistoryOutcome,
  type GmailHistoryRecord,
  type GmailHistoryRequest,
  type GmailListOutcome,
  type GmailListRequest,
  type GmailMessageBody,
  type GmailMessageMetadata,
  type GmailOAuthConfig,
  type GmailProfile,
  type GmailSendOutcome,
  type GmailSendRequest,
  type GmailSentSearchOutcome,
  type GmailTokenOutcome,
  type GmailWatchOutcome,
} from './gmailClient.ts';
import { historyIdOf } from './historyIds.ts';

/**
 * The Gmail API over HTTP.
 *
 * The one implementation of `GmailClient` that reaches the network, and it reaches it
 * through an injected `fetch` for the reason `apps/api/src/auth/googleClient.ts` does:
 * a test gives it a loopback server and no test ever touches Google.
 *
 * Three decisions are worth reading before changing anything here.
 *
 * **Every read is `format=metadata` unless it is `getBody`.** `metadataHeaders` is
 * repeated once per allowlisted header, which is how the API restricts the response;
 * asking for `format=full` and ignoring the rest would pull message bodies over the
 * wire for every message in the mailbox, including ones FSS never matches, and 12.3
 * is explicit that it must not.
 *
 * **Status codes are mapped to the specification's outcomes, not to retries.** A 404
 * from `history.list` is 12.3's expired cursor and has a defined recovery; a 401 or a
 * 403 `authError` is 12.6's revoked grant and has a defined hold; a 429 or a 403
 * `rateLimitExceeded` is a retry. Anything else throws, and the job runner's ladder
 * decides.
 *
 * **A body is the first `text/plain` part, decoded, bounded.** HTML-only mail is
 * flattened crudely on purpose: the deterministic classifier reads sentences, and a
 * dependency that parses HTML properly is a dependency that parses hostile HTML.
 */

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface HttpRequest {
  readonly method?: 'GET' | 'POST';
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

export type HttpFetch = (url: string, request?: HttpRequest) => Promise<HttpResponse>;

/** The platform's. Nothing in `packages/domain` depends on an HTTP client. */
export const httpFetch: HttpFetch = async (url, request = {}) => {
  const response = await fetch(url, {
    method: request.method ?? 'GET',
    ...(request.headers === undefined ? {} : { headers: { ...request.headers } }),
    ...(request.body === undefined ? {} : { body: request.body }),
  });
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return { status: response.status, headers, body: await response.text() };
};

export interface GmailHttpOptions {
  readonly fetch: HttpFetch;
  /**
   * Where the Gmail API is. `GMAIL_API_BASE_URL` in production; a loopback origin in
   * the test that serves the API itself, which is why it is a parameter and not a
   * constant.
   */
  readonly apiBaseUrl: string;
  /** The largest body this client will keep. A very long mail is truncated, not refused. */
  readonly maxBodyCharacters?: number | undefined;
}

export const DEFAULT_MAX_BODY_CHARACTERS = 100_000;

type Json = Record<string, unknown>;

function parseJson(body: string): Json | null {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Json) : null;
  } catch {
    return null;
  }
}

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : typeof value === 'number' ? String(value) : null;

/** The first `reason` Google put in its error payload, lower-cased, or null. */
function errorReason(body: string): string | null {
  const parsed = parseJson(body);
  const error = parsed?.['error'];
  if (typeof error !== 'object' || error === null) return null;
  const errors = (error as Json)['errors'];
  if (Array.isArray(errors) && errors.length > 0) {
    const first = errors[0];
    if (typeof first === 'object' && first !== null) {
      const reason = (first as Json)['reason'];
      if (typeof reason === 'string') return reason.toLowerCase();
    }
  }
  const status = (error as Json)['status'];
  return typeof status === 'string' ? status.toLowerCase() : null;
}

/** What a non-2xx means, in the specification's vocabulary. */
export type GmailFailure = 'grant_revoked' | 'rate_limited' | 'history_expired' | 'not_found' | 'unexpected';

export function classifyStatus(status: number, body: string): GmailFailure {
  if (status === 401) return 'grant_revoked';
  if (status === 403) {
    const reason = errorReason(body) ?? '';
    if (reason.includes('ratelimit') || reason.includes('userratelimit') || reason.includes('quota')) {
      return 'rate_limited';
    }
    return 'grant_revoked';
  }
  if (status === 404) return 'not_found';
  if (status === 429 || status === 503) return 'rate_limited';
  return 'unexpected';
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

interface MessagePart {
  readonly mimeType?: string;
  readonly filename?: string;
  readonly body?: { readonly size?: number; readonly data?: string; readonly attachmentId?: string };
  readonly parts?: readonly MessagePart[];
}

/** The first `text/plain` part, depth first; then the first `text/html`, flattened. */
export function readBodyText(payload: MessagePart | undefined): string {
  if (payload === undefined) return '';
  const plain = findPart(payload, 'text/plain');
  if (plain !== null) return decodeBase64Url(plain);
  const html = findPart(payload, 'text/html');
  if (html === null) return '';
  return decodeBase64Url(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function findPart(part: MessagePart, mimeType: string): string | null {
  if (part.mimeType === mimeType && typeof part.body?.data === 'string') return part.body.data;
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found !== null) return found;
  }
  return null;
}

/** Filename, media type, size and the Gmail reference. Never the bytes (10.3). */
export function readAttachmentReferences(payload: MessagePart | undefined): GmailAttachmentReference[] {
  const found: GmailAttachmentReference[] = [];
  const walk = (part: MessagePart): void => {
    const filename = part.filename;
    const attachmentId = part.body?.attachmentId;
    if (typeof filename === 'string' && filename.length > 0 && typeof attachmentId === 'string') {
      found.push({
        filename: filename.slice(0, 300),
        mimeType: part.mimeType ?? 'application/octet-stream',
        sizeBytes: part.body?.size ?? 0,
        attachmentId,
      });
    }
    for (const child of part.parts ?? []) walk(child);
  };
  if (payload !== undefined) walk(payload);
  return found.slice(0, 100);
}

export function createGmailHttpClient(options: GmailHttpOptions): GmailClient {
  const maxBody = options.maxBodyCharacters ?? DEFAULT_MAX_BODY_CHARACTERS;
  const base = options.apiBaseUrl.replace(/\/$/, '');

  const api = async (
    access: GmailAccessGrant,
    path: string,
    query: Readonly<Record<string, string | readonly string[] | undefined>>,
    method: 'GET' | 'POST' = 'GET',
    body?: unknown,
  ): Promise<HttpResponse> => {
    const url = new URL(`${base}${path}`);
    for (const [name, value] of Object.entries(query)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) for (const member of value) url.searchParams.append(name, member);
      else url.searchParams.set(name, value as string);
    }
    return await options.fetch(url.toString(), {
      method,
      headers: {
        authorization: `Bearer ${access.accessToken}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  };

  const exchange = async (
    config: GmailOAuthConfig,
    form: URLSearchParams,
  ): Promise<{ readonly status: number; readonly json: Json | null }> => {
    const response = await options.fetch(config.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: form.toString(),
    });
    return { status: response.status, json: parseJson(response.body) };
  };

  /**
   * One page of message ids matching `q`, bounded by epoch seconds (Appendix D: never an
   * ambiguous date string). `prefix` narrows the search; the bounds are always the
   * request's own.
   *
   * `strict` (the Sent listing, lane W3-S8 review): a 200 whose body is not a JSON
   * object, whose `messages` is present and not an array, one of whose entries is not an
   * object with an id, or whose `nextPageToken` is present and not a string, is
   * `malformed_response` — never a page of no messages, because the restore's Sent
   * reconciliation reads "no messages" as "nothing was sent". An absent `messages` is
   * Google's own empty page and stays one. The sync's listing keeps its old reading.
   */
  const listIds = async (
    access: GmailAccessGrant,
    prefix: string,
    request: GmailListRequest,
    failure: string,
    strict = false,
  ): Promise<GmailListOutcome> => {
    const response = await api(
      access,
      '/gmail/v1/users/me/messages',
      {
        q: `${prefix}after:${String(request.afterEpochSeconds)} before:${String(request.beforeEpochSeconds)}`,
        maxResults: String(request.maxResults),
        includeSpamTrash: 'true',
        ...(request.pageToken === undefined ? {} : { pageToken: request.pageToken }),
      },
    );
    if (response.status !== 200) {
      const classified = classifyStatus(response.status, response.body);
      if (classified === 'grant_revoked') return { ok: false, reason: 'grant_revoked' };
      if (classified === 'rate_limited') return { ok: false, reason: 'rate_limited' };
      throw new GmailClientError('unexpected_status', failure, response.status);
    }
    const json = parseJson(response.body);
    if (strict) {
      const malformed = (why: string): never => {
        throw new GmailClientError('malformed_response', `${failure}: ${why}`, response.status);
      };
      if (json === null) malformed('the page was not a JSON object');
      const members = json?.['messages'];
      if (members !== undefined && !Array.isArray(members)) malformed('messages was not a list');
      const token = json?.['nextPageToken'];
      if (token !== undefined && token !== null && typeof token !== 'string') malformed('nextPageToken was not a string');
      for (const member of (members ?? []) as unknown[]) {
        if (typeof member !== 'object' || member === null || asString((member as Json)['id']) === null) {
          malformed('a listed message had no id');
        }
      }
    }
    const messageIds: string[] = [];
    for (const member of Array.isArray(json?.['messages']) ? (json['messages'] as unknown[]) : []) {
      if (typeof member !== 'object' || member === null) continue;
      const id = asString((member as Json)['id']);
      if (id !== null) messageIds.push(id);
    }
    return { ok: true, messageIds, nextPageToken: asString(json?.['nextPageToken']) };
  };

  return {
    authorizationUrl(config, input): string {
      const url = new URL(config.authorizationEndpoint);
      url.searchParams.set('client_id', config.clientId);
      url.searchParams.set('redirect_uri', config.redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', input.scopes.join(' '));
      url.searchParams.set('state', input.state);
      url.searchParams.set('code_challenge', input.codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
      // Both are required for a refresh token: without `offline` Google returns an
      // access token only, and without `consent` a re-consent returns no refresh
      // token at all — a mailbox that works for an hour and then looks revoked.
      url.searchParams.set('access_type', 'offline');
      url.searchParams.set('prompt', 'consent');
      url.searchParams.set('include_granted_scopes', 'false');
      if (input.loginHint !== undefined) url.searchParams.set('login_hint', input.loginHint);
      return url.toString();
    },

    exchangeAuthorizationCode: async (config, input): Promise<GmailTokenOutcome> => {
      const { status, json } = await exchange(
        config,
        new URLSearchParams({
          grant_type: 'authorization_code',
          code: input.code,
          code_verifier: input.codeVerifier,
          redirect_uri: config.redirectUri,
          client_id: config.clientId,
          client_secret: config.clientSecret,
        }),
      );
      if (status !== 200 || json === null) return { ok: false, reason: 'grant_refused' };
      const accessToken = asString(json['access_token']);
      if (accessToken === null) return { ok: false, reason: 'grant_refused' };
      const expiresIn = Number(json['expires_in'] ?? 3600);
      return {
        ok: true,
        grant: {
          accessToken,
          expiresAtEpochSeconds: Math.floor(Date.now() / 1000) + (Number.isFinite(expiresIn) ? expiresIn : 3600),
          refreshToken: asString(json['refresh_token']),
          grantedScopes: (asString(json['scope']) ?? '').split(' ').filter(scope => scope.length > 0),
        },
      };
    },

    refreshAccessToken: async (config, refreshToken): Promise<GmailAccessOutcome> => {
      const { status, json } = await exchange(
        config,
        new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: config.clientId,
          client_secret: config.clientSecret,
        }),
      );
      // Google answers 400 `invalid_grant` for a revoked or expired refresh token,
      // which is the ordinary end of a grant rather than a fault to retry.
      if (status !== 200 || json === null) return { ok: false, reason: 'grant_revoked' };
      const accessToken = asString(json['access_token']);
      if (accessToken === null) return { ok: false, reason: 'grant_revoked' };
      const expiresIn = Number(json['expires_in'] ?? 3600);
      return {
        ok: true,
        grant: {
          accessToken,
          expiresAtEpochSeconds: Math.floor(Date.now() / 1000) + (Number.isFinite(expiresIn) ? expiresIn : 3600),
        },
      };
    },

    revokeRefreshToken: async (config, refreshToken): Promise<void> => {
      // Best effort by contract: the caller deletes the material either way.
      await options.fetch(config.revocationEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: refreshToken }).toString(),
      });
    },

    getProfile: async (access): Promise<GmailProfile> => {
      const response = await api(access, '/gmail/v1/users/me/profile', {});
      if (response.status !== 200) {
        throw new GmailClientError('unexpected_status', 'the Gmail profile read failed', response.status);
      }
      const json = parseJson(response.body);
      const emailAddress = asString(json?.['emailAddress']);
      const historyId = historyIdOf(json?.['historyId']);
      if (emailAddress === null || historyId === null) {
        throw new GmailClientError('malformed_response', 'the Gmail profile had no address or history id');
      }
      return { emailAddress: emailAddress.toLowerCase(), historyId };
    },

    watch: async (access, input): Promise<GmailWatchOutcome> => {
      const response = await api(access, '/gmail/v1/users/me/watch', {}, 'POST', {
        topicName: input.topicName,
        labelFilterBehavior: 'include',
      });
      if (response.status !== 200) {
        const failure = classifyStatus(response.status, response.body);
        return { ok: false, reason: failure === 'grant_revoked' ? 'grant_revoked' : 'provider_refusal' };
      }
      const json = parseJson(response.body);
      const historyId = historyIdOf(json?.['historyId']);
      const expiration = asString(json?.['expiration']);
      if (historyId === null || expiration === null) return { ok: false, reason: 'provider_refusal' };
      return {
        ok: true,
        watch: { historyId, expiresAtEpochMilliseconds: Number(expiration) },
      };
    },

    stopWatch: async (access): Promise<void> => {
      await api(access, '/gmail/v1/users/me/stop', {}, 'POST', {});
    },

    listHistory: async (access, request: GmailHistoryRequest): Promise<GmailHistoryOutcome> => {
      const response = await api(
        access,
        '/gmail/v1/users/me/history',
        {
          startHistoryId: request.startHistoryId,
          historyTypes: ['messageAdded', 'labelAdded'],
          ...(request.pageToken === undefined ? {} : { pageToken: request.pageToken }),
        },
      );
      if (response.status !== 200) {
        const failure = classifyStatus(response.status, response.body);
        // 12.3: "On expired history cursor ..." Gmail says 404 for a start id it has
        // pruned, and that is the only 404 this call can produce.
        if (failure === 'not_found') return { ok: false, reason: 'history_expired' };
        if (failure === 'grant_revoked') return { ok: false, reason: 'grant_revoked' };
        if (failure === 'rate_limited') return { ok: false, reason: 'rate_limited' };
        throw new GmailClientError('unexpected_status', 'the Gmail history read failed', response.status);
      }
      // `ListHistoryResponse` is `{ history: History[], nextPageToken, historyId }`, and
      // a `History` is `{ id, messages, messagesAdded, messagesDeleted, labelsAdded,
      // labelsRemoved }`: https://developers.google.com/gmail/api/reference/rest/v1/users.history/list
      // and https://developers.google.com/gmail/api/reference/rest/v1/users.history#History.
      // The record's own id is `id` (`historyId` is a field of `Message`, never of
      // `History`; audit item C06). A record without a usable id is a malformed page: there is no cursor it could safely stand for.
      const json = parseJson(response.body);
      const records: GmailHistoryRecord[] = [];
      for (const entry of Array.isArray(json?.['history']) ? (json['history'] as unknown[]) : []) {
        if (typeof entry !== 'object' || entry === null) continue;
        const item = entry as Json;
        const recordId = historyIdOf(item['id']);
        if (recordId === null) {
          throw new GmailClientError('malformed_response', 'a Gmail history record had no id');
        }
        const changes: GmailHistoryChange[] = [];
        for (const [key, kind] of [
          ['messagesAdded', 'message_added'],
          ['labelsAdded', 'label_added'],
        ] as const) {
          for (const member of Array.isArray(item[key]) ? (item[key] as unknown[]) : []) {
            if (typeof member !== 'object' || member === null) continue;
            const message = (member as Json)['message'];
            if (typeof message !== 'object' || message === null) continue;
            const id = asString((message as Json)['id']);
            const threadId = asString((message as Json)['threadId']);
            if (id === null || threadId === null) continue;
            const labelIds = Array.isArray((message as Json)['labelIds'])
              ? ((message as Json)['labelIds'] as unknown[]).filter((label): label is string => typeof label === 'string')
              : [];
            changes.push({ messageId: id, threadId, kind, labelIds });
          }
        }
        records.push({ id: recordId, changes });
      }
      // No usable current id means "no further than where this read began", which can
      // never claim coverage the read did not have.
      const historyId = historyIdOf(json?.['historyId']) ?? request.startHistoryId;
      return { ok: true, records, nextPageToken: asString(json?.['nextPageToken']), historyId };
    },

    listMessageIds: async (access, request: GmailListRequest): Promise<GmailListOutcome> =>
      await listIds(access, '', request, 'the Gmail message listing failed'),

    // The same listing, narrowed to the Sent folder. Trashed messages stay in
    // (`includeSpamTrash`), because a salesperson who deleted an FSS email from Sent did
    // not unsend it, and Appendix E step 3 is looking for sends, not for tidy folders.
    listSentMessageIds: async (access, request: GmailListRequest): Promise<GmailListOutcome> =>
      await listIds(access, 'in:sent ', request, 'the Gmail Sent folder listing failed', true),

    getMetadata: async (access, messageId, headers): Promise<GmailMessageMetadata | null> => {
      const response = await api(
        access,
        `/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}`,
        { format: 'metadata', metadataHeaders: [...headers] },
      );
      if (response.status === 404) return null;
      if (response.status !== 200) {
        throw new GmailClientError('unexpected_status', 'the Gmail metadata read failed', response.status);
      }
      const json = parseJson(response.body);
      if (json === null) throw new GmailClientError('malformed_response', 'the Gmail metadata read was not JSON');
      const payload = json['payload'] as MessagePart | undefined;
      const collected: Record<string, string> = {};
      for (const member of Array.isArray((payload as Json | undefined)?.['headers'])
        ? (((payload as unknown as Json)['headers'] as unknown[]) ?? [])
        : []) {
        if (typeof member !== 'object' || member === null) continue;
        const name = asString((member as Json)['name']);
        const value = asString((member as Json)['value']);
        if (name !== null && value !== null) collected[name] = value;
      }
      const id = asString(json['id']);
      const threadId = asString(json['threadId']);
      if (id === null || threadId === null) {
        throw new GmailClientError('malformed_response', 'the Gmail metadata read had no id');
      }
      return {
        id,
        threadId,
        internalDateEpochMilliseconds: Number(asString(json['internalDate']) ?? '0'),
        labelIds: Array.isArray(json['labelIds'])
          ? (json['labelIds'] as unknown[]).filter((label): label is string => typeof label === 'string')
          : [],
        headers: collected,
        attachments: readAttachmentReferences(payload),
        sizeEstimate: Number(json['sizeEstimate'] ?? 0),
      };
    },

    getBody: async (access, messageId): Promise<GmailMessageBody | null> => {
      const response = await api(
        access,
        `/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}`,
        { format: 'full' },
      );
      if (response.status === 404) return null;
      if (response.status !== 200) {
        throw new GmailClientError('unexpected_status', 'the Gmail body read failed', response.status);
      }
      const json = parseJson(response.body);
      if (json === null) throw new GmailClientError('malformed_response', 'the Gmail body read was not JSON');
      const text = readBodyText(json['payload'] as MessagePart | undefined);
      return { text: text.slice(0, maxBody), truncated: text.length > maxBody };
    },

    sendMessage: async (access, request: GmailSendRequest): Promise<GmailSendOutcome> => {
      let response: HttpResponse;
      try {
        response = await api(
          access,
          '/gmail/v1/users/me/messages/send',
          {},
          'POST',
          { raw: Buffer.from(mimeOf(request), 'utf8').toString('base64url') },
        );
      } catch (error) {
        // The request threw. That covers a timeout, a reset connection and a DNS
        // failure, and in every one of them the bytes may already have reached
        // Google. Appendix B: "Never resend; enter reconciling."
        return {
          ok: false,
          outcome: 'indeterminate',
          detail: error instanceof Error ? error.name : 'the send request failed',
        };
      }

      if (response.status === 200) {
        const json = parseJson(response.body);
        const id = asString(json?.['id']);
        const threadId = asString(json?.['threadId']);
        // A 200 whose body cannot be read is *not* a failure to send. Gmail accepted
        // it; only the receipt is missing, and the Sent search is what recovers it.
        if (id === null || threadId === null) {
          return { ok: false, outcome: 'indeterminate', detail: 'the send response had no message id' };
        }
        return { ok: true, messageId: id, threadId };
      }

      // 4xx means Gmail read the request and declined it, so nothing was sent and
      // the fence may be held. 5xx and everything else may have been accepted before
      // the error, and must never be retried.
      if (response.status >= 400 && response.status < 500) {
        const failure = classifyStatus(response.status, response.body);
        return {
          ok: false,
          outcome: 'refused',
          reason:
            failure === 'grant_revoked'
              ? 'grant_revoked'
              : failure === 'rate_limited'
                ? 'rate_limited'
                : response.status === 400
                  ? 'recipient_rejected'
                  : 'provider_refusal',
        };
      }
      return {
        ok: false,
        outcome: 'indeterminate',
        detail: `the send returned status ${String(response.status)}`,
      };
    },

    searchSentByMessageId: async (access, rfcMessageId): Promise<GmailSentSearchOutcome> => {
      // Appendix B: "`rfc822msgid:` search on the sending mailbox". The angle
      // brackets are not part of the searchable value.
      const bare = rfcMessageId.replace(/^</, '').replace(/>$/, '');
      const response = await api(
        access,
        '/gmail/v1/users/me/messages',
        { q: `rfc822msgid:${bare} in:sent`, maxResults: '2' },
        'GET',
      );
      if (response.status !== 200) {
        const failure = classifyStatus(response.status, response.body);
        if (failure === 'grant_revoked') return { ok: false, reason: 'grant_revoked' };
        if (failure === 'rate_limited') return { ok: false, reason: 'rate_limited' };
        throw new GmailClientError('unexpected_status', 'the Sent search failed', response.status);
      }
      const json = parseJson(response.body);
      const messages = Array.isArray(json?.['messages']) ? (json['messages'] as unknown[]) : [];
      const first = messages[0];
      if (typeof first !== 'object' || first === null) return { ok: true, found: null };
      const id = asString((first as Json)['id']);
      const threadId = asString((first as Json)['threadId']);
      if (id === null) return { ok: true, found: null };
      return { ok: true, found: { messageId: id, threadId: threadId ?? id } };
    },
  };
}

/**
 * The RFC 5322 message a send request becomes.
 *
 * Plain text, one recipient, no HTML alternative and no tracking pixel (12.7: "FSS
 * uses no open-tracking pixels"). The Message-ID is *ours*, written here rather than
 * left to Gmail, because it is what the Sent-folder reconciliation of Appendix B
 * searches for and it has to exist before the send rather than after it.
 *
 * Header values are stripped of CR and LF. A newline inside a header is header
 * injection, and the rendered subject comes from a template a person wrote.
 */
export function mimeOf(request: GmailSendRequest): string {
  const clean = (value: string): string => value.replace(/[\r\n]+/g, ' ').trim();
  const headers = [
    `From: ${clean(request.from)}`,
    `To: ${clean(request.to)}`,
    `Subject: ${encodeHeaderValue(clean(request.subject))}`,
    `Message-ID: ${clean(request.rfcMessageId)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: 8bit',
  ];
  if (request.inReplyTo !== undefined) headers.push(`In-Reply-To: ${clean(request.inReplyTo)}`);
  if (request.references !== undefined && request.references.length > 0) {
    headers.push(`References: ${request.references.map(clean).join(' ')}`);
  }
  return `${headers.join('\r\n')}\r\n\r\n${request.body.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')}`;
}

/** RFC 2047 encoded-word, but only when the value is not already plain ASCII. */
function encodeHeaderValue(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?utf-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

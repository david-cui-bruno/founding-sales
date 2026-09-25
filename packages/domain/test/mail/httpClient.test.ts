import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GMAIL_SCOPES,
  METADATA_HEADERS,
  classifyStatus,
  createGmailHttpClient,
  readBodyText,
  type GmailClient,
  type GmailOAuthConfig,
} from '../../mail/index.ts';

/**
 * The one Gmail implementation that speaks HTTP, against a loopback server.
 *
 * No test in this repository may reach Google, so this one *is* Google for the
 * length of the file: a `node:http` server on 127.0.0.1 that answers the handful of
 * endpoints the lane uses and records what was asked of it. That is enough to prove
 * the three things that are only true in the HTTP layer and are invisible in the
 * recorded fake.
 *
 *   * **The metadata read is restricted at the wire.** `format=metadata` with one
 *     `metadataHeaders` parameter per allowlisted header, so the response cannot
 *     contain a body even if a later refactor forgets to ignore one (12.3).
 *   * **Google's status codes become the specification's outcomes.** 404 from
 *     `history.list` is an expired cursor with a recovery, 401 is a revoked grant
 *     with a hold, 429 is a retry. Getting this wrong turns a routine cursor
 *     expiry into a paging alarm.
 *   * **The client secret travels in a POST body and nowhere else.** Not the
 *     consent URL, not a query string, not a log line.
 */

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly body: string;
}

describe('the Gmail HTTP client', () => {
  let server: Server;
  let origin: string;
  const requests: Recorded[] = [];
  let client: GmailClient;
  let config: GmailOAuthConfig;
  const clientSecret = randomBytes(24).toString('base64url');
  const access = { accessToken: randomBytes(16).toString('base64url'), expiresAtEpochSeconds: 0 };

  /** What the stub answers next, keyed by the path it is asked for. */
  const answers = new Map<string, { status: number; body: unknown }>();
  const answer = (path: string, status: number, body: unknown): void => {
    answers.set(path, { status, body });
  };

  beforeAll(async () => {
    server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        requests.push({
          method: request.method ?? 'GET',
          url: request.url ?? '/',
          body: Buffer.concat(chunks).toString('utf8'),
        });
        const prepared = answers.get(url.pathname) ?? { status: 200, body: {} };
        response.writeHead(prepared.status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(prepared.body));
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('the stub server has no port');
    origin = `http://127.0.0.1:${String(address.port)}`;

    config = {
      clientId: 'fss-greenfield-gmail.apps.googleusercontent.test',
      clientSecret,
      redirectUri: 'https://api.example.test/oauth/gmail/callback',
      authorizationEndpoint: `${origin}/o/oauth2/v2/auth`,
      tokenEndpoint: `${origin}/token`,
      revocationEndpoint: `${origin}/revoke`,
      apiBaseUrl: origin,
    };
    // The injected fetch is the platform's, pointed at the loopback server by the
    // configuration above; there is no rewriting and no interception.
    client = createGmailHttpClient({
      apiBaseUrl: origin,
      maxBodyCharacters: 40,
      fetch: async (url, init = {}) => {
        const response = await fetch(url, {
          method: init.method ?? 'GET',
          ...(init.headers === undefined ? {} : { headers: { ...init.headers } }),
          ...(init.body === undefined ? {} : { body: init.body }),
        });
        return { status: response.status, headers: {}, body: await response.text() };
      },
    });
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  const lastRequest = (): Recorded => {
    const last = requests.at(-1);
    if (last === undefined) throw new Error('the stub server was never called');
    return last;
  };

  it('asks for the two scopes, PKCE and offline access, and puts no secret in the consent URL', () => {
    const url = new URL(
      client.authorizationUrl(config, {
        state: 'signed-state',
        codeChallenge: 'a-challenge',
        scopes: GMAIL_SCOPES,
        loginHint: 'sales@example.test',
      }),
    );
    expect(url.searchParams.get('scope')?.split(' ').sort()).toEqual([...GMAIL_SCOPES].sort());
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('access_type')).toBe('offline');
    // Without `prompt=consent` a second consent returns no refresh token at all.
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('include_granted_scopes')).toBe('false');
    expect(url.toString()).not.toContain(clientSecret);
  });

  it('exchanges a code with the secret in the POST body and never in the URL', async () => {
    answer('/token', 200, {
      access_token: 'an-access-token',
      refresh_token: 'a-refresh-token',
      expires_in: 3599,
      scope: GMAIL_SCOPES.join(' '),
    });
    const outcome = await client.exchangeAuthorizationCode(config, { code: 'a-code', codeVerifier: 'a-verifier' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.grant.refreshToken).toBe('a-refresh-token');
    expect([...outcome.grant.grantedScopes].sort()).toEqual([...GMAIL_SCOPES].sort());

    const sent = lastRequest();
    expect(sent.method).toBe('POST');
    expect(sent.url).not.toContain(clientSecret);
    expect(new URLSearchParams(sent.body).get('client_secret')).toBe(clientSecret);
    expect(new URLSearchParams(sent.body).get('code_verifier')).toBe('a-verifier');
  });

  it('reads a revoked refresh token as grant_revoked rather than as a fault to retry', async () => {
    answer('/token', 400, { error: 'invalid_grant' });
    const outcome = await client.refreshAccessToken(config, 'a-dead-refresh-token');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('grant_revoked');
  });

  it('restricts the metadata read at the wire: format=metadata and one header parameter each', async () => {
    answer('/gmail/v1/users/me/messages/m-1', 200, {
      id: 'm-1',
      threadId: 't-1',
      internalDate: '1758000000000',
      labelIds: ['INBOX'],
      sizeEstimate: 4096,
      payload: {
        headers: [
          { name: 'From', value: 'Someone <someone@example.test>' },
          { name: 'Subject', value: 'A subject' },
        ],
        parts: [{ filename: 'terms.pdf', mimeType: 'application/pdf', body: { size: 900, attachmentId: 'att-1' } }],
      },
    });
    const metadata = await client.getMetadata(access, 'm-1', METADATA_HEADERS);
    expect(metadata?.headers['Subject']).toBe('A subject');
    // 10.3: the reference, never the bytes.
    expect(metadata?.attachments).toEqual([
      { filename: 'terms.pdf', mimeType: 'application/pdf', sizeBytes: 900, attachmentId: 'att-1' },
    ]);
    expect(metadata).not.toHaveProperty('body');

    const asked = new URL(lastRequest().url, origin);
    expect(asked.searchParams.get('format')).toBe('metadata');
    expect(asked.searchParams.getAll('metadataHeaders')).toEqual([...METADATA_HEADERS]);
  });

  it('returns null for a message that vanished between the listing and the read', async () => {
    answer('/gmail/v1/users/me/messages/m-gone', 404, { error: { code: 404 } });
    expect(await client.getMetadata(access, 'm-gone', METADATA_HEADERS)).toBeNull();
    expect(await client.getBody(access, 'm-gone')).toBeNull();
  });

  it('prefers the text/plain part and reports a truncated body as truncated', async () => {
    const long = 'Thanks, and please take me off your list. '.repeat(4);
    answer('/gmail/v1/users/me/messages/m-2', 200, {
      id: 'm-2',
      payload: {
        mimeType: 'multipart/alternative',
        parts: [
          { mimeType: 'text/html', body: { data: Buffer.from('<p>html</p>', 'utf8').toString('base64url') } },
          { mimeType: 'text/plain', body: { data: Buffer.from(long, 'utf8').toString('base64url') } },
        ],
      },
    });
    const body = await client.getBody(access, 'm-2');
    expect(body?.truncated).toBe(true);
    expect(body?.text).toBe(long.slice(0, 40));
    expect(body?.text).not.toContain('html');
  });

  it('turns a 404 from history.list into an expired cursor, not a failure', async () => {
    answer('/gmail/v1/users/me/history', 404, { error: { code: 404, message: 'Not Found' } });
    const expired = await client.listHistory(access, { startHistoryId: '900' });
    expect(expired.ok).toBe(false);
    if (expired.ok) return;
    expect(expired.reason).toBe('history_expired');

    answer('/gmail/v1/users/me/history', 429, { error: { code: 429 } });
    const limited = await client.listHistory(access, { startHistoryId: '900' });
    expect(limited.ok === false && limited.reason).toBe('rate_limited');

    answer('/gmail/v1/users/me/history', 401, { error: { code: 401 } });
    const revoked = await client.listHistory(access, { startHistoryId: '900' });
    expect(revoked.ok === false && revoked.reason).toBe('grant_revoked');
  });

  /**
   * A `users.history.list` answer in the shape Google documents, not the shape the
   * adapter expects (lane g76, audit item C06).
   *
   * https://developers.google.com/gmail/api/reference/rest/v1/users.history/list —
   * `ListHistoryResponse` is `{ history: History[], nextPageToken, historyId }`, where
   * `historyId` is "the ID of the mailbox's current history record".
   * https://developers.google.com/gmail/api/reference/rest/v1/users.history#History —
   * a `History` is `{ id, messages, messagesAdded, messagesDeleted, labelsAdded,
   * labelsRemoved }`; `id` is "the mailbox sequence ID", and "each history change may
   * affect multiple messages in multiple ways". A `LabelAdded` is `{ message, labelIds }`.
   * Messages in a history answer "will typically only have id and threadId fields
   * populated", with `labelIds` alongside in practice. Every id is a uint64 decimal
   * string (`"format": "uint64"` in the discovery document).
   *
   * No record here has a `historyId`. That field belongs to the `Message` resource, and
   * the fixture this replaces put it on the record, which is the only reason the
   * adapter that read it passed.
   */
  const documentedHistoryPage = {
    history: [
      {
        id: '1010',
        messages: [{ id: 'm-3', threadId: 't-3' }],
        messagesAdded: [{ message: { id: 'm-3', threadId: 't-3', labelIds: ['INBOX', 'UNREAD'] } }],
      },
      {
        id: '1017',
        messages: [
          { id: 'm-4', threadId: 't-4' },
          { id: 'm-5', threadId: 't-5' },
        ],
        labelsAdded: [
          { message: { id: 'm-4', threadId: 't-4', labelIds: ['SENT'] }, labelIds: ['SENT'] },
          { message: { id: 'm-5', threadId: 't-5', labelIds: ['INBOX', 'IMPORTANT'] }, labelIds: ['IMPORTANT'] },
        ],
      },
    ],
    nextPageToken: 'page-2',
    historyId: '1020',
  };

  it('reads each history record by its own id, keeps its messages together, and carries the page token', async () => {
    answer('/gmail/v1/users/me/history', 200, documentedHistoryPage);
    const page = await client.listHistory(access, { startHistoryId: '1000', pageToken: 'page-1' });
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    // The record's `id`, never the start cursor: the old adapter answered '1000' twice.
    expect(page.records.map(record => record.id)).toEqual(['1010', '1017']);
    expect(page.records.map(record => record.changes.map(change => change.messageId))).toEqual([
      ['m-3'],
      ['m-4', 'm-5'],
    ]);
    expect(page.records[0]?.changes[0]?.kind).toBe('message_added');
    expect(page.records[1]?.changes.map(change => change.kind)).toEqual(['label_added', 'label_added']);
    expect(page.historyId).toBe('1020');
    expect(page.nextPageToken).toBe('page-2');
    expect(new URL(lastRequest().url, origin).searchParams.get('pageToken')).toBe('page-1');
  });

  it('keeps a uint64 history id exactly, digit for digit', async () => {
    answer('/gmail/v1/users/me/history', 200, {
      history: [
        { id: '9007199254740993', messagesAdded: [{ message: { id: 'm-6', threadId: 't-6', labelIds: ['INBOX'] } }] },
      ],
      historyId: '18446744073709551615',
    });
    const page = await client.listHistory(access, { startHistoryId: '9007199254740992' });
    expect(page.ok && page.records[0]?.id).toBe('9007199254740993');
    expect(page.ok && page.historyId).toBe('18446744073709551615');
    expect(page.ok && page.nextPageToken).toBeNull();
  });

  it('refuses a history record without an id instead of standing it on the start cursor', async () => {
    // The shape the old fixture used. A record with no id has no cursor it could
    // safely stand for, so the page is malformed and the run fails without writing.
    answer('/gmail/v1/users/me/history', 200, {
      history: [{ historyId: '1010', messagesAdded: [{ message: { id: 'm-7', threadId: 't-7' } }] }],
      historyId: '1011',
    });
    await expect(client.listHistory(access, { startHistoryId: '1000' })).rejects.toMatchObject({
      name: 'GmailClientError',
      code: 'malformed_response',
    });
  });

  it('Appendix D: the recovery listing is bounded by epoch seconds, never a date string', async () => {
    answer('/gmail/v1/users/me/messages', 200, { messages: [{ id: 'm-5' }], nextPageToken: null });
    const listed = await client.listMessageIds(access, {
      afterEpochSeconds: 1_757_000_000,
      beforeEpochSeconds: 1_758_000_000,
      maxResults: 500,
    });
    expect(listed.ok && listed.messageIds).toEqual(['m-5']);
    expect(new URL(lastRequest().url, origin).searchParams.get('q')).toBe('after:1757000000 before:1758000000');
  });

  it('lists the Sent folder by the same epoch-second bounds, trash included (lane g73)', async () => {
    answer('/gmail/v1/users/me/messages', 200, { messages: [{ id: 'm-6' }], nextPageToken: 'next' });
    const listed = await client.listSentMessageIds(access, {
      afterEpochSeconds: 1_757_000_000,
      beforeEpochSeconds: 1_758_000_000,
      maxResults: 500,
      pageToken: 'first',
    });
    expect(listed).toEqual({ ok: true, messageIds: ['m-6'], nextPageToken: 'next' });
    const params = new URL(lastRequest().url, origin).searchParams;
    expect(params.get('q')).toBe('in:sent after:1757000000 before:1758000000');
    expect(params.get('includeSpamTrash')).toBe('true');
    expect(params.get('pageToken')).toBe('first');

    answer('/gmail/v1/users/me/messages', 429, { error: { code: 429 } });
    const limited = await client.listSentMessageIds(access, {
      afterEpochSeconds: 1_757_000_000,
      beforeEpochSeconds: 1_758_000_000,
      maxResults: 500,
    });
    expect(limited).toEqual({ ok: false, reason: 'rate_limited' });
  });

  it('registers and stops a watch, and reads a refusal as a refusal', async () => {
    answer('/gmail/v1/users/me/watch', 200, { historyId: '1100', expiration: '1758600000000' });
    const registered = await client.watch(access, { topicName: 'projects/callie-fss/topics/fss-test-gmail-push' });
    expect(registered.ok && registered.watch.historyId).toBe('1100');
    expect(JSON.parse(lastRequest().body)).toMatchObject({
      topicName: 'projects/callie-fss/topics/fss-test-gmail-push',
    });

    answer('/gmail/v1/users/me/watch', 400, { error: { code: 400 } });
    const refused = await client.watch(access, { topicName: 'projects/callie-fss/topics/fss-test-gmail-push' });
    expect(refused.ok === false && refused.reason).toBe('provider_refusal');

    await client.stopWatch(access);
    expect(lastRequest().url).toBe('/gmail/v1/users/me/stop');
  });

  it('revokes against the revocation endpoint and survives a refusal, because revocation is best effort', async () => {
    answer('/revoke', 400, { error: 'invalid_token' });
    await expect(client.revokeRefreshToken(config, 'a-refresh-token')).resolves.toBeUndefined();
    expect(lastRequest().url).toBe('/revoke');
  });

  it('separates a quota 403 from an authorisation 403', () => {
    expect(classifyStatus(403, JSON.stringify({ error: { errors: [{ reason: 'rateLimitExceeded' }] } }))).toBe(
      'rate_limited',
    );
    expect(classifyStatus(403, JSON.stringify({ error: { errors: [{ reason: 'authError' }] } }))).toBe('grant_revoked');
    expect(classifyStatus(401, '')).toBe('grant_revoked');
    expect(classifyStatus(404, '')).toBe('not_found');
    expect(classifyStatus(500, '')).toBe('unexpected');
  });

  it('flattens HTML-only mail without parsing it', () => {
    const html = '<style>p{}</style><p>Please <b>stop</b> emailing me.</p><script>x()</script>';
    const text = readBodyText({
      mimeType: 'text/html',
      body: { data: Buffer.from(html, 'utf8').toString('base64url') },
    });
    expect(text).toContain('Please stop emailing me.');
    expect(text).not.toContain('<');
    expect(text).not.toContain('x()');
  });
});

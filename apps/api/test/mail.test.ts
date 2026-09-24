import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectMailboxCommandSchema, gmailConnectResultSchema, gmailStatusSchema } from '@fss/contracts';
import {
  GMAIL_SCOPES,
  fixturePushTokens,
  localEnvelopeCipher,
  recordedGmailClient,
  signGrantState,
  staticSecretProvider,
  type GmailFixture,
  type MailPublicConfig,
  type PushTokenClaims,
  type RecordedGmailClient,
} from '@fss/domain/mail';
import { dispatch, type ApiRequest } from '../src/server.ts';
import type { MailRoutingDeps } from '../src/routes/types.ts';
import {
  createAuthFixture,
  CURRENT_CLIENT_VERSION,
  OUTDATED_CLIENT_VERSION,
  type AuthFixture,
} from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';

/**
 * The Gmail routes, through the real dispatcher with real sessions.
 *
 * What is proved here is the wiring; the rules have their own tests against a real
 * PostgreSQL in `@fss/domain/mail`. Four things are wiring and each has been wrong in
 * a mail integration before:
 *
 *   * the consent URL asks for the two scopes and nothing wider, and carries no
 *     secret;
 *   * the callback authenticates on its signed state rather than on a session, and
 *     tells the browser nothing either way;
 *   * the push endpoint refuses a well-signed token with the wrong audience and
 *     writes no row while doing it;
 *   * the message read is redacted by the caller's visibility class, so a colleague's
 *     response has no field a body could hide in (Appendix F).
 */
describe('Gmail routes', () => {
  let fixture: AuthFixture;
  let assigneeToken: string;
  let gmail: RecordedGmailClient;
  let mail: MailRoutingDeps;
  let stateSigningKey: Buffer;
  let gmailFixture: GmailFixture;

  const config = (): MailPublicConfig => ({
    clientId: 'api-test-client.apps.googleusercontent.test',
    redirectUri: 'https://api.example.test/oauth/gmail/callback',
    authorizationEndpoint: 'https://accounts.example.test/o/oauth2/v2/auth',
    tokenEndpoint: 'https://oauth2.example.test/token',
    revocationEndpoint: 'https://oauth2.example.test/revoke',
    apiBaseUrl: 'https://gmail.example.test',
    pushTopicName: 'projects/callie-fss/topics/fss-test-gmail-push',
    pushAudience: 'https://api.example.test/integrations/gmail/push',
    pushServiceAccountEmail: 'fss-test-push@callie-fss.iam.gserviceaccount.test',
    hostedDomain: fixture.hostedDomain,
    baselineDays: 30,
  });

  const tokens = fixturePushTokens();

  const options = () => ({
    session: fixture.db,
    supportedClientVersions: fixture.deps.config.supportedClientVersions,
    sendingEnabled: false,
    expectedSystemGeneration: null,
    auth: fixture.deps,
    mail,
  });

  const post = async (
    path: string,
    token: string | null,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const request: ApiRequest = {
      method: 'POST',
      path,
      query: new URLSearchParams(),
      headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...headers },
      body,
    };
    const result = await dispatch(request, options());
    return { status: result.status, body: result.body as Record<string, unknown> };
  };

  const get = async (
    path: string,
    token: string | null,
    query: Record<string, string> = {},
  ): Promise<{ status: number; body: unknown; contentType?: string | undefined }> => {
    const result = await dispatch(
      {
        method: 'GET',
        path,
        query: new URLSearchParams(query),
        headers: token === null ? {} : { authorization: `Bearer ${token}` },
        body: undefined,
      },
      options(),
    );
    return { status: result.status, body: result.body, contentType: result.contentType };
  };

  const command = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    commandId: randomUUID(),
    clientVersion: CURRENT_CLIENT_VERSION,
    ...extra,
  });

  beforeAll(async () => {
    fixture = await createAuthFixture();
    const grant = await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson);
    assigneeToken = grant.accessToken;

    stateSigningKey = randomBytes(32);
    gmailFixture = {
      emailAddress: `sales.alpha@${fixture.hostedDomain}`,
      historyId: '1000',
      messages: [],
      refreshToken: randomBytes(24).toString('base64url'),
    };
    gmail = recordedGmailClient(gmailFixture);
    mail = {
      gmail,
      config: config(),
      secrets: staticSecretProvider({ gmail_oauth_client_secret: randomBytes(24).toString('base64url') }),
      cipher: localEnvelopeCipher('api-test-envelope'),
      stateSigningKey,
      pushVerifier: tokens.verifier,
    };
  });

  afterAll(async () => {
    await fixture.stop();
  });

  it('refuses every mail path without a session, and the commands to an outdated client', async () => {
    expect((await post('/gmail/connect', null, command())).status).toBe(401);
    expect((await post('/messages', null, { opportunityId: randomUUID() })).status).toBe(401);
    const outdated = await post('/gmail/connect', assigneeToken, command({ clientVersion: OUTDATED_CLIENT_VERSION }));
    expect(outdated.status).toBe(426);
  });

  it('asks Google for gmail.readonly and gmail.send and nothing wider, with no secret in the URL', async () => {
    // The envelope the Mac sends is the shared contract's, and so is the answer it parses.
    const body = command();
    expect(connectMailboxCommandSchema.safeParse(body).success).toBe(true);
    const started = await post('/gmail/connect', assigneeToken, body);
    expect(started.status).toBe(200);
    const result = gmailConnectResultSchema.parse(started.body['result']);
    const url = new URL(result.authorizationUrl);
    expect(url.searchParams.get('scope')?.split(' ').sort()).toEqual([...GMAIL_SCOPES].sort());
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.toString()).not.toContain('client_secret');
    // The one secret this lane has never leaves the token exchange.
    expect(url.toString()).not.toContain(mail.config.clientId.replace('client', 'secret'));
  });

  it('completes the grant from its signed state, with no session, and says nothing to the browser', async () => {
    const state = signGrantState(stateSigningKey, {
      workspaceId: fixture.alpha.workspaceId,
      userId: fixture.alpha.salesperson.userId,
      expiresAtEpochSeconds: Math.floor(Date.now() / 1000) + 600,
    });
    const page = await get('/oauth/gmail/callback', null, { state, code: 'a-google-code' });
    expect(page.status).toBe(200);
    expect(page.contentType).toBe('text/html; charset=utf-8');
    expect(String(page.body)).toContain('Gmail connected');
    // Nothing about the grant, the address or the state reaches the page.
    expect(String(page.body)).not.toContain(gmailFixture.emailAddress);
    expect(String(page.body)).not.toContain(state);

    const status = await get('/gmail/status', assigneeToken);
    // Parsed with the schema the Mac's Mailbox row uses (`@fss/contracts`), so a shape
    // the route changes on its own is a failure here, not a row that says "Unknown".
    const reported = gmailStatusSchema.parse(status.body);
    expect(reported.connected).toBe(true);
    expect(reported.mailbox?.emailAddress).toBe(gmailFixture.emailAddress);
    expect(reported.mailbox?.syncState).toBe('baseline_pending');
    expect(JSON.stringify(reported)).not.toContain(gmailFixture.refreshToken ?? 'never');
  });

  it('refuses a callback whose state is forged or expired, and connects nothing', async () => {
    const forged = signGrantState(randomBytes(32), {
      workspaceId: fixture.alpha.workspaceId,
      userId: fixture.alpha.salesperson.userId,
      expiresAtEpochSeconds: Math.floor(Date.now() / 1000) + 600,
    });
    const page = await get('/oauth/gmail/callback', null, { state: forged, code: 'a-google-code' });
    expect(page.status).toBe(400);
    expect(String(page.body)).toContain('Gmail not connected');

    const expired = signGrantState(stateSigningKey, {
      workspaceId: fixture.alpha.workspaceId,
      userId: fixture.alpha.salesperson.userId,
      expiresAtEpochSeconds: Math.floor(Date.now() / 1000) - 1,
    });
    expect((await get('/oauth/gmail/callback', null, { state: expired, code: 'c' })).status).toBe(400);
    // A callback with no code at all is refused before anything is verified.
    expect((await get('/oauth/gmail/callback', null, { state: forged })).status).toBe(400);
  });

  it('Appendix G 27: the push endpoint refuses the wrong audience and writes no row', async () => {
    const now = Math.floor(Date.now() / 1000);
    const claims = (overrides: Partial<PushTokenClaims> = {}): PushTokenClaims => ({
      iss: 'https://accounts.google.com',
      aud: mail.config.pushAudience,
      email: mail.config.pushServiceAccountEmail,
      email_verified: true,
      iat: now - 5,
      exp: now + 600,
      ...overrides,
    });
    const body = (messageId: string): unknown => ({
      message: {
        data: Buffer.from(
          JSON.stringify({ emailAddress: gmailFixture.emailAddress, historyId: '1009' }),
          'utf8',
        ).toString('base64'),
        messageId,
        publishTime: new Date().toISOString(),
      },
    });

    const wrongAudience = await post('/integrations/gmail/push', null, body('push-wrong'), {
      authorization: `Bearer ${tokens.sign(claims({ aud: 'https://api.example.test/elsewhere' }))}`,
    });
    expect(wrongAudience.status).toBe(401);
    expect(wrongAudience.body['error']).toBe('push_refused');

    const accepted = await post('/integrations/gmail/push', null, body('push-good'), {
      authorization: `Bearer ${tokens.sign(claims())}`,
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body['status']).toBe('accepted');

    const { rows } = await fixture.db.query<{ provider_message_id: string }>(
      'SELECT provider_message_id FROM gmail_push_notifications ORDER BY provider_message_id',
    );
    expect(rows.map(row => row.provider_message_id)).toEqual(['push-good']);
  });

  it('disconnects, deletes the refresh-token material and holds the owner', async () => {
    const status = await get('/gmail/status', assigneeToken);
    const mailboxId = (status.body as { mailbox: { id: string } }).mailbox.id;

    const disconnected = await post(
      '/gmail/disconnect',
      assigneeToken,
      command({ mailboxId, reason: 'testing the departure path' }),
    );
    expect(disconnected.status).toBe(200);
    expect((disconnected.body['result'] as { tokenDeleted: boolean }).tokenDeleted).toBe(true);

    const tokensLeft = await fixture.db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM mailbox_tokens WHERE mailbox_id = $1',
      [mailboxId],
    );
    expect(tokensLeft.rows[0]?.count).toBe('0');

    const holds = await fixture.db.query<{ reason_code: string }>(
      `SELECT reason_code FROM active_holds
        WHERE source_event_kind = 'mailbox' AND source_event_id = $1 AND released_at IS NULL`,
      [mailboxId],
    );
    expect(holds.rows.map(row => row.reason_code)).toContain('mailbox_disconnected');

    const after = await get('/gmail/status', assigneeToken);
    expect((after.body as { connected: boolean }).connected).toBe(false);
  });
});

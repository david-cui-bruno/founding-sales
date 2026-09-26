import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gmailConnectResultSchema, gmailStatusSchema } from '@fss/contracts';
import {
  GMAIL_API_BASE_URL,
  GOOGLE_AUTHORIZATION_ENDPOINT,
  GOOGLE_REVOCATION_ENDPOINT,
  GOOGLE_TOKEN_ENDPOINT,
} from '@fss/domain/mail/config.ts';
import { localEnvelopeCipher } from '@fss/domain/mail/envelope.ts';
import { type HttpFetch, type HttpRequest, type HttpResponse } from '@fss/domain/mail/gmailClientHttp.ts';
import { GMAIL_SCOPES } from '@fss/domain/mail/types.ts';
import { DEPLOYMENT_ENVIRONMENT_VARIABLES, readApiDeployment, type ApiDeployment } from '../src/bootstrap/deployment.ts';
import type { MailRoutingDeps } from '../src/routes/types.ts';
import { dispatch, type ApiRequest } from '../src/server.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';

/**
 * The Gmail grant against Google's real endpoints (release.md 8.0x).
 *
 * Sign-in's first production attempt was refused because `discovery()` held Google's
 * document to a same-origin rule Google's own hosts do not meet (8.0u, lane g45), and the
 * lane tests had not seen it because their local provider served every endpoint from one
 * loopback origin. The Gmail grant is the next Google-side path production will run for
 * the first time — the Mac's new Connect Gmail button starts it — so this is the same
 * question asked of it before it runs.
 *
 * **The answer, from the code.** The Gmail grant does not use discovery, `exchangeCode`
 * or any issuer or origin rule. `beginGmailGrant` and `completeGmailGrant`
 * (`packages/domain/mail/oauth.ts`) call the `GmailClient` port, and the live API gives
 * it `createGmailHttpClient`, which posts the code to `config.tokenEndpoint` as it stands.
 * `readApiDeployment` fixes that to `https://oauth2.googleapis.com/token` — the same host
 * Google's discovery document names — and the consent screen to
 * `https://accounts.google.com/o/oauth2/v2/auth`. No id token comes back (the grant asks
 * for `gmail.readonly` and `gmail.send`, not `openid`), so no key set is fetched either.
 * Nothing needed changing; these tests hold it there.
 *
 * So the deployment here is the live one, read through `readApiDeployment` with an
 * injected `fetch` that answers only Google's real URLs in Google's real shapes, and
 * reaches nothing. The envelope cipher is the local one because the KMS transport is a
 * stub; that is the only part swapped.
 */

const V = DEPLOYMENT_ENVIRONMENT_VARIABLES;
const ORIGIN = 'https://api.example.test';
const REDIRECT = `${ORIGIN}/oauth/gmail/callback`;
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const PROFILE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';

interface Recorded {
  readonly url: string;
  readonly request: HttpRequest | undefined;
}

const json = (status: number, body: unknown): HttpResponse => ({
  status,
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify(body),
});

describe("the Gmail grant against Google's real endpoints", () => {
  let fixture: AuthFixture;
  let accessToken: string;
  let deployment: ApiDeployment;
  let mail: MailRoutingDeps;
  let address: string;
  const clientId = `${randomBytes(12).toString('hex')}.apps.googleusercontent.test`;
  const requests: Recorded[] = [];
  let tokenAnswer: HttpResponse = json(404, {});

  /** Google, as far as the grant can see it. Anything else is a 404 and a failed test. */
  const google: HttpFetch = async (url, request) => {
    requests.push({ url, request });
    if (url === TOKEN_URL && request?.method === 'POST') return await Promise.resolve(tokenAnswer);
    if (url === PROFILE_URL && (request?.method ?? 'GET') === 'GET') {
      return await Promise.resolve(json(200, { emailAddress: address, messagesTotal: 12, threadsTotal: 9, historyId: '4812' }));
    }
    return await Promise.resolve({ status: 404, headers: {}, body: '' });
  };

  const options = () => ({
    session: fixture.db,
    supportedClientVersions: fixture.deps.config.supportedClientVersions,
    sendingEnabled: false,
    auth: fixture.deps,
    mail,
  });

  const call = async (
    method: 'GET' | 'POST',
    path: string,
    token: string | null,
    extra: { readonly body?: unknown; readonly query?: Record<string, string> } = {},
  ): Promise<{ status: number; body: unknown }> => {
    const request: ApiRequest = {
      method,
      path,
      query: new URLSearchParams(extra.query ?? {}),
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
      body: extra.body,
    };
    const result = await dispatch(request, options());
    return { status: result.status, body: result.body };
  };

  const connect = async (): Promise<URL> => {
    const started = await call('POST', '/gmail/connect', accessToken, {
      body: { commandId: randomUUID(), clientVersion: CURRENT_CLIENT_VERSION },
    });
    expect(started.status).toBe(200);
    const result = gmailConnectResultSchema.parse((started.body as { result: unknown }).result);
    return new URL(result.authorizationUrl);
  };

  beforeAll(async () => {
    fixture = await createAuthFixture();
    accessToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)).accessToken;
    address = `sales.alpha@${fixture.hostedDomain}`;
    deployment = await readApiDeployment(
      {
        [V.environmentName]: 'production',
        [V.dependencies]: 'live',
        [V.region]: 'us-east-1',
        [V.publicOrigin]: `${ORIGIN}/`,
        [V.envelopeKeyId]: 'arn:aws:kms:us-east-1:000000000000:key/example',
        [V.journalBucket]: 'fss-prod-suppression-journal',
        [V.pushAudience]: `${ORIGIN}/integrations/gmail/push`,
        [V.pushServiceAccount]: 'fss-prod-gmail-push@example.iam.gserviceaccount.test',
        [V.pushTopic]: 'projects/example/topics/fss-prod-gmail-push',
        [V.hostedDomain]: fixture.hostedDomain,
        [V.sendingEnabled]: 'false',
        [V.upgradeUrl]: 'https://updates.example.test/releases/darwin-arm64/latest.json',
        [V.sessionSigningKey]: randomBytes(48).toString('base64'),
        [V.gmailOAuthClient]: JSON.stringify({ client_id: clientId, client_secret: randomBytes(24).toString('hex') }),
        [V.oidcClient]: JSON.stringify({
          client_id: 'signin.apps.googleusercontent.test',
          client_secret: randomBytes(24).toString('hex'),
        }),
      },
      {
        loadKms: async () =>
          await Promise.resolve({ generateDataKey: async () => ({}), decrypt: async () => ({}) } as never),
        putObject: async () => await Promise.resolve('written' as const),
        fetch: google,
      },
    );
    const live = deployment.mail;
    if (live === undefined) throw new Error('a live deployment always has mail deps');
    mail = { ...live, cipher: localEnvelopeCipher('gmail-google-test') };
  });

  afterAll(async () => {
    await fixture.stop();
  });

  it("names Google's own hosts, the ones its discovery document names, and the registered redirect", () => {
    expect(deployment.gmailSource).toBe('https');
    expect(deployment.mailConfig).toMatchObject({
      authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      revocationEndpoint: 'https://oauth2.googleapis.com/revoke',
      apiBaseUrl: 'https://gmail.googleapis.com',
      redirectUri: REDIRECT,
    });
    // The deployment spells them out; the domain names them. Two copies agree or this fails.
    expect(deployment.mailConfig?.authorizationEndpoint).toBe(GOOGLE_AUTHORIZATION_ENDPOINT);
    expect(deployment.mailConfig?.tokenEndpoint).toBe(GOOGLE_TOKEN_ENDPOINT);
    expect(deployment.mailConfig?.revocationEndpoint).toBe(GOOGLE_REVOCATION_ENDPOINT);
    expect(deployment.mailConfig?.apiBaseUrl).toBe(GMAIL_API_BASE_URL);
  });

  it('starts the grant on accounts.google.com with the registered redirect and the two scopes, and reaches nothing', async () => {
    const before = requests.length;
    const url = await connect();
    expect(`${url.origin}${url.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe(clientId);
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('scope')?.split(' ').sort()).toEqual([...GMAIL_SCOPES].sort());
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(requests.length).toBe(before);
  });

  it('connects nothing when Google refuses the code, and says nothing to the browser', async () => {
    tokenAnswer = json(400, { error: 'invalid_grant', error_description: 'Bad Request' });
    const state = (await connect()).searchParams.get('state') ?? '';
    const page = await call('GET', '/oauth/gmail/callback', null, { query: { state, code: `4/0A${randomUUID()}` } });
    expect(page.status).toBe(409);
    expect(String(page.body)).toContain('Gmail not connected');
    const status = gmailStatusSchema.parse((await call('GET', '/gmail/status', accessToken)).body);
    expect(status).toEqual({ connected: false, mailbox: null });
  });

  it('exchanges the code at https://oauth2.googleapis.com/token, reads the profile on gmail.googleapis.com, and connects', async () => {
    // Google's answer for this grant: no id token, the scopes in Google's own order, and
    // a field the client has never heard of, which it must ignore.
    tokenAnswer = json(200, {
      access_token: `ya29.${randomBytes(24).toString('base64url')}`,
      expires_in: 3599,
      refresh_token: `1//${randomBytes(24).toString('base64url')}`,
      scope: 'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly',
      token_type: 'Bearer',
      refresh_token_expires_in: 604799,
    });
    const consent = await connect();
    const state = consent.searchParams.get('state') ?? '';
    const code = `4/0A${randomUUID()}`;
    const before = requests.length;

    const page = await call('GET', '/oauth/gmail/callback', null, { query: { state, code } });
    expect(page.status).toBe(200);
    expect(String(page.body)).toContain('Gmail connected');

    const reached = requests.slice(before);
    expect(reached.map(entry => `${entry.request?.method ?? 'GET'} ${entry.url}`)).toEqual([
      `POST ${TOKEN_URL}`,
      `GET ${PROFILE_URL}`,
    ]);
    const form = new URLSearchParams(reached[0]?.request?.body ?? '');
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe(code);
    expect(form.get('redirect_uri')).toBe(REDIRECT);
    expect(form.get('client_id')).toBe(clientId);
    // PKCE ties the two legs: the challenge on the consent URL is the S256 of the
    // verifier the exchange sent, and the verifier was never in a URL.
    const verifier = form.get('code_verifier') ?? '';
    expect(createHash('sha256').update(verifier, 'utf8').digest('base64url')).toBe(
      consent.searchParams.get('code_challenge'),
    );
    expect(consent.toString()).not.toContain(verifier);

    // What the Mac's Mailbox row reads next, in the schema it parses it with.
    const status = gmailStatusSchema.parse((await call('GET', '/gmail/status', accessToken)).body);
    expect(status.connected).toBe(true);
    expect(status.mailbox).toMatchObject({ emailAddress: address, status: 'connected', syncState: 'baseline_pending' });
  });
});

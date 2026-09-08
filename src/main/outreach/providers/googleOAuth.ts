/* eslint-disable no-control-regex -- Reject NUL in the untrusted OAuth callback code. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { z } from 'zod';
import type { GmailCredentials } from './providerTypes';
import { gmailSendScope } from './gmailProvider';
import { requestJsonOnce } from './providerHttp';
import { fail, mailboxSchema, ProviderError, safeError, secretSchema } from './providerValidation';

const clientSchema = z.object({ clientId: z.string().min(1).max(500).regex(/^[a-zA-Z0-9._-]+\.apps\.googleusercontent\.com$/),
  clientSecret: secretSchema });
const tokenSchema = z.object({ access_token: secretSchema.min(1), refresh_token: secretSchema.min(1),
  token_type: z.literal('Bearer'), expires_in: z.number().int().min(60).max(86400), scope: z.string().min(1).max(4000) });
const identitySchema = z.object({ sub: z.string().min(1).max(255), email: mailboxSchema, email_verified: z.literal(true) });

/** Explicit desktop authorization only. Browser owns login, never embedded webview.
 * The loopback listener is short-lived and cannot invoke arbitrary app commands.
 */
export async function authorizeGoogle(input: {
  clientId: string; clientSecret: string; signal: AbortSignal; now?: () => number;
  openExternal(url: string): Promise<void>; fetch: typeof globalThis.fetch; timeoutMs?: number;
}): Promise<GmailCredentials> {
  const client = clientSchema.safeParse(input);
  if (!client.success) fail('invalid_configuration');
  if (input.signal.aborted) fail('oauth_cancelled');
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  const callbackPath = `/oauth/callback/${randomBytes(16).toString('hex')}`;
  const controller = new AbortController();
  let failure: ProviderError | null = null;
  let resolveCode: (code: string) => void;
  let rejectCode: (error: ProviderError) => void;
  const codePromise = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  // Observe abort/browser/listen errors even before the listener finishes binding.
  void codePromise.catch((): undefined => undefined);
  const stop = (code: 'oauth_cancelled' | 'oauth_timeout' | 'oauth_browser_failed' | 'oauth_unavailable' | 'oauth_denied') => {
    if (failure !== null) return;
    failure = new ProviderError(code);
    controller.abort();
    rejectCode(failure);
  };
  const cancel = () => stop('oauth_cancelled');
  input.signal.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => stop('oauth_timeout'), input.timeoutMs ?? 120000);
  let host = '';
  let received = false;
  const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    response.setHeader('Connection', 'close');
    const refuse = (status: number) => { response.writeHead(status); response.end('Authorization callback rejected.'); };
    if (received || controller.signal.aborted) { refuse(410); return; }
    if (request.method !== 'GET' || request.headers.host !== host || (request.url?.length ?? 0) > 8192) { refuse(400); return; }
    let url: URL;
    try { url = new URL(request.url ?? '', `http://${host}`); } catch { refuse(400); return; }
    if (url.origin !== `http://${host}` || url.pathname !== callbackPath) { refuse(404); return; }
    const candidate = url.searchParams.get('state') ?? '';
    if (url.searchParams.getAll('state').length !== 1 || Buffer.byteLength(candidate) !== Buffer.byteLength(state)
      || !timingSafeEqual(Buffer.from(candidate), Buffer.from(state))) { refuse(400); return; }
    if (url.searchParams.has('error')) {
      received = true;
      response.end('Authorization was not completed.', () => stop('oauth_denied'));
      return;
    }
    const code = url.searchParams.get('code');
    if (url.searchParams.getAll('code').length !== 1 || !code || code.length > 4096 || /[\r\n\u0000]/.test(code)) { refuse(400); return; }
    received = true;
    response.end('Authorization received. You may return to FSS.', () => resolveCode(code));
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.on('error', () => stop('oauth_unavailable'));
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    if (failure) throw failure;
    const address = server.address();
    if (address === null || typeof address === 'string') fail('oauth_unavailable');
    host = `127.0.0.1:${address.port}`;
    const redirectUri = `http://${host}${callbackPath}`;
    const authorization = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authorization.search = new URLSearchParams({ client_id: client.data.clientId, redirect_uri: redirectUri,
      response_type: 'code', scope: `openid email ${gmailSendScope}`, state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
      access_type: 'offline', prompt: 'consent select_account', include_granted_scopes: 'false',
    }).toString();
    try { Promise.resolve(input.openExternal(authorization.href)).catch(() => stop('oauth_browser_failed')); }
    catch { stop('oauth_browser_failed'); }
    const code = await codePromise;
    if (failure) throw failure;
    const body = new URLSearchParams({ client_id: client.data.clientId, redirect_uri: redirectUri,
      grant_type: 'authorization_code', code, code_verifier: verifier });
    if (client.data.clientSecret) body.set('client_secret', client.data.clientSecret);
    const reply = await requestJsonOnce({ fetch: input.fetch, signal: controller.signal,
      url: 'https://oauth2.googleapis.com/token', init: { method: 'POST', body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' } } });
    if (reply.status < 200 || reply.status >= 300) fail('oauth_denied');
    const token = tokenSchema.safeParse(reply.data);
    if (!token.success) fail('provider_response_invalid');
    const granted = new Set(token.data.scope.split(' '));
    if (!granted.has(gmailSendScope) || !granted.has('openid')
      || !(granted.has('email') || granted.has('https://www.googleapis.com/auth/userinfo.email'))) fail('oauth_denied');
    const identityReply = await requestJsonOnce({ fetch: input.fetch, signal: controller.signal,
      url: 'https://openidconnect.googleapis.com/v1/userinfo', init: {
        headers: { Authorization: `Bearer ${token.data.access_token}` },
      } });
    const identity = identitySchema.safeParse(identityReply.data);
    if (identityReply.status !== 200 || !identity.success) fail('oauth_identity_invalid');
    if (failure) throw failure;
    return { clientId: client.data.clientId, clientSecret: client.data.clientSecret,
      accessToken: token.data.access_token, refreshToken: token.data.refresh_token,
      expiresAt: (input.now ?? Date.now)() + token.data.expires_in * 1000, email: identity.data.email };
  } catch (error) { throw failure ?? safeError(error, 'oauth_unavailable'); }
  finally {
    clearTimeout(timer);
    input.signal.removeEventListener('abort', cancel);
    controller.abort();
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }
}

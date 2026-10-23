import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import pg from 'pg';
import { asSession, CLUSTER_URL_ENVIRONMENT_VARIABLE } from '@fss/domain/db/testing/testDatabase.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture, type SeededMember } from '../../../api/test/support/authFixture.ts';
import { seedFirm } from '../../../api/test/support/crmSeed.ts';
import { createBrowserHandler } from '../../src/server/browser.ts';
import { localCertificate } from './tls.ts';
import type { BrowserRuntime } from '../../src/server/runtime.ts';

export interface LocalBrowserApp {
  readonly origin: string;
  readonly fixture: AuthFixture;
  readonly alphaFirmId: string;
  readonly betaFirmId: string;
  readonly meetingId: string;
  chooseIdentity(member: SeededMember): void;
  dropNextNotesResponse(): void;
  holdNext(path: string): () => void;
  stop(): Promise<void>;
}

/** Only the missing provider navigation is supplied here. Token exchange, RSA/JWKS,
 * callback, one-time claim, membership and authentication are the existing code. */
export async function startLocalBrowserApp(): Promise<LocalBrowserApp> {
  const fixture = await createAuthFixture();
  try { return await bootLocalBrowserApp(fixture); }
  catch (error) { await fixture.stop(); throw error; }
}

async function bootLocalBrowserApp(fixture: AuthFixture): Promise<LocalBrowserApp> {
  const alphaFirmId = await seedFirm(fixture, { name: 'Alpha Synthetic Browser Firm', regionCode: 'TX', assignedUserId: fixture.alpha.salesperson.userId });
  const betaFirmId = await seedFirm(fixture, { name: 'Beta Synthetic Browser Firm', regionCode: 'TX', assignedUserId: fixture.beta.salesperson.userId }, fixture.beta);
  const meetingId = randomUUID();
  await fixture.db.query("INSERT INTO meetings(workspace_id,id,firm_id,booking_uid,current_booking_uid,state,starts_at,ends_at,last_event_at) VALUES($1,$2,$3,$4,$4,'booked',now(),now(),now())", [fixture.alpha.workspaceId, meetingId, alphaFirmId, `browser-${meetingId}`]);
  let identity = fixture.alpha.salesperson;
  let dropNotes = false;
  const held = new Map<string, Promise<void>>();
  const bundle = await build({ outdir: 'local-browser-bundle', entryPoints: [fileURLToPath(new URL('../../src/client/main.tsx', import.meta.url))], bundle: true, format: 'esm', target: 'es2022', write: false, platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
  const script = bundle.outputFiles.find(file => file.path.endsWith('.js'))?.text ?? '';
  const styles = bundle.outputFiles.find(file => file.path.endsWith('.css'))?.text ?? '';
  let origin = '';
  let handler: ReturnType<typeof createBrowserHandler>;
  const certificate = await localCertificate();
  const server: Server = createServer(certificate, (request, response) => {
    const send = (status: number, body: string, contentType = 'text/html; charset=utf-8') => {
      response.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; script-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'" });
      response.end(body);
    };
    void (async () => {
      const url = new URL(request.url ?? '/', origin);
      if (url.pathname === '/styles.css') return send(200, styles, 'text/css; charset=utf-8');
      if (url.pathname === '/renderer.js') return send(200, script, 'text/javascript; charset=utf-8');
      if (url.pathname === '/__local/provider') {
        const code = `local-${randomUUID()}`;
        fixture.google.issueCode(code);
        fixture.google.nextIdToken(fixture.google.signIdToken({ sub: identity.googleSub, email: identity.email, hd: fixture.hostedDomain, nonce: url.searchParams.get('nonce') ?? '', iat: Math.floor(fixture.deps.now().getTime() / 1000), exp: Math.floor(fixture.deps.now().getTime() / 1000) + 3600 }));
        const callback = new URL('/browser/callback', origin);
        callback.searchParams.set('code', code);
        callback.searchParams.set('state', url.searchParams.get('state') ?? '');
        response.writeHead(302, { location: callback.toString(), 'cache-control': 'no-store' });
        return response.end();
      }
      if (!url.pathname.startsWith('/browser/')) return send(200, '<!doctype html><html><head><meta charset="utf-8"><title>Callie local acceptance</title><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><script type="module" src="/renderer.js"></script></body></html>');
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString('utf8');
      const headers: Record<string, string | undefined> = {};
      for (const [key, value] of Object.entries(request.headers)) headers[key] = Array.isArray(value) ? value.join(', ') : value;
      const result = await handler({ method: request.method ?? 'GET', path: url.pathname, query: url.searchParams, headers, body: raw.length === 0 ? undefined : JSON.parse(raw) });
      if (result === null) return send(404, 'Not found', 'text/plain');
      const wait = held.get(url.pathname);
      held.delete(url.pathname);
      await wait;
      if (url.pathname === '/browser/api/meetings/notes') console.log(`LOCAL_NOTES_RESULT: ${result.status}`);
      if (dropNotes && url.pathname === '/browser/api/meetings/notes') {
        dropNotes = false;
        response.writeHead(result.status, { ...result.headers, 'content-type': 'application/json', 'content-length': '100000' });
        response.write('{');
        response.flushHeaders();
        setImmediate(() => response.destroy());
        return;
      }
      // The stub intentionally has no authorize endpoint. Redirect only that exact
      // loopback provider URL through the test navigation router, preserving parameters.
      const outgoing = { ...result.headers };
      const location = outgoing['location'];
      if (typeof location === 'string' && location.startsWith(`${fixture.google.issuer}/o/oauth2/v2/auth?`)) {
        const authorization = new URL(location);
        outgoing['location'] = `${origin}/__local/provider?${authorization.searchParams.toString()}`;
      }
      let body = result.body;
      if (url.pathname === '/browser/sign-in' && body !== null && typeof body === 'object' && 'authorizationUrl' in body && typeof body.authorizationUrl === 'string') {
        const authorization = new URL(body.authorizationUrl);
        if (authorization.origin !== fixture.google.issuer || authorization.pathname !== '/o/oauth2/v2/auth') throw new Error('Unexpected local provider');
        body = { authorizationUrl: `${origin}/__local/provider?${authorization.searchParams.toString()}` };
      }
      response.writeHead(result.status, { 'content-type': result.contentType ?? 'application/json; charset=utf-8', ...outgoing });
      response.end(typeof body === 'string' && result.contentType?.startsWith('text/') ? body : JSON.stringify(body));
    })().catch(() => {
      if (!response.headersSent) send(500, 'Local acceptance server failed', 'text/plain');
      else response.destroy();
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, 'localhost', resolve); });
  } catch (error) { await certificate.remove(); throw error; }
  origin = `https://localhost:${String((server.address() as AddressInfo).port)}`;
  const config = { ...fixture.deps.config, oidc: { ...fixture.deps.config.oidc, redirectUri: `${origin}/browser/callback` } };
  const runtime: BrowserRuntime = {
    origin, clientVersion: CURRENT_CLIENT_VERSION, cookieKey: randomBytes(32),
    withRequest: async work => {
      const connectionString = new URL(process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE] ?? '');
      connectionString.pathname = `/${fixture.database.name}`;
      const client = new pg.Client({ connectionString: connectionString.toString() });
      await client.connect();
      try {
        const session = asSession({ query: async (text, values) => await client.query(text, values), connect: async () => { await client.connect(); }, end: async () => { await client.end(); } });
        const auth = { ...fixture.deps, config, db: session };
        return await work({ auth, api: { session, auth, supportedClientVersions: config.supportedClientVersions, sendingEnabled: false, production: false } });
      } finally { await client.end(); }
    },
  };
  try { handler = createBrowserHandler(runtime); }
  catch (error) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await certificate.remove();
    throw error;
  }
  return {
    origin, fixture, alphaFirmId, betaFirmId, meetingId,
    chooseIdentity: member => { identity = member; },
    dropNextNotesResponse: () => { dropNotes = true; },
    holdNext: path => {
      let release = () => undefined as void;
      held.set(path, new Promise<void>(resolve => { release = resolve; }));
      return release;
    },
    stop: async () => {
      try {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      } finally {
        try { await fixture.stop(); } finally { await certificate.remove(); }
      }
    },
  };
}

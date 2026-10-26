import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { access, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RequestListener } from 'node:http';
import type { Server } from 'node:https';
import { createServer as reserveServer, type AddressInfo } from 'node:net';
import pg from 'pg';
import { asSession, CLUSTER_URL_ENVIRONMENT_VARIABLE } from '@fss/domain/db/testing/testDatabase.ts';
import type { HumanReplyDraftPort } from '@fss/domain/replies/composerGeneration.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type SeededMember } from '../../../api/test/support/authFixture.ts';
import { seedFirm } from '../../../api/test/support/crmSeed.ts';
import { createBrowserServer } from '../../src/server/server.ts';
import { buildBrowserAssets } from '../../src/server/assets.ts';
import { readBrowserHostSettings } from '../../src/server/settings.ts';
import type { BrowserRuntime } from '../../src/server/runtime.ts';
import { localCertificate } from './tls.ts';
import { seedReplyBrief } from './replyBriefSeed.ts';
import type { SyntheticCase } from './syntheticBusinessFixture.ts';
import type { RoutingOptions } from '../../../api/src/routes/types.ts';
import type { BrowserAssets } from '../../src/server/hostContract.ts';

async function reservePort(): Promise<number> {
  const reservation = reserveServer();
  await new Promise<void>((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, 'localhost', resolve); });
  const port = (reservation.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  return port;
}

/** Actual exported HTTPS host, bundled UI, signed OIDC/PKCE/JWKS and request-owned API.
 * Only the local identity-provider navigation and paid draft port are controlled. */
export async function startReplyBriefApp(options: { conversation?: SyntheticCase; decorateAssets?: (assets: BrowserAssets) => BrowserAssets; requestDatabaseRole?: 'app_runtime'; apiIntegrations?: RoutingOptions['integrations'] } = {}) {
  const fixture = await createAuthFixture();
  const certificate = await localCertificate().catch(async error => { await fixture.stop(); throw error; });
  let server: Server | undefined;
  try {
    const directory = await fixture.db.query<{ data_directory: string }>('SHOW data_directory');
    const storagePath = directory.rows[0]!.data_directory;
    const postgresPid = Number((await readFile(join(storagePath, 'postmaster.pid'), 'utf8')).split('\n')[0]);
    const tlsDirectories = (await readdir(tmpdir())).filter(name => name.startsWith('fss-browser-tls-'));
    const certificatePaths = await Promise.all(tlsDirectories.map(async name => {
      const path = join(tmpdir(), name);
      try { return (await readFile(join(path, 'cert.pem'))).equals(certificate.cert) ? path : undefined; }
      catch { return undefined; }
    }));
    const tlsPath = certificatePaths.find(path => path !== undefined);
    if (!tlsPath) throw new Error('Owned certificate directory not found');
    console.log('REPLY_BRIEF_OWNED_RESOURCES', JSON.stringify({ storagePath, postgresPid, tlsPath, database: fixture.database.name }));
    const firmId = await seedFirm(fixture, { name: options.conversation?.firm ?? 'Reply Brief Synthetic Firm', regionCode: 'TX', assignedUserId: fixture.alpha.salesperson.userId });
    const seed = await seedReplyBrief(fixture, firmId, options.conversation);
    const meetingId = randomUUID();
    await fixture.db.query("INSERT INTO meetings(workspace_id,id,firm_id,booking_uid,current_booking_uid,state,starts_at,ends_at,last_event_at,attendee_name,event_title,booking_notes,details_observed_at) VALUES($1,$2,$3,$4,$4,'booked',now()+interval '2 days',now()+interval '2 days 30 minutes',now(),'Robin Fixture','Synthetic maintenance discussion','Discuss current maintenance workflow.',now())", [fixture.alpha.workspaceId, meetingId, firmId, `reply-brief-${meetingId}`]);
    const built = await buildBrowserAssets();
    const assets = options.decorateAssets?.(built) ?? built;
    let identity: SeededMember = fixture.alpha.salesperson;
    let calls = 0;
    let runtimeRoleChecks = 0;
    let answer = 'Thank you for your question.';
    let duringGeneration: (() => Promise<void>) | undefined;
    const port: HumanReplyDraftPort = {
      providerKey: 'aws_bedrock.outreach_reply', countInputTokens: async () => 100,
      prepareReplyDraft: async context => {
        calls += 1;
        await duringGeneration?.();
        return { raw: JSON.stringify({ text: answer, factRefs: context.facts.map(({ id, version }) => ({ id, version })), unsupportedClaims: [] }), costCents: 1, costEstimated: false };
      },
    };
    const listenPort = await reservePort();
    const origin = `https://localhost:${String(listenPort)}`;
    const settings = readBrowserHostSettings({ FSS_BROWSER_ORIGIN: origin, FSS_BROWSER_CLIENT_VERSION: CURRENT_CLIENT_VERSION, FSS_BROWSER_COOKIE_KEY_HEX: randomBytes(32).toString('hex') });
    const config = { ...fixture.deps.config, oidc: { ...fixture.deps.config.oidc, redirectUri: `${origin}/browser/callback` } };
    const runtime: BrowserRuntime = {
      ...settings,
      withRequest: async work => {
        const url = new URL(process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE] ?? '');
        url.pathname = `/${fixture.database.name}`;
        const client = new pg.Client({ connectionString: url.toString() });
        await client.connect();
        try {
          if (options.requestDatabaseRole === 'app_runtime') {
            await client.query('SET ROLE app_runtime');
            const role = await client.query<{ current_user: string }>('SELECT current_user');
            assert.equal(role.rows[0]?.current_user, 'app_runtime');
            runtimeRoleChecks += 1;
          }
          const session = asSession({ query: async (text, values) => await client.query(text, values), connect: async () => { await client.connect(); }, end: async () => { await client.end(); } });
          const auth = { ...fixture.deps, config, db: session };
          return await work({ auth, api: { session, auth, supportedClientVersions: config.supportedClientVersions, sendingEnabled: false, production: false, replyComposer: port, ...(options.apiIntegrations ? { integrations: options.apiIntegrations } : {}) } });
        } finally { await client.end(); }
      },
    };
    server = await createBrowserServer({ settings, withRequest: runtime.withRequest, tls: certificate, assets });
    const listeners = server.listeners('request');
    assert.equal(listeners.length, 1);
    const product = listeners[0] as RequestListener;
    server.removeListener('request', product);
    server.on('request', (request, response) => {
      const url = new URL(request.url ?? '/', origin);
      if (url.pathname !== '/__local/provider') return product(request, response);
      const code = `reply-brief-${randomUUID()}`;
      fixture.google.issueCode(code);
      const now = Math.floor(fixture.deps.now().getTime() / 1000);
      fixture.google.nextIdToken(fixture.google.signIdToken({ sub: identity.googleSub, email: identity.email, hd: fixture.hostedDomain, nonce: url.searchParams.get('nonce') ?? '', iat: now, exp: now + 3600 }));
      const callback = new URL('/browser/callback', origin);
      callback.searchParams.set('code', code);
      callback.searchParams.set('state', url.searchParams.get('state') ?? '');
      response.writeHead(302, { location: callback.toString(), 'cache-control': 'no-store' });
      response.end();
    });
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(listenPort, 'localhost', resolve); });
    console.log('REPLY_BRIEF_HTTPS_RESERVED', origin);
    return {
      origin, fixture, firmId, meetingId, seed, storagePath, postgresPid, tlsPath,
      calls: () => calls,
      runtimeRoleChecks: () => runtimeRoleChecks,
      setAnswer: (text: string) => { answer = text; },
      duringGeneration: (action?: () => Promise<void>) => { duringGeneration = action; },
      chooseIdentity: (member: SeededMember) => { identity = member; },
      stop: async () => {
        try {
          server!.closeAllConnections();
          await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
          assert.equal(server!.listening, false);
          console.log('REPLY_BRIEF_HTTPS_RELEASED');
        } finally {
          try {
            await fixture.stop();
            const client = new pg.Client({ connectionString: process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE] });
            await client.connect();
            try { assert.equal((await client.query('SELECT 1 FROM pg_database WHERE datname=$1', [fixture.database.name])).rowCount, 0); }
            finally { await client.end(); }
            console.log('REPLY_BRIEF_DATABASE_ABSENT');
          } finally {
            await certificate.remove();
            await access(tlsPath).then(() => { throw new Error('Owned TLS directory remains'); }, error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
            console.log('REPLY_BRIEF_TLS_ABSENT');
          }
        }
      },
    };
  } catch (error) {
    server?.closeAllConnections();
    if (server?.listening) await new Promise<void>(resolve => server!.close(() => resolve()));
    try { await fixture.stop(); } finally { await certificate.remove(); }
    throw error;
  }
}
export type ReplyBriefApp = Awaited<ReturnType<typeof startReplyBriefApp>>;

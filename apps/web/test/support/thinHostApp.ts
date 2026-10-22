import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { access, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { asSession, CLUSTER_URL_ENVIRONMENT_VARIABLE } from '@fss/domain/db/testing/testDatabase.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type SeededMember } from '../../../api/test/support/authFixture.ts';
import { seedFirm } from '../../../api/test/support/crmSeed.ts';
import { createBrowserHostHandler } from '../../src/server/host.ts';
import { buildBrowserAssets } from '../../src/server/assets.ts';
import { readBrowserHostSettings } from '../../src/server/settings.ts';
import type { BrowserRuntime } from '../../src/server/runtime.ts';
import { localCertificate } from './tls.ts';

/** Only provider navigation is synthetic. Every product byte uses the exported host. */
export async function startThinHostApp() {
  const fixture = await createAuthFixture();
  const certificate = await localCertificate().catch(async error => { await fixture.stop(); throw error; });
  let server: ReturnType<typeof createServer> | undefined;
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
    if (tlsPath === undefined) throw new Error('Owned certificate directory not found');
    console.log('THIN_HOST_OWNED_RESOURCES', JSON.stringify({ storagePath, postgresPid, tlsPath, database: fixture.database.name }));
    const alphaFirmId = await seedFirm(fixture, { name: 'Thin Host Alpha Firm', regionCode: 'TX', assignedUserId: fixture.alpha.salesperson.userId });
    const betaFirmId = await seedFirm(fixture, { name: 'Thin Host Beta Firm', regionCode: 'TX', assignedUserId: fixture.beta.salesperson.userId }, fixture.beta);
    const meetingId = randomUUID();
    await fixture.db.query("INSERT INTO meetings(workspace_id,id,firm_id,booking_uid,current_booking_uid,state,starts_at,ends_at,last_event_at) VALUES($1,$2,$3,$4,$4,'booked',now(),now(),now())", [fixture.alpha.workspaceId, meetingId, alphaFirmId, `thin-${meetingId}`]);
    const assets = await buildBrowserAssets();
    let identity: SeededMember = fixture.alpha.salesperson;
    let origin = '';
    let requestConnections = 0;
    server = createServer(certificate, (request, response) => {
      const url = new URL(request.url ?? '/', origin);
      if (url.pathname !== '/__local/provider') return handler(request, response);
      const code = `thin-${randomUUID()}`;
      fixture.google.issueCode(code);
      const now = Math.floor(fixture.deps.now().getTime() / 1000);
      fixture.google.nextIdToken(fixture.google.signIdToken({ sub: identity.googleSub, email: identity.email, hd: fixture.hostedDomain, nonce: url.searchParams.get('nonce') ?? '', iat: now, exp: now + 3600 }));
      const callback = new URL('/browser/callback', origin);
      callback.searchParams.set('code', code);
      callback.searchParams.set('state', url.searchParams.get('state') ?? '');
      response.writeHead(302, { location: callback.toString(), 'cache-control': 'no-store' });
      response.end();
    });
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, 'localhost', resolve); });
    origin = `https://localhost:${String((server.address() as AddressInfo).port)}`;
    const settings = readBrowserHostSettings({ FSS_BROWSER_ORIGIN: origin, FSS_BROWSER_CLIENT_VERSION: CURRENT_CLIENT_VERSION, FSS_BROWSER_COOKIE_KEY_HEX: randomBytes(32).toString('hex') });
    const config = { ...fixture.deps.config, oidc: { ...fixture.deps.config.oidc, redirectUri: `${origin}/browser/callback` } };
    const runtime: BrowserRuntime = {
      ...settings,
      withRequest: async work => {
        requestConnections += 1;
        const url = new URL(process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE] ?? '');
        url.pathname = `/${fixture.database.name}`;
        const client = new pg.Client({ connectionString: url.toString() });
        await client.connect();
        try {
          const session = asSession({ query: async (text, values) => await client.query(text, values), connect: async () => { await client.connect(); }, end: async () => { await client.end(); } });
          const auth = { ...fixture.deps, config, db: session };
          return await work({ auth, api: { session, auth, supportedClientVersions: config.supportedClientVersions, sendingEnabled: false, production: false } });
        } finally { await client.end(); }
      },
    };
    const handler = createBrowserHostHandler({ runtime, assets, bodyTimeoutMs: 150 });
    return {
      origin, fixture, alphaFirmId, betaFirmId, meetingId, assets, storagePath, postgresPid,
      connections: () => requestConnections,
      chooseIdentity: (member: SeededMember) => { identity = member; },
      stop: async () => {
        try {
          server!.closeAllConnections();
          await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
          if (server!.listening) throw new Error('Owned HTTPS listener remains open');
          console.log('THIN_HOST_HTTPS_RELEASED');
        } finally {
          try {
            await fixture.stop();
            const client = new pg.Client({ connectionString: process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE] });
            await client.connect();
            try {
              const remaining = await client.query('SELECT 1 FROM pg_database WHERE datname=$1', [fixture.database.name]);
              assert.equal(remaining.rowCount, 0, 'Owned fixture database remains');
            } finally { await client.end(); }
            console.log('THIN_HOST_FIXTURE_RELEASED: database absence verified');
          } finally {
            await certificate.remove();
            await access(tlsPath).then(() => { throw new Error('Owned TLS directory remains'); }, error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
            console.log('THIN_HOST_TLS_RELEASED: directory absence verified');
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
export type ThinHostApp = Awaited<ReturnType<typeof startThinHostApp>>;

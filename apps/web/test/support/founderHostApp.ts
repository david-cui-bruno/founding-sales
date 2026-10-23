import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { createServer as reserveServer, type AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import { createAuthFixture, CURRENT_CLIENT_VERSION } from '../../../api/test/support/authFixture.ts';
import { seedFirm } from '../../../api/test/support/crmSeed.ts';
import { createApiServer, type ApiServerOptions } from '../../../api/src/server.ts';
import { createApiBrowserMount, readFounderBrowserSettings } from '../../../api/src/bootstrap/browser.ts';
import { poolConnections } from '../../../api/src/bootstrap/connections.ts';
import { loadBrowserAssets } from '../../src/server/publicAssets.ts';
import { founderHostProxy } from './founderHostProxy.ts';
import { absent, founderHostDatabase, listenerAbsent } from './founderHostResources.ts';

async function pinnedPort() {
  const server = reserveServer();
  await new Promise<void>(resolve => server.listen(0, 'localhost', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
async function close(server: Server | undefined) {
  if (!server?.listening) return;
  const address = server.address() as AddressInfo;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await listenerAbsent(address.port, address.address);
}

/** Production factories only. The fixture supplies a database, local signed OIDC,
 * TLS edge and instrumentation around the real bounded pool, not an auth adapter. */
export async function startFounderHostApp(directory: string) {
  const assets = await loadBrowserAssets(directory); // No PG before real artifacts validate.
  const database = await founderHostDatabase();
  const cleanup: (() => Promise<void>)[] = [() => database.stop()];
  let api: Server | undefined;
  let proxy: Server | undefined;
  try {
    const fixture = await createAuthFixture();
    cleanup.push(async () => {
      const name = fixture.database.name;
      const issuer = new URL(fixture.google.issuer);
      await fixture.stop();
      const admin = new pg.Client({ connectionString: database.cluster.adminUrl });
      await admin.connect();
      try { assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [name])).rowCount, 0); }
      finally { await admin.end(); }
      await listenerAbsent(Number(issuer.port));
      console.log('FOUNDER_HOST_DB_AND_OIDC_ABSENT', name);
    });
    const alphaFirmId = await seedFirm(fixture, { name: 'Founder Host Synthetic Firm', regionCode: 'TX', assignedUserId: fixture.alpha.salesperson.userId });
    const connectionString = new URL(database.cluster.adminUrl);
    connectionString.pathname = `/${fixture.database.name}`;
    const pool = new pg.Pool({ connectionString: connectionString.toString(), max: 2, connectionTimeoutMillis: 1000 });
    cleanup.push(async () => { assert.equal(active, 0); await pool.end(); });
    const real = poolConnections(pool);
    let acquired = 0, released = 0, active = 0, peak = 0;
    const connections = { checkout: async () => {
      const lease = await real.checkout();
      acquired += 1; active += 1; peak = Math.max(peak, active);
      let ended = false;
      return { session: lease.session, release() { assert.equal(ended, false); ended = true; lease.release(); released += 1; active -= 1; } };
    } };
    const port = await pinnedPort();
    const origin = `https://localhost:${String(port)}`;
    const tlsPath = await mkdtemp(join(tmpdir(), 'fss-founder-host-tls-'));
    cleanup.push(async () => { await rm(tlsPath, { recursive: true, force: true }); await absent(tlsPath); console.log('FOUNDER_HOST_TLS_ABSENT'); });
    await promisify(execFile)('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(tlsPath, 'key.pem'), '-out', join(tlsPath, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost']);
    const settings = readFounderBrowserSettings({ FSS_BROWSER_ORIGIN: origin, FSS_BROWSER_CLIENT_VERSION: CURRENT_CLIENT_VERSION, FSS_BROWSER_COOKIE_KEY_HEX: randomBytes(32).toString('hex'), FSS_BROWSER_FOUNDER_WORKSPACE_ID: fixture.alpha.workspaceId, FSS_BROWSER_FOUNDER_USER_ID: fixture.alpha.salesperson.userId });
    assert.ok(settings);
    const options: ApiServerOptions = { connections, auth: fixture.deps, supportedClientVersions: fixture.deps.config.supportedClientVersions, sendingEnabled: false, production: false };
    const desktopCallback = fixture.deps.config.oidc.redirectUri;
    const browser = await createApiBrowserMount(settings, options, directory);
    api = createApiServer({ ...options, browser });
    cleanup.push(async () => { await close(api); console.log('FOUNDER_HOST_HTTP_ABSENT'); });
    await new Promise<void>((resolve, reject) => { api!.once('error', reject); api!.listen(0, '127.0.0.1', resolve); });
    proxy = await founderHostProxy(api, { key: await readFile(join(tlsPath, 'key.pem')), cert: await readFile(join(tlsPath, 'cert.pem')), remove: async () => {} }, port);
    cleanup.push(async () => { await close(proxy); console.log('FOUNDER_HOST_HTTPS_ABSENT'); });
    console.log('FOUNDER_HOST_LISTENERS', JSON.stringify({ http: api.address(), https: proxy.address(), tlsPath }));
    return { origin, fixture, alphaFirmId, assets, desktopCallback,
      counts: () => ({ acquired, released, active, peak, waiting: pool.waitingCount }),
      async stop() {
        const errors: unknown[] = [];
        for (const release of cleanup.reverse()) { try { await release(); } catch (error) { errors.push(error); } }
        if (errors.length) throw new AggregateError(errors, 'Owned founder host cleanup failed');
      },
    };
  } catch (error) {
    const failures: unknown[] = [error];
    for (const release of cleanup.reverse()) { try { await release(); } catch (failure) { failures.push(failure); } }
    throw new AggregateError(failures, 'Founder host startup failed');
  }
}
export type FounderHostApp = Awaited<ReturnType<typeof startFounderHostApp>>;

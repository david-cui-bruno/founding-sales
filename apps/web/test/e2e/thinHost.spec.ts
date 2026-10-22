import { createHash, randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE } from '@fss/domain/db/testing/testDatabase.ts';
import type { IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { test, expect, type Page } from 'playwright/test';
import { startThinHostApp, type ThinHostApp } from '../support/thinHostApp.ts';
import { reserveLocalBrowserDatabase } from '../support/database.ts';
import { browserRequest, browserSession } from '../support/browser.ts';
import { MAX_REQUEST_BYTES } from '../../../api/src/limits.ts';

let app: ThinHostApp;
let release: (() => Promise<void>) | undefined;
test.beforeAll(async () => {
  release = await reserveLocalBrowserDatabase();
  try { app = await startThinHostApp(); }
  catch (error) { await release(); release = undefined; throw error; }
});
test.afterAll(async () => {
  try { await app?.stop(); }
  finally {
    await release?.();
    if (app) {
      await access(app.storagePath).then(() => { throw new Error('Owned cluster directory remains'); }, error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
      let processExists = true;
      try { process.kill(app.postgresPid, 0); }
      catch (error) { expect((error as NodeJS.ErrnoException).code).toBe('ESRCH'); processExists = false; }
      expect(processExists).toBe(false);
      expect(process.env[TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE]).toBeUndefined();
      console.log('THIN_HOST_CLUSTER_RELEASED: exact PID and directory absent, template environment cleared');
    }
  }
});
test.afterEach(async ({ context }) => { await context.close(); console.log('THIN_HOST_BROWSER_CONTEXT_RELEASED'); });
test.beforeEach(async ({ context }) => {
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== app.origin) return await route.abort('blockedbyclient');
    if (url.pathname !== '/browser/sign-in') return await route.continue();
    // Test-only response adapter. The exported handler still generates state,
    // cookies and authorization request. No product transport is duplicated.
    const response = await route.fetch();
    const body = await response.json() as { authorizationUrl?: string };
    if (response.status() !== 200 || body.authorizationUrl === undefined) return await route.fulfill({ response });
    const authorization = new URL(body.authorizationUrl);
    expect(authorization.origin).toBe(app.fixture.google.issuer);
    expect(authorization.pathname).toBe('/o/oauth2/v2/auth');
    await route.fulfill({ response, json: { authorizationUrl: `${app.origin}/__local/provider?${authorization.searchParams.toString()}` } });
  });
});

async function login(page: Page, beta = false): Promise<void> {
  const workspace = beta ? app.fixture.beta : app.fixture.alpha;
  app.chooseIdentity(workspace.salesperson);
  await page.goto(app.origin);
  await page.getByLabel('Workspace ID', { exact: true }).fill(workspace.workspaceId);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: beta ? 'Thin Host Beta Firm' : 'Thin Host Alpha Firm', exact: true })).toBeVisible();
}
async function firm(page: Page): Promise<void> {
  await page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Thin Host Alpha Firm', exact: true }) }).getByRole('button', { name: 'Open firm' }).click();
  await expect(page.getByRole('region', { name: 'Firm', exact: true })).toBeVisible();
}
async function notes(page: Page): Promise<void> {
  await page.getByLabel('Meeting ID', { exact: true }).fill(app.meetingId);
  await page.getByRole('button', { name: 'Read meeting notes', exact: true }).click();
  await expect(page.getByLabel('Your notes', { exact: true })).toBeVisible();
}

// This suite deliberately qualifies NEW host composition, not the closed old suite.
test('new host serves externally bundled CSP-safe UI with real signed login, Firm, reload and identity isolation', async ({ page }) => {
  const violations: string[] = [];
  await page.exposeFunction('thinCspViolation', (directive: string) => { violations.push(directive); });
  await page.addInitScript(() => document.addEventListener('securitypolicyviolation', event => { void (window as unknown as { thinCspViolation(value: string): Promise<void> }).thinCspViolation(JSON.stringify({ directive: event.violatedDirective, blocked: event.blockedURI, source: event.sourceFile, line: event.lineNumber, sample: event.sample })); }));
  const root = await page.goto(app.origin);
  expect(root?.headers()['content-security-policy']).not.toContain('unsafe-inline');
  const markup = await root!.text();
  expect(markup).toMatch(/<script[^>]+src=/u);
  expect(markup).toMatch(/<link[^>]+stylesheet/u);
  await login(page);
  const exchange = app.fixture.google.tokenExchanges().at(-1);
  expect(exchange?.clientSecretPresented).toBe(true);
  expect(exchange?.redirectUri).toBe(`${app.origin}/browser/callback`);
  expect(app.fixture.google.jwksFetches()).toBeGreaterThan(0);
  const oidc = await app.fixture.db.query<{ code_challenge: string }>('SELECT code_challenge FROM oidc_authorization_requests ORDER BY created_at DESC LIMIT 1');
  expect(createHash('sha256').update(exchange?.codeVerifier ?? '').digest('base64url')).toBe(oidc.rows[0]?.code_challenge);
  expect(await page.locator('body').evaluate(element => getComputedStyle(element).margin)).toBe('0px');
  await firm(page);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Thin Host Alpha Firm', exact: true })).toBeVisible();
  const alpha = await browserSession(page);
  expect(alpha.status).toBe('signed_in');
  for (const cookie of await page.context().cookies(app.origin)) {
    expect(cookie.name).toMatch(/^__Host-/u);
    expect(cookie.httpOnly && cookie.secure && cookie.path === '/' && cookie.sameSite === 'Lax').toBe(true);
  }
  expect(await page.evaluate(() => document.cookie)).toBe('');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByLabel('Workspace ID', { exact: true })).toBeVisible();
  expect((await browserRequest(page, '/today')).status).toBe(401);
  await login(page, true);
  expect((await browserRequest(page, `/firms/${app.alphaFirmId}`)).status).toBe(404);
  expect((await browserRequest(page, '/today/firm', { body: { firmId: app.betaFirmId }, revision: alpha.status === 'signed_in' ? alpha.revision : '' })).status).toBe(409);
  await expect(page.getByRole('heading', { name: 'Thin Host Alpha Firm', exact: true })).toHaveCount(0);
  expect(violations).toEqual([]);
});

test('new host commits meeting note then exact UUID replay reconciles a deterministically dropped response', async ({ page }) => {
  await login(page);
  await firm(page);
  await notes(page);
  await page.getByLabel('Your notes', { exact: true }).fill('Thin-host initial synthetic note');
  await page.getByRole('button', { name: 'Save notes', exact: true }).click();
  await expect(page.getByText('Saved notes revision 1.', { exact: true })).toBeVisible();
  await page.route('**/browser/api/meetings/notes', async route => {
    const committed = await route.fetch();
    expect(committed.status()).toBe(200);
    await route.abort('failed');
  }, { times: 1 });
  await page.getByLabel('Your notes', { exact: true }).fill('Thin-host committed but response dropped');
  const sent = page.waitForRequest(request => request.url().endsWith('/browser/api/meetings/notes') && request.method() === 'POST');
  await page.getByRole('button', { name: 'Save notes', exact: true }).click();
  const original = (await sent).postDataJSON() as { commandId: string };
  expect(original.commandId).toMatch(/^[0-9a-f-]{36}$/u);
  await expect(page.getByText('Save outcome is unresolved.', { exact: false })).toBeVisible();
  expect((await app.fixture.db.query('SELECT 1 FROM command_receipts WHERE command_id=$1', [original.commandId])).rows).toHaveLength(1);
  await page.reload();
  await firm(page);
  await notes(page);
  await expect(page.getByLabel('Your notes', { exact: true })).toHaveValue('Thin-host committed but response dropped');
  const replay = page.waitForRequest(request => request.url().endsWith('/browser/api/meetings/notes') && request.method() === 'POST');
  await page.getByRole('button', { name: 'Retry save', exact: true }).click();
  expect((await replay).postDataJSON()).toEqual(original);
  await expect(page.getByText('Saved notes revision 2 (existing receipt).', { exact: true })).toBeVisible();
  expect((await browserRequest(page, `/meetings/outcomes?meetingId=${app.meetingId}`)).body).toMatchObject({ notes: { revision: 2, debrief: 'Thin-host committed but response dropped' } });
  expect((await app.fixture.db.query('SELECT 1 FROM command_receipts WHERE command_id=$1', [original.commandId])).rows).toHaveLength(1);
});

test('new host authenticates revocation and protects generation after delayed real response and logout', async ({ page }) => {
  await login(page);
  expect((await browserRequest(page, '/today/firm', { body: { firmId: app.alphaFirmId }, csrf: 'wrong' })).status).toBe(403);
  let releaseResponse = () => {};
  const held = new Promise<void>(resolve => { releaseResponse = resolve; });
  let observed = () => {};
  const received = new Promise<void>(resolve => { observed = resolve; });
  await page.route('**/browser/api/today?*', async route => {
    const response = await route.fetch();
    observed();
    await held;
    await route.fulfill({ response });
  }, { times: 1 });
  const delivered = page.waitForResponse(response => response.url().includes('/browser/api/today?'));
  try {
    await page.getByRole('button', { name: 'Today', exact: true }).click();
    await received;
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByLabel('Workspace ID', { exact: true })).toBeVisible();
  } finally { releaseResponse(); }
  expect((await delivered).status()).toBe(200);
  await page.evaluate(async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); });
  await expect(page.getByRole('heading', { name: 'Thin Host Alpha Firm', exact: true })).toHaveCount(0);
  await login(page);
  const session = await browserSession(page);
  if (session.status !== 'signed_in') throw new Error('Expected signed-in real session');
  await app.fixture.db.query("UPDATE devices SET status='revoked',revoked_at=now() WHERE workspace_id=$1 AND id=$2", [session.workspaceId, session.deviceId]);
  expect((await browserRequest(page, '/today')).status).toBe(401);
  const commandId = randomUUID();
  expect((await browserRequest(page, '/meetings/notes', { body: { meetingId: app.meetingId, expectedRevision: 2, debrief: 'Revoked thin-host command must not persist', speakerMappings: [], itemOverrides: [], sufficient: false, commandId } })).status).toBeGreaterThanOrEqual(400);
  expect((await app.fixture.db.query('SELECT 1 FROM command_receipts WHERE command_id=$1', [commandId])).rows).toHaveLength(0);
  await page.reload();
  await expect(page.getByLabel('Workspace ID', { exact: true })).toBeVisible();
});

async function wire(path: string, options: { method?: string; headers?: Record<string, string | string[]>; body?: string; unfinished?: boolean } = {}) {
  return await new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const url = new URL(app.origin);
    const request = httpsRequest({ hostname: 'localhost', port: url.port, path, method: options.method ?? 'GET', rejectUnauthorized: false, agent: false, headers: options.headers }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => { request.destroy(); resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString() }); });
      response.on('error', reject);
    });
    request.setTimeout(5000, () => request.destroy(new Error('Thin host wire test timed out')));
    request.on('error', reject);
    if (options.body !== undefined) request.write(options.body);
    if (options.unfinished) request.flushHeaders();
    else request.end();
  });
}

test('new HTTPS host rejects oversize length/chunks, malformed JSON and upload deadline before request-owned DB', async () => {
  const baseline = app.connections();
  const headers = { 'content-type': 'application/json', origin: app.origin };
  expect((await wire('/browser/sign-in', { method: 'POST', headers: { ...headers, 'content-length': String(MAX_REQUEST_BYTES + 1) }, unfinished: true })).status).toBe(413);
  expect((await wire('/browser/sign-in', { method: 'POST', headers: { ...headers, 'transfer-encoding': 'chunked' }, body: 'x'.repeat(MAX_REQUEST_BYTES + 1) })).status).toBe(413);
  expect((await wire('/browser/sign-in', { method: 'POST', headers, body: '{' })).status).toBe(400);
  expect((await wire('/browser/sign-in', { method: 'POST', headers: { ...headers, 'content-length': '10' }, body: '{', unfinished: true })).status).toBe(408);
  expect(app.connections()).toBe(baseline);
});

test('new HTTPS host allowlists built assets, paths, methods, Host and secure headers with origin refusal', async () => {
  const baseline = app.connections();
  for (const [path, asset] of app.assets) {
    const result = await wire(path);
    expect(result.status).toBe(200);
    expect(result.headers['content-type']).toBe(asset.contentType);
    expect(Buffer.from(result.body)).toEqual(Buffer.from(asset.body));
    expect(result.headers['content-security-policy']).not.toContain('unsafe-inline');
    expect(result.headers['x-content-type-options']).toBe('nosniff');
    expect(result.headers['cache-control']).toContain('no-store');
    expect(result.headers['x-frame-options']).toBe('DENY');
    expect((await wire(path, { method: 'HEAD' })).body).toBe('');
  }
  for (const path of ['/missing.js', '/assets/missing.css']) expect((await wire(path)).status).toBe(404);
  for (const path of ['/../package.json', '/%2e%2e/package.json', '/assets\\secret', '//elsewhere']) expect((await wire(path)).status).toBe(400);
  expect((await wire('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(405);
  expect((await wire('/', { headers: { 'x-thin-large-header': 'x'.repeat(20_000) } })).status).toBe(431);
  expect((await wire('/', { headers: { host: 'other.example.test' } })).status).toBe(400);
  expect((await wire('/', { headers: { 'x-thin-duplicate': ['one', 'two'] } })).status).toBe(400);
  expect((await wire('/', { headers: { 'content-encoding': 'gzip' } })).status).toBe(415);
  expect((await wire('/browser/sign-in', { method: 'POST', headers: { 'content-type': 'text/plain', origin: app.origin }, body: '{}' })).status).toBe(415);
  expect((await wire('/browser/session', { method: 'PUT' })).status).toBe(405);
  expect((await wire('/browser/session', { headers: { origin: 'https://other.example.test' } })).status).toBe(403);
  expect(app.connections()).toBe(baseline);
});

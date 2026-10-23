import { createHash } from 'node:crypto';
import { expect } from 'playwright/test';
import { test } from '../support/founderHostTest.ts';
import { startFounderHostApp, type FounderHostApp } from '../support/founderHostApp.ts';
import { founderLogin, founderRaw, founderWire, providerNavigation } from '../support/founderHostBrowser.ts';
import { browserRequest, browserSession } from '../support/browser.ts';
import { MAX_REQUEST_BYTES } from '../../../api/src/limits.ts';

// Frozen NEW issue745 gates only. Do not replay closed738–744 feature suites.
// All execution uses the existing single-worker/retries0 Playwright configuration.
let app: FounderHostApp;
test.beforeAll(async () => {
  const directory = process.env['FSS_FOUNDER_HOST_ASSETS'];
  if (!directory || process.env['FSS_FOUNDER_HOST_READY'] !== '1') throw new Error('Waiting on runtime and actual prebuilt artifact readiness');
  app = await startFounderHostApp(directory);
});
test.afterAll(async () => { await app?.stop(); });
test.afterEach(async ({ context }) => { await context.close(); console.log('FOUNDER_HOST_BROWSER_CONTEXT_CLOSED'); });

test('NEW745 production mount serves actual prebuilt assets with strict CSP and no DB for public/refused envelopes', async () => {
  const before = app.counts().acquired;
  for (const [path, asset] of app.assets) {
    const result = await founderWire(app, path);
    expect(result.status).toBe(200);
    expect(result.body).toEqual(Buffer.from(asset.body));
    expect(result.headers['content-type']).toBe(asset.contentType);
    expect(result.headers['content-security-policy']).toContain("script-src 'self'");
    expect(result.headers['content-security-policy']).not.toMatch(/unsafe-inline|unsafe-eval/u);
    expect(result.headers['x-content-type-options']).toBe('nosniff');
  }
  for (const path of ['/publicAssets.ts', '/renderer.js.map', '/browser-public/index.html', '/auth/google/callback']) {
    expect((await founderWire(app, path)).status).toBe(404);
  }
  const headers = { origin: app.origin, 'content-type': 'application/json' };
  expect((await founderWire(app, '/browser/sign-in', { method: 'POST', headers, body: '{' })).status).toBe(400);
  expect((await founderWire(app, '/browser/sign-in', { method: 'POST', headers, body: 'x'.repeat(MAX_REQUEST_BYTES + 1) })).status).toBe(413);
  const host = new URL(app.origin).host;
  expect(await founderRaw(app, '/browser/session', [`Host: ${host}`, `Host: ${host}`])).toMatch(/^HTTP\/1\.1 400/u);
  expect(await founderRaw(app, '/%2e%2e/renderer.js', [`Host: ${host}`])).toMatch(/^HTTP\/1\.1 400/u);
  expect((await founderWire(app, '/browser/session', { headers: { host: 'wrong.example', 'x-forwarded-host': host, 'x-forwarded-proto': 'https' } })).status).toBe(400);
  expect((await founderWire(app, '/browser/session', { headers: { host: host.toUpperCase() } })).status).toBe(400);
  expect((await founderWire(app, '/healthz')).status).toBe(200);
  expect(app.counts().acquired).toBe(before);
});

test('NEW745 signed PKCE founder login Today Firm reload logout preserves desktop callback and CSP', async ({ page, context }) => {
  await providerNavigation(context, app, app.fixture.alpha.salesperson);
  const violations: string[] = [];
  await page.exposeFunction('founderCsp', (directive: string) => { violations.push(directive); });
  await page.addInitScript(() => document.addEventListener('securitypolicyviolation', event => { void (window as unknown as { founderCsp(value: string): Promise<void> }).founderCsp(event.violatedDirective); }));
  await founderLogin(page, app);
  const session = await browserSession(page);
  expect(session).toMatchObject({ status: 'signed_in', workspaceId: app.fixture.alpha.workspaceId, userId: app.fixture.alpha.salesperson.userId });
  const exchange = app.fixture.google.tokenExchanges().at(-1)!;
  expect(exchange.redirectUri).toBe(`${app.origin}/browser/callback`);
  expect(exchange.clientSecretPresented).toBe(true);
  const challenge = await app.fixture.db.query<{ code_challenge: string }>('SELECT code_challenge FROM oidc_authorization_requests ORDER BY created_at DESC LIMIT 1');
  expect(createHash('sha256').update(exchange.codeVerifier).digest('base64url')).toBe(challenge.rows[0]?.code_challenge);
  expect(app.fixture.google.jwksFetches()).toBeGreaterThan(0);
  expect(app.fixture.deps.config.oidc.redirectUri).toBe(app.desktopCallback);
  expect(app.desktopCallback).not.toBe(`${app.origin}/browser/callback`);
  await page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Founder Host Synthetic Firm', exact: true }) }).getByRole('button', { name: 'Open firm' }).click();
  await expect(page.getByRole('region', { name: 'Firm', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Founder Host Synthetic Firm', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.cookie)).toBe('');
  for (const cookie of await context.cookies(app.origin)) expect(cookie.httpOnly && cookie.secure && cookie.sameSite === 'Lax' && cookie.path === '/').toBe(true);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByLabel('Workspace ID', { exact: true })).toBeVisible();
  expect((await browserRequest(page, '/today')).status).toBe(401);
  expect(violations).toEqual([]);
  await expect.poll(() => app.counts().active).toBe(0);
  expect(app.counts().released).toBe(app.counts().acquired);
});

test('NEW745 second valid same-workspace identity is refused before browser access or product disclosure', async ({ page, context }) => {
  await providerNavigation(context, app, app.fixture.alpha.admin);
  await page.goto(app.origin);
  await page.getByLabel('Workspace ID', { exact: true }).fill(app.fixture.alpha.workspaceId);
  const callback = page.waitForResponse(response => response.url().includes('/browser/callback?'));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const refusal = await callback;
  expect(refusal.status()).toBe(401);
  expect(await refusal.text()).not.toMatch(/Founder Host Synthetic Firm|workspaceId|userId|supportedClientVersions/u);
  await page.goto(app.origin);
  expect((await browserSession(page)).status).toBe('signed_out');
  expect((await browserRequest(page, `/firms/${app.alphaFirmId}`)).status).toBe(401);
  expect((await context.cookies(app.origin)).filter(cookie => cookie.name.includes('access'))).toHaveLength(0);
  await expect.poll(() => app.counts().active).toBe(0);
});

test('NEW745 readiness gates authenticated work and bounded concurrent leases return after success and error', async ({ page, context }) => {
  await providerNavigation(context, app, app.fixture.alpha.salesperson);
  await founderLogin(page, app);
  const cookies = (await context.cookies(app.origin)).map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
  const headers = { cookie: cookies };
  await app.fixture.db.query('ALTER TABLE schema_versions RENAME TO founder_host_schema_versions_held');
  try {
    expect((await founderWire(app, '/readyz')).status).toBe(503);
    const refused = await founderWire(app, '/browser/session', { headers });
    expect(refused.status).toBe(503);
    expect(refused.body.toString()).not.toContain('workspaceId');
  } finally { await app.fixture.db.query('ALTER TABLE founder_host_schema_versions_held RENAME TO schema_versions'); }
  await expect.poll(() => app.counts().active).toBe(0);
  expect((await founderWire(app, '/readyz')).status).toBe(200);
  await app.fixture.db.query('BEGIN');
  await app.fixture.db.query('LOCK TABLE schema_versions IN ACCESS EXCLUSIVE MODE');
  const pending = Array.from({ length: 4 }, () => founderWire(app, '/browser/session', { headers }));
  try {
    await expect.poll(() => app.counts().active).toBe(2);
    await expect.poll(() => app.counts().waiting).toBe(2);
    expect((await founderWire(app, '/healthz')).status).toBe(200);
  } finally { await app.fixture.db.query('COMMIT'); }
  expect((await Promise.all(pending)).map(result => result.status)).toEqual([200, 200, 200, 200]);
  await expect.poll(() => app.counts().active).toBe(0);
  expect(app.counts().peak).toBe(2);
  expect(app.counts().released).toBe(app.counts().acquired);
});

test('NEW745 real device revocation refuses current founder cookies and releases request connection', async ({ page, context }) => {
  await providerNavigation(context, app, app.fixture.alpha.salesperson);
  await founderLogin(page, app);
  const session = await browserSession(page);
  if (session.status !== 'signed_in') throw new Error('Expected actual founder session');
  await app.fixture.db.query("UPDATE devices SET status='revoked',revoked_at=now() WHERE workspace_id=$1 AND id=$2", [session.workspaceId, session.deviceId]);
  expect((await browserRequest(page, '/today')).status).toBe(401);
  await page.reload();
  await expect(page.getByLabel('Workspace ID', { exact: true })).toBeVisible();
  await expect.poll(() => app.counts().active).toBe(0);
  expect(app.counts().released).toBe(app.counts().acquired);
});

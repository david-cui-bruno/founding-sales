import { randomUUID } from 'node:crypto';
import { request } from 'node:https';
import { connect } from 'node:tls';
import type { IncomingHttpHeaders } from 'node:http';
import { expect, type BrowserContext, type Page } from 'playwright/test';
import type { SeededMember } from '../../../api/test/support/authFixture.ts';
import type { FounderHostApp } from './founderHostApp.ts';

export async function providerNavigation(context: BrowserContext, app: FounderHostApp, member: SeededMember) {
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === app.origin) return await route.continue();
    if (url.origin !== app.fixture.google.issuer || url.pathname !== '/o/oauth2/v2/auth') return await route.abort('blockedbyclient');
    expect(url.searchParams.get('redirect_uri')).toBe(`${app.origin}/browser/callback`);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const code = `founder-${randomUUID()}`;
    app.fixture.google.issueCode(code);
    const now = Math.floor(app.fixture.deps.now().getTime() / 1000);
    app.fixture.google.nextIdToken(app.fixture.google.signIdToken({ sub: member.googleSub, email: member.email, hd: app.fixture.hostedDomain, nonce: url.searchParams.get('nonce') ?? '', iat: now, exp: now + 3600 }));
    const callback = new URL('/browser/callback', app.origin);
    callback.searchParams.set('state', url.searchParams.get('state') ?? '');
    callback.searchParams.set('code', code);
    await route.fulfill({ status: 302, headers: { location: callback.toString(), 'cache-control': 'no-store' }, body: '' });
  });
}
export async function founderLogin(page: Page, app: FounderHostApp) {
  await page.goto(app.origin);
  await page.getByLabel('Workspace ID', { exact: true }).fill(app.fixture.alpha.workspaceId);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Founder Host Synthetic Firm', exact: true })).toBeVisible();
}
export async function founderWire(app: FounderHostApp, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return await new Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const outgoing = request({ hostname: 'localhost', port: new URL(app.origin).port, path, method: options.method ?? 'GET', headers: options.headers, rejectUnauthorized: false, agent: false }, incoming => {
      const chunks: Buffer[] = [];
      incoming.on('data', chunk => chunks.push(Buffer.from(chunk)));
      incoming.on('end', () => resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, body: Buffer.concat(chunks) }));
      incoming.on('error', reject);
    });
    outgoing.on('error', reject);
    outgoing.setTimeout(5000, () => outgoing.destroy(new Error('Founder wire timeout')));
    outgoing.end(options.body);
  });
}
export async function founderRaw(app: FounderHostApp, target: string, headers: string[]) {
  return await new Promise<string>((resolve, reject) => {
    const socket = connect({ host: 'localhost', port: Number(new URL(app.origin).port), rejectUnauthorized: false }, () => {
      socket.write(`GET ${target} HTTP/1.1\r\n${headers.join('\r\n')}\r\nConnection: close\r\n\r\n`);
    });
    const chunks: Buffer[] = [];
    socket.on('data', chunk => chunks.push(Buffer.from(chunk)));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString()));
    socket.on('error', reject);
    socket.setTimeout(5000, () => socket.destroy(new Error('Founder raw timeout')));
  });
}

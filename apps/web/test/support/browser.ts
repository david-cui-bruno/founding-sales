import { expect, type Page } from 'playwright/test';
import type { BrowserSession } from '../../src/shared/browserContract.ts';
import type { LocalBrowserApp } from './appServer.ts';

export async function browserSession(page: Page): Promise<BrowserSession> {
  return await page.evaluate(async () => await (await fetch('/browser/session', { cache: 'no-store' })).json() as BrowserSession);
}

export async function browserRequest(page: Page, path: string, options: { body?: unknown; csrf?: string; revision?: string } = {}): Promise<{ status: number; body: unknown; cache: string | null }> {
  return await page.evaluate(async ({ path, options }) => {
    const session = await (await fetch('/browser/session', { cache: 'no-store' })).json() as BrowserSession;
    const response = await fetch(`/browser/api${path}`, {
      method: options.body === undefined ? 'GET' : 'POST', cache: 'no-store',
      headers: { 'x-callie-csrf': options.csrf ?? session.csrfToken,
        'x-callie-session': options.revision ?? (session.status === 'signed_in' ? session.revision : ''),
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    return { status: response.status, body: await response.json() as unknown, cache: response.headers.get('cache-control') };
  }, { path, options });
}

export async function assertNoBrowserCredentials(page: Page, app: LocalBrowserApp): Promise<void> {
  const state = await page.evaluate(async () => ({ cookies: document.cookie, local: { ...localStorage }, session: { ...sessionStorage }, caches: await caches.keys(), globals: ['callie', 'callieApi'].filter(key => key in globalThis) }));
  expect(state.cookies).toBe('');
  expect(state.caches).toEqual([]);
  expect(state.globals).toEqual([]);
  expect(JSON.stringify(state)).not.toMatch(/accessToken|deviceSecret|handoffSecret|id_token|code_verifier/u);
  expect(JSON.stringify(state)).not.toContain(app.fixture.google.clientSecret);
  const cookies = await page.context().cookies(app.origin);
  for (const cookie of cookies) {
    expect(cookie.name).toMatch(/^__Host-/u);
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.secure).toBe(true);
    expect(cookie.sameSite).toBe('Lax');
    expect(cookie.path).toBe('/');
  }
}

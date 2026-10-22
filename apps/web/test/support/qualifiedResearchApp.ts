import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test as base, expect, type Page, type BrowserContext } from 'playwright/test';
import { TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE } from '@fss/domain/db/testing/testDatabase.ts';
import { reserveLocalBrowserDatabase } from './database.ts';
import { startThinHostApp, type ThinHostApp } from './thinHostApp.ts';

export const test = base.extend<{ researchPage: Page }>({
  researchPage: async ({ playwright, launchOptions }, use) => {
    const profile = await mkdtemp(join(process.env['JCODE_SCRATCH_DIR'] ?? process.env['HOME']!, 'qualified-research-browser-'));
    let context: BrowserContext | undefined;
    let pids: number[] = [];
    try {
      context = await playwright.chromium.launchPersistentContext(profile, { ...launchOptions, headless: true, ignoreHTTPSErrors: true });
      const processes = execFileSync('ps', ['-axo', 'pid,command'], { encoding: 'utf8' }).split('\n').filter(line => line.includes(`--user-data-dir=${profile}`));
      assert.equal(processes.filter(line => !line.includes('--type=')).length, 1, 'Exactly one owned Chromium browser root');
      pids = processes.map(line => Number(line.trim().split(/\s+/u)[0]));
      console.log('QUALIFIED_RESEARCH_BROWSER_ACQUIRED', JSON.stringify({ profile, pids }));
      await use(context.pages()[0] ?? await context.newPage());
    }
    finally {
      await context?.close();
      await rm(profile, { recursive: true, force: true });
      await absent(profile);
      for (const pid of pids) {
        await expect.poll(() => {
          try { process.kill(pid, 0); return true; }
          catch (error) { assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH'); return false; }
        }).toBe(false);
      }
      assert(!execFileSync('ps', ['-axo', 'command'], { encoding: 'utf8' }).includes(`--user-data-dir=${profile}`));
      console.log('QUALIFIED_RESEARCH_BROWSER_RELEASED: exact process/profile absent');
    }
  },
});
export { expect };
export async function absent(path: string): Promise<void> {
  await access(path).then(() => { throw new Error('Owned resource remains'); }, error => { assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT'); });
}
export async function startQualifiedResearchApp() {
  // Never adopt or stop Homebrew PostgreSQL. Any non-Homebrew postgres means
  // ownership is unknown or another disposable slot is active, so refuse.
  const postgres = execFileSync('ps', ['-axo', 'pid,ppid,command'], { encoding: 'utf8' }).split('\n').filter(line => /(?:^|\s)(?:\S*\/)?postgres(?:\s|$)/u.test(line) && !/postgres: /u.test(line));
  assert(postgres.every(line => line.includes('/opt/homebrew/opt/postgresql@17/bin/postgres -D /opt/homebrew/var/postgresql@17')), 'Unknown PostgreSQL resource or active disposable PG job');
  console.log('QUALIFIED_RESEARCH_PG_PREFLIGHT: no disposable postgres, unrelated Homebrew untouched');
  const release = await reserveLocalBrowserDatabase();
  let app: ThinHostApp;
  try { app = await startThinHostApp(); }
  catch (error) { await release(); throw error; }
  console.log('QUALIFIED_RESEARCH_RESOURCES_ACQUIRED: sole PG slot, real HTTPS host, signed OIDC provider');
  return {
    app,
    stop: async () => {
      try { await app.stop(); }
      finally {
        await release();
        await absent(app.storagePath);
        assert.throws(() => process.kill(app.postgresPid, 0), { code: 'ESRCH' });
        assert.equal(process.env[TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE], undefined);
        console.log('QUALIFIED_RESEARCH_RESOURCES_RELEASED: DB/template/cluster/HTTPS/TLS/PG process absence verified');
      }
    },
  };
}
export async function routeQualifiedResearchProvider(page: Page, app: ThinHostApp): Promise<void> {
  await page.context().route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== app.origin) return await route.abort('blockedbyclient');
    if (url.pathname !== '/browser/sign-in') return await route.continue();
    const response = await route.fetch();
    const body = await response.json() as { authorizationUrl?: string };
    if (response.status() !== 200 || body.authorizationUrl === undefined) return await route.fulfill({ response });
    const authorization = new URL(body.authorizationUrl);
    expect(authorization.origin).toBe(app.fixture.google.issuer);
    expect(authorization.pathname).toBe('/o/oauth2/v2/auth');
    await route.fulfill({ response, json: { authorizationUrl: `${app.origin}/__local/provider?${authorization.searchParams.toString()}` } });
  });
}
export async function loginQualifiedResearch(page: Page, app: ThinHostApp, beta = false): Promise<void> {
  const workspace = beta ? app.fixture.beta : app.fixture.alpha;
  app.chooseIdentity(workspace.admin);
  await page.goto(app.origin);
  await page.getByLabel('Workspace ID', { exact: true }).fill(workspace.workspaceId);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
}

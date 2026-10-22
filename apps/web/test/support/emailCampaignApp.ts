import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test as base, expect, type Page, type BrowserContext } from 'playwright/test';
import { TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE } from '@fss/domain/db/testing/testDatabase.ts';
import { reserveLocalBrowserDatabase } from './database.ts';
import { startThinHostApp } from './thinHostApp.ts';
export { routeQualifiedResearchProvider as routeCampaignProvider, loginQualifiedResearch as loginCampaign } from './qualifiedResearchApp.ts';
export { expect };

async function absent(path: string) {
  await access(path).then(() => { throw new Error(`Owned resource remains: ${path}`); }, error => {
    assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT');
  });
}
function disposablePostgresAbsent() {
  const roots = execFileSync('ps', ['-axo', 'pid,ppid,command'], { encoding: 'utf8' }).split('\n')
    .filter(line => /(?:^|\s)(?:\S*\/)?postgres(?:\s|$)/u.test(line) && !/postgres: /u.test(line));
  assert(roots.every(line => line.includes('/opt/homebrew/opt/postgresql@17/bin/postgres -D /opt/homebrew/var/postgresql@17')), 'Unknown or already owned disposable PG resource');
}

/** This new lane uses the original TLS, real createBrowserServer and signed OIDC fixture.
 * No principal injection, browser profile adoption, provider adapter or sending worker. */
export async function startEmailCampaignApp() {
  disposablePostgresAbsent();
  console.log('EMAIL_CAMPAIGN_PREFLIGHT: disposable PG absent, existing Homebrew untouched');
  const release = await reserveLocalBrowserDatabase();
  try {
    const app = await startThinHostApp();
    return { app, stop: async () => {
      try { await app.stop(); }
      finally {
        await release();
        await absent(app.storagePath);
        assert.throws(() => process.kill(app.postgresPid, 0), { code: 'ESRCH' });
        assert.equal(process.env[TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE], undefined);
        disposablePostgresAbsent();
        console.log('EMAIL_CAMPAIGN_RELEASED: HTTPS/TLS/database/template/cluster/process absent');
      }
    } };
  } catch (error) {
    await release();
    disposablePostgresAbsent();
    throw error;
  }
}

export const test = base.extend<{ campaignPage: Page }>({
  campaignPage: async ({ playwright, launchOptions }, use) => {
    assert(process.env['FSS_LOCAL_BROWSER_EXECUTABLE'], 'Use the installed isolated Chrome executable explicitly');
    const profile = await mkdtemp(join(process.env['JCODE_SCRATCH_DIR'] ?? process.env['HOME']!, 'email-campaign-browser-'));
    let context: BrowserContext | undefined;
    let pids: number[] = [];
    try {
      context = await playwright.chromium.launchPersistentContext(profile, { ...launchOptions, headless: true, ignoreHTTPSErrors: true });
      const roots = execFileSync('ps', ['-axo', 'pid,command'], { encoding: 'utf8' }).split('\n').filter(line => line.includes(`--user-data-dir=${profile}`));
      assert.equal(roots.filter(line => !line.includes('--type=')).length, 1);
      pids = roots.map(line => Number(line.trim().split(/\s+/u)[0]));
      await use(context.pages()[0] ?? await context.newPage());
    } finally {
      await context?.close();
      await rm(profile, { recursive: true, force: true });
      await absent(profile);
      for (const pid of pids) await expect.poll(() => {
        try { process.kill(pid, 0); return true; }
        catch (error) { assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH'); return false; }
      }).toBe(false);
      assert(!execFileSync('ps', ['-axo', 'command'], { encoding: 'utf8' }).includes(`--user-data-dir=${profile}`));
      console.log('EMAIL_CAMPAIGN_BROWSER_RELEASED: exact profile and processes absent');
    }
  },
});

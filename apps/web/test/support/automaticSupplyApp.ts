import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test as base, expect, type Page, type BrowserContext } from 'playwright/test';
import { TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE } from '@fss/domain/db/testing/testDatabase.ts';
import { reserveLocalBrowserDatabase } from './database.ts';
import { startThinHostApp } from './thinHostApp.ts';
export { routeQualifiedResearchProvider as routeAutomaticSupplyProvider, loginQualifiedResearch as loginAutomaticSupply } from './qualifiedResearchApp.ts';
export { expect };
async function absent(path: string) {
  await access(path).then(() => { throw new Error(`Owned resource remains: ${path}`); }, error => assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT'));
}
export const test = base.extend<{ supplyPage: Page }>({
  supplyPage: async ({ playwright, launchOptions }, use) => {
    const profile = await mkdtemp(join(process.env['JCODE_SCRATCH_DIR'] ?? process.env['HOME']!, 'automatic-supply-browser-'));
    let context: BrowserContext | undefined;
    let pids: number[] = [];
    try {
      context = await playwright.chromium.launchPersistentContext(profile, { ...launchOptions, headless: true, ignoreHTTPSErrors: true });
      const processes = execFileSync('ps', ['-axo', 'pid,command'], { encoding: 'utf8' }).split('\n').filter(line => line.includes(`--user-data-dir=${profile}`));
      assert.equal(processes.filter(line => !line.includes('--type=')).length, 1);
      pids = processes.map(line => Number(line.trim().split(/\s+/u)[0]));
      console.log('AUTOMATIC_SUPPLY_BROWSER_ACQUIRED', JSON.stringify({ profile, pids }));
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
      console.log('AUTOMATIC_SUPPLY_BROWSER_RELEASED: exact PIDs/profile absent');
    }
  },
});
export async function startAutomaticSupplyApp() {
  const postgres = execFileSync('ps', ['-axo', 'pid,ppid,command'], { encoding: 'utf8' }).split('\n').filter(line => /(?:^|\s)(?:\S*\/)?postgres(?:\s|$)/u.test(line) && !/postgres: /u.test(line));
  assert(postgres.every(line => line.includes('/opt/homebrew/opt/postgresql@17/bin/postgres -D /opt/homebrew/var/postgresql@17')), 'Unknown PostgreSQL resource or occupied disposable lane');
  console.log('AUTOMATIC_SUPPLY_PREFLIGHT', JSON.stringify({ unrelatedPostgres: postgres }));
  const release = await reserveLocalBrowserDatabase();
  let app: Awaited<ReturnType<typeof startThinHostApp>>;
  try { app = await startThinHostApp(); }
  catch (error) { await release(); throw error; }
  return { app, stop: async () => {
    try { await app.stop(); }
    finally {
      await release();
      await absent(app.storagePath);
      assert.throws(() => process.kill(app.postgresPid, 0), { code: 'ESRCH' });
      assert.equal(process.env[TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE], undefined);
      const after = execFileSync('ps', ['-axo', 'pid,ppid,command'], { encoding: 'utf8' });
      for (const line of postgres) assert(after.includes(line), 'Unrelated Homebrew PostgreSQL must stay untouched');
      console.log('AUTOMATIC_SUPPLY_RELEASED: DB/template/cluster/TLS/HTTPS/PG PID absence, Homebrew unchanged');
    }
  } };
}

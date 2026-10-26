import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type BrowserContext } from 'playwright/test';

/** Own one installed Chrome process and one private profile per acceptance case.
 * No browser allocation occurs during module import or source checking. */
export async function launchGlassContext() {
  assert.equal(process.env['FSS_GLASS_WORKSPACE_EXCLUSIVE_LANE'], '783');
  const executablePath = process.env['FSS_LOCAL_BROWSER_EXECUTABLE'];
  const directory = process.env['FSS_GLASS_PRIVATE_ARTIFACTS'];
  assert(executablePath && directory && directory.startsWith('/Users/davidcui824/.jcode/scratch/'));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const profile = await mkdtemp(join(directory, 'chrome-profile-'));
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(profile, { executablePath, headless: true, ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
    const owned = context;
    const processes = execFileSync('ps', ['-axo', 'pid,command'], { encoding: 'utf8' }).split('\n').filter(line => line.includes(`--user-data-dir=${profile}`));
    const pids = processes.map(line => Number(line.trim().split(/\s+/u)[0]));
    assert(pids.length > 0 && pids.every(Number.isSafeInteger), 'Exact owned Chrome PID required');
    console.log('GLASS783_CHROME_REGISTERED', JSON.stringify({ executablePath, profile, pids, headless: true }));
    return { context: owned, async stop() {
      try {
        await owned.close();
        for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      } finally {
        await rm(profile, { recursive: true, force: true });
        await access(profile).then(() => { throw Error('Owned Chrome profile remains'); }, error => { assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT'); });
        console.log('GLASS783_CHROME_RELEASED', JSON.stringify({ profile, pids }));
      }
    } };
  } catch (error) { try { await context?.close(); } finally { await rm(profile, { recursive: true, force: true }); } throw error; }
}

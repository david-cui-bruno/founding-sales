import assert from 'node:assert/strict';
import { access, chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type BrowserContext } from 'playwright/test';
import { hasExplicitLaneGrant, privateArtifactsDirectory, processCommands } from './soleDisposableLane.ts';

/** Own one installed Chrome process and one private profile per acceptance case.
 * No browser allocation occurs during module import or source checking. */
export async function launchGlassContext() {
  assert(hasExplicitLaneGrant(), 'Explicit sole-lane or M2 fake-provider grant required before launching Chrome');
  const executablePath = process.env['FSS_LOCAL_BROWSER_EXECUTABLE'];
  assert(executablePath, 'Use the installed, explicitly selected Chrome');
  const directory = privateArtifactsDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const profile = await mkdtemp(join(directory, 'chrome-profile-'));
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(profile, { executablePath, headless: true, ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
    context.setDefaultTimeout(15_000);
    const owned = context;
    const processes = processCommands().split('\n').filter(line => line.includes(`--user-data-dir=${profile}`));
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

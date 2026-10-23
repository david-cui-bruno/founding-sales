import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test as base } from 'playwright/test';
import { absent } from './founderHostResources.ts';

async function processes() { return (await promisify(execFile)('/bin/ps', ['-axo', 'pid=,command='])).stdout.split('\n'); }
/** Use installed Chrome only. Record the actual browser PID/profile, then check
 * independently after close rather than treating close() as proof of absence. */
export const test = base.extend({
  browser: [async ({ playwright }, use) => {
    const executablePath = process.env['FSS_LOCAL_BROWSER_EXECUTABLE'];
    assert.ok(executablePath, 'Installed browser executable is required, no downloads');
    const before = new Set(await processes());
    const browser = await playwright.chromium.launch({ executablePath, headless: true });
    const owned = (await processes()).filter(line => !before.has(line) && line.includes(executablePath) && line.includes('--remote-debugging-pipe'));
    try {
      assert.equal(owned.length, 1);
      const line = owned[0]!;
      const pid = Number(line.trim().split(/\s+/u)[0]);
      const profile = /--user-data-dir=([^ ]+)/u.exec(line)?.[1];
      assert.ok(profile);
      console.log('FOUNDER_HOST_BROWSER_OWNED', JSON.stringify({ pid, profile }));
      try { await use(browser); }
      finally {
        await browser.close();
        assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
        await absent(profile);
        console.log('FOUNDER_HOST_BROWSER_ABSENT: actual PID and profile');
      }
    } finally { if (browser.isConnected()) await browser.close(); }
  }, { scope: 'worker' }],
});

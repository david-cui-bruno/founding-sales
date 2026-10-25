import { execFileSync } from 'node:child_process';
import { access, chmod } from 'node:fs/promises';
import { test, expect } from 'playwright/test';
import { assertSyntheticNoSend, containSyntheticBrowser, demoLabel, signInSyntheticBrowser, startSyntheticBrowser } from '../support/syntheticBrowserApp.ts';
import { scriptedReply, syntheticBrowserCase, syntheticReplySource } from '../support/syntheticBrowserCase.ts';
import { browserRequest } from '../support/browser.ts';

test.skip(process.env['FSS_SYNTHETIC_LOCAL_DEMO'] !== '1', 'Explicit isolated local demo opt-in required');
// New composed user journey, not a replay of issue751 domain scenarios.
test('fictional originals to editable reply, sourced preparation and durable private rehearsal notes in current Chrome', async ({ page, context, browser }) => {
  const runtime = await startSyntheticBrowser();
  const app = runtime.app;
  const proof = process.env['FSS_SYNTHETIC_PROOF_DIR'];
  let profile: string | undefined;
  let chromePid: number | undefined;
  try {
    const processes = execFileSync('/bin/ps', ['-axo', 'pid,command'], { encoding: 'utf8' }).split('\n').filter(line => line.includes('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome ') && line.includes('--remote-debugging-pipe') && !line.includes('--type='));
    expect(processes).toHaveLength(1);
    profile = /--user-data-dir=([^ ]+)/u.exec(processes[0]!)?.[1];
    chromePid = Number(processes[0]!.trim().split(/\s+/u)[0]);
    expect(profile).toBeTruthy();
    console.log('SYNTHETIC_781_CHROME_OWNED', JSON.stringify({ chromePid, profile, version: browser.version() }));
    await containSyntheticBrowser(context, app);
    await signInSyntheticBrowser(page, app);
    await expect(page.getByLabel('Synthetic demo notice')).toContainText(demoLabel);
    expect(app.fixture.google.jwksFetches()).toBeGreaterThan(0);
    expect(app.fixture.google.tokenExchanges().at(-1)?.clientSecretPresented).toBe(true);
    await page.getByRole('button', { name: 'Refresh replies', exact: true }).click();
    await page.getByRole('button', { name: `${syntheticBrowserCase.firm}: ${syntheticReplySource.subject}`, exact: true }).click();
    await page.getByRole('button', { name: 'Refresh current reply context', exact: true }).click();
    for (const source of syntheticBrowserCase.messages) await expect(page.getByText(source.body, { exact: true })).toBeVisible();
    if (proof) { await page.getByText(syntheticReplySource.body, { exact: true }).scrollIntoViewIfNeeded(); await page.screenshot({ path: `${proof}/781-input-viewport.png` }); await chmod(`${proof}/781-input-viewport.png`, 0o600); }
    expect(app.calls()).toBe(0);
    await page.getByRole('button', { name: 'Generate suggestion', exact: true }).click();
    await expect(page.getByRole('complementary', { name: 'Reply suggestion' })).toContainText(scriptedReply);
    expect(app.calls()).toBe(1);
    await page.getByRole('button', { name: 'Use suggestion in draft', exact: true }).click();
    const edited = `${scriptedReply} [SYNTHETIC manual edit: retain the recap promise as unfulfilled. NO SEND.]`;
    await page.getByLabel('Reply draft', { exact: true }).fill(edited);
    await page.getByRole('button', { name: 'Preview exact reply', exact: true }).click();
    await expect(page.getByRole('article', { name: 'Final reply preview' })).toContainText(edited);
    await expect(page.getByRole('button', { name: /^(Send|Confirm reply|Book)$/u })).toHaveCount(0);
    for (const path of ['/replies/composer/send', '/replies/composer/send-status', '/replies/confirm']) expect((await browserRequest(page, path, { body: {} })).status).toBe(404);
    if (proof) { await page.getByRole('article', { name: 'Final reply preview' }).scrollIntoViewIfNeeded(); await page.screenshot({ path: `${proof}/781-reply.png`, fullPage: true }); await chmod(`${proof}/781-reply.png`, 0o600); await page.screenshot({ path: `${proof}/781-reply-viewport.png` }); await chmod(`${proof}/781-reply-viewport.png`, 0o600); }
    const open = async () => {
      await page.getByRole('article').filter({ has: page.getByRole('heading', { name: syntheticBrowserCase.firm, level: 3, exact: true }) }).getByRole('button', { name: 'Open firm', exact: true }).click();
    };
    await open();
    await page.getByRole('button', { name: 'Load existing meetings', exact: true }).click();
    await page.getByRole('button', { name: 'Open preparation', exact: true }).click();
    const brief = page.getByRole('article', { name: 'Current meeting brief' });
    await expect(brief).toContainText('Mara Fenwick (invented)');
    await expect(brief).toContainText('84 rental doors');
    await expect(brief).toContainText('Fulfillment unobserved');
    await expect(brief).toContainText(app.meetingId);
    const note = 'SYNTHETIC rehearsal only, not a completed meeting: Mara wants request ownership clarified when vendors have not replied. SYN-A-04 recap promise due 2026-10-27 12:00 America/New_York, fulfillment unobserved. Private preparation notes only, no task assignment, calendar event or send.';
    await page.getByLabel('Meeting ID', { exact: true }).fill(app.meetingId);
    await page.getByRole('button', { name: 'Read meeting notes', exact: true }).click();
    await page.getByLabel('Your notes', { exact: true }).fill(note);
    await page.getByRole('button', { name: 'Save notes', exact: true }).click();
    await expect(page.getByText('Saved notes revision 1.', { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByLabel('Synthetic demo notice')).toContainText(demoLabel);
    await expect(page.getByRole('heading', { name: syntheticBrowserCase.firm, level: 3, exact: true })).toBeVisible();
    await open();
    await page.getByLabel('Meeting ID', { exact: true }).fill(app.meetingId);
    await page.getByRole('button', { name: 'Read meeting notes', exact: true }).click();
    await expect(page.getByLabel('Your notes', { exact: true })).toHaveValue(note);
    expect(app.calls()).toBe(1);
    const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
    expect(stored).not.toContain(note);
    expect(stored).not.toContain(scriptedReply);
    if (proof) { await page.screenshot({ path: `${proof}/781-reopened-notes.png`, fullPage: true }); await chmod(`${proof}/781-reopened-notes.png`, 0o600); }
    await assertSyntheticNoSend(app);
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByLabel('Workspace ID', { exact: true })).toBeVisible();
    expect((await browserRequest(page, '/replies', { body: {} })).status).toBe(401);
    await expect(page.getByLabel('Your notes', { exact: true })).toHaveCount(0);
    await assertSyntheticNoSend(app);
  } finally {
    try { await context.close(); await browser.close(); }
    finally { await runtime.stop(); }
    if (profile) await access(profile).then(() => { throw Error('Chrome profile remains'); }, error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    if (chromePid) { const pid = chromePid; expect(() => process.kill(pid, 0)).toThrow(); }
    console.log('SYNTHETIC_781_CHROME_PID_PROFILE_ABSENT');
  }
});

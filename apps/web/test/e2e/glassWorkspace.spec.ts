import { expect, test as base, type Page } from 'playwright/test';
import { browserRequest, browserSession } from '../support/browser.ts';
import { assertGlassFits, assertGlassNoExternalActions, assertGlassStorage, containGlass, glassCase, glassScreenshot, navigateGlass, openGlassSettings, requireGlassRuntimeGrant, signInGlass, startGlassWorkspace } from '../support/glassWorkspaceApp.ts';
import { seedGlassWorkspace, type GlassWorkspaceSeed } from '../support/glassWorkspaceSeed.ts';
import { acceptGlassCandidateContract } from '../support/glassWorkspaceContracts.ts';
import { launchGlassContext } from '../support/glassWorkspaceBrowser.ts';
import { assertGlassHistoryUnchanged, seedGlassIntroductions, type GlassIntroductions } from '../support/glassWorkspaceHistory.ts';
import { editGlassPromisedEmail, saveGlassCanonicalWrap } from '../support/glassWorkspaceCalling.ts';
import { acceptGlassTwoTabUnknown } from '../support/glassWorkspaceUnknown.ts';

const test = base.extend({ context: async ({ browserName }, use) => {
  expect(browserName).toBe('chromium');
  const ownedBrowser = await launchGlassContext();
  try { await use(ownedBrowser.context); }
  finally { await ownedBrowser.stop(); }
} });

// New composed product acceptance only. No old child-proof suite is invoked.
// Runtime grant: FSS_GLASS_WORKSPACE_EXCLUSIVE_LANE=783, FSS_SYNTHETIC_LOCAL_DEMO=1,
// installed FSS_LOCAL_BROWSER_EXECUTABLE and private FSS_GLASS_PRIVATE_ARTIFACTS.
test.use({ ignoreHTTPSErrors: true, actionTimeout: 15_000, screenshot: 'off', trace: 'off', video: 'off', viewport: { width: 1440, height: 1000 }, launchOptions: { ...(process.env['FSS_LOCAL_BROWSER_EXECUTABLE'] ? { executablePath: process.env['FSS_LOCAL_BROWSER_EXECUTABLE'] } : {}) } });
// One worker still runs serially, but one failed outcome must not skip unrelated flows.
test.describe.configure({ mode: 'default', timeout: 180_000 });
let owned: Awaited<ReturnType<typeof startGlassWorkspace>> | undefined;
let seed: GlassWorkspaceSeed;
let history: GlassIntroductions | undefined;
const app = () => { if (!owned) throw Error('Actual glass runtime not initialized'); return owned.app; };
test.beforeAll(async () => {
  requireGlassRuntimeGrant();
  owned = await startGlassWorkspace();
  seed = await seedGlassWorkspace(owned.app);
  history = await seedGlassIntroductions(owned.app, seed.preparedFirmId);
});
test.afterAll(async () => {
  if (!owned) return;
  try {
    await assertGlassNoExternalActions(owned.app, history?.outbound.length ?? 0);
    if (history) await assertGlassHistoryUnchanged(owned.app, history);
  }
  finally { await owned.stop(); owned = undefined; }
});
test.beforeEach(async ({ context, page }) => {
  await containGlass(context, app());
  await signInGlass(page, app());
});

async function openEmail(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await signInGlass(page, app(), 'salesperson');
  await navigateGlass(page, 'Email');
  await page.getByRole('button', { name: 'Refresh replies', exact: true }).click();
}
const firstConversation = (page: Page) => page.getByRole('button', { name: `${glassCase.firm}: FICTIONAL GLASS783 current question`, exact: true });
const secondConversation = (page: Page) => page.getByRole('button', { name: 'FICTIONAL Glass783 independent conversation: FICTIONAL independent original', exact: true });

test('Today -> exact prepared Prospects -> canonical Calling wrap -> saved Email edit/reload preserves sent and uncertain history', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'Today', exact: true, level: 1 })).toBeVisible();
  await page.getByRole('region', { name: 'Manual calling review', exact: true }).getByRole('button', { name: 'Prospect supply', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Prospects', exact: true, level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Today', exact: true, level: 1 })).toHaveCount(0);
  const row = page.locator('.prospects-supply-row').filter({ has: page.getByRole('heading', { name: seed.name, exact: true }) });
  await row.getByRole('button', { name: 'Review current research', exact: true }).click();
  const proof = page.getByRole('region', { name: 'Current research proof' });
  await expect(proof.getByRole('heading', { name: seed.name, exact: true })).toBeFocused();
  await expect(proof).toContainText('Channel authority not granted');
  const website = proof.getByRole('link', { name: seed.website, exact: true }).first();
  await expect(website).toHaveAttribute('href', seed.website);
  await expect(website).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(website).toHaveAttribute('referrerpolicy', 'no-referrer');
  await proof.getByText('Source passages and exact research lineage', { exact: true }).click();
  for (const id of [seed.preparedFirmId, seed.selection.candidateId, seed.selection.runId, seed.source.recordId]) await expect(proof).toContainText(id);
  await expect(proof).toContainText('Maintenance need not established');
  await assertGlassFits(page);
  await glassScreenshot(page, '783-prospects-current-desktop');
  await page.getByRole('button', { name: '← Back to prepared research', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Prepared source-backed supply' })).toBeFocused();
  await row.getByRole('button', { name: 'Review current research', exact: true }).click();
  if (!history) throw Error('Controlled pending/held/sent/uncertain history required');
  const saved = await saveGlassCanonicalWrap(page, app(), seed, history);
  await editGlassPromisedEmail(page, saved);
});

test('Email reads current originals, expands prior history, keeps independent drafts, previews exact edits', async ({ page }) => {
  await openEmail(page);
  await firstConversation(page).click();
  const history = page.getByRole('region', { name: 'Available message history' });
  await expect(history).toContainText(glassCase.messages[2]!.body);
  await history.getByText('Prior conversation context · 2 available passages', { exact: true }).click();
  await expect(history).toContainText(glassCase.messages[0]!.body);
  await expect(history).toContainText(glassCase.messages[1]!.body);
  const composer = page.locator('.email-anchored-composer');
  const anchored = await composer.boundingBox();
  expect(anchored).not.toBeNull();
  expect(await history.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
  await history.evaluate(node => { node.scrollTop = node.scrollHeight; });
  expect(await history.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
  const afterScroll = await composer.boundingBox();
  expect(afterScroll?.y).toBeCloseTo(anchored!.y, 0);
  const firstDraft = 'FICTIONAL 783 first independent manual reply. NO SEND.';
  const secondDraft = 'FICTIONAL 783 second independent manual reply. NO SEND.';
  await page.getByRole('textbox', { name: 'Reply draft', exact: true }).fill(firstDraft);
  await secondConversation(page).click();
  await expect(page.getByRole('textbox', { name: 'Reply draft', exact: true })).toHaveValue('');
  await expect(history).toContainText('OTHER CONVERSATION');
  await page.getByRole('textbox', { name: 'Reply draft', exact: true }).fill(secondDraft);
  await firstConversation(page).click();
  await expect(page.getByRole('textbox', { name: 'Reply draft', exact: true })).toHaveValue(firstDraft);
  await page.getByRole('button', { name: 'Preview exact reply', exact: true }).click();
  await expect(page.getByRole('article', { name: 'Final reply preview' })).toContainText(firstDraft);
  await page.getByRole('textbox', { name: 'Reply draft', exact: true }).fill(`${firstDraft} Edited.`);
  await expect(page.getByRole('article', { name: 'Final reply preview' })).toHaveCount(0);
  await assertGlassStorage(page, [firstDraft, secondDraft, glassCase.messages[2]!.body]);
  await page.getByRole('button', { name: 'Night mode', exact: true }).click();
  await expect(page.locator('.browser-workspace')).toHaveAttribute('data-theme', 'dark');
  await assertGlassFits(page);
  await glassScreenshot(page, '783-email-night-desktop');
  await page.getByRole('button', { name: 'Day mode', exact: true }).click();
  await page.setViewportSize({ width: 388, height: 844 });
  await assertGlassFits(page);
  const back = page.getByRole('button', { name: 'Back to conversations', exact: true });
  await back.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Search loaded replies', { exact: true })).toBeFocused();
  await firstConversation(page).click();
  await expect(page.getByRole('textbox', { name: 'Reply draft', exact: true })).toHaveValue(`${firstDraft} Edited.`);
  await page.getByRole('textbox', { name: 'Reply draft', exact: true }).press('2');
  await expect(page.getByRole('heading', { name: 'Email', exact: true, level: 1 })).toBeVisible();
  await glassScreenshot(page, '783-email-388');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await navigateGlass(page, 'Social');
  await expect(page.getByRole('textbox', { name: 'Reply draft', exact: true })).toHaveCount(0);
  await navigateGlass(page, 'Email');
  await page.getByRole('button', { name: 'Refresh replies', exact: true }).click();
  await firstConversation(page).click();
  await expect(page.getByRole('textbox', { name: 'Reply draft', exact: true })).toHaveValue('');
  await page.getByLabel('Search loaded replies', { exact: true }).fill('nonexistent-fictional-783');
  await expect(page.getByText('No loaded replies match. Try another name or subject.', { exact: true })).toBeVisible();
});

test('Social metadata stays body-free and one selected private editor saves/reopens at 388px', async ({ page }) => {
  await navigateGlass(page, 'Social');
  await expect(page.getByText('No saved private drafts. Start a new manual draft.', { exact: true })).toBeVisible();
  const meta = await browserRequest(page, '/social/private-drafts/list', { body: {} });
  expect(meta.status).toBe(200);
  expect(meta.body).toEqual({ drafts: [], nextAfterId: null });
  await page.getByRole('button', { name: 'Read retained social suggestions', exact: true }).click();
  await expect(page.getByRole('article', { name: `Social request ${seed.socialRequestId}` })).toContainText(seed.socialText);
  await page.getByRole('button', { name: 'Start new manual draft', exact: true }).click();
  const text = 'FICTIONAL goal783 independent private post. No publishing requested.';
  await page.getByRole('textbox', { name: 'Private social text', exact: true }).fill(text);
  await page.getByRole('button', { name: 'Save private draft', exact: true }).click();
  await expect(page.getByText('Private draft saved at revision 1. Not approved, scheduled or published.', { exact: true })).toBeVisible();
  const list = await browserRequest(page, '/social/private-drafts/list', { body: {} });
  expect(list.status).toBe(200);
  expect(JSON.stringify(list.body)).not.toContain(text);
  expect(JSON.stringify(list.body)).not.toContain('"text"');
  await assertGlassStorage(page, [text, seed.socialText]);
  await page.reload();
  await navigateGlass(page, 'Social');
  await expect(page.getByRole('textbox', { name: 'Private social text', exact: true })).toHaveValue('');
  await page.setViewportSize({ width: 388, height: 844 });
  await page.getByRole('button', { name: /^Reopen private draft /u }).click();
  await expect(page.getByRole('textbox', { name: 'Private social text', exact: true })).toHaveValue(text);
  await expect(page.getByRole('textbox', { name: 'Private social text', exact: true })).toHaveCount(1);
  await expect(page.getByRole('textbox', { name: 'Private social text', exact: true })).toBeFocused();
  await assertGlassFits(page);
  await glassScreenshot(page, '783-social-private-388');
  await page.getByRole('button', { name: 'Back to drafts', exact: true }).click();
  await expect(page.getByRole('button', { name: 'List saved private drafts', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Conversations', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open public discussion', exact: true })).toBeDisabled();
  await expect(page.getByText('No discussions have been fetched or invented.', { exact: false })).toBeVisible();
});

test('new Calling candidate contract persists exact IDs, excludes notes, and never mutates canonical state', async ({ page }) => {
  await acceptGlassCandidateContract(page, app(), seed);
});

test('real two-tab lost responses conserve exact UNKNOWN records and inactive auth clears both tabs', async ({ page, context }) => {
  await acceptGlassTwoTabUnknown(page, context, app(), seed);
});

test('actual missing-source refusal and held real response cannot restore unmounted or signed-out Email', async ({ page, context }) => {
  await openEmail(page);
  // Real source loss, not a fabricated API refusal or injected frontend state.
  await app().fixture.db.query('DELETE FROM mail_message_bodies WHERE mail_message_id=$1', [app().seed.messageId]);
  await firstConversation(page).click();
  await expect(page.getByText('Current source or operation unavailable.', { exact: false })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Reply draft', exact: true })).toHaveCount(0);
  const pattern = '**/browser/api/replies';
  let release = () => {};
  let observed = () => {};
  let delivered = () => {};
  const completed = new Promise<void>(resolve => { delivered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const arrived = new Promise<void>(resolve => { observed = resolve; });
  await context.route(pattern, async route => {
    const response = await route.fetch(); // Existing real authenticated API/domain result.
    observed();
    await held;
    await route.fulfill({ response });
    delivered();
  });
  try {
    await page.getByRole('button', { name: 'Refresh replies', exact: true }).click();
    await arrived;
    await openGlassSettings(page);
    const session = await browserSession(page);
    if (session.status !== 'signed_in') throw Error('Current signed identity required for revocation acceptance');
    await app().fixture.db.query("UPDATE devices SET status='revoked',revoked_at=now() WHERE id=$1", [session.deviceId]);
    const revoked = await browserRequest(page, '/calling/follow-ups/list', { body: {} });
    expect(revoked.status).toBe(401);
    await page.getByRole('button', { name: 'Refresh access', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
    release();
    await completed;
    await context.unroute(pattern);
    await expect(page.getByText(glassCase.messages[2]!.body, { exact: true })).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Reply draft', exact: true })).toHaveCount(0);
    const refused = await browserRequest(page, '/calling/follow-ups/list', { body: {} });
    expect(refused.status).toBe(401);
    await assertGlassStorage(page, [glassCase.messages[2]!.body]);
  } finally { release(); await context.unroute(pattern); }
});

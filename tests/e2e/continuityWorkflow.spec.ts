import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from 'playwright/test';
import { launchFounderWorkspace, navigateFounderRoute } from '../support/founderWorkspace';

/**
 * Prospective packaged P1/P2 acceptance. Source lease only, not yet executed.
 * All application writes below are explicit supported UI actions. evaluate()
 * only reads the public API/DOM or establishes native focus/text selection.
 * No unsaved-restart, exact-once, held-refresh, or global no-network claim.
 */
test.describe.configure({ mode: 'serial' });

const companyName = (page: Page) => page.getByRole('textbox', { name: 'Company name', exact: true });
const companyDomain = (page: Page) => page.getByRole('textbox', { name: 'Company domain (optional)', exact: true });
const intake = (page: Page) => page.getByRole('form', { name: 'Local company intake', exact: true });
const diagnostics = (page: Page) => page.getByRole('region', { name: 'Diagnostic observation', exact: true });
const palette = (page: Page) => page.getByRole('dialog', { name: 'Command palette', exact: true });

async function accounts(page: Page) {
  const snapshot = await page.evaluate(() => window.callie.localWorkspace.get());
  expect(snapshot.accounts.state).toBe('available');
  if (snapshot.accounts.state !== 'available') throw new Error('Local account read unavailable');
  return snapshot.accounts.snapshots;
}

async function ready(page: Page) {
  await expect(page).toHaveURL(/^callie:\/\//u);
  await expect(page.getByRole('navigation', { name: 'Primary', exact: true })).toBeVisible();
  await expect(diagnostics(page).locator('time')).toHaveAttribute('datetime', /\S/u);
  const health = await page.evaluate(() => window.callie.health.get());
  expect(health).toMatchObject({ domainReady: true, domainStatus: 'ready' });
  return health.domainStartupEvaluatedAt;
}

async function unpaired(page: Page) {
  expect(await page.evaluate(() => window.callie.delegation.status())).toMatchObject({
    state: 'unconfigured', workspaceId: null, configuration: null,
  });
  expect(await page.evaluate(() => window.callie.daily.get())).toMatchObject({
    workspaceId: null, accounts: [], campaigns: [], calls: { accountIds: [] },
    answers: [], ownerStatus: [], transport: [],
  });
}

function observeRenderer(page: Page) {
  const errors: string[] = [];
  const http: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/u.test(request.url())) http.push(request.url()); });
  return () => {
    // Observation starts after supported launcher attachment, not at process birth.
    expect(errors, 'renderer page errors since attachment').toEqual([]);
    expect(http, 'renderer HTTP only, not a process-wide egress proof').toEqual([]);
  };
}

async function draft(page: Page, name: string, domain: string) {
  await expect(intake(page)).toBeVisible();
  await expect(companyName(page)).toHaveValue(name);
  await expect(companyDomain(page)).toHaveValue(domain);
}

async function routeRoundTrip(page: Page) {
  for (const route of ['Campaigns', 'Today', 'Accounts']) await navigateFounderRoute(page, route);
}

/** Capture after route changes. This oracle is only for a stable route lifetime. */
async function retainInput(locator: Locator, value: string) {
  await expect(locator).toHaveValue(value);
  const handle = await locator.elementHandle();
  if (!handle) throw new Error('Expected a mounted input');
  return {
    async unchanged() {
      expect(await handle.evaluate(node => {
        const input = node as HTMLInputElement;
        return { connected: input.isConnected, sameIdNode: document.getElementById(input.id) === input, value: input.value };
      })).toEqual({ connected: true, sameIdNode: true, value });
    },
    async focused() {
      await expect.poll(() => handle.evaluate(node => document.activeElement === node)).toBe(true);
    },
    async selection() {
      expect(await handle.evaluate(node => {
        const input = node as HTMLInputElement;
        return [input.selectionStart, input.selectionEnd, input.selectionDirection];
      })).toEqual([2, 9, 'forward']);
    },
    async dispose() { await handle.dispose(); },
  };
}

async function selectText(locator: Locator) {
  await locator.focus();
  await locator.evaluate(node => {
    const input = node as HTMLInputElement;
    if (input.type !== 'text') throw new Error('Text selection oracle must not run on date/time controls');
    input.setSelectionRange(2, 9, 'forward');
  });
}

async function reachable(locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  await expect(locator).toBeInViewport({ ratio: 1 });
  await expect.poll(() => locator.evaluate(node => {
    const r = node.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!hit && (hit === node || node.contains(hit));
  })).toBe(true);
}

async function noHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}

async function capture(page: Page, label: string) {
  await noHorizontalOverflow(page);
  await page.screenshot({ path: test.info().outputPath(`${label}.png`), animations: 'disabled' });
  const audit = await new AxeBuilder({ page }).setLegacyMode(true).analyze();
  expect(audit.violations.filter(issue => issue.impact === 'serious' || issue.impact === 'critical'), label).toEqual([]);
}

type Appearance = { theme: 'light' | 'dark'; density: 'comfortable' | 'compact'; width: number; height: number };
const appearances: readonly Appearance[] = [
  { theme: 'light', density: 'comfortable', width: 1050, height: 700 },
  { theme: 'dark', density: 'compact', width: 1440, height: 900 },
];

async function setAppearance(page: Page, appearance: Appearance) {
  await page.setViewportSize({ width: appearance.width, height: appearance.height });
  await navigateFounderRoute(page, 'Settings');
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  const region = page.getByRole('region', { name: 'Appearance', exact: true });
  await region.getByRole('button', { name: appearance.theme === 'light' ? 'Light appearance' : 'Dark appearance', exact: true }).click();
  await region.getByRole('button', { name: appearance.density === 'comfortable' ? 'Comfortable density' : 'Compact density', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', appearance.theme);
  await expect(page.locator('html')).toHaveAttribute('data-density', appearance.density);
}

async function sharedPresentation(page: Page, surface: Locator, appearance: Appearance) {
  await expect(page.locator('html')).toHaveAttribute('data-theme', appearance.theme);
  await expect(page.locator('html')).toHaveAttribute('data-density', appearance.density);
  const root = page.locator('.presentation-root');
  const tokens = (locator: Locator) => locator.evaluate(node => {
    const style = getComputedStyle(node);
    return ['--font-ui', '--surface-raised', '--text', '--grid-row', '--control-height']
      .map(token => style.getPropertyValue(token).trim());
  });
  const expected = await tokens(root);
  expect(expected.every(token => token.length > 0)).toBe(true);
  expect(await tokens(surface)).toEqual(expected);
}

async function modal(page: Page, dialog: Locator) {
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate(node => node instanceof HTMLDialogElement && node.open && node.matches(':modal'))).toBe(true);
  await expect(page.locator('dialog:modal')).toHaveCount(1);
  // Exercise native keyboard isolation without trying to focus the inert form.
  for (let index = 0; index < 3; index += 1) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate(node => node.contains(document.activeElement))).toBe(true);
  }
}

async function openPalette(page: Page) {
  await page.keyboard.press('Meta+k');
  await modal(page, palette(page));
}

async function dismissPalette(page: Page) {
  await page.keyboard.press('Escape');
  await expect(palette(page)).toHaveCount(0);
  await expect(page.locator('dialog:modal')).toHaveCount(0);
}

async function diagnosticGeometry(page: Page) {
  const strip = diagnostics(page);
  const nav = page.getByRole('navigation', { name: 'Primary', exact: true });
  await reachable(strip.getByRole('button', { name: 'Refresh diagnostics', exact: true }));
  await expect(strip).toBeInViewport({ ratio: 1 });
  const stripBox = await strip.boundingBox();
  const navBox = await nav.boundingBox();
  if (!stripBox || !navBox) throw new Error('Missing diagnostic/navigation geometry');
  expect(stripBox.x).toBeGreaterThanOrEqual(navBox.x + navBox.width - 1);
  expect(await strip.evaluate(node => {
    const outer = node.getBoundingClientRect();
    return node.scrollWidth <= node.clientWidth + 1 && [...node.querySelectorAll('p,time,button')].every(child => {
      const r = child.getBoundingClientRect();
      return r.left >= outer.left - 1 && r.right <= outer.right + 1 && r.top >= 0 && r.bottom <= innerHeight + 1;
    });
  })).toBe(true);
  for (const control of [companyName(page), companyDomain(page), page.getByRole('button', { name: 'Close company form', exact: true })]) {
    await reachable(control); // Scroll the real workspace owner, not the page by assumption.
    const box = await control.boundingBox();
    if (!box) throw new Error('Missing company control geometry');
    expect(box.y + box.height <= stripBox.y + 1 || box.y >= stripBox.y + stripBox.height - 1).toBe(true);
  }
  await reachable(nav.getByRole('link', { name: 'Accounts', exact: true }));
  await noHorizontalOverflow(page);
}

test('P1: packaged company draft and reviewed intent survive real routes before one explicit create', async () => {
  test.setTimeout(180_000);
  const workspace = await launchFounderWorkspace();
  const { page } = workspace;
  const assertObserved = observeRenderer(page);
  // Independent raw and persisted expectations. The name is fictional and this profile is fresh.
  const rawName = '  Continuity Fictional Management  ';
  const savedName = 'Continuity Fictional Management';
  const domain = 'continuity.invalid';
  try {
    await ready(page);
    expect(await accounts(page)).toEqual([]);
    expect(await page.evaluate(() => window.callie.localWorkspace.get())).toMatchObject({ workflowMode: 'legacy', transitionReceipt: null });
    await unpaired(page);
    await navigateFounderRoute(page, 'Accounts');
    await page.getByRole('button', { name: 'Add company', exact: true }).click();
    await companyName(page).fill(rawName);
    await companyDomain(page).fill(domain);
    await routeRoundTrip(page);
    await draft(page, rawName, domain); // State retention, not a node identity claim across routes.
    expect(await accounts(page)).toEqual([]);
    await page.getByRole('button', { name: 'Review company', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Create company', exact: true })).toBeEnabled();
    await expect(page.getByText(`Reviewed company: ${savedName} · ${domain}`, { exact: true })).toBeVisible();
    await expect(page.getByText('No matching companies in the current local review.', { exact: true })).toBeVisible();
    expect(await accounts(page)).toEqual([]);
    // Review deliberately normalizes input. Preserve those independently fixed reviewed values
    // across later route phases, while pre-Review raw-value assertions stay unchanged.
    await draft(page, savedName, domain);
    await routeRoundTrip(page);
    await draft(page, savedName, domain);
    await expect(page.getByRole('button', { name: 'Create company', exact: true })).toBeEnabled();
    await expect(page.getByText(`Reviewed company: ${savedName} · ${domain}`, { exact: true })).toBeVisible();
    expect(await accounts(page)).toEqual([]);
    await page.getByRole('button', { name: 'Create company', exact: true }).click();
    await expect(page.getByRole('heading', { name: savedName, exact: true })).toBeVisible();
    await expect.poll(async () => (await accounts(page)).length).toBe(1);
    const created = await accounts(page);
    const saved = created[0]!;
    expect(saved.account).toMatchObject({ name: savedName, domain, version: 1 });
    expect(saved.account.id).toEqual(expect.any(String));
    expect(saved.account.id.length).toBeGreaterThan(0);
    expect(saved.claims).toEqual([]);
    expect(saved.portfolio).toEqual([]);
    expect(saved.routes).toEqual([]);
    await navigateFounderRoute(page, 'Campaigns');
    await navigateFounderRoute(page, 'Accounts');
    const localRow = page.getByRole('button', { name: `Local account · ${savedName}`, exact: true });
    await expect(localRow).toHaveAttribute('data-row-key', JSON.stringify(['local-account', saved.account.id]));
    await localRow.click();
    await expect(localRow).toHaveAttribute('aria-current', 'true');
    await expect(page.getByRole('heading', { name: savedName, exact: true })).toBeVisible();
    expect(await accounts(page)).toEqual(created);
    expect(await page.evaluate(() => window.callie.localWorkspace.get())).toMatchObject({ workflowMode: 'legacy', transitionReceipt: null });
    await unpaired(page);
    // P1 remains in legacy mode. Visible hold copy and public evidence establish the worker boundary.
    await expect(page.getByText('Legacy workflow is active. Local records remain available. Switch to Native Desk in Settings to change the daily workspace. Worker actions are held.', { exact: true })).toBeVisible();
    await capture(page, 'p1-local-account-worker-boundary');
    await navigateFounderRoute(page, 'Campaigns');
    await expect(page.getByText('Legacy workflow is active. Local records remain available. Switch to Native Desk in Settings to change the daily workspace. Worker actions are held.', { exact: true })).toBeVisible();
    await unpaired(page);
    assertObserved();

    // Additive Native boundary proof, after all original legacy P1 checks above.
    // Reuse P2's supported one-way Settings action on this disposable profile.
    await navigateFounderRoute(page, 'Settings');
    await page.getByRole('button', { name: 'Data & storage', exact: true }).click();
    await page.getByRole('checkbox', { name: /one-way local change/i }).check();
    await page.getByRole('button', { name: 'Switch to Native Desk', exact: true }).click();
    await expect(page.getByText(/Native Desk is active/i)).toBeVisible();
    expect(await page.evaluate(() => window.callie.localWorkspace.get())).toMatchObject({ workflowMode: 'meeting_first' });
    await unpaired(page);

    await navigateFounderRoute(page, 'Accounts');
    await expect(page.getByTestId('native-desk')).toHaveAttribute('data-workflow-mode', 'meeting_first');
    const nativeAccounts = page.getByRole('heading', { name: /^Worker accounts\s/u, level: 2 });
    await expect(nativeAccounts).toBeVisible();
    await expect(nativeAccounts.locator('span')).toHaveText('Unavailable');
    await expect(page.getByText('Worker-scoped accounts are unavailable.', { exact: true })).toBeVisible();
    const nativeLocalRow = page.getByRole('button', { name: `Local account · ${savedName}`, exact: true });
    await expect(nativeLocalRow).toHaveAttribute('data-row-key', JSON.stringify(['local-account', saved.account.id]));
    await expect(nativeLocalRow.getByText('Read-only local evidence', { exact: true })).toBeVisible();
    await nativeLocalRow.click();
    await expect(nativeLocalRow).toHaveAttribute('aria-current', 'true');
    const localDetail = page.locator('.native-desk__account');
    await expect(localDetail.getByRole('heading', { name: savedName, exact: true })).toBeVisible();
    await expect(localDetail.getByText(domain, { exact: true })).toBeVisible();
    await expect(localDetail.getByText('Local evidence, not worker authority or complete research.', { exact: true })).toBeVisible();
    expect(await accounts(page)).toEqual(created);

    await navigateFounderRoute(page, 'Campaigns');
    await expect(page.getByTestId('native-desk')).toHaveAttribute('data-workflow-mode', 'meeting_first');
    const nativeCampaigns = page.getByRole('heading', { name: /^Saved campaign versions\s/u, level: 2 });
    await expect(nativeCampaigns).toBeVisible();
    await expect(nativeCampaigns.locator('span')).toHaveText('Unavailable');
    await expect(page.getByText('Campaign scope is unavailable.', { exact: true })).toBeVisible();
    // Campaigns has no local-company library. Prove unchanged saved evidence
    // through the real public read here, not an invented company row on this route.
    await expect(page.getByRole('region', { name: 'Local account library', exact: true })).toHaveCount(0);
    expect(await accounts(page)).toEqual(created);
    await unpaired(page);
    await navigateFounderRoute(page, 'Accounts');
    await expect(nativeAccounts.locator('span')).toHaveText('Unavailable');
    await expect(nativeLocalRow).toHaveAttribute('data-row-key', JSON.stringify(['local-account', saved.account.id]));
    await nativeLocalRow.click();
    await expect(localDetail.getByRole('heading', { name: savedName, exact: true })).toBeVisible();
    await expect(localDetail.getByText(domain, { exact: true })).toBeVisible();
    expect(await accounts(page)).toEqual(created);
    assertObserved();
  } finally {
    await workspace.close(); // Owned-launcher cleanup, not graceful native Quit evidence.
  }
});

test('P2: packaged Native company diagnostics and the palette overlay retain drafts', async () => {
  test.setTimeout(300_000);
  const workspace = await launchFounderWorkspace();
  const { page } = workspace;
  const assertObserved = observeRenderer(page);
  const name = 'Unsaved Native Continuity';
  const domain = 'draft-continuity.invalid';
  try {
    const startup = await ready(page);
    await unpaired(page);
    expect(await accounts(page)).toEqual([]);
    await navigateFounderRoute(page, 'Settings');
    await page.getByRole('button', { name: 'Data & storage', exact: true }).click();
    await page.getByRole('checkbox', { name: /one-way local change/i }).check();
    await page.getByRole('button', { name: 'Switch to Native Desk', exact: true }).click();
    await expect(page.getByText(/Native Desk is active/i)).toBeVisible();
    expect(await page.evaluate(() => window.callie.localWorkspace.get())).toMatchObject({ workflowMode: 'meeting_first' });
    await unpaired(page);
    await navigateFounderRoute(page, 'Accounts');
    await page.getByRole('button', { name: 'Add company', exact: true }).click();
    await companyName(page).fill(name);
    await companyDomain(page).fill(domain);

    for (const appearance of appearances) {
      const label = `p2-company-${appearance.theme}-${appearance.density}-${appearance.width}`;
      await setAppearance(page, appearance);
      await navigateFounderRoute(page, 'Accounts');
      await draft(page, name, domain);
      await expect(page.getByTestId('native-desk')).toHaveAttribute('data-workflow-mode', 'meeting_first');
      const heldName = await retainInput(companyName(page), name);
      const heldDomain = await retainInput(companyDomain(page), domain);
      try {
        await selectText(companyName(page));
        const time = diagnostics(page).locator('time');
        const before = await time.getAttribute('datetime');
        expect(before).not.toBeNull();
        await diagnostics(page).getByRole('button', { name: 'Refresh diagnostics', exact: true }).click();
        await expect(time).not.toHaveAttribute('datetime', before!);
        await expect(time).toHaveAttribute('datetime', /\S/u);
        await expect(diagnostics(page).getByRole('alert')).toHaveCount(0);
        await expect(diagnostics(page)).not.toContainText('(stale)');
        await expect(diagnostics(page).getByText('Refreshing diagnostics…', { exact: true })).toHaveCount(0);
        await heldName.unchanged();
        await heldDomain.unchanged();
        await heldName.selection(); // Clicking the refresh button may take focus, intentionally.
        await diagnosticGeometry(page);
        await sharedPresentation(page, intake(page), appearance);
        await capture(page, `${label}-refresh`);

        await selectText(companyName(page));
        await openPalette(page);
        await heldName.unchanged();
        await heldDomain.unchanged();
        await sharedPresentation(page, palette(page), appearance);
        await capture(page, `${label}-palette`);
        await dismissPalette(page);
        await heldName.unchanged();
        await heldName.focused();
        await heldName.selection();
        await draft(page, name, domain);
        expect(await accounts(page)).toEqual([]);
        expect(await page.evaluate(() => window.callie.health.get())).toMatchObject({
          domainReady: true, domainStatus: 'ready', domainStartupEvaluatedAt: startup,
        }); // Stable timestamp, not an invocation-counter proof.
        await unpaired(page);
      } finally {
        await heldName.dispose();
        await heldDomain.dispose();
      }
    }
    assertObserved();
  } finally {
    await workspace.close();
  }
});

import { expect, type Page } from 'playwright/test';
import { appRoutes, type AppRoute } from '../../src/renderer/app/routes';
import type { ApplicationPresentationBrowser } from '../fixtures/applicationPresentationBrowser';

export { appRoutes };
export type PresentationContext = { mode: 'legacy' | 'meeting_first'; theme: 'light' | 'dark'; density: 'comfortable' | 'compact'; width: 1050 | 1440 };
export const routeProofs = {
  today: { label: 'Today', heading: 'Today', read: 'daily.get' },
  accounts: { label: 'Accounts', heading: 'Accounts', read: 'daily.get' },
  campaigns: { label: 'Campaigns', heading: 'Campaigns', read: 'daily.get' },
  // Settings performs no bridge read on mount since the Apple spike panel was removed (18 September 2026); its proof is the heading alone.
  settings: { label: 'Settings', heading: 'Settings', read: null as null },
} satisfies Record<AppRoute, { label: string; heading: string; read: string | null }>;

/** Exact hold the desk routes show while the legacy workflow is active. The removed legacy queue never renders. */
export const legacyHoldCopy = 'Legacy workflow is active. Local records remain available. Switch to Native Desk in Settings to change the daily workspace. Worker actions are held.';

export const nativePalette = {
  light: { canvas: 'rgb(233, 237, 242)', rail: 'rgb(233, 237, 242)', text: 'rgb(34, 42, 53)', surface: 'rgb(255, 255, 255)' },
  dark: { canvas: 'rgb(24, 29, 37)', rail: 'rgb(25, 31, 40)', text: 'rgb(237, 241, 246)', surface: 'rgb(38, 46, 57)' },
};

export function routeLinkName(route: AppRoute): string {
  return routeProofs[route].label;
}

export async function navigateActualRoute(page: Page, route: AppRoute) {
  const link = page.locator('.nav-rail').getByRole('link', { name: routeLinkName(route), exact: true });
  await expect(link).toHaveAttribute('href', `#/${route}`);
  await expect(link.locator('.nav-rail__label')).toHaveText(routeProofs[route].label);
  await link.click();
  await expect(link).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('main').getByRole('heading', { level: 1, name: routeProofs[route].heading, exact: true })).toBeVisible();
}

export async function assertActualDestination(page: Page, route: AppRoute, mode: PresentationContext['mode']) {
  switch (route) {
    case 'today':
      if (mode === 'legacy') {
        // Local commitments stay readable under the hold; no desk and no removed queue is substituted.
        await expect(page.getByText(legacyHoldCopy, { exact: true })).toBeVisible();
        await expect(page.getByRole('heading', { level: 2, name: /^Local commitments/ })).toBeVisible();
        await expect(page.getByTestId('native-desk')).toHaveCount(0);
      } else {
        await expect(page.locator('.native-desk__queue--today')).toBeVisible();
        const queue = page.getByRole('navigation', { name: 'Today queue', exact: true });
        await expect(queue.getByRole('region', { name: 'Calls', exact: true }).getByRole('button', { name: 'Call · Account A', exact: true })).toBeVisible();
        await expect(queue.getByRole('region', { name: /^Saved draft continuations/ }).locator('[data-row-key]')).toHaveCount(3);
      }
      break;
    case 'accounts':
    case 'campaigns':
      if (mode === 'legacy') {
        await expect(page.getByText(legacyHoldCopy, { exact: true })).toBeVisible();
        if (route === 'accounts') {
          await expect(page.getByRole('navigation', { name: 'Local accounts', exact: true })).toBeVisible();
          await expect(page.getByRole('button', { name: 'Add company', exact: true })).toBeVisible();
        } else await expect(page.getByText('Campaign scope unavailable. This is a read-only capability preview. Creation, editing, enrollment and activation are not available here.', { exact: true })).toBeVisible();
      } else {
        const queue = page.getByRole('navigation', { name: `${routeProofs[route].label} queue`, exact: true });
        await expect(queue).toBeVisible();
        if (route === 'accounts') {
          await expect(queue.locator('[data-row-key="account:a"]')).toContainText('Account A');
          await expect(queue.locator('[data-row-key="account:b"]')).toContainText('Account B');
          await expect(queue.locator('[data-row-key]')).toHaveCount(2);
        } else {
          await expect(queue.locator('[data-row-key="campaign:version"]')).toContainText('Fixture campaign');
          await expect(queue.locator('[data-row-key="campaign:version"]')).toContainText('Version 1');
          await expect(queue.locator('[data-row-key]')).toHaveCount(1);
        }
      }
      await expect(page.locator('.native-desk__queue--today')).toHaveCount(0);
      break;
    case 'settings':
      await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Appearance', exact: true })).toBeVisible();
      break;
  }
}

export async function presentationSample(page: Page) {
  return page.evaluate(() => {
    const root = document.querySelector('.presentation-root');
    const shell = document.querySelector('.app-shell')!;
    const rail = document.querySelector('.nav-rail')!;
    const current = rail.querySelector('[aria-current="page"]')!;
    const main = document.querySelector('main')!;
    const title = main.querySelector('h1');
    const titleStyle = title ? getComputedStyle(title) : null;
    const sharedTitle = main.querySelector('.page-header__title');
    const style = getComputedStyle(root ?? shell);
    const brand = rail.querySelector('.nav-rail__brand-native');
    return {
      rootCount: document.querySelectorAll('.presentation-root[data-presentation="native-a"]').length,
      rootAuthority: root?.getAttribute('data-workflow-mode') ?? null,
      theme: document.documentElement.dataset.theme,
      density: document.documentElement.dataset.density,
      font: style.fontFamily, color: style.color,
      canvas: getComputedStyle(document.querySelector('.app-shell__workspace')!).backgroundColor,
      railColor: getComputedStyle(rail).backgroundColor,
      railWidth: rail.getBoundingClientRect().width,
      currentHeight: current.getBoundingClientRect().height,
      brand: brand && getComputedStyle(brand).display !== 'none' ? brand.textContent?.trim() : null,
      brandCount: rail.querySelectorAll('.nav-rail__brand-native').length,
      legacyBrandCount: rail.querySelectorAll('.nav-rail__brand').length,
      titleFont: titleStyle?.fontFamily ?? null,
      sharedTitleSize: sharedTitle ? getComputedStyle(sharedTitle).fontSize : null,
      pageSizeToken: style.getPropertyValue('--text-native-page').trim(),
      uiFontToken: style.getPropertyValue('--font-ui').trim(),
      displayFontToken: style.getPropertyValue('--font-display').trim(),
      mainLeft: main.getBoundingClientRect().left,
      railRight: rail.getBoundingClientRect().right,
      mainPadding: [getComputedStyle(main).paddingTop, getComputedStyle(main).paddingRight, getComputedStyle(main).paddingBottom, getComputedStyle(main).paddingLeft],
      overflow: document.documentElement.scrollWidth > innerWidth,
    };
  });
}
export function assertSharedPresentation(sample: Awaited<ReturnType<typeof presentationSample>>, context: PresentationContext) {
  const palette = nativePalette[context.theme];
  expect.soft(sample.rootCount).toBe(1);
  expect.soft(sample.rootAuthority).toBeNull();
  expect.soft(sample.theme).toBe(context.theme);
  expect.soft(sample.density).toBe(context.density);
  expect.soft(sample.font).toContain('-apple-system');
  expect.soft(sample.color).toBe(palette.text);
  expect.soft(sample.canvas).toBe(palette.canvas);
  expect.soft(sample.railColor).toBe(palette.rail);
  expect.soft(sample.railWidth).toBe(context.width === 1050 ? 124 : 142);
  expect.soft(sample.currentHeight).toBe(44);
  expect.soft(sample.brand).toBe('Callie');
  expect.soft(sample.brandCount).toBe(1);
  expect.soft(sample.legacyBrandCount).toBe(0);
  expect.soft(sample.titleFont).toContain('-apple-system');
  expect.soft(sample.pageSizeToken).toBe('25px');
  expect.soft(sample.uiFontToken).toContain('-apple-system');
  expect.soft(sample.displayFontToken).toContain('-apple-system');
  if (sample.sharedTitleSize !== null) expect.soft(sample.sharedTitleSize).toBe('25px');
  expect.soft(sample.mainLeft).toBe(sample.railRight);
  expect.soft(sample.mainPadding).toEqual(['12px', '16px', '12px', '16px']);
  expect.soft(sample.overflow).toBe(false);
}

export function assertTransitionPresentation(observation: ReturnType<ApplicationPresentationBrowser['stopPresentationFrames']>, context: PresentationContext) {
  expect(observation.rootReplaced).toBe(false);
  expect(observation.frames.length).toBeGreaterThan(1);
  expect(observation.frames.length).toBeLessThan(1000);
  for (const frame of observation.frames) {
    expect(frame.sameRoot).toBe(true);
    expect(frame.rootCount).toBe(1);
    expect(frame.font).toContain('-apple-system');
    expect(frame.color).toBe(nativePalette[context.theme].text);
    expect(frame.canvas).toBe(nativePalette[context.theme].canvas);
    expect(frame.rail).toBe(nativePalette[context.theme].rail);
    expect(frame.railWidth).toBe(context.width === 1050 ? 124 : 142);
    expect(frame.theme).toBe(context.theme);
    expect(frame.density).toBe(context.density);
    expect(frame.brands).toEqual(['Callie']);
    expect(frame.legacyBrands).toBe(0);
  }
}

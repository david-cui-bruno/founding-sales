import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright/test';

const VIEWPORTS = [['1440', 1440, 1000], ['1024', 1024, 800], ['850', 850, 900], ['390', 390, 844]] as const;

/**
 * Opt-in, SYNTHETIC-ONLY visual artifacts of the current Prospects screen. Set FSS_PROSPECTS_SCREENSHOTS to an owner-only
 * scratch directory; unset, this is a no-op. It only captures PNGs: no snapshot comparison, trace or video, and the
 * caller must be inside an acceptance flow whose data is fictional. The page returns to its prior viewport and theme.
 */
export async function captureProspectsScreenshots(page: Page, name: string): Promise<void> {
  const directory = process.env['FSS_PROSPECTS_SCREENSHOTS'];
  if (!directory) return;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const original = page.viewportSize();
  const theme = () => page.locator('.browser-workspace').first().getAttribute('data-theme');
  const initial = await theme();
  const setTheme = async (target: 'light' | 'dark'): Promise<void> => {
    if ((await theme()) === target) return;
    await page.getByRole('button', { name: target === 'dark' ? 'Night mode' : 'Day mode', exact: true }).click();
  };
  try {
    for (const mode of ['light', 'dark'] as const) {
      await setTheme(mode);
      for (const [label, width, height] of VIEWPORTS) {
        await page.setViewportSize({ width, height });
        await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); scrollTo(0, 0); });
        const path = join(directory, `prospects-${name}-${label}-${mode}.png`);
        await page.screenshot({ path });
        await chmod(path, 0o600);
      }
    }
  } finally {
    if (initial === 'light' || initial === 'dark') await setTheme(initial);
    if (original) await page.setViewportSize(original);
  }
}

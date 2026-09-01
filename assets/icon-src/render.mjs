import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({
  viewport: { width: 1024, height: 1024 },
  deviceScaleFactor: 1,
});
await page.goto(`file://${join(here, 'icon.html')}`);
await page.waitForTimeout(300);
await page.screenshot({
  path: join(here, 'icon-1024.png'),
  omitBackground: true,
});
await browser.close();
console.log('rendered icon-1024.png');

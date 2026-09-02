// Founder-polish visual review: CDP screenshots of the packaged app in both
// themes for the routes touched by the shell/settings polish pass.
// Usage: node scripts/polishScreenshots.mjs <outputDir>
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { chromium } from 'playwright/test';

const binary = join(
  process.cwd(),
  'out',
  'Callie Founder Sales System-darwin-arm64',
  'Callie Founder Sales System.app',
  'Contents',
  'MacOS',
  'Callie Founder Sales System',
);

const outDir = process.argv[2] ?? 'polish-screens';
await mkdir(outDir, { recursive: true });

const port = await new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    server.close(() => resolve(address.port));
  });
});

const userDataPath = await mkdtemp(join(tmpdir(), 'callie-polish-screens-'));
const app = spawn(binary, [
  `--user-data-dir=${userDataPath}`,
  `--remote-debugging-port=${port}`,
  '--use-mock-keychain',
]);

let browser;
for (let attempt = 0; attempt < 120 && browser === undefined; attempt += 1) {
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
if (browser === undefined) throw new Error('no CDP connection');

let page;
for (let attempt = 0; attempt < 200 && page === undefined; attempt += 1) {
  page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => candidate.url().startsWith('callie://'));
  if (page === undefined) await new Promise((resolve) => setTimeout(resolve, 100));
}
if (page === undefined) throw new Error('no renderer page');

await page.getByRole('navigation', { name: 'Primary' }).waitFor();

const routes = [
  ['Conversations', 'conversations'],
  ['Learnings', 'learnings'],
  ['Review', 'review'],
  ['Friday', 'friday'],
  ['Settings', 'settings'],
];

for (const theme of ['light', 'dark']) {
  await page.evaluate((value) => {
    localStorage.setItem('callie.theme', value);
    document.documentElement.dataset.theme = value;
  }, theme);
  await page.waitForTimeout(250);

  // Top-left corner: wordmark vs traffic lights.
  await page.screenshot({
    path: join(outDir, `top-left-${theme}.png`),
    clip: { x: 0, y: 0, width: 320, height: 120 },
  });

  for (const [link, slug] of routes) {
    await page.getByRole('link', { name: link }).click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(outDir, `${slug}-${theme}.png`) });
  }
}

await browser.close();
app.kill('SIGTERM');
await new Promise((resolve) => setTimeout(resolve, 1000));
app.kill('SIGKILL');
await rm(userDataPath, { recursive: true, force: true });
console.log(`screenshots written to ${outDir}`);

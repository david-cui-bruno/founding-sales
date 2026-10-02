import { mkdir } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { expect, test } from 'playwright/test';
import { compileStylesheet } from '../../scripts/styles.ts';

/**
 * The Today call panel in each phase of a call (slice S2), as the real component draws it
 * with the phases `useCall` reports: ringing and connected with the announcement to read
 * aloud, the voicemail script, and after the call the steps that refresh in place and
 * Next firm. A component harness, because a live call needs Twilio's SDK and a microphone.
 * With `FSS_SCREENS_DIR` set, each phase is also written there.
 */

const SCREENS = process.env['FSS_SCREENS_DIR'];
let server: Server;
let base = '';

test.beforeAll(async () => {
  const harness = fileURLToPath(new URL('./support/callPanelHarness.tsx', import.meta.url));
  const bundle = await build({
    entryPoints: [harness],
    bundle: true,
    format: 'esm',
    write: false,
    platform: 'browser',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const script = bundle.outputFiles[0]?.text ?? '';
  const styles = await compileStylesheet(fileURLToPath(new URL('../../src/renderer/tailwind.css', import.meta.url)));
  const html = '<!doctype html><html><head><link rel="stylesheet" href="/styles.css"></head><body><div id="app"></div><script type="module" src="/harness.js"></script></body></html>';
  server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const [type, body] = path === '/harness.js' ? ['text/javascript', script] : path === '/styles.css' ? ['text/css', styles] : ['text/html', html];
    response.writeHead(200, { 'content-type': `${type}; charset=utf-8` });
    response.end(body);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/`;
});

test.afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

const shots = [
  { name: 'call-ringing', query: 'phase=ringing', check: 'Ringing…' },
  { name: 'call-connected', query: 'phase=connected&voicemail=1', check: 'Connected · recording' },
  { name: 'call-ended-pending', query: 'phase=ended&steps=pending', check: 'Call ended' },
  { name: 'call-ended-done', query: 'phase=ended&steps=done', check: 'Call ended' },
  { name: 'call-ended-transcript-missing', query: 'phase=ended&steps=failed', check: 'Call ended' },
] as const;

for (const shot of shots) {
  test(`the call panel: ${shot.name}`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 760 });
    await page.goto(`${base}?${shot.query}`);
    await expect(page.locator('[data-region="call"]')).toContainText(shot.check);
    if (shot.name === 'call-connected') {
      await expect(page.getByTestId('call-announcement')).toContainText('This call is being recorded');
      await expect(page.getByTestId('call-voicemail')).toBeVisible();
      await expect(page.getByTestId('call-hang-up')).toHaveText('Hang up');
    }
    if (shot.name === 'call-ended-pending') {
      await expect(page.getByTestId('step-transcription')).toHaveAttribute('data-state', 'pending');
      await expect(page.getByTestId('call-next')).toBeEnabled();
    }
    if (shot.name === 'call-ended-transcript-missing') {
      await expect(page.getByTestId('step-transcription')).toHaveAttribute('data-state', 'failed');
      await expect(page.getByTestId('post-call-sentence')).toContainText('No transcript came back');
    }
    if (SCREENS !== undefined) {
      await mkdir(SCREENS, { recursive: true });
      await page.screenshot({ path: `${SCREENS}/${shot.name}.png` });
    }
  });
}

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright';
import { startPrototypeServer } from './prototype.ts';

/**
 * Screenshots of the Slice 1 design prototype at laptop and monitor sizes, plus a contact
 * sheet. Development only; it starts the prototype server on a free loopback port.
 *
 *   node --experimental-strip-types scripts/prototypeScreens.ts <output directory> [only]
 */

const SIZES = [
  { name: '1280', width: 1280, height: 800 },
  { name: '1440', width: 1440, height: 900 },
  { name: '2560', width: 2560, height: 1440 },
] as const;

interface Shot {
  readonly name: string;
  readonly title: string;
  readonly query: string;
  /** Something to do on the page before the picture. */
  readonly act?: (page: Page) => Promise<void>;
  /** Only at these sizes (default: all). */
  readonly sizes?: readonly string[];
}

const SHOTS: readonly Shot[] = [
  { name: 'today-idle', title: 'Today · callback selected, ready to call', query: '' },
  { name: 'today-connected', title: 'Today · call connected, announcement to read', query: 'call=connected' },
  { name: 'today-dialling', title: 'Today · dialling', query: 'call=dialling', sizes: ['1440'] },
  { name: 'today-analysis-pending', title: 'Today · call ended, analysis pending', query: 'call=ended&analysis=pending' },
  { name: 'today-analysis-done', title: 'Today · analysis done: summary, saved steps, needs review', query: 'call=ended&analysis=done' },
  { name: 'today-transcription-failed', title: 'Today · transcription failed', query: 'call=ended&analysis=failed' },
  { name: 'today-research-open', title: 'Today · deeper research expanded in place', query: 'research=1' },
  { name: 'today-long-name', title: 'Today · very long firm name', query: 'firm=brazos-valley' },
  { name: 'today-missing-phone', title: 'Today · missing phone (not eligible, explained)', query: 'firm=bluebonnet' },
  { name: 'today-missing-location', title: 'Today · missing location and time zone, editing', query: 'firm=elm-fork&edit=location' },
  { name: 'today-loading', title: 'Today · loading', query: 'queue=loading' },
  { name: 'today-error', title: 'Today · queue failed to load', query: 'queue=error' },
  { name: 'today-empty', title: 'Today · empty queue', query: 'queue=empty' },
  { name: 'today-log-incoming', title: 'Today · log incoming call', query: 'dialog=log', sizes: ['1440'] },
  { name: 'today-shortcuts', title: 'Keyboard shortcuts', query: 'dialog=help', sizes: ['1440'] },
  { name: 'today-search', title: 'Search', query: 'dialog=search', act: async page => page.keyboard.type('tr'), sizes: ['1440'] },
  {
    name: 'today-focus',
    title: 'Keyboard focus ring (Tab)',
    query: '',
    act: async page => {
      for (let i = 0; i < 4; i += 1) await page.keyboard.press('Tab');
    },
    sizes: ['1440'],
  },
  { name: 'pipeline', title: 'Pipeline · Kanban, existing stages', query: 'view=pipeline' },
  { name: 'pipeline-lost', title: 'Pipeline · Lost shown by the filter', query: 'view=pipeline&lost=1', sizes: ['1440'] },
  { name: 'pipeline-panel', title: 'Pipeline · firm context panel, board kept', query: 'view=pipeline&panel=cedar-hollow' },
  { name: 'firm', title: 'Firm detail', query: 'view=firm' },
  { name: 'firm-edit', title: 'Firm detail · inline edit of a property', query: 'view=firm&edit=phone', sizes: ['1440'] },
  { name: 'firm-long-missing', title: 'Firm detail · long name', query: 'view=firm&firm=brazos-valley', sizes: ['1440'] },
];

const out = resolve(process.argv[2] ?? 'prototype-screens');
const only = process.argv[3];
await mkdir(out, { recursive: true });
const server = await startPrototypeServer();
const browser = await chromium.launch();
const written: { readonly file: string; readonly title: string; readonly size: string }[] = [];
try {
  for (const size of SIZES) {
    const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(String(error)));
    page.on('console', message => {
      if (message.type() === 'error') errors.push(message.text());
    });
    for (const shot of SHOTS) {
      if (only !== undefined && !shot.name.includes(only)) continue;
      if (shot.sizes !== undefined && !shot.sizes.includes(size.name)) continue;
      await page.goto(`${server.url}?clean=1${shot.query === '' ? '' : `&${shot.query}`}`);
      await page.waitForSelector('.callie-v2');
      if (shot.act !== undefined) await shot.act(page);
      // Let the spinners and the pulse settle into a frame; the timer is real time.
      await page.waitForTimeout(250);
      const file = `${shot.name}--${size.name}.png`;
      await page.screenshot({ path: join(out, file) });
      written.push({ file, title: shot.title, size: `${String(size.width)}×${String(size.height)}` });
    }
    if (errors.length > 0) throw new Error(`page errors at ${size.name}:\n${errors.join('\n')}`);
    await context.close();
  }
} finally {
  await browser.close();
  await server.stop();
}

const groups = new Map<string, typeof written>();
for (const item of written) {
  const key = item.title;
  groups.set(key, [...(groups.get(key) ?? []), item]);
}
const sections = [...groups.entries()]
  .map(
    ([title, items]) => `<section><h2>${title}</h2><div class="row">${items
      .map(item => `<figure><a href="${item.file}"><img src="${item.file}" loading="lazy" alt="${title}, ${item.size}"></a><figcaption>${item.size} · ${item.file}</figcaption></figure>`)
      .join('')}</div></section>`,
  )
  .join('\n');
await writeFile(
  join(out, 'index.html'),
  `<!doctype html><meta charset="utf-8"><title>Callie v2 prototype — screens</title>
<style>body{font:13px -apple-system,system-ui,sans-serif;margin:32px;color:#2b2a27;background:#fafaf9}h1{font-size:20px}h2{font-size:14px;margin:28px 0 8px}
.row{display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap}figure{margin:0}img{display:block;height:260px;border:1px solid #e5e4e1;border-radius:6px;background:#fff}figcaption{color:#888;margin-top:4px;font-size:11px}</style>
<h1>Callie v2 design prototype — ${String(written.length)} screens</h1><p>Slice 1, static fixtures. Click a screen for full size.</p>
${sections}\n`,
);
console.error(`${String(written.length)} screenshots in ${out}`);

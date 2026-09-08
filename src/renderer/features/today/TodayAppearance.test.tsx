import { readFileSync } from 'node:fs';

import { chromium, type Browser } from 'playwright';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, expect, it } from 'vitest';

import type { TodayItem, TodaySnapshot } from '../../../shared/contracts/todayContract';
import { TodayPage } from './TodayPage';
import { TodayRoute, type TodayRouteApi } from './TodayRoute';

// Browser-only presentation fixtures. No app, providers, or transport is launched.
const css = ['design/tokens.css', 'design/themes.css', 'design/base.css',
  'design/motion.css', 'features/today/today.css'].map(path =>
  readFileSync(`src/renderer/${path}`, 'utf8')).join('\n');
const items: TodayItem[] = [1, 2].map((index): TodayItem => ({
  id: `cycle-${index}`, salesCycleId: `cycle-${index}`, personId: `person-${index}`,
  personName: `Person ${index}`, lane: 'p1', contextLabel: null, stage: 'ready',
  priorityContext: null, action: { id: `action-${index}`, type: 'call_lead', channel: 'call', label: 'Call lead' },
  reason: 'cadence_step_next', activeTriggers: [], verifyFirst: false, pinned: false,
  consentRequirement: null, cloudScores: null,
}));
const snapshot: TodaySnapshot = {
  lanes: [{ id: 'p1', items, overflowCount: 0 }], dialBudget: 40, scheduledDials: 2,
  conversationTarget: 5, conversationsHeld: 0, reviewErrorCount: 0,
  unreviewedBacklogCount: 0, unreviewedCloudSignalCount: 0, revision: 1,
};
const noOp = (): void => undefined;
const unavailable = async (): Promise<never> => { throw new Error('Presentation fixture must not request transport'); };
const api: TodayRouteApi = { get: unavailable, complete: unavailable, snooze: unavailable,
  pin: unavailable, logPastActivity: unavailable, getTriageQueue: unavailable, setReviewPosition: unavailable };
let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser?.close(); });

function contrast(a: string, b: string): number {
  const luminance = (color: string) => {
    const [r, g, blue] = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(value => {
      const c = value / 255;
      return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
    });
    return r * .2126 + g * .7152 + blue * .0722;
  };
  const [low, high] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (high + .05) / (low + .05);
}

it.each(['light', 'dark'])('keeps the actual Today weekday at small-text contrast in %s', async theme => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<html data-theme="${theme}"><head><style>${css}</style></head><body>${renderToStaticMarkup(
      <TodayRoute api={api} onOpenLead={noOp} />,
    )}</body></html>`);
    const weekday = page.locator('.today-header__date span');
    expect(await weekday.textContent()).toBe(new Date().toLocaleDateString(undefined, { weekday: 'short' }));
    const colors = await weekday.evaluate(element => ({
      text: getComputedStyle(element).color,
      background: getComputedStyle(element.parentElement!).backgroundColor,
    }));
    expect(contrast(colors.text, colors.background)).toBeGreaterThanOrEqual(4.5);
  } finally { await page.close(); }
});

it('changes actual Also today row geometry with the persisted density attribute', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.setContent(`<html data-theme="light" data-density="comfortable"><head><style>${css}</style></head><body>${renderToStaticMarkup(
      <TodayPage snapshot={snapshot} onOpenLead={noOp} onCall={noOp} onSnoozeUntil={noOp}
        onSkipToday={noOp} onLogPastActivity={noOp} onOpenInLeads={noOp} onStartTriage={noOp} />,
    )}</body></html>`);
    const row = page.locator('.today__also .today-row');
    const comfortable = (await row.boundingBox())!.height;
    await page.evaluate(() => { document.documentElement.dataset.density = 'compact'; });
    const compact = (await row.boundingBox())!.height;
    expect(compact).toBeLessThan(comfortable);
    expect(await row.getByRole('button', { name: 'Person 2', exact: true }).count()).toBe(1);
  } finally { await page.close(); }
});

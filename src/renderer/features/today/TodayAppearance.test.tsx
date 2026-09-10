import { PresentationRoot } from '../../app/PresentationRoot';
import { readFileSync } from 'node:fs';

import { chromium, type Browser } from 'playwright';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, expect, it } from 'vitest';

import type { TodayItem, TodaySnapshot } from '../../../shared/contracts/todayContract';
import { TodayPage } from './TodayPage';
import { TodayRoute, type TodayRouteApi } from './TodayRoute';
import { LeadFullPage } from '../leadInspector/LeadFullPage';
import { leadDetailSchema } from '../../../shared/contracts/leadDetailContract';

// Browser-only presentation fixtures. No app, providers, or transport is launched.
const css = ['design/tokens.css', 'design/themes.css', 'design/base.css',
  'design/motion.css', 'features/today/today.css', 'features/leadInspector/leadInspector.css'].map(path =>
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

it.each(['light', 'dark'])('keeps real queue selection and keyboard focus distinct in %s', async theme => {
  const page = await browser.newPage({ viewport: { width: 420, height: 800 } });
  try {
    await page.setContent(`<html data-theme="${theme}"><head><style>${css}</style></head><body>${renderToStaticMarkup(
      <TodayPage snapshot={snapshot} selectedPersonId="person-1" onOpenLead={noOp} onCall={noOp} onSnoozeUntil={noOp}
        onSkipToday={noOp} onLogPastActivity={noOp} onOpenInLeads={noOp} />,
    )}</body></html>`);
    const selected = page.locator('.today-row[aria-current="true"]');
    expect(await selected.count()).toBe(1);
    const style = await selected.evaluate(element => ({ background: getComputedStyle(element).backgroundColor, shadow: getComputedStyle(element).boxShadow }));
    expect(style.background).not.toBe('rgba(0, 0, 0, 0)'); expect(style.shadow).not.toBe('none');
    await page.keyboard.press('Tab');
    expect(await selected.evaluate(element => element === document.activeElement)).toBe(true);
    expect(await selected.evaluate(element => getComputedStyle(element).outlineStyle)).toBe('solid');
    expect(await page.evaluate(() => document.body.scrollWidth <= innerWidth)).toBe(true);
  } finally { await page.close(); }
});

const person = leadDetailSchema.parse({ personId: 'person', salesCycleId: 'cycle', personName: 'Avery Fictional Property Owner',
  phones: [{ id: 'phone', kind: 'phone', value: '+14015550100', label: null, valid: true, validationState: 'valid', contactSnapshot: 'a'.repeat(64),
    reachability: 'direct', sourceLabel: null, vendorRank: null, phoneKind: 'mobile', ownershipState: 'verified_person', evidenceObservedAt: null,
    compliance: { status: 'verified_clear', label: 'Verified clear', expiresAt: null, callRefusalReason: null, textRefusalReason: null } }],
  emails: [{ id: 'email', kind: 'email', value: 'avery-owner-with-long-address@example.com', label: null, valid: true, validationState: 'valid', contactSnapshot: 'b'.repeat(64),
    reachability: 'direct', sourceLabel: null, vendorRank: null, phoneKind: null, ownershipState: 'verified_person', evidenceObservedAt: null, compliance: null }],
  organizationLabel: 'Fictional Properties', propertySummaries: [], stage: 'ready', workflowStatus: 'active', sourceLabel: 'parcel', segment: 'cold',
  priorityContext: null, priorityReasons: [], cloudScores: null, cloudLinked: false, findContactEligibility: { eligible: false, refusalReason: null },
  nextAction: null, optedOut: false, cadence: null, outboundAttempts: [], activities: [], conversations: [], properties: [], history: [], revision: 1,
  portfolio: { role: 'owner', ownedCount: 1, managedCount: 0, linkedCount: 0, knownUnits: 4, locations: ['Providence, RI'],
    summary: '1 known owned property. 4 known units where recorded. Partial records, not a complete portfolio.', completeness: 'partial', facts: [] },
  contactReason: { text: 'Recorded owner of 12 Fictional Elm St.', evidenceIds: ['property'] } });
it.each(['light', 'dark'])('keeps portfolio and primary action readable at narrow width in %s', async theme => {
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  try {
    await page.setContent(`<html data-theme="${theme}"><head><style>${css}</style></head><body>${renderToStaticMarkup(
      <PresentationRoot><LeadFullPage onClose={noOp} state={{ status: 'ready', detail: person }} onRetry={noOp} onBeginOutbound={unavailable}
        onConfirmTransition={noOp} onDismissLead={noOp} onOverrideCloudScore={noOp} /></PresentationRoot>,
    )}</body></html>`);
    const call = page.getByRole('button', { name: 'Call', exact: true });
    expect(await call.isVisible()).toBe(true); expect(await page.getByRole('button', { name: 'Email', exact: true }).isVisible()).toBe(true);
    const callColors = await call.evaluate(element => ({ text: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor }));
    expect(contrast(callColors.text, callColors.background)).toBeGreaterThanOrEqual(4.5);
    const portfolioColors = await page.locator('.lead-inspector__portfolio').evaluate(element => ({ text: getComputedStyle(element).color, background: getComputedStyle(document.body).backgroundColor }));
    expect(contrast(portfolioColors.text, portfolioColors.background)).toBeGreaterThanOrEqual(4.5);
    expect(await page.evaluate(() => document.body.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.getByRole('button', { name: /Next|Prepare|Refresh|Mark ready/ }).count()).toBe(0);
  } finally { await page.close(); }
});

it('changes actual compact queue row geometry with the persisted density attribute', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.setContent(`<html data-theme="light" data-density="comfortable"><head><style>${css}</style></head><body>${renderToStaticMarkup(
      <TodayPage snapshot={snapshot} onOpenLead={noOp} onCall={noOp} onSnoozeUntil={noOp}
        onSkipToday={noOp} onLogPastActivity={noOp} onOpenInLeads={noOp} />,
    )}</body></html>`);
    const row = page.locator('.today-work-list .today-row').nth(1);
    const comfortable = (await row.boundingBox())!.height;
    await page.evaluate(() => { document.documentElement.dataset.density = 'compact'; });
    const compact = (await row.boundingBox())!.height;
    expect(compact).toBeLessThan(comfortable);
    expect(await row.getByRole('button', { name: 'Person 2', exact: true }).count()).toBe(1);
  } finally { await page.close(); }
});

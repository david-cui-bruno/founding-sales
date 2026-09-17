import { readFileSync } from 'node:fs';

import { chromium, type Browser } from 'playwright';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PresentationRoot } from '../app/PresentationRoot';
import { NavigationRail } from '../app/NavigationRail';
import { Button } from '../components/Button';
import { PageHeader } from '../components/PageHeader';
import { StatusBadge } from '../components/StatusBadge';

// A real browser resolves custom properties, color-mix and inherited fonts.
// This is a shared-components fixture, not an integrated route screenshot.
const css = ['design/tokens.css', 'design/themes.css', 'design/base.css',
  'design/motion.css', 'app/shell.css'].map((path) =>
  readFileSync(`src/renderer/${path}`, 'utf8')).join('\n');
const presentationCss = readFileSync('src/renderer/app.css', 'utf8').replace(/@import[^;]+;/g, '');
let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser?.close(); });

function contrast(a: string, b: string): number {
  const luminance = (color: string) => {
    const channels = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map((v) => {
      const c = v / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
  };
  const [low, high] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (high! + 0.05) / (low! + 0.05);
}

describe('Shared Native rendered design', () => {
  it.each(['light', 'dark'])('renders crisp geometry, legible semantics and native chrome in %s', async (theme) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await page.setContent(`<html data-theme="${theme}"><head><style>${css}\n${presentationCss}</style></head><body data-platform="darwin">${renderToStaticMarkup(
        <PresentationRoot><div className="app-shell">
          <NavigationRail route="accounts" onNavigate={() => undefined} />
          <main className="app-shell__workspace">
            <PageHeader title="Your workspace" count="3 companies" description="One line explains the route." primaryAction={<Button>Take action</Button>} />
            <p className="body-copy">Legible body and table typography</p>
            <Button variant="danger">Remove</Button>
            <div className="sunken" style={{ background: 'var(--surface-sunken)' }}>
              <span className="faint-copy" style={{ color: 'var(--text-faint)' }}>Secondary metadata</span>
              <StatusBadge tone="success" label="Completed" />
              <StatusBadge tone="danger" label="Needs attention" />
            </div>
          </main>
        </div></PresentationRoot>,
      )}</body></html>`);
      const styles = await page.evaluate(() => {
        const style = (selector: string) => getComputedStyle(document.querySelector(selector)!);
        const root = getComputedStyle(document.querySelector('.presentation-root')!);
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d')!;
        // Canvas resolves hex, color-mix and rgba() into one opaque rgb() sample.
        const rgb = (value: string, background?: string): string => {
          context.clearRect(0, 0, 1, 1);
          if (background) { context.fillStyle = background; context.fillRect(0, 0, 1, 1); }
          context.fillStyle = value;
          context.fillRect(0, 0, 1, 1);
          return `rgb(${Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3).join(', ')})`;
        };
        const surface = rgb(root.getPropertyValue('--canvas').trim());
        const primary = style('.button--primary');
        const title = style('.page-header__title');
        const current = style('.nav-rail__item--current');
        const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
        return {
          canvas: root.getPropertyValue('--canvas').trim(),
          blue: root.getPropertyValue('--bauhaus-blue').trim(),
          red: root.getPropertyValue('--bauhaus-red').trim(),
          yellow: root.getPropertyValue('--bauhaus-yellow').trim(),
          font: title.fontFamily, bodyFont: style('.body-copy').fontFamily,
          radius: primary.borderRadius,
          surface, titleText: rgb(title.color),
          muted: rgb(style('.page-header__count').color), description: rgb(style('.page-header__description').color),
          body: rgb(style('.body-copy').color),
          danger: rgb(style('.button--danger').color, rgb(style('.button--danger').backgroundColor, surface)),
          dangerSurface: rgb(style('.button--danger').backgroundColor, surface),
          actionBackground: primary.backgroundColor, actionText: primary.color,
          selectedBackground: rgb(current.backgroundColor, rgb(style('.nav-rail').backgroundColor, surface)),
          selectedText: rgb(current.color),
          sunken: rgb(style('.sunken').backgroundColor, surface),
          faint: rgb(style('.faint-copy').color),
          statuses: ['.status-badge--success', '.status-badge--danger'].map((selector) => ({
            color: rgb(style(selector).color), dot: rgb(style(`${selector} .status-badge__dot`).backgroundColor),
          })),
          nativeBottom: box('.nav-rail__native-controls').bottom,
          brandTop: box('.nav-rail__brand-native').top,
        };
      });
      expect(contrast(styles.faint, styles.sunken)).toBeGreaterThanOrEqual(4.5);
      for (const status of styles.statuses) {
        expect(contrast(status.color, styles.sunken)).toBeGreaterThanOrEqual(4.5);
      }
      // The dot carries the tone; the label stays neutral for both statuses.
      expect(styles.statuses[0]!.dot).not.toBe(styles.statuses[1]!.dot);
      expect(styles.statuses[0]!.color).toBe(styles.statuses[1]!.color);
      expect(styles.font).toContain('-apple-system');
      expect(styles.bodyFont).toContain('-apple-system');
      expect(styles.radius).toBe('2px');
      expect(styles.blue).not.toBe('');
      expect(styles.red).not.toBe('');
      expect(styles.yellow).not.toBe('');
      expect(styles.brandTop).toBeGreaterThanOrEqual(styles.nativeBottom);
      expect(contrast(styles.titleText, styles.surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(styles.body, styles.surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(styles.muted, styles.surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(styles.description, styles.surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(styles.danger, styles.dangerSurface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(styles.actionText, styles.actionBackground)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(styles.selectedText, styles.selectedBackground)).toBeGreaterThanOrEqual(4.5);
      if (theme === 'light') {
        expect(styles.canvas).toBe('#e9edf2');
        expect(styles.actionBackground).toBe('rgb(49, 87, 186)');
      } else {
        expect(styles.surface).not.toBe('rgb(233, 237, 242)');
      }
    } finally {
      await page.close();
    }
  });

  it.each(['light', 'dark'])('keeps nav labels readable during rapid route swaps with motion enabled in %s', async (theme) => {
    const page = await browser.newPage({ reducedMotion: 'no-preference' });
    try {
      await page.setContent(`<html data-theme="${theme}"><head><style>${css}\n${presentationCss}</style></head><body>${renderToStaticMarkup(
        <PresentationRoot><NavigationRail route="today" onNavigate={() => undefined} /></PresentationRoot>,
      )}</body></html>`);
      const result = await page.evaluate(() => {
        const rail = document.querySelector('.nav-rail')!;
        const links = Array.from(rail.querySelectorAll<HTMLAnchorElement>('a'));
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d')!;
        // Canvas resolves interpolated color()/rgba() syntax and composites
        // transparent link backgrounds over the actual opaque rail surface.
        const rgb = (value: string, background?: string): string => {
          context.clearRect(0, 0, 1, 1);
          if (background) {
            context.fillStyle = background;
            context.fillRect(0, 0, 1, 1);
          }
          context.fillStyle = value;
          context.fillRect(0, 0, 1, 1);
          return `rgb(${Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3).join(', ')})`;
        };
        const samples: { route: string; time: number; color: string; background: string }[] = [];
        let previous = links[0]!;
        getComputedStyle(previous).getPropertyValue('color');
        for (const route of ['accounts', 'campaigns', 'today', 'settings']) {
          const next = links.find((link) => link.hash === `#/${route}`)!;
          previous.classList.remove('nav-rail__item--current');
          next.classList.add('nav-rail__item--current');
          getComputedStyle(previous).getPropertyValue('color');
          getComputedStyle(next).getPropertyValue('color');
          const transitions = [previous, next].flatMap((link) => link.getAnimations());
          transitions.forEach((animation) => animation.pause());
          // Seek actual CSS animations, not wall-clock sleeps. With discrete
          // colors there are no transitions, so every sample sees safe endpoints.
          for (const time of [0, 10, 20, 30, 45, 60, 90, 150]) {
            transitions.forEach((animation) => { animation.currentTime = time; });
            for (const link of [previous, next]) {
              const style = getComputedStyle(link);
              samples.push({
                route: link.hash, time,
                color: rgb(style.color),
                background: rgb(style.backgroundColor, getComputedStyle(rail).backgroundColor),
              });
            }
          }
          // Change routes again while any original transition is mid-flight.
          transitions.forEach((animation) => { animation.currentTime = 20; });
          previous = next;
        }
        return { reduced: matchMedia('(prefers-reduced-motion: reduce)').matches, samples };
      });
      expect(result.reduced).toBe(false);
      expect(result.samples).toHaveLength(64);
      for (const sample of result.samples) {
        expect(contrast(sample.color, sample.background), `${theme} ${sample.route} at ${sample.time}ms`)
          .toBeGreaterThanOrEqual(4.5);
      }
    } finally {
      await page.close();
    }
  });
});

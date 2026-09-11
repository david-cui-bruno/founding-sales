import { readFileSync } from 'node:fs';

import { chromium, type Browser } from 'playwright';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { NavigationRail } from '../app/NavigationRail';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { LoadingState } from '../components/LoadingState';
import { Panel } from '../components/Panel';
import { StatusPill } from '../components/StatusPill';

// A real browser resolves custom properties, color-mix and inherited fonts.
// This is a shared-components fixture, not an integrated route screenshot.
const css = ['design/tokens.css', 'design/themes.css', 'design/base.css',
  'design/motion.css', 'app/shell.css'].map((path) =>
  readFileSync(`src/renderer/${path}`, 'utf8')).join('\n');
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

describe('Bauhaus shared rendered design', () => {
  it.each(['light', 'dark'])('renders crisp geometry, legible semantics and native chrome in %s', async (theme) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await page.setContent(`<html data-theme="${theme}"><head><style>${css}</style></head><body data-platform="darwin">${renderToStaticMarkup(
        <div className="app-shell">
          <NavigationRail route="inbox" onNavigate={() => undefined} reviewCount={3} />
          <main className="app-shell__workspace"><Panel title="Your workspace">
            <p className="body-copy">Legible body and table typography</p>
            <Button>Take action</Button><Button variant="danger">Remove</Button>
            <EmptyState title="Nothing queued" description="You are up to date." />
            <ErrorState title="Could not load" description="Try again shortly." />
            <LoadingState label="Loading workspace" />
            <div className="sunken" style={{ background: 'var(--surface-sunken)' }}>
              <span className="faint-copy" style={{ color: 'var(--text-faint)' }}>Secondary metadata</span>
              <StatusPill tone="positive">Completed</StatusPill>
              <StatusPill tone="danger">Needs attention</StatusPill>
            </div>
          </Panel></main>
        </div>,
      )}</body></html>`);
      const styles = await page.evaluate(() => {
        const style = (selector: string) => getComputedStyle(document.querySelector(selector)!);
        const root = getComputedStyle(document.documentElement);
        const primary = style('.button--primary');
        const title = style('.panel__title');
        const panel = style('.panel');
        const muted = style('.empty-state__description');
        const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
        return {
          canvas: root.getPropertyValue('--canvas').trim(),
          blue: root.getPropertyValue('--bauhaus-blue').trim(),
          red: root.getPropertyValue('--bauhaus-red').trim(),
          yellow: root.getPropertyValue('--bauhaus-yellow').trim(),
          font: title.fontFamily, bodyFont: style('.body-copy').fontFamily,
          radius: primary.borderRadius, panelRadius: panel.borderRadius,
          panelBackground: panel.backgroundColor, panelText: panel.color,
          muted: muted.color, danger: style('.button--danger').color,
          actionBackground: primary.backgroundColor, actionText: primary.color,
          selectedBackground: style('.nav-rail__item--current').backgroundColor,
          badgeText: style('.nav-rail__badge').color,
          sunken: style('.sunken').backgroundColor,
          faint: style('.faint-copy').color,
          statuses: ['.status-pill--positive', '.status-pill--danger'].map((selector) => ({
            color: style(selector).color, background: style(selector).backgroundColor,
          })),
          nativeBottom: box('.nav-rail__native-controls').bottom,
          brandTop: box('.nav-rail__brand').top,
        };
      });
      expect(contrast(styles.faint, styles.sunken)).toBeGreaterThanOrEqual(4.5);
      for (const status of styles.statuses) {
        const foreground = status.background.match(/[\d.]+/g)!.map(Number);
        const background = styles.sunken.match(/[\d.]+/g)!.map(Number);
        const alpha = foreground[3] ?? 1;
        const composite = foreground.slice(0, 3).map((channel, i) =>
          channel * alpha + background[i]! * (1 - alpha));
        expect(contrast(status.color, `rgb(${composite.join(', ')})`)).toBeGreaterThanOrEqual(4.5);
      }
      expect(styles.font).toContain('Futura');
      expect(styles.bodyFont).toContain('InterVariable');
      expect(styles.radius).toBe('2px');
      expect(styles.panelRadius).toBe('3px');
      expect(styles.blue).not.toBe('');
      expect(styles.red).not.toBe('');
      expect(styles.yellow).not.toBe('');
      expect(styles.brandTop).toBeGreaterThanOrEqual(styles.nativeBottom);
      expect(contrast(styles.panelText, styles.panelBackground)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(styles.muted, styles.panelBackground)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(styles.danger, styles.panelBackground)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(styles.actionText, styles.actionBackground)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(styles.badgeText, styles.selectedBackground)).toBeGreaterThanOrEqual(4.5);
      if (theme === 'light') {
        expect(styles.canvas).toBe('#f6f0df');
        expect(styles.panelBackground).toBe('rgb(255, 250, 240)');
        expect(styles.actionBackground).toBe('rgb(23, 72, 182)');
      } else {
        expect(styles.panelBackground).not.toBe('rgb(255, 250, 240)');
      }
    } finally {
      await page.close();
    }
  });

  it.each(['light', 'dark'])('keeps nav labels readable during rapid route swaps with motion enabled in %s', async (theme) => {
    const page = await browser.newPage({ reducedMotion: 'no-preference' });
    try {
      await page.setContent(`<html data-theme="${theme}"><head><style>${css}</style></head><body>${renderToStaticMarkup(
        <NavigationRail route="today" onNavigate={() => undefined} reviewCount={3} />,
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
        for (const route of ['leads', 'conversations', 'today', 'inbox']) {
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

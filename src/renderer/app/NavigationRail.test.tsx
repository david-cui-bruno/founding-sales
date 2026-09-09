// @vitest-environment jsdom

import { readFileSync } from 'node:fs';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NavigationRail } from './NavigationRail';
import type { AppRoute } from './routes';

const shellCss = readFileSync('src/renderer/app/shell.css', 'utf8');
let stylesheet: HTMLStyleElement;

beforeEach(() => {
  stylesheet = document.createElement('style');
  stylesheet.textContent = shellCss;
  document.head.append(stylesheet);
});

afterEach(() => {
  cleanup();
  stylesheet.remove();
  delete document.body.dataset.platform;
});

// jsdom checks display and parses sizing, but cannot prove native geometry.
function cssRule(selector: string): CSSStyleDeclaration {
  const rules = Array.from(stylesheet.sheet!.cssRules).filter(
    (rule): rule is CSSStyleRule =>
      rule instanceof CSSStyleRule && rule.selectorText === selector,
  );
  expect(rules, selector).toHaveLength(1);
  return rules[0]!.style;
}

// jsdom discards Electron's app-region property, so check its source declaration.
function dragRegion(selector: string): string | undefined {
  const rules = shellCss.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g);
  const rule = Array.from(rules).find(([, candidate]) => candidate.trim() === selector);
  return rule?.[2].match(/-webkit-app-region:\s*([^;]+);/)?.[1];
}

function RailHarness() {
  const [route, setRoute] = useState<AppRoute>('today');
  return <NavigationRail route={route} onNavigate={setRoute} reviewCount={3} />;
}

describe('NavigationRail window chrome', () => {
  it.each([
    ['darwin', 'block'],
    ['win32', 'none'],
    ['linux', 'none'],
    [undefined, 'none'],
  ])('reserves a separate native row only on %s', (platform, display) => {
    if (platform) document.body.dataset.platform = platform;
    render(<RailHarness />);

    const rail = screen.getByRole('navigation', { name: 'Primary' });
    const nativeRow = rail.querySelector<HTMLElement>('.nav-rail__native-controls');
    const header = rail.querySelector<HTMLElement>('.nav-rail__header');
    const brands = rail.querySelectorAll('.nav-rail__brand');
    expect(nativeRow).not.toBeNull();
    expect(rail.firstElementChild).toBe(nativeRow);
    expect(nativeRow!.nextElementSibling).toBe(header);
    expect(nativeRow!.getAttribute('aria-hidden')).toBe('true');
    expect(nativeRow!.childNodes).toHaveLength(0);
    expect(nativeRow!.tabIndex).toBe(-1);
    expect(getComputedStyle(nativeRow!).display).toBe(display);
    expect(brands).toHaveLength(1);
    expect(brands[0]!.textContent).toBe('FSS');
    expect(brands[0]!.parentElement).toBe(header);
    expect(brands[0]!.getAttribute('aria-hidden')).toBe('true');
    expect(header!.nextElementSibling?.className).toBe('nav-rail__list');
  });

  it('keeps the Darwin native row nonshrinking and draggable above a left-aligned brand', () => {
    const nativeRow = cssRule('body[data-platform="darwin"] .nav-rail__native-controls');
    expect(nativeRow.getPropertyValue('display')).toBe('block');
    expect(nativeRow.getPropertyValue('flex-grow')).toBe('0');
    expect(nativeRow.getPropertyValue('flex-shrink')).toBe('0');
    expect(nativeRow.getPropertyValue('flex-basis')).toBe('auto');
    expect(nativeRow.getPropertyValue('height')).toBe('var(--chrome-header-height)');
    expect(dragRegion('body[data-platform="darwin"] .nav-rail__native-controls')).toBe('drag');
    expect(
      cssRule('body[data-platform="darwin"] .nav-rail__header').getPropertyValue('padding-left'),
    ).toBe('var(--space-4)');
  });

  it('preserves shared header sizing, drag and interactive no-drag rules', () => {
    const header = cssRule('.nav-rail__header');
    expect(header.getPropertyValue('display')).toBe('flex');
    expect(header.getPropertyValue('flex-grow')).toBe('0');
    expect(header.getPropertyValue('flex-shrink')).toBe('0');
    expect(header.getPropertyValue('flex-basis')).toBe('auto');
    expect(header.getPropertyValue('height')).toBe('var(--chrome-header-height)');
    expect(header.getPropertyValue('margin')).toBe('0 calc(-1 * var(--space-2)) var(--space-2)');
    expect(header.getPropertyValue('padding')).toBe('0 var(--space-4)');
    expect(dragRegion('.nav-rail__header')).toBe('drag');
    expect(dragRegion('.nav-rail__header :is(a, button)')).toBe('no-drag');
  });

  it('retains the fixed-width column, compact links and flexible Settings spacer', () => {
    const rail = cssRule('.nav-rail');
    expect(rail.getPropertyValue('position')).toBe('fixed');
    expect(rail.getPropertyValue('display')).toBe('flex');
    expect(rail.getPropertyValue('flex-direction')).toBe('column');
    expect(rail.getPropertyValue('width')).toBe('var(--nav-rail-width)');
    expect(cssRule('.nav-rail__item').getPropertyValue('height')).toBe('32px');
    expect(cssRule('.nav-rail__spacer').getPropertyValue('flex-grow')).toBe('1');
  });

  it.each(['darwin', 'win32', 'linux', undefined])(
    'preserves link order, focusability and in-window navigation on %s',
    (platform) => {
      if (platform) document.body.dataset.platform = platform;
      render(<RailHarness />);
      const rail = screen.getByRole('navigation', { name: 'Primary' });
      const links = screen.getAllByRole<HTMLAnchorElement>('link');
      expect(links.map((link) => link.getAttribute('href'))).toEqual([
        '#/today', '#/accounts', '#/campaigns', '#/leads', '#/pipeline', '#/conversations',
        '#/learnings', '#/friday', '#/inbox', '#/settings',
      ]);
      const more = rail.querySelector<HTMLButtonElement>('.nav-rail__more-toggle')!;
      expect(more).not.toBeNull();
      expect(more.getAttribute('aria-label')).toBe('More workspaces');
      expect(more.getAttribute('aria-expanded')).toBe('false');
      expect(getComputedStyle(more).display).toBe('none');
      // The approved native-only disclosure is in the DOM but cannot join legacy tab order.
      expect(Array.from(rail.querySelectorAll('a, button, input, select, textarea, [tabindex]'))).toEqual([
        ...links.slice(0, 3), more, ...links.slice(3),
      ]);
      for (const link of links) {
        expect(link.tabIndex).toBe(0);
        expect(link.getAttribute('target')).toBeNull();
        link.focus();
        expect(document.activeElement).toBe(link);
      }
      const leads = screen.getByRole('link', { name: 'Leads' });
      expect(fireEvent.click(leads)).toBe(false);
      expect(leads.getAttribute('aria-current')).toBe('page');
      expect(screen.getByRole('link', { name: 'Today' }).getAttribute('aria-current')).toBeNull();
      expect(screen.getByLabelText('3 items awaiting review').textContent).toBe('3');
    },
  );
});

it('opts into Native Desk branding only while a stored meeting-first surface is present', () => {
  const nativeStyle = document.createElement('style');
  nativeStyle.textContent = readFileSync('src/renderer/features/today/nativeDesk.css', 'utf8');
  document.head.append(nativeStyle);
  try {
    const { rerender, container } = render(<div className="app-shell"><RailHarness /></div>);
    const brand = container.querySelector<HTMLElement>('.nav-rail__brand-native')!;
    expect(getComputedStyle(brand).display).toBe('none');
    rerender(<div className="app-shell"><RailHarness /><section className="native-desk" data-presentation="native-a" data-workflow-mode="meeting_first" /></div>);
    expect(getComputedStyle(brand).display).toBe('inline');
    expect(getComputedStyle(container.querySelector('.nav-rail__brand')!).display).toBe('none');
    expect(brand.textContent).toBe('Callie');
    rerender(<div className="app-shell"><RailHarness /></div>);
    expect(getComputedStyle(brand).display).toBe('none');
    expect(getComputedStyle(container.querySelector('.nav-rail__brand')!).display).not.toBe('none');
  } finally { nativeStyle.remove(); }
});

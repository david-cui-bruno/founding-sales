// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppShell } from './AppShell';
import type { AppRoute } from './routes';
import { useHashRoute } from './useHashRoute';

beforeEach(() => {
  window.history.replaceState(null, '', window.location.pathname);
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.density;
});

afterEach(() => {
  cleanup();
});

describe('AppShell', () => {
  it('renders fixed navigation and marks Today current', () => {
    render(
      <AppShell route="today" onNavigate={vi.fn()} reviewCount={3}>
        <p>Queue</p>
      </AppShell>,
    );

    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Today' }).getAttribute('aria-current'),
    ).toBe('page');
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.queryByText(/custom stage/i)).toBeNull();
  });

  it('navigates without opening a new window', () => {
    const onNavigate = vi.fn();
    render(
      <AppShell route="today" onNavigate={onNavigate} reviewCount={0}>
        <p>Queue</p>
      </AppShell>,
    );

    const leads = screen.getByRole('link', { name: 'Leads' });
    expect(leads.getAttribute('target')).toBeNull();
    fireEvent.click(leads);

    expect(onNavigate).toHaveBeenCalledWith('leads');
  });

  it('renders children inside the labelled main content region', () => {
    render(
      <AppShell route="today" onNavigate={vi.fn()} reviewCount={0}>
        <p>Queue</p>
      </AppShell>,
    );

    const main = screen.getByRole('main');
    expect(main.getAttribute('id')).toBe('main-content');
    expect(main.textContent).toContain('Queue');
  });

  it('offers a skip link to the main content region', () => {
    render(
      <AppShell route="today" onNavigate={vi.fn()} reviewCount={0}>
        <p>Queue</p>
      </AppShell>,
    );

    expect(
      screen.getByRole('link', { name: 'Skip to content' }).getAttribute('href'),
    ).toBe('#main-content');
  });

  it('navigates to Conversations and Learnings now that they are live', () => {
    const onNavigate = vi.fn();
    render(
      <AppShell route="today" onNavigate={onNavigate} reviewCount={0}>
        <p>Queue</p>
      </AppShell>,
    );

    for (const name of ['Conversations', 'Learnings']) {
      const link = screen.getByRole('link', { name });
      expect(link.getAttribute('aria-disabled')).toBeNull();
      fireEvent.click(link);
    }

    expect(onNavigate).toHaveBeenCalledTimes(2);
    expect(onNavigate).toHaveBeenNthCalledWith(1, 'conversations');
    expect(onNavigate).toHaveBeenNthCalledWith(2, 'learnings');
  });

  it('omits the review badge when nothing awaits review', () => {
    render(
      <AppShell route="review" onNavigate={vi.fn()} reviewCount={0}>
        <p>Queue</p>
      </AppShell>,
    );

    const review = screen.getByRole('link', { name: 'Review' });
    expect(review.textContent).toBe('Review');
    expect(review.getAttribute('aria-current')).toBe('page');
  });
});

function RouteProbe({ initial = 'today' }: { initial?: AppRoute }) {
  const routing = useHashRoute(initial);

  return (
    <>
      <output data-testid="route">{routing.route}</output>
      <button type="button" onClick={() => routing.navigate('pipeline')}>
        Go to pipeline
      </button>
    </>
  );
}

describe('useHashRoute', () => {
  it('starts from the initial route when no hash is present', () => {
    render(<RouteProbe initial="leads" />);

    expect(screen.getByTestId('route').textContent).toBe('leads');
  });

  it('adopts a valid route hash on mount', () => {
    window.location.hash = '#/friday';
    render(<RouteProbe />);

    expect(screen.getByTestId('route').textContent).toBe('friday');
  });

  it('ignores unknown hashes instead of rendering a broken route', () => {
    window.location.hash = '#/not-a-route';
    render(<RouteProbe />);

    expect(screen.getByTestId('route').textContent).toBe('today');
  });

  it('navigates by updating the location hash', () => {
    render(<RouteProbe />);

    fireEvent.click(screen.getByRole('button', { name: 'Go to pipeline' }));

    expect(screen.getByTestId('route').textContent).toBe('pipeline');
    expect(window.location.hash).toBe('#/pipeline');
  });

  it('follows external hash changes', () => {
    render(<RouteProbe />);

    act(() => {
      window.location.hash = '#/review';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });

    expect(screen.getByTestId('route').textContent).toBe('review');
  });
});

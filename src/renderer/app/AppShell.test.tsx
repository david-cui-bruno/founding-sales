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
      <AppShell route="today" onNavigate={vi.fn()}>
        <p>Queue</p>
      </AppShell>,
    );

    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Today' }).getAttribute('aria-current'),
    ).toBe('page');
    expect(screen.queryByText(/custom stage/i)).toBeNull();
  });

  it('navigates without opening a new window', () => {
    const onNavigate = vi.fn();
    render(
      <AppShell route="today" onNavigate={onNavigate}>
        <p>Queue</p>
      </AppShell>,
    );

    const accounts = screen.getByRole('link', { name: 'Accounts' });
    expect(accounts.getAttribute('target')).toBeNull();
    fireEvent.click(accounts);

    expect(onNavigate).toHaveBeenCalledWith('accounts');
  });

  it('renders children inside the labelled main content region', () => {
    render(
      <AppShell route="today" onNavigate={vi.fn()}>
        <p>Queue</p>
      </AppShell>,
    );

    const main = screen.getByRole('main');
    expect(main.getAttribute('id')).toBe('main-content');
    expect(main.textContent).toContain('Queue');
  });

  it('offers a skip link to the main content region', () => {
    render(
      <AppShell route="today" onNavigate={vi.fn()}>
        <p>Queue</p>
      </AppShell>,
    );

    expect(
      screen.getByRole('link', { name: 'Skip to content' }).getAttribute('href'),
    ).toBe('#main-content');
  });

  it('offers exactly the company-model workspaces and Settings with no review badge or More disclosure', () => {
    const onNavigate = vi.fn();
    render(
      <AppShell route="settings" onNavigate={onNavigate}>
        <p>Preferences</p>
      </AppShell>,
    );

    expect(screen.getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual([
      '#main-content', '#/today', '#/accounts', '#/campaigns', '#/settings',
    ]);
    expect(screen.getByRole('link', { name: 'Settings' }).getAttribute('aria-current')).toBe('page');
    expect(screen.queryByRole('button', { name: 'More workspaces' })).toBeNull();
    for (const name of ['Leads', 'Pipeline', 'Conversations', 'Learnings', 'Friday', 'Inbox']) {
      expect(screen.queryByRole('link', { name })).toBeNull();
    }
    expect(screen.queryByLabelText(/open local reviews/)).toBeNull();
    for (const name of ['Today', 'Accounts', 'Campaigns']) {
      const link = screen.getByRole('link', { name });
      expect(link.getAttribute('aria-disabled')).toBeNull();
      fireEvent.click(link);
    }
    expect(onNavigate.mock.calls.map(([route]) => route)).toEqual(['today', 'accounts', 'campaigns']);
  });
});

function RouteProbe({ initial = 'today' }: { initial?: AppRoute }) {
  const routing = useHashRoute(initial);

  return (
    <>
      <output data-testid="route">{routing.route}</output>
      <button type="button" onClick={() => routing.navigate('accounts')}>
        Go to accounts
      </button>
    </>
  );
}

describe('useHashRoute', () => {
  it('starts from the initial route when no hash is present', () => {
    render(<RouteProbe initial="campaigns" />);

    expect(screen.getByTestId('route').textContent).toBe('campaigns');
  });

  it('adopts a valid route hash on mount', () => {
    window.location.hash = '#/settings';
    render(<RouteProbe />);

    expect(screen.getByTestId('route').textContent).toBe('settings');
  });

  it('ignores unknown hashes instead of rendering a broken route', () => {
    window.location.hash = '#/not-a-route';
    render(<RouteProbe />);

    expect(screen.getByTestId('route').textContent).toBe('today');
  });

  it('navigates by updating the location hash', () => {
    render(<RouteProbe />);

    fireEvent.click(screen.getByRole('button', { name: 'Go to accounts' }));

    expect(screen.getByTestId('route').textContent).toBe('accounts');
    expect(window.location.hash).toBe('#/accounts');
  });

  it('follows external hash changes', () => {
    render(<RouteProbe />);

    act(() => {
      window.location.hash = '#/campaigns';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });

    expect(screen.getByTestId('route').textContent).toBe('campaigns');
  });

  it('lands removed legacy hashes on Today instead of a blank route', () => {
    render(<RouteProbe initial="settings" />);
    expect(screen.getByTestId('route').textContent).toBe('settings');

    for (const legacy of ['leads', 'pipeline', 'conversations', 'learnings', 'friday', 'inbox', 'review']) {
      act(() => {
        window.location.hash = '#/settings';
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      });
      act(() => {
        window.location.hash = `#/${legacy}`;
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      });
      expect(screen.getByTestId('route').textContent, legacy).toBe('today');
    }
  });
});

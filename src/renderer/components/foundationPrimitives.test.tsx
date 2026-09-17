// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { PageHeader } from './PageHeader';
import { StatusBadge } from './StatusBadge';
import { Button } from './Button';

afterEach(() => {
  cleanup();
});

describe('StatusBadge', () => {
  it('renders the dot and a neutral label for each tone', () => {
    render(
      <>
        <StatusBadge tone="success" label="Encrypted SQLite ready" />
        <StatusBadge tone="warning" label="FTS5 degraded" />
        <StatusBadge tone="danger" label="Bridge unavailable" />
        <StatusBadge tone="neutral" label="Idle" />
      </>,
    );

    const success = screen.getByText('Encrypted SQLite ready');
    expect(success.className).toContain('status-badge--success');
    expect(success.querySelector('.status-badge__dot')).toBeTruthy();
    expect(
      success.querySelector('.status-badge__dot')?.getAttribute('aria-hidden'),
    ).toBe('true');
    expect(screen.getByText('Idle').className).toContain('status-badge--neutral');
  });
});

describe('PageHeader', () => {
  it('renders the title as the single page heading with a muted count', () => {
    render(<PageHeader title="Accounts" count="12 companies" />);

    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading.textContent).toBe('Accounts · 12 companies');
  });

  it('renders search, trailing, and primary action slots', () => {
    render(
      <PageHeader
        title="Accounts"
        primaryAction={<Button>Add company</Button>}
        trailing={<span>view switcher</span>}
      >
        <input type="search" aria-label="Search companies" />
      </PageHeader>,
    );

    expect(screen.getByRole('searchbox', { name: 'Search companies' })).toBeTruthy();
    expect(screen.getByText('view switcher')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add company' })).toBeTruthy();
  });

  it('omits the count when not provided', () => {
    render(<PageHeader title="Today" />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Today');
  });
});

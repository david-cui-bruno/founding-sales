// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Plus } from 'lucide-react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Avatar } from './Avatar';
import { Button } from './Button';
import { EmptyState } from './EmptyState';
import { ErrorState } from './ErrorState';
import { IconButton } from './IconButton';
import { LoadingState } from './LoadingState';
import { Panel } from './Panel';
import { StatusPill } from './StatusPill';

afterEach(() => {
  cleanup();
});

describe('Button', () => {
  it('renders a real button and forwards clicks', () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Add lead</Button>);

    const button = screen.getByRole('button', { name: 'Add lead' });
    expect(button.getAttribute('type')).toBe('button');
    fireEvent.click(button);

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('supports quiet and danger variants without changing semantics', () => {
    render(
      <>
        <Button variant="quiet">Dismiss</Button>
        <Button variant="danger">Remove</Button>
      </>,
    );

    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy();
  });

  it('does not fire when disabled', () => {
    const onClick = vi.fn();
    render(
      <Button onClick={onClick} disabled>
        Add lead
      </Button>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add lead' }));

    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('IconButton', () => {
  it('always exposes an accessible name for icon-only controls', () => {
    const onClick = vi.fn();
    render(<IconButton label="Add lead" icon={Plus} onClick={onClick} />);

    const button = screen.getByRole('button', { name: 'Add lead' });
    fireEvent.click(button);

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
  });
});

describe('Avatar', () => {
  it('derives initials and keeps the full name accessible', () => {
    render(<Avatar name="Kevin Shin" />);

    const avatar = screen.getByRole('img', { name: 'Kevin Shin' });
    expect(avatar.textContent).toBe('KS');
  });

  it('never renders more than two initial characters', () => {
    render(<Avatar name="Ana Maria Da Silva" />);

    expect(screen.getByRole('img', { name: 'Ana Maria Da Silva' }).textContent).toBe(
      'AS',
    );
  });
});

describe('StatusPill', () => {
  it('renders neutral status text by default', () => {
    render(<StatusPill>Contacted</StatusPill>);

    const pill = screen.getByText('Contacted');
    expect(pill.className).toContain('status-pill');
    expect(pill.className).toContain('status-pill--neutral');
  });

  it('reserves the urgent tone for meaningful states', () => {
    render(<StatusPill tone="urgent">P0</StatusPill>);

    expect(screen.getByText('P0').className).toContain('status-pill--urgent');
  });
});

describe('Panel', () => {
  it('renders a labelled region with heading and children', () => {
    render(
      <Panel title="Foundation health">
        <p>Encrypted SQLite ready</p>
      </Panel>,
    );

    const region = screen.getByRole('region', { name: 'Foundation health' });
    expect(region.textContent).toContain('Encrypted SQLite ready');
    expect(
      screen.getByRole('heading', { name: 'Foundation health' }),
    ).toBeTruthy();
  });

  it('renders optional toolbar actions beside the heading', () => {
    render(
      <Panel title="Leads" actions={<Button variant="quiet">Import</Button>}>
        <p>Rows</p>
      </Panel>,
    );

    expect(screen.getByRole('button', { name: 'Import' })).toBeTruthy();
  });
});

describe('EmptyState', () => {
  it('explains the empty condition and offers an action', () => {
    const onAction = vi.fn();
    render(
      <EmptyState
        title="No leads yet"
        description="Import a CSV to get started."
        action={<Button onClick={onAction}>Import leads</Button>}
      />,
    );

    expect(screen.getByRole('heading', { name: 'No leads yet' })).toBeTruthy();
    expect(screen.getByText('Import a CSV to get started.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Import leads' }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });
});

describe('LoadingState', () => {
  it('announces progress politely through a status role', () => {
    render(<LoadingState label="Loading leads" />);

    const status = screen.getByRole('status');
    expect(status.textContent).toContain('Loading leads');
  });
});

describe('ErrorState', () => {
  it('announces the failure and offers retry without raw internals', () => {
    const onRetry = vi.fn();
    render(
      <ErrorState
        title="Leads could not be loaded"
        description="Try again in a moment."
        onRetry={onRetry}
      />,
    );

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Leads could not be loaded');
    expect(alert.textContent).not.toMatch(/sqlite|stack|errno/i);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('omits the retry button when no handler is given', () => {
    render(<ErrorState title="Leads could not be loaded" />);

    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});

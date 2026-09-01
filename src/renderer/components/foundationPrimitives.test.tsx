// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PageHeader } from './PageHeader';
import { SegmentedControl } from './SegmentedControl';
import { Select } from './Select';
import { StatusBadge } from './StatusBadge';
import { Button } from './Button';

afterEach(() => {
  cleanup();
});

const sortOptions = [
  { value: 'priority', label: 'Priority' },
  { value: 'due_at', label: 'Due' },
  { value: 'person_name', label: 'Name' },
  { value: 'last_contact', label: 'Last contact' },
] as const;

function ControlledSelect({ onChange = vi.fn() }: { onChange?(value: string): void }) {
  const [value, setValue] = useState<string>('priority');
  return (
    <Select
      label="Sort leads"
      options={sortOptions}
      value={value as (typeof sortOptions)[number]['value']}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
    />
  );
}

describe('Select', () => {
  it('renders a closed combobox trigger showing the current value', () => {
    render(<ControlledSelect />);

    const trigger = screen.getByRole('combobox', { name: 'Sort leads' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.textContent).toContain('Priority');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('opens on click and commits an option by click', () => {
    const onChange = vi.fn();
    render(<ControlledSelect onChange={onChange} />);

    fireEvent.click(screen.getByRole('combobox', { name: 'Sort leads' }));
    const listbox = screen.getByRole('listbox');
    fireEvent.click(within(listbox).getByRole('option', { name: 'Due' }));

    expect(onChange).toHaveBeenCalledWith('due_at');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(
      screen.getByRole('combobox', { name: 'Sort leads' }).textContent,
    ).toContain('Due');
  });

  it('supports full keyboard interaction: arrows, Home, End, Enter, Escape', () => {
    const onChange = vi.fn();
    render(<ControlledSelect onChange={onChange} />);
    const trigger = screen.getByRole('combobox', { name: 'Sort leads' });

    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(screen.getByRole('listbox')).toBeTruthy();

    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.keyDown(trigger, { key: 'Home' });
    fireEvent.keyDown(trigger, { key: 'End' });
    fireEvent.keyDown(trigger, { key: 'Enter' });

    expect(onChange).toHaveBeenCalledWith('last_contact');
    expect(screen.queryByRole('listbox')).toBeNull();

    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('moves the active option by typeahead while open', () => {
    const onChange = vi.fn();
    render(<ControlledSelect onChange={onChange} />);
    const trigger = screen.getByRole('combobox', { name: 'Sort leads' });

    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.keyDown(trigger, { key: 'n' });
    fireEvent.keyDown(trigger, { key: 'Enter' });

    expect(onChange).toHaveBeenCalledWith('person_name');
  });

  it('marks the selected option and exposes aria-activedescendant', () => {
    render(<ControlledSelect />);
    const trigger = screen.getByRole('combobox', { name: 'Sort leads' });
    fireEvent.click(trigger);

    const selected = screen.getByRole('option', { name: 'Priority' });
    expect(selected.getAttribute('aria-selected')).toBe('true');
    expect(trigger.getAttribute('aria-activedescendant')).toBe(selected.id);
  });
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

function ControlledSegmented({ onChange = vi.fn() }: { onChange?(value: string): void }) {
  const [value, setValue] = useState('board');
  return (
    <SegmentedControl
      label="Pipeline view"
      options={[
        { value: 'board', label: 'Board' },
        { value: 'table', label: 'Table' },
      ]}
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
    />
  );
}

describe('SegmentedControl', () => {
  it('renders a radiogroup with the selected option checked', () => {
    render(<ControlledSegmented />);

    expect(screen.getByRole('radiogroup', { name: 'Pipeline view' })).toBeTruthy();
    expect(
      screen.getByRole('radio', { name: 'Board' }).getAttribute('aria-checked'),
    ).toBe('true');
    expect(
      screen.getByRole('radio', { name: 'Table' }).getAttribute('aria-checked'),
    ).toBe('false');
  });

  it('changes selection on click', () => {
    const onChange = vi.fn();
    render(<ControlledSegmented onChange={onChange} />);

    fireEvent.click(screen.getByRole('radio', { name: 'Table' }));
    expect(onChange).toHaveBeenCalledWith('table');
    expect(
      screen.getByRole('radio', { name: 'Table' }).getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('moves and wraps selection with arrow keys', () => {
    const onChange = vi.fn();
    render(<ControlledSegmented onChange={onChange} />);

    fireEvent.keyDown(screen.getByRole('radio', { name: 'Board' }), {
      key: 'ArrowRight',
    });
    expect(onChange).toHaveBeenLastCalledWith('table');

    fireEvent.keyDown(screen.getByRole('radio', { name: 'Table' }), {
      key: 'ArrowRight',
    });
    expect(onChange).toHaveBeenLastCalledWith('board');
  });

  it('keeps only the checked option in the tab order', () => {
    render(<ControlledSegmented />);

    expect(
      screen.getByRole('radio', { name: 'Board' }).getAttribute('tabindex'),
    ).toBe('0');
    expect(
      screen.getByRole('radio', { name: 'Table' }).getAttribute('tabindex'),
    ).toBe('-1');
  });
});

describe('PageHeader', () => {
  it('renders the title as the single page heading with a muted count', () => {
    render(<PageHeader title="Leads" count="354 people" />);

    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading.textContent).toBe('Leads · 354 people');
  });

  it('renders search, trailing, and primary action slots', () => {
    render(
      <PageHeader
        title="Leads"
        primaryAction={<Button>Import</Button>}
        trailing={<span>view switcher</span>}
      >
        <input type="search" aria-label="Search leads" />
      </PageHeader>,
    );

    expect(screen.getByRole('searchbox', { name: 'Search leads' })).toBeTruthy();
    expect(screen.getByText('view switcher')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Import' })).toBeTruthy();
  });

  it('omits the count when not provided', () => {
    render(<PageHeader title="Today" />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Today');
  });
});

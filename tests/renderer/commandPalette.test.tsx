// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { navigationItems } from '../../src/renderer/app/navigationItems';
import { CommandPalette } from '../../src/renderer/app/commandPalette/CommandPalette';

afterEach(() => {
  cleanup();
});

/**
 * The shortcut helper sets both modifiers so the assertion holds on any
 * platform: the component requires metaKey on darwin and ctrlKey elsewhere.
 */
const pressShortcut = () => {
  fireEvent.keyDown(window, { key: 'k', metaKey: true, ctrlKey: true });
};

const renderPalette = () => {
  const navigate = vi.fn();
  const openImport = vi.fn();
  render(<CommandPalette navigate={navigate} openImport={openImport} />);
  return { navigate, openImport };
};

describe('CommandPalette', () => {
  it('stays closed until Cmd+K opens it and focuses the input', () => {
    renderPalette();

    expect(screen.queryByRole('dialog')).toBeNull();

    pressShortcut();

    expect(screen.getByRole('dialog', { name: 'Command palette' })).not.toBeNull();
    const input = screen.getByRole('combobox', { name: 'Command palette' });
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(input);
  });

  it('closes on Escape and returns focus to the previously focused element', () => {
    render(<button type="button">Anchor</button>);
    renderPalette();
    const anchor = screen.getByRole('button', { name: 'Anchor' });
    anchor.focus();

    pressShortcut();
    expect(screen.getByRole('dialog')).not.toBeNull();

    fireEvent.keyDown(
      screen.getByRole('combobox', { name: 'Command palette' }),
      { key: 'Escape' },
    );

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(anchor);
  });

  it('closes when the backdrop is clicked', () => {
    const { navigate } = renderPalette();

    pressShortcut();
    fireEvent.mouseDown(screen.getByTestId('command-palette-backdrop'));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('offers a Go to command per enabled navigation item plus Import leads', () => {
    renderPalette();

    pressShortcut();

    const labels = screen
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(labels).toEqual([
      'Go to Today',
      'Go to Accounts',
      'Go to Campaigns',
      'Go to Leads',
      'Go to Pipeline',
      'Go to Conversations',
      'Go to Learnings',
      'Go to Friday',
      'Go to Inbox',
      'Go to Settings',
      'Import leads…',
    ]);
  });

  it('only offers destinations whose navigation entry is enabled', () => {
    renderPalette();

    pressShortcut();

    const offered = screen
      .getAllByRole('option')
      .map((option) => option.textContent);
    for (const item of navigationItems) {
      expect(offered.includes(`Go to ${item.label}`)).toBe(item.enabled);
    }
  });

  it('filters by case-insensitive substring', () => {
    renderPalette();

    pressShortcut();
    fireEvent.change(screen.getByRole('combobox', { name: 'Command palette' }), {
      target: { value: 'PIPE' },
    });

    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]!.textContent).toBe('Go to Pipeline');
  });

  it('filters by subsequence for fuzzy-ish queries', () => {
    renderPalette();

    pressShortcut();
    fireEvent.change(screen.getByRole('combobox', { name: 'Command palette' }), {
      target: { value: 'gtf' },
    });

    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]!.textContent).toBe('Go to Friday');
  });

  it('runs the selected command on Enter and closes', () => {
    const { navigate } = renderPalette();

    pressShortcut();
    fireEvent.keyDown(
      screen.getByRole('combobox', { name: 'Command palette' }),
      { key: 'Enter' },
    );

    expect(navigate).toHaveBeenCalledWith('today');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('moves selection with ArrowDown/ArrowUp and wraps at both ends', () => {
    renderPalette();

    pressShortcut();
    const input = screen.getByRole('combobox', { name: 'Command palette' });

    let options = screen.getAllByRole('option');
    expect(options[0]!.getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    options = screen.getAllByRole('option');
    expect(options[0]!.getAttribute('aria-selected')).toBe('false');
    expect(options[1]!.getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    options = screen.getAllByRole('option');
    expect(options.at(-1)!.getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    options = screen.getAllByRole('option');
    expect(options[0]!.getAttribute('aria-selected')).toBe('true');
  });

  it('navigates to an arrowed-to destination on Enter', () => {
    const { navigate } = renderPalette();

    pressShortcut();
    const input = screen.getByRole('combobox', { name: 'Command palette' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(navigate).toHaveBeenCalledWith('accounts');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('runs openImport for the Import leads command', () => {
    const { navigate, openImport } = renderPalette();

    pressShortcut();
    const input = screen.getByRole('combobox', { name: 'Command palette' });
    fireEvent.change(input, { target: { value: 'import' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(openImport).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows an empty state instead of stale options for a hopeless query', () => {
    const { navigate } = renderPalette();

    pressShortcut();
    const input = screen.getByRole('combobox', { name: 'Command palette' });
    fireEvent.change(input, { target: { value: 'zzzz' } });

    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText('No matching commands')).not.toBeNull();

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(navigate).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom

import { PresentationRoot } from '../../src/renderer/app/PresentationRoot';
import { cleanup, fireEvent, render as testingRender, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { navigationItems } from '../../src/renderer/app/navigationItems';
import { CommandPalette } from '../../src/renderer/app/commandPalette/CommandPalette';

const render = (ui: Parameters<typeof testingRender>[0], options?: Parameters<typeof testingRender>[1]) => testingRender(ui, { wrapper: PresentationRoot, ...options });

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function(this: HTMLDialogElement) { this.open = true; });
  HTMLDialogElement.prototype.close = vi.fn(function(this: HTMLDialogElement) { this.open = false; });
});

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
  render(<CommandPalette navigate={navigate} />);
  return { navigate };
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

  it('closes on Escape and returns focus to the previously focused element', async () => {
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
    await waitFor(() => expect(document.activeElement).toBe(anchor));
  });

  it('closes when the backdrop is clicked', () => {
    const { navigate } = renderPalette();

    pressShortcut();
    fireEvent.mouseDown(screen.getByTestId('command-palette-backdrop'));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('offers exactly one Go to command per company-model destination and nothing else', () => {
    renderPalette();

    pressShortcut();

    const labels = screen
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(labels).toEqual([
      'Go to Today',
      'Go to Accounts',
      'Go to Campaigns',
      'Go to Settings',
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
      target: { value: 'ACCO' },
    });

    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]!.textContent).toBe('Go to Accounts');
  });

  it('filters by subsequence for fuzzy-ish queries', () => {
    renderPalette();

    pressShortcut();
    fireEvent.change(screen.getByRole('combobox', { name: 'Command palette' }), {
      target: { value: 'gtcmp' },
    });

    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]!.textContent).toBe('Go to Campaigns');
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

  it('offers no import, lead or review command now that those surfaces are gone', () => {
    const { navigate } = renderPalette();

    pressShortcut();
    const input = screen.getByRole('combobox', { name: 'Command palette' });
    for (const query of ['import', 'lead', 'pipeline', 'inbox', 'friday', 'conversation', 'learning']) {
      fireEvent.change(input, { target: { value: query } });
      expect(screen.queryAllByRole('option'), query).toHaveLength(0);
      expect(screen.getByText('No matching commands')).not.toBeNull();
    }
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Command palette' })).not.toBeNull();
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

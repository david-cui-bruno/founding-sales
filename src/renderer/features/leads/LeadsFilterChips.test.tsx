// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LeadsFilterChips } from './LeadsFilterChips';

afterEach(() => {
  cleanup();
});

describe('LeadsFilterChips', () => {
  it('renders an All chip plus one chip per lifecycle stage', () => {
    render(
      <LeadsFilterChips stages={[]} counts={null} onStagesChange={vi.fn()} />,
    );

    const names = screen
      .getAllByRole('button')
      .map((button) => button.textContent);
    expect(names).toEqual([
      'All',
      'Unreviewed',
      'Ready',
      'Contacted',
      'Interviewed',
      'Offered',
      'Won',
      'Lost',
    ]);
  });

  it('shows per-stage counts when they are known', () => {
    render(
      <LeadsFilterChips
        stages={[]}
        counts={{ all: 5, ready: 3, contacted: 2 }}
        onStagesChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'All 5' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ready 3' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Contacted 2' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Won' })).toBeTruthy();
  });

  it('marks All pressed when no stage filter is active', () => {
    render(
      <LeadsFilterChips stages={[]} counts={null} onStagesChange={vi.fn()} />,
    );

    expect(
      screen.getByRole('button', { name: 'All' }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(
      screen.getByRole('button', { name: 'Ready' }).getAttribute('aria-pressed'),
    ).toBe('false');
  });

  it('multi-selects by adding a stage to the existing selection', () => {
    const onStagesChange = vi.fn();
    render(
      <LeadsFilterChips
        stages={['ready']}
        counts={null}
        onStagesChange={onStagesChange}
      />,
    );

    expect(
      screen.getByRole('button', { name: 'Ready' }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(
      screen.getByRole('button', { name: 'All' }).getAttribute('aria-pressed'),
    ).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Contacted' }));
    expect(onStagesChange).toHaveBeenCalledWith(['ready', 'contacted']);
  });

  it('deselects a pressed stage chip', () => {
    const onStagesChange = vi.fn();
    render(
      <LeadsFilterChips
        stages={['ready', 'won']}
        counts={null}
        onStagesChange={onStagesChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Ready' }));
    expect(onStagesChange).toHaveBeenCalledWith(['won']);
  });

  it('resets every stage filter through the All chip', () => {
    const onStagesChange = vi.fn();
    render(
      <LeadsFilterChips
        stages={['ready', 'won']}
        counts={null}
        onStagesChange={onStagesChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(onStagesChange).toHaveBeenCalledWith([]);
  });
});

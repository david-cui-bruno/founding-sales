// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LeadsBulkBar } from './LeadsBulkBar';

afterEach(() => {
  cleanup();
});

describe('LeadsBulkBar', () => {
  it('announces the selection count and offers the bulk field op plus Clear', () => {
    render(
      <LeadsBulkBar
        count={3}
        onSetOrganization={vi.fn()}
        onClear={vi.fn()}
      />,
    );

    const bar = screen.getByRole('toolbar', { name: 'Bulk actions' });
    expect(bar.textContent).toContain('3 selected');
    expect(screen.getByRole('button', { name: 'Set organization' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Clear' })).toBeTruthy();
  });

  it('commits a bulk organization value with Enter', () => {
    const onSetOrganization = vi.fn();
    render(
      <LeadsBulkBar
        count={2}
        onSetOrganization={onSetOrganization}
        onClear={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Set organization' }));
    const input = screen.getByRole('textbox', {
      name: 'Organization for 2 selected',
    });
    fireEvent.change(input, { target: { value: 'Shared Holdings' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSetOrganization).toHaveBeenCalledWith('Shared Holdings');
  });

  it('clears the selection when Escape is pressed anywhere', () => {
    const onClear = vi.fn();
    render(
      <LeadsBulkBar count={1} onSetOrganization={vi.fn()} onClear={onClear} />,
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('lets Escape close the inline editor without clearing the selection', () => {
    const onClear = vi.fn();
    render(
      <LeadsBulkBar count={1} onSetOrganization={vi.fn()} onClear={onClear} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Set organization' }));
    const input = screen.getByRole('textbox', {
      name: 'Organization for 1 selected',
    });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClear).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('textbox', { name: 'Organization for 1 selected' }),
    ).toBeNull();
  });

  it('clears through the Clear button', () => {
    const onClear = vi.fn();
    render(
      <LeadsBulkBar count={4} onSetOrganization={vi.fn()} onClear={onClear} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});

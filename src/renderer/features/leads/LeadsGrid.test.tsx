// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { LeadRow } from '../../../shared/contracts/leadsContract';
import { LeadsGrid } from './LeadsGrid';

/**
 * TanStack Virtual measures the scroll container through offsetWidth and
 * offsetHeight, which jsdom reports as 0. Give every element an explicit
 * size so the virtualizer renders real rows.
 */
const elementSizes: PropertyDescriptor[] = [];

beforeAll(() => {
  elementSizes.push(
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight') ?? {},
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth') ?? {},
  );
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => 480,
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get: () => 960,
  });
});

afterAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', elementSizes[0]!);
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', elementSizes[1]!);
});

afterEach(() => {
  cleanup();
});

const leadRow: LeadRow = {
  personId: 'person-1',
  salesCycleId: 'cycle-1',
  personName: 'Avery Landlord',
  initials: 'AL',
  organization: 'Landlord LLC',
  propertySummary: '12 Benefit St, Providence',
  stage: 'ready',
  source: 'frbo',
  segment: 'hot',
  priorityContext: {
    priority: 'P1',
    fitPoints: 24,
    fitBand: 'high',
    timingValue: 31,
    timingBand: 'hot',
    reachability: 'direct',
    dataConfidence: 8,
  },
  cloudScores: { fit: 62, timing: 41 },
  nextAction: {
    id: 'action-1',
    type: 'call_lead',
    channel: 'call',
    dueAt: '2026-08-31T15:00:00.000Z',
    label: 'Call lead',
    overdue: false,
  },
  optedOut: false,
  lastActivityAt: '2026-08-30T12:00:00.000Z',
};

const secondRow: LeadRow = {
  ...leadRow,
  personId: 'person-2',
  salesCycleId: 'cycle-2',
  personName: 'Blake Owner',
  initials: 'BO',
  organization: null,
  propertySummary: null,
  priorityContext: null,
  cloudScores: null,
  nextAction: null,
  lastActivityAt: null,
};

const noop = (): void => undefined;

describe('LeadsGrid', () => {
  it('renders people first and exposes separate Fit and Timing columns', () => {
    render(
      <LeadsGrid
        rows={[leadRow]}
        selectedPersonId={null}
        onSelect={vi.fn()}
        onUpdateField={vi.fn()}
      />,
    );

    const headers = screen
      .getAllByRole('columnheader')
      .map((node) => node.textContent);
    expect(headers.slice(0, 3)).toEqual(['Person', 'Context', 'Lifecycle']);
    expect(headers).toContain('Fit');
    expect(headers).toContain('Timing');
    expect(headers.join(' ')).not.toMatch(/lead score|weighted|blended/i);
  });

  it('renders Fit and Timing as separate band · points readouts, never combined', () => {
    render(
      <LeadsGrid
        rows={[leadRow]}
        selectedPersonId={null}
        onSelect={vi.fn()}
        onUpdateField={vi.fn()}
      />,
    );

    expect(screen.getByText('High · 24/30')).toBeTruthy();
    expect(screen.getByText('Hot · 31/40')).toBeTruthy();
  });

  it('renders the cloud chip as two separate axes and a muted placeholder when unscored', () => {
    render(
      <LeadsGrid
        rows={[leadRow, secondRow]}
        selectedPersonId={null}
        onSelect={vi.fn()}
        onUpdateField={vi.fn()}
      />,
    );

    expect(screen.getByText('Fit 62 · Timing 41')).toBeTruthy();
    const unscored = screen.getByRole('row', { name: /Blake Owner/ });
    expect(within(unscored).queryByText(/Fit \d+ · Timing \d+/)).toBeNull();
  });

  it('renders muted placeholders for physically absent prioritization data', () => {
    render(
      <LeadsGrid
        rows={[secondRow]}
        selectedPersonId={null}
        onSelect={vi.fn()}
        onUpdateField={vi.fn()}
      />,
    );

    const row = screen.getByRole('row', { name: /Blake Owner/ });
    const placeholders = within(row)
      .getAllByText('—')
      .map((node) => node.textContent);
    expect(placeholders.length).toBeGreaterThanOrEqual(3);
  });

  it('selects a row on click and marks it selected', () => {
    const onSelect = vi.fn();
    render(
      <LeadsGrid
        rows={[leadRow, secondRow]}
        selectedPersonId="person-2"
        onSelect={onSelect}
        onUpdateField={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('row', { name: /Blake Owner/ }).getAttribute('aria-selected'),
    ).toBe('true');
    fireEvent.click(screen.getByRole('row', { name: /Avery Landlord/ }));
    expect(onSelect).toHaveBeenCalledWith('person-1');
  });

  it('moves selection with the keyboard and opens a lead with Enter', () => {
    const onSelect = vi.fn();
    const onOpenLead = vi.fn();
    render(
      <LeadsGrid
        rows={[leadRow, secondRow]}
        selectedPersonId="person-1"
        onSelect={onSelect}
        onUpdateField={vi.fn()}
        onOpenLead={onOpenLead}
      />,
    );

    const firstRow = screen.getByRole('row', { name: /Avery Landlord/ });
    fireEvent.keyDown(firstRow, { key: 'ArrowDown' });
    expect(onSelect).toHaveBeenCalledWith('person-2');
    fireEvent.keyDown(firstRow, { key: 'Enter' });
    expect(onOpenLead).toHaveBeenCalledWith('person-1');
  });

  it('supports bulk selection through labelled per-person checkboxes', () => {
    const onToggleChecked = vi.fn();
    render(
      <LeadsGrid
        rows={[leadRow, secondRow]}
        selectedPersonId={null}
        onSelect={noop}
        onUpdateField={vi.fn()}
        checkedPersonIds={new Set(['person-2'])}
        onToggleChecked={onToggleChecked}
      />,
    );

    const checkbox = screen.getByRole('checkbox', {
      name: 'Select Avery Landlord',
    }) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    expect(
      (screen.getByRole('checkbox', {
        name: 'Select Blake Owner',
      }) as HTMLInputElement).checked,
    ).toBe(true);
    fireEvent.click(checkbox);
    expect(onToggleChecked).toHaveBeenCalledWith('person-1');
  });

  it('edits the person name inline and commits with Enter', () => {
    const onUpdateField = vi.fn();
    render(
      <LeadsGrid
        rows={[leadRow]}
        selectedPersonId={null}
        onSelect={noop}
        onUpdateField={onUpdateField}
      />,
    );

    fireEvent.doubleClick(screen.getByText('Avery Landlord'));
    const input = screen.getByRole('textbox', {
      name: 'Edit name for Avery Landlord',
    });
    fireEvent.change(input, { target: { value: 'Avery Renamed' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onUpdateField).toHaveBeenCalledWith({
      personId: 'person-1',
      field: 'person_name',
      value: 'Avery Renamed',
    });
  });

  it('cancels an inline edit with Escape without emitting an update', () => {
    const onUpdateField = vi.fn();
    render(
      <LeadsGrid
        rows={[leadRow]}
        selectedPersonId={null}
        onSelect={noop}
        onUpdateField={onUpdateField}
      />,
    );

    fireEvent.doubleClick(screen.getByText('Avery Landlord'));
    const input = screen.getByRole('textbox', {
      name: 'Edit name for Avery Landlord',
    });
    fireEvent.change(input, { target: { value: 'Discarded' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(onUpdateField).not.toHaveBeenCalled();
    expect(screen.getByText('Avery Landlord')).toBeTruthy();
  });

  it('edits the organization label inline and commits an emptied value as null', () => {
    const onUpdateField = vi.fn();
    render(
      <LeadsGrid
        rows={[leadRow]}
        selectedPersonId={null}
        onSelect={noop}
        onUpdateField={onUpdateField}
      />,
    );

    fireEvent.doubleClick(screen.getByText('Landlord LLC'));
    const input = screen.getByRole('textbox', {
      name: 'Edit organization for Avery Landlord',
    });
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onUpdateField).toHaveBeenCalledWith({
      personId: 'person-1',
      field: 'organization_label',
      value: null,
    });
  });
});

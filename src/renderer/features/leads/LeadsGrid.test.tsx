// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { LeadRow } from '../../../shared/contracts/leadsContract';
import { LeadsGrid as Grid, type LeadsGridProps } from './LeadsGrid';
import type { InlineEdit } from './useLeadMutations';
import { PresentationRoot } from '../../app/PresentationRoot';
function LeadsGrid(props: Omit<LeadsGridProps, 'editor'>) {
  const [session, setSession] = useState<InlineEdit | null>(null);
  const focus = useRef<{node: HTMLInputElement | null; initial: boolean}>({node:null,initial:false});
  return <PresentationRoot><Grid {...props} editor={{ session, pending: false, bindInput: (node, allow) => { focus.current.node=node; if(node && focus.current.initial){focus.current.initial=false;if(allow)node.focus();}}, focusInput:()=>focus.current.node?.focus(), start: input => { focus.current.initial=true; setSession({ ...input, status: 'editing', error: null }); }, change: draft => setSession(current => current && ({ ...current, draft })), cancel: () => setSession(null) }} onUpdateField={async input => { await props.onUpdateField(input); setSession(null); return { status: 'saved' }; }} /></PresentationRoot>;
}

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
    label: 'Call lead',
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

  it('renders a zero-signal cloud chip in the muted variant, scored chips in the accent', () => {
    const zeroSignalRow: LeadRow = {
      ...leadRow,
      personId: 'person-3',
      salesCycleId: 'cycle-3',
      personName: 'Casey Quiet',
      initials: 'CQ',
      cloudScores: { fit: 0, timing: 0 },
    };
    render(
      <LeadsGrid
        rows={[leadRow, zeroSignalRow]}
        selectedPersonId={null}
        onSelect={vi.fn()}
        onUpdateField={vi.fn()}
      />,
    );

    const zeroChip = screen.getByText('Fit 0 · Timing 0');
    expect(zeroChip.className).toContain('leads-grid__cloud-chip--zero');
    const scoredChip = screen.getByText('Fit 62 · Timing 41');
    expect(scoredChip.className).toContain('leads-grid__cloud-chip');
    expect(scoredChip.className).not.toContain('leads-grid__cloud-chip--zero');
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

  it('opens the inspector AND selects on a single row click', () => {
    const onSelect = vi.fn();
    const onOpenLead = vi.fn();
    render(
      <LeadsGrid
        rows={[leadRow, secondRow]}
        selectedPersonId="person-2"
        onSelect={onSelect}
        onUpdateField={vi.fn()}
        onOpenLead={onOpenLead}
      />,
    );

    expect(
      screen.getByRole('row', { name: /Blake Owner/ }).getAttribute('aria-selected'),
    ).toBe('true');
    // Real mouse path: a plain click on the row body both selects and opens.
    fireEvent.click(screen.getByRole('row', { name: /Avery Landlord/ }));
    expect(onSelect).toHaveBeenCalledWith('person-1');
    expect(onOpenLead).toHaveBeenCalledWith('person-1');
  });

  it('still selects on click when no open handler is wired', () => {
    const onSelect = vi.fn();
    render(
      <LeadsGrid
        rows={[leadRow, secondRow]}
        selectedPersonId={null}
        onSelect={onSelect}
        onUpdateField={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('row', { name: /Avery Landlord/ }));
    expect(onSelect).toHaveBeenCalledWith('person-1');
  });

  it('keeps checkbox clicks select-only: no inspector open', () => {
    const onOpenLead = vi.fn();
    const onToggleChecked = vi.fn();
    render(
      <LeadsGrid
        rows={[leadRow]}
        selectedPersonId={null}
        onSelect={vi.fn()}
        onUpdateField={vi.fn()}
        onOpenLead={onOpenLead}
        checkedPersonIds={new Set()}
        onToggleChecked={onToggleChecked}
      />,
    );

    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Select Avery Landlord' }),
    );
    expect(onToggleChecked).toHaveBeenCalledWith('person-1');
    expect(onOpenLead).not.toHaveBeenCalled();
  });

  it.each(['metaKey', 'ctrlKey', 'altKey'] as const)(
    'leaves %s + k unhandled on rows and child checkboxes', (modifier) => {
      const onSelect = vi.fn();
      const onOpenLead = vi.fn();
      render(<LeadsGrid rows={[leadRow, secondRow]} selectedPersonId="person-2"
        onSelect={onSelect} onUpdateField={vi.fn()} onOpenLead={onOpenLead}
        checkedPersonIds={new Set()} onToggleChecked={vi.fn()} />);
      for (const target of [screen.getByRole('row', { name: /Blake Owner/ }),
        screen.getByRole('checkbox', { name: 'Select Blake Owner' })]) {
        const event = new KeyboardEvent('keydown', {
          key: 'k', [modifier]: true, bubbles: true, cancelable: true,
        });
        fireEvent(target, event);
        expect(event.defaultPrevented).toBe(false);
        expect(onSelect).not.toHaveBeenCalled();
        expect(onOpenLead).not.toHaveBeenCalled();
      }
    },
  );

  it.each(['j', 'k', 'ArrowDown', 'ArrowUp', 'Enter'])(
    'leaves child checkbox %s separate from row navigation', (key) => {
      const onSelect = vi.fn();
      const onOpenLead = vi.fn();
      render(<LeadsGrid rows={[leadRow, secondRow]} selectedPersonId="person-1"
        onSelect={onSelect} onUpdateField={vi.fn()} onOpenLead={onOpenLead}
        checkedPersonIds={new Set()} onToggleChecked={vi.fn()} />);
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      fireEvent(screen.getByRole('checkbox', { name: 'Select Avery Landlord' }), event);
      expect(event.defaultPrevented).toBe(false);
      expect(onSelect).not.toHaveBeenCalled();
      expect(onOpenLead).not.toHaveBeenCalled();
    },
  );

  it.each(['j', 'ArrowDown', 'Enter'])(
    'respects composing and already-handled row %s', (key) => {
      const onSelect = vi.fn();
      const onOpenLead = vi.fn();
      render(<LeadsGrid rows={[leadRow, secondRow]} selectedPersonId="person-1"
        onSelect={onSelect} onUpdateField={vi.fn()} onOpenLead={onOpenLead}
        checkedPersonIds={new Set()} onToggleChecked={vi.fn()} />);
      const row = screen.getByRole('row', { name: /Avery Landlord/ });
      const composing = new KeyboardEvent('keydown', {
        key, isComposing: true, bubbles: true, cancelable: true,
      });
      fireEvent(row, composing);
      expect(composing.defaultPrevented).toBe(false);
      const handled = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      handled.preventDefault();
      fireEvent(row, handled);
      expect(onSelect).not.toHaveBeenCalled();
      expect(onOpenLead).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['j', false, 'Avery Landlord', 'person-2'],
    ['J', true, 'Avery Landlord', 'person-2'],
    ['ArrowDown', false, 'Avery Landlord', 'person-2'],
    ['k', false, 'Blake Owner', 'person-1'],
    ['K', true, 'Blake Owner', 'person-1'],
    ['ArrowUp', false, 'Blake Owner', 'person-1'],
  ] as const)('preserves row navigation %s', (key, shiftKey, name, expected) => {
    const onSelect = vi.fn();
    render(<LeadsGrid rows={[leadRow, secondRow]} selectedPersonId={null}
      onSelect={onSelect} onUpdateField={vi.fn()} />);
    const event = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true });
    fireEvent(screen.getByRole('row', { name: new RegExp(name) }), event);
    expect(event.defaultPrevented).toBe(true);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(expected);
  });

  it('keeps editor typing and Enter separate from row selection and opening', () => {
    const onSelect = vi.fn();
    const onOpenLead = vi.fn();
    const onUpdateField = vi.fn();
    render(<LeadsGrid rows={[leadRow, secondRow]} selectedPersonId="person-1"
      onSelect={onSelect} onUpdateField={onUpdateField} onOpenLead={onOpenLead} />);
    fireEvent.doubleClick(screen.getByText('Avery Landlord'));
    const input = screen.getByRole('textbox', { name: 'Edit name for Avery Landlord' });
    fireEvent.keyDown(input, { key: 'j' });
    fireEvent.keyDown(input, { key: 'k' });
    fireEvent.change(input, { target: { value: 'Avery jk' } });
    expect((input as HTMLInputElement).value).toBe('Avery jk');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onUpdateField).toHaveBeenCalledTimes(1);
    expect(onUpdateField).toHaveBeenCalledWith({
      personId: 'person-1', field: 'person_name', value: 'Avery jk',
    });
    expect(onSelect).not.toHaveBeenCalled();
    expect(onOpenLead).not.toHaveBeenCalled();
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

  it('shows organization over address when the organization differs from the person', () => {
    render(
      <LeadsGrid
        rows={[leadRow]}
        selectedPersonId={null}
        onSelect={noop}
        onUpdateField={vi.fn()}
      />,
    );

    const row = screen.getByRole('row', { name: /Avery Landlord/ });
    const cell = row.querySelector('.leads-grid__context');
    expect(cell?.querySelector('.leads-grid__organization')?.textContent).toBe(
      'Landlord LLC',
    );
    expect(cell?.querySelector('.leads-grid__property')?.textContent).toBe(
      '12 Benefit St, Providence',
    );
    expect(cell?.getAttribute('title')).toBe(
      'Landlord LLC · 12 Benefit St, Providence',
    );
  });

  it('renders a single address line, never a leading em-dash, for personless orgs', () => {
    const orgless: LeadRow = {
      ...secondRow,
      propertySummary: '30 Evergreen Ter, Springfield',
    };
    render(
      <LeadsGrid
        rows={[orgless]}
        selectedPersonId={null}
        onSelect={noop}
        onUpdateField={vi.fn()}
      />,
    );

    const row = screen.getByRole('row', { name: /Blake Owner/ });
    const cell = row.querySelector('.leads-grid__context');
    expect(cell?.textContent).toBe('30 Evergreen Ter, Springfield');
    expect(cell?.textContent).not.toContain('—');
    expect(cell?.className).toContain('leads-grid__context--single');
    expect(cell?.getAttribute('title')).toBe('30 Evergreen Ter, Springfield');
  });

  it('collapses to the address when the organization merely repeats the person name', () => {
    const selfNamed: LeadRow = {
      ...leadRow,
      organization: 'avery landlord',
    };
    render(
      <LeadsGrid
        rows={[selfNamed]}
        selectedPersonId={null}
        onSelect={noop}
        onUpdateField={vi.fn()}
      />,
    );

    const cell = screen
      .getByRole('row', { name: /Avery Landlord/ })
      .querySelector('.leads-grid__context');
    expect(cell?.querySelector('.leads-grid__organization')).toBeNull();
    expect(cell?.textContent).toBe('12 Benefit St, Providence');
  });

  it('renders an empty context cell without placeholder text when nothing is known', () => {
    render(
      <LeadsGrid
        rows={[secondRow]}
        selectedPersonId={null}
        onSelect={noop}
        onUpdateField={vi.fn()}
      />,
    );

    const cell = screen
      .getByRole('row', { name: /Blake Owner/ })
      .querySelector('.leads-grid__context');
    expect(cell?.textContent).toBe('');
    expect(cell?.getAttribute('title')).toBeNull();
  });

  it('exposes clickable Person and Last activity sort headers with aria-sort', () => {
    const onSortChange = vi.fn();
    render(
      <LeadsGrid
        rows={[leadRow]}
        selectedPersonId={null}
        onSelect={noop}
        onUpdateField={vi.fn()}
        sort="priority"
        onSortChange={onSortChange}
      />,
    );

    const personHeader = screen.getByRole('columnheader', { name: 'Person' });
    expect(personHeader.getAttribute('aria-sort')).toBe('none');
    fireEvent.click(within(personHeader).getByRole('button'));
    expect(onSortChange).toHaveBeenCalledWith('person_name');

    const lastActivity = screen.getByRole('columnheader', {
      name: 'Last activity',
    });
    fireEvent.click(within(lastActivity).getByRole('button'));
    expect(onSortChange).toHaveBeenCalledWith('last_contact');

    // Unsupported server sorts stay plain headers.
    for (const name of ['Lifecycle', 'Fit', 'Timing', 'Cloud']) {
      const header = screen.getByRole('columnheader', { name });
      expect(within(header).queryByRole('button')).toBeNull();
      expect(header.getAttribute('aria-sort')).toBeNull();
    }
  });

  it('marks the active sort column with the matching aria-sort direction', () => {
    const { rerender } = render(
      <LeadsGrid
        rows={[leadRow]}
        selectedPersonId={null}
        onSelect={noop}
        onUpdateField={vi.fn()}
        sort="person_name"
        onSortChange={vi.fn()}
      />,
    );
    expect(
      screen
        .getByRole('columnheader', { name: /Person/ })
        .getAttribute('aria-sort'),
    ).toBe('ascending');

    rerender(
      <LeadsGrid
        rows={[leadRow]}
        selectedPersonId={null}
        onSelect={noop}
        onUpdateField={vi.fn()}
        sort="last_contact"
        onSortChange={vi.fn()}
      />,
    );
    expect(
      screen
        .getByRole('columnheader', { name: /Last activity/ })
        .getAttribute('aria-sort'),
    ).toBe('descending');
    expect(
      screen
        .getByRole('columnheader', { name: 'Person' })
        .getAttribute('aria-sort'),
    ).toBe('none');
  });

  it('moves selection and roving focus with J/K', () => {
    function Harness() {
      const [selected, setSelected] = useState<string | null>('person-1');
      return (
        <LeadsGrid
          rows={[leadRow, secondRow]}
          selectedPersonId={selected}
          onSelect={setSelected}
          onUpdateField={vi.fn()}
        />
      );
    }
    render(<Harness />);

    const first = screen.getByRole('row', { name: /Avery Landlord/ });
    first.focus();
    fireEvent.keyDown(first, { key: 'j' });
    const second = screen.getByRole('row', { name: /Blake Owner/ });
    expect(second.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(second);

    fireEvent.keyDown(second, { key: 'k' });
    expect(
      screen
        .getByRole('row', { name: /Avery Landlord/ })
        .getAttribute('aria-selected'),
    ).toBe('true');
    expect(document.activeElement?.textContent).toContain('Avery Landlord');
  });

  it('applies the tabular-nums utility to numeric columns', () => {
    render(
      <LeadsGrid
        rows={[leadRow]}
        selectedPersonId={null}
        onSelect={noop}
        onUpdateField={vi.fn()}
      />,
    );

    const row = screen.getByRole('row', { name: /Avery Landlord/ });
    for (const column of ['fit', 'timing', 'lastActivity']) {
      const cell = row.querySelector(`.leads-grid__col--${column}`);
      expect(cell?.className).toContain('numeric');
    }
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

it.each(['name','organization'] as const)('real double-click sequence edits %s without selecting or opening the inspector', field=>{
  const onOpenLead=vi.fn();const onSelect=vi.fn();
  render(<LeadsGrid rows={[leadRow]} selectedPersonId={null} onSelect={onSelect} onOpenLead={onOpenLead} onUpdateField={vi.fn(async()=>({status:'saved' as const}))}/>);
  const text=screen.getByText(field==='name'?'Avery Landlord':'Landlord LLC');
  fireEvent.click(text,{detail:1});fireEvent.click(text,{detail:2});fireEvent.doubleClick(text,{detail:2});
  expect(screen.getByRole('textbox',{name:field==='name'?'Edit name for Avery Landlord':'Edit organization for Avery Landlord'})).toBeTruthy();
  expect(onSelect).not.toHaveBeenCalled();expect(onOpenLead).not.toHaveBeenCalled();
});

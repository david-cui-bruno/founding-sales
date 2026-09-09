// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { TodayItem, TodaySnapshot } from '../../../shared/contracts/todayContract';
import { TodayPage } from './TodayPage';
afterEach(cleanup);
const item = (id: string, lane: TodayItem['lane'] = 'due_cadence'): TodayItem => ({ id, salesCycleId: id, personId: id, personName: id, lane, contextLabel: 'Example portfolio', stage: 'ready', priorityContext: null, action: { id: `action-${id}`, type: 'call_lead', channel: 'call', label: 'Call' }, reason: 'callback_promised_today', activeTriggers: [], verifyFirst: false, pinned: false, consentRequirement: null, cloudScores: null });
const snapshot = (items = [item('Avery'), item('Blair')]): TodaySnapshot => ({ lanes: [{ id: 'due_cadence', items, overflowCount: 0 }], dialBudget: 40, scheduledDials: 2, conversationTarget: 4, reviewErrorCount: 0, revision: 1, unreviewedBacklogCount: 10, unreviewedCloudSignalCount: 5, conversationsHeld: 0 });
function page(value = snapshot()) { const props = { snapshot: value, onOpenLead: vi.fn(), onCall: vi.fn(), onSnoozeUntil: vi.fn(), onSkipToday: vi.fn(), onLogPastActivity: vi.fn(), onOpenInLeads: vi.fn() }; return { props, ...render(<TodayPage {...props} discovery={<button>Refresh shortlist</button>} />) }; }

it('renders the main-process queue as one compact contact list with no generic preparation or judgment surface', () => {
  page();
  expect(screen.getByRole('list', { name: 'Work queue' }).children).toHaveLength(2);
  expect(screen.getByRole('button', { name: 'Avery' })).toBeTruthy();
  for (const name of [/Next/, /Refresh/, /Prepare/, /Review/, /judgment/i]) expect(screen.queryByRole('button', { name })).toBeNull();
  expect(screen.queryByRole('region', { name: 'Next up' })).toBeNull();
});
it('does not duplicate main queue policy or reorder the supplied rows', () => {
  page({ ...snapshot(), lanes: [{ id: 'p1', items: [item('First', 'p1')], overflowCount: 0 }, { id: 'due_cadence', items: [item('Second')], overflowCount: 0 }] });
  expect([...screen.getByRole('list', { name: 'Work queue' }).children].map(row => row.getAttribute('data-cycle-id'))).toEqual(['First', 'Second']);
});
it('moves roving keyboard focus and selects with Enter without requesting outreach', () => {
  const { props } = page();
  const rows = [...screen.getByRole('list', { name: 'Work queue' }).children] as HTMLElement[];
  rows[0]!.focus(); fireEvent.keyDown(rows[0]!, { key: 'j' }); expect(document.activeElement).toBe(rows[1]);
  fireEvent.keyDown(rows[1]!, { key: 'Enter' }); expect(props.onOpenLead).toHaveBeenCalledWith('Blair');
  expect(props.onCall).not.toHaveBeenCalled();
  fireEvent.keyDown(rows[1]!, { key: 'ArrowUp' }); expect(document.activeElement).toBe(rows[0]);
  expect(rows[0]!.tabIndex).toBe(0); expect(rows[1]!.tabIndex).toBe(-1);
});
it('retains explicit Call and non-destructive row context commands', () => {
  const { props } = page(); const row = screen.getByRole('list', { name: 'Work queue' }).children[0]! as HTMLElement;
  fireEvent.click(within(row).getByRole('button', { name: 'Call Avery' })); expect(props.onCall).toHaveBeenCalledWith(expect.objectContaining({ personId: 'Avery' }));
  fireEvent.keyDown(row, { key: 's' }); expect(props.onSnoozeUntil).toHaveBeenCalledWith(expect.objectContaining({ personId: 'Avery' }), expect.any(String));
  fireEvent.keyDown(row, { key: 'x' }); expect(props.onSkipToday).toHaveBeenCalledWith(expect.objectContaining({ personId: 'Avery' }));
});
it('shows an honest empty queue without implying no unreviewed people exist', () => {
  page(snapshot([])); expect(screen.getByText('No contacts due right now.')).toBeTruthy();
  expect(screen.queryByText(/fresh queue builds/)).toBeNull();
});
it.each(['metaKey', 'ctrlKey', 'altKey', 'isComposing'])('never performs queue mutations or selection for %s key combinations', modifier => {
  const { props } = page(); const rows = [...screen.getByRole('list', { name: 'Work queue' }).children] as HTMLElement[];
  rows[0]!.focus();
  for (const key of ['s', 'x', 'j', 'Enter']) fireEvent.keyDown(rows[0]!, { key, [modifier]: true });
  expect(props.onSnoozeUntil).not.toHaveBeenCalled(); expect(props.onSkipToday).not.toHaveBeenCalled();
  expect(props.onOpenLead).not.toHaveBeenCalled(); expect(document.activeElement).toBe(rows[0]);
});

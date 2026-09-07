// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { TodayItem } from '../../../shared/contracts/todayContract';
import { LogPastActivityDialog } from './LogPastActivityDialog';

const item: TodayItem = {
  id: 'cycle-owner', lane: 'p1', personId: 'owner-person', salesCycleId: 'cycle-owner',
  personName: 'Example Owner', contextLabel: null, stage: 'interviewed', priorityContext: null,
  action: { id: 'action-owner', type: 'offer', channel: 'call', label: 'Discuss offer' },
  reason: 'Follow up', activeTriggers: [], verifyFirst: false, pinned: false,
  consentRequirement: null, cloudScores: null,
};
afterEach(cleanup);
function form() {
  const onSubmit = vi.fn();
  const props = { item, busy: false, onSubmit, onClose: vi.fn() };
  const view = render(<LogPastActivityDialog {...props} />);
  fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-09-01' } });
  fireEvent.change(screen.getByLabelText('What happened'), { target: { value: 'We discussed $50.' } });
  return { ...view, props, onSubmit };
}
it('defaults to unchecked and never infers price evidence from money in a summary', () => {
  const { onSubmit } = form();
  expect((screen.getByRole('checkbox', { name: 'I stated the price' }) as HTMLInputElement).checked).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Log activity' }));
  expect(onSubmit).toHaveBeenCalledWith({ personId: 'owner-person', salesCycleId: 'cycle-owner', kind: 'call', direction: 'outbound', occurredAt: new Date('2026-09-01T12:00:00').toISOString(), summary: 'We discussed $50.', outcome: null });
});
it('logs only explicitly checked dated communication once even with synchronous duplicate clicks', () => {
  const { onSubmit } = form();
  fireEvent.click(screen.getByRole('checkbox', { name: 'I stated the price' }));
  const button = screen.getByRole('button', { name: 'Log activity' });
  fireEvent.click(button); fireEvent.click(button);
  expect(onSubmit).toHaveBeenCalledTimes(1);
  expect(onSubmit).toHaveBeenCalledWith({ personId: 'owner-person', salesCycleId: 'cycle-owner', kind: 'call', direction: 'outbound', occurredAt: new Date('2026-09-01T12:00:00').toISOString(), summary: 'We discussed $50.', outcome: 'price_said' });
});
it('disables and resets price for internal notes and does not restore it when returning to a call', () => {
  const { onSubmit } = form();
  fireEvent.click(screen.getByRole('checkbox', { name: 'I stated the price' }));
  fireEvent.click(screen.getByRole('combobox', { name: 'Activity kind' }));
  fireEvent.click(screen.getByRole('option', { name: 'Note' }));
  const checkbox = screen.getByRole('checkbox', { name: 'I stated the price' }) as HTMLInputElement;
  expect(checkbox.disabled).toBe(true); expect(checkbox.checked).toBe(false);
  fireEvent.click(screen.getByRole('combobox', { name: 'Activity kind' }));
  fireEvent.click(screen.getByRole('option', { name: 'Call' }));
  expect(checkbox.checked).toBe(false);
  fireEvent.click(screen.getByRole('combobox', { name: 'Activity kind' }));
  fireEvent.click(screen.getByRole('option', { name: 'Note' }));
  fireEvent.click(screen.getByRole('button', { name: 'Log activity' }));
  expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'note', direction: 'internal', outcome: null }));
});
it('resets price and summary when the selected Person changes', () => {
  const { props, rerender } = form();
  fireEvent.click(screen.getByRole('checkbox', { name: 'I stated the price' }));
  rerender(<LogPastActivityDialog {...props} item={{ ...item, personId: 'other-owner', salesCycleId: 'other-cycle' }} />);
  expect((screen.getByRole('checkbox', { name: 'I stated the price' }) as HTMLInputElement).checked).toBe(false);
  expect((screen.getByLabelText('What happened') as HTMLTextAreaElement).value).toBe('');
});

// @vitest-environment jsdom
import { cleanup, act, fireEvent, render as testingRender, screen } from '@testing-library/react';
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
import { PresentationRoot } from '../../app/PresentationRoot';
const render = (ui: Parameters<typeof testingRender>[0], options?: Parameters<typeof testingRender>[1]) => testingRender(ui, { wrapper: PresentationRoot, ...options });
Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.open = true; } });
Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.open = false; } });

afterEach(cleanup);
function form() {
  const onSubmit = vi.fn< (request: import('../../../shared/contracts/todayContract').LogPastActivityRequest) => Promise<void>>(() => new Promise(() => {}));
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

it('retains a pending manual form and all input after an unconfirmed result', async () => {
  let reject!: (error: Error) => void;
  const pending = new Promise<void>((_, fail) => { reject = fail; });
  const { props, rerender } = form();
  const onSubmit = vi.fn(() => pending);
  rerender(<LogPastActivityDialog {...props} onSubmit={onSubmit} />);
  fireEvent.click(screen.getByRole('checkbox', { name: 'I stated the price' }));
  const dialog = screen.getByRole('dialog');
  const save = screen.getByRole('button', { name: 'Log activity' });
  act(() => { save.click(); save.click(); });
  fireEvent.keyDown(dialog, { key: 'Escape' });
  fireEvent(dialog, new Event('cancel', { cancelable: true }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(props.onClose).not.toHaveBeenCalled();
  expect(onSubmit).toHaveBeenCalledTimes(1);
  expect((screen.getByLabelText('What happened') as HTMLTextAreaElement).disabled).toBe(true);
  await act(async () => { reject(new Error('private failure')); });
  expect(screen.getByRole('alert').textContent).toBe('Past activity save was not confirmed. Your input is still here. Check Activity before logging it again.');
  expect((screen.getByLabelText('What happened') as HTMLTextAreaElement).value).toBe('We discussed $50.');
  expect((screen.getByLabelText('Date') as HTMLInputElement).value).toBe('2026-09-01');
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
  expect(dialog.tagName).toBe('DIALOG');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(props.onClose).toHaveBeenCalledTimes(1);
});

it('consumes a synchronous throw as an unconfirmed result and permits deliberate close', async () => {
  const { props, rerender } = form();
  rerender(<LogPastActivityDialog {...props} onSubmit={() => { throw new Error('private detail'); }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Log activity' }));
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect((screen.getByLabelText('What happened') as HTMLTextAreaElement).value).toBe('We discussed $50.');
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  expect(props.onClose).toHaveBeenCalledTimes(1);
});
it('does not let an old finally unlock the new Person pending attempt', async () => {
  const resolvers: Array<() => void> = [];
  const { props, rerender } = form();
  const onSubmit = vi.fn(() => new Promise<void>(resolve => { resolvers.push(resolve); }));
  rerender(<LogPastActivityDialog {...props} onSubmit={onSubmit} />);
  fireEvent.click(screen.getByRole('button', { name: 'Log activity' }));
  rerender(<LogPastActivityDialog {...props} item={{ ...item, personId: 'other-person', salesCycleId: 'other-cycle' }} onSubmit={onSubmit} />);
  fireEvent.change(screen.getByLabelText('What happened'), { target: { value: 'New Person pending' } });
  fireEvent.click(screen.getByRole('button', { name: 'Log activity' }));
  await act(async () => resolvers[0]!());
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  expect(props.onClose).not.toHaveBeenCalled();
  expect((screen.getByLabelText('What happened') as HTMLTextAreaElement).disabled).toBe(true);
  await act(async () => resolvers[1]!());
  expect((screen.getByLabelText('What happened') as HTMLTextAreaElement).disabled).toBe(false);
});

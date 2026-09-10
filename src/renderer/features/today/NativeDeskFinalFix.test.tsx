import { PresentationRoot } from '../../app/PresentationRoot';
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render as testingRender, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { NativeDeskRoute } from './NativeDeskRoute';
import { nativeDeskReviewFixture, nativeDeskFixture } from './nativeDesk.fixture';
import { answerKey } from './DailyAnswers';
import type { DailyAnswer } from '../../../shared/contracts/dailyContract';
afterEach(cleanup);
const pending = { commandId: 'retained', status: 'pending' as const, authorityGeneration: 1, aggregateVersion: 2, reason: null as null };
function fixture() {
  const snapshot = nativeDeskReviewFixture();
  snapshot.ownerStatus[0].pendingCommands = [pending];
  snapshot.ownerStatus[0].status = 'pending';
  const f = nativeDeskFixture(snapshot);
  vi.spyOn(f.api.delegation, 'sync').mockImplementation(async () => ({ applied: 99, gaps: 0, cursor: null, ownerFresh: true }));
  return f;
}
it('explicit reconciliation exists without relaxing pending holds or inferring applied from counts', async () => {
  const f = fixture();
  render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} onOpenLead={vi.fn()} />);
  await screen.findByRole('heading', { name: 'Today' });
  expect(f.api.delegation.sync).not.toHaveBeenCalled();
  fireEvent.focus(window);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(f.calls.filter(c => c.method === 'daily.get')).toHaveLength(3));
  expect(f.api.delegation.sync).not.toHaveBeenCalled();
  expect(screen.getByText(/may retry already-queued commands/i)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Reconcile queued commands' }));
  await waitFor(() => expect(f.calls.filter(c => c.method === 'daily.get')).toHaveLength(4));
  expect(f.api.delegation.sync).toHaveBeenCalledTimes(1);
  expect(screen.getByText(/1 pending command/)).toBeTruthy();
});
it('saved reply IDs and no-draft placeholder have distinct stable keys', () => {
  const thread = { thread: { provider: 'gmail', mailboxSubject: 'mailbox', providerThreadId: 'thread' } };
  const a = { kind: 'reply', accountId: 'a', thread, draft: { id: 'first' } } as DailyAnswer;
  const b = { ...a, draft: { id: 'second' } } as DailyAnswer;
  const placeholder = { ...a, draft: null } as DailyAnswer;
  expect(new Set([answerKey(a), answerKey(b), answerKey(placeholder)]).size).toBe(3);
});
it.each(['paused', 'revoked', 'foreign', 'unknown', 'unrelated'] as const)('holds reconciliation for %s scope/authority', async kind => {
  const f = fixture();
  const config = await f.api.delegation.status();
  if (kind === 'paused') f.setConfiguration({ ...config, state: 'paused' });
  if (kind === 'foreign') f.setConfiguration({ ...config, workspaceId: 'foreign' });
  if (kind === 'revoked' || kind === 'unknown' || kind === 'unrelated') {
    const next = f.snapshot();
    const owner = next.ownerStatus[kind === 'unrelated' ? 1 : 0];
    owner.pendingCommands = [pending];
    owner.authority = kind === 'unknown' ? null : { ...owner.authority!, state: 'revoked' };
    f.setSnapshot(next);
  }
  render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} onOpenLead={vi.fn()} />);
  const button = await screen.findByRole('button', { name: 'Reconcile queued commands' });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(button);
  expect(f.api.delegation.sync).not.toHaveBeenCalled();
});
it('waits for completion, prevents double sync and preserves holds on failure', async () => {
  const f = fixture();
  let reject!: (e: Error) => void;
  vi.spyOn(f.api.delegation, 'sync').mockImplementation(() => new Promise((_, no) => { reject = no; }));
  render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} onOpenLead={vi.fn()} />);
  const button = await screen.findByRole('button', { name: 'Reconcile queued commands' });
  fireEvent.click(button); fireEvent.click(button);
  expect(f.api.delegation.sync).toHaveBeenCalledTimes(1);
  expect(f.calls.filter(c => c.method === 'daily.get')).toHaveLength(1);
  reject(Error('offline'));
  await screen.findByText(/Reconciliation unavailable/);
  expect(f.calls.filter(c => c.method === 'daily.get')).toHaveLength(1);
  expect(screen.getByText(/1 pending command/)).toBeTruthy();
  expect((button as HTMLButtonElement).disabled).toBe(false);
});
it.each(['remount', 'pause', 'foreign'] as const)('does not revive sync continuation after %s and return', async kind => {
  const f = fixture();
  let done!: () => void;
  vi.spyOn(f.api.delegation, 'sync').mockImplementation(() => new Promise(resolve => { done = () => resolve({ applied: 1, gaps: 0, cursor: null, ownerFresh: true }); }));
  const view = render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} onOpenLead={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Reconcile queued commands' }));
  if (kind === 'remount') {
    view.unmount();
    render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} onOpenLead={vi.fn()} />);
    await screen.findByRole('button', { name: 'Reconcile queued commands' });
  } else {
    const config = await f.api.delegation.status();
    f.setConfiguration(kind === 'pause' ? { ...config, state: 'paused' } : { ...config, workspaceId: 'foreign' });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.getByText(kind === 'pause' ? 'Configured paused' : 'Local configuration unavailable')).toBeTruthy());
    f.setConfiguration(config);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByText('Configured active');
  }
  const reads = f.calls.filter(c => c.method === 'daily.get').length;
  await act(async () => done());
  expect(f.calls.filter(c => c.method === 'daily.get')).toHaveLength(reads);
});

const render = (ui: Parameters<typeof testingRender>[0], options?: Parameters<typeof testingRender>[1]) => testingRender(ui, { wrapper: PresentationRoot, ...options });

Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.open = true; } });
Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.open = false; } });

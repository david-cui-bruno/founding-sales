// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { CalliePreloadApi } from '../../shared/preload';
import { SuppressionSection, SUPPRESSION_EMPTY, SUPPRESSION_KIND_LABELS, SUPPRESSION_PERMANENCE, SUPPRESSION_TRUNCATED, SUPPRESSION_UNAVAILABLE } from './SuppressionSection';
import type { SuppressionList } from '../../shared/contracts/replyFirstDraftContract';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const list = (overrides: Partial<SuppressionList> = {}): SuppressionList => ({
  generatedAt: '2026-09-18T12:00:00.000Z', truncated: false, entries: [
    { kind: 'never_call', subject: 'Fictional suppressed PM', accountId: 'account-1', observedAt: '2026-09-17T09:00:00.000Z',
      why: 'Never call this firm: you marked it, and that is permanent.', evidenceRef: 'command-1' },
    { kind: 'handle_opt_out', subject: 'manager@example.test', accountId: null, observedAt: '2026-09-16T09:00:00.000Z',
      why: 'This address is suppressed. Someone at this firm asked to stop, in a reply to one of these emails.', evidenceRef: 'thread-1:incoming-9' },
    { kind: 'retired_route', subject: '+14015550200', accountId: 'account-2', observedAt: '2026-09-12T09:00:00.000Z',
      why: 'Retired phone route: version 2 replaced this one, and the old value is never dialled or written again.', evidenceRef: null },
  ], ...overrides });

it('lists each kind with when and why, read-only and with no undo', async () => {
  const read = vi.fn<NonNullable<CalliePreloadApi['delegation']['readSuppression']>>(async () => list());
  const network = vi.fn((): never => { throw Error('Unexpected network effect'); });
  vi.stubGlobal('fetch', network);
  render(<SuppressionSection api={{ readSuppression: read }} />);
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  const section = screen.getByRole('region', { name: 'Suppressed' });
  expect(within(section).getByText(SUPPRESSION_PERMANENCE)).toBeTruthy();
  for (const label of [SUPPRESSION_KIND_LABELS.never_call, SUPPRESSION_KIND_LABELS.handle_opt_out, SUPPRESSION_KIND_LABELS.retired_route]) {
    expect(within(section).getByText(label)).toBeTruthy();
  }
  expect(within(section).getByRole('rowheader', { name: 'manager@example.test' })).toBeTruthy();
  expect(within(section).getByText('2026-09-12T09:00:00.000Z')).toBeTruthy();
  expect(within(section).getByText(/version 2 replaced this one/)).toBeTruthy();
  expect(within(section).getByText(/Evidence thread-1:incoming-9/)).toBeTruthy();
  // No undo, restore, remove or unsuppress control exists.
  expect(within(section).getAllByRole('button').map(button => button.textContent)).toEqual(['Refresh suppression list']);
  expect(network).not.toHaveBeenCalled();
  fireEvent.click(within(section).getByRole('button', { name: 'Refresh suppression list' }));
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
});

it('says an unreadable list is unknown rather than showing it as empty', async () => {
  const read = vi.fn<NonNullable<CalliePreloadApi['delegation']['readSuppression']>>(async () => { throw Error('Unavailable'); });
  render(<SuppressionSection api={{ readSuppression: read }} />);
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(SUPPRESSION_UNAVAILABLE));
  expect(screen.queryByText(SUPPRESSION_EMPTY)).toBeNull();
  expect(screen.queryByRole('table')).toBeNull();
});

it('keeps the last good list and says so when a later read fails', async () => {
  const read = vi.fn<NonNullable<CalliePreloadApi['delegation']['readSuppression']>>()
    .mockResolvedValueOnce(list()).mockRejectedValueOnce(Error('Unavailable'));
  render(<SuppressionSection api={{ readSuppression: read }} />);
  await waitFor(() => expect(screen.getByRole('table')).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: 'Refresh suppression list' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(SUPPRESSION_UNAVAILABLE));
  expect(screen.getByRole('rowheader', { name: 'manager@example.test' })).toBeTruthy();
});

it('reports truncation and an empty list honestly', async () => {
  const truncated = vi.fn<NonNullable<CalliePreloadApi['delegation']['readSuppression']>>(async () => list({ truncated: true }));
  render(<SuppressionSection api={{ readSuppression: truncated }} />);
  await waitFor(() => expect(screen.getByText(SUPPRESSION_TRUNCATED)).toBeTruthy());
  cleanup();
  const empty = vi.fn<NonNullable<CalliePreloadApi['delegation']['readSuppression']>>(async () => list({ entries: [] }));
  render(<SuppressionSection api={{ readSuppression: empty }} />);
  await waitFor(() => expect(screen.getByText(SUPPRESSION_EMPTY)).toBeTruthy());
  expect(screen.queryByRole('table')).toBeNull();
});

it('reads nothing at all when the bridge does not offer the read', () => {
  render(<SuppressionSection />);
  expect(screen.getByRole('region', { name: 'Suppressed' })).toBeTruthy();
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.getByText(SUPPRESSION_PERMANENCE)).toBeTruthy();
});

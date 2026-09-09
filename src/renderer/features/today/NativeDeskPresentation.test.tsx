// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { NativeDeskRoute } from './NativeDeskRoute';
import { dailyFixture, nativeDeskFixture } from './nativeDesk.fixture';

afterEach(cleanup);
it.each([
  ['today', 'No conversations queued.'],
  ['accounts', 'Your account library starts here.'],
  ['campaigns', 'No frozen campaigns to review.'],
] as const)('gives an empty %s surface a relevant welcome without asking for nonexistent work', async (surface, title) => {
  const f = nativeDeskFixture(dailyFixture({ workspaceId: null, accounts: [], calls: { accountIds: [], workloadConflict: false }, answers: [] }));
  render(<NativeDeskRoute api={f.api} surface={surface} onOpenLead={vi.fn()} />);
  await screen.findByTestId('native-desk');
  expect(screen.getByRole('heading', { name: title })).toBeTruthy();
  expect(screen.queryByText(/Select an item/)).toBeNull();
  expect(screen.getByText(/Local snapshot · remote freshness unknown/)).toBeTruthy();
  expect(screen.getByText(/Worker unavailable/)).toBeTruthy();
  expect(f.calls.every(call => ['daily.get', 'delegation.status', 'localWorkspace.get', 'localWorkspace.getCommitments'].includes(call.method))).toBe(true);
});
it('keeps refresh accessible and icon-only beside persistent truthful worker status', async () => {
  const f = nativeDeskFixture();
  render(<NativeDeskRoute api={f.api} onOpenLead={vi.fn()} />);
  const root = await screen.findByTestId('native-desk');
  const refresh = within(root).getByRole('button', { name: 'Refresh' });
  expect(refresh.textContent).toBe('');
  expect(refresh.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  expect(root.querySelector('.native-desk__connection summary')?.textContent).toContain('Worker freshness unknown');
  fireEvent.click(refresh);
  expect(screen.queryByText(/worker up to date/i)).toBeNull();
});
it('labels the queue and renders small decorative lane icons with real count badges', async () => {
  const f = nativeDeskFixture();
  render(<NativeDeskRoute api={f.api} onOpenLead={vi.fn()} />);
  const root = await screen.findByTestId('native-desk');
  expect(screen.getByRole('heading', { name: 'Your next conversations' })).toBeTruthy();
  const approvals = screen.getByRole('heading', { name: 'Needs your approval 2' });
  expect(approvals.querySelector('.native-desk__count')?.textContent).toBe('2');
  for (const lane of root.querySelectorAll('.native-desk__lane')) {
    expect(lane.querySelector('h2 svg')?.getAttribute('width')).toBe('14');
    expect(lane.querySelector('h2 svg')?.getAttribute('aria-hidden')).toBe('true');
  }
});
it('keeps an empty queue keyboard-focusable for scrolling', async () => {
  const f = nativeDeskFixture(dailyFixture({ accounts: [], calls: { accountIds: [], workloadConflict: false }, answers: [] }));
  render(<NativeDeskRoute api={f.api} onOpenLead={vi.fn()} />);
  await screen.findByTestId('native-desk');
  expect(screen.getByRole('navigation', { name: 'Today queue' }).tabIndex).toBe(0);
});

it('keeps the Calls label text separate from its decorative icon', async () => {
  const f = nativeDeskFixture();
  render(<NativeDeskRoute api={f.api} onOpenLead={vi.fn()} />);
  await screen.findByTestId('native-desk');
  const heading = screen.getByRole('heading', { name: /^Calls/ });
  const label = heading.querySelector('.native-desk__lane-label')!;
  expect(label.children).toHaveLength(0);
  expect(heading.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
});

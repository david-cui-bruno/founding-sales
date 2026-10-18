// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DiscoveryStatus } from '../src/renderer/settings/DiscoveryStatus.tsx';
import { LinkedinConnection } from '../src/renderer/settings/LinkedinConnection.tsx';

const bridge = vi.hoisted(() => ({ available: true, read: vi.fn(), command: vi.fn() }));
vi.mock('../src/renderer/app/bridges.ts', () => ({ operations: () => bridge.available ? bridge : undefined }));
beforeEach(() => { bridge.available = true; bridge.read.mockReset(); bridge.command.mockReset(); });
afterEach(cleanup);

it('reads discovery metadata only and distinguishes scheduling from authority', async () => {
  bridge.read.mockResolvedValue({ view: { discovery: { enabled: true, halted: false, dailyRemaining: 7, monthlyRemaining: 90, nextRunAt: '2026-10-19T10:00:00Z', lastResult: 'complete' }, candidates: [{ evidence: 'Private candidate quote' }], hasMore: false }, reason: null });
  render(<DiscoveryStatus available privacyKey="owner:1" />);
  await screen.findByText(/7 searches remaining today/);
  expect(bridge.read).toHaveBeenCalledExactlyOnceWith('sourcing.list', { status: 'needs_review', offset: 0 });
  expect(screen.getByText(/Turning research off also pauses/)).toBeTruthy();
  expect(screen.getByText(/subject to research and holds/)).toBeTruthy();
  expect(screen.queryByText(/Private candidate quote/)).toBeNull();
  expect(bridge.command).not.toHaveBeenCalled();
});

it('does not infer discovery permission from a failed or absent read', async () => {
  bridge.read.mockResolvedValue({ view: null, reason: 'admin_only' });
  render(<DiscoveryStatus available privacyKey="owner:1" />);
  expect(await screen.findByRole('status')).toHaveProperty('textContent', expect.stringContaining('could not be read'));
  expect(bridge.command).not.toHaveBeenCalled();
});

it('does not read or offer account actions in a read-only session', () => {
  render(<LinkedinConnection enabled={false} privacyKey="owner:1" />);
  expect(screen.getByText(/session is read-only/)).toBeTruthy();
  expect(bridge.read).not.toHaveBeenCalled();
  expect(bridge.command).not.toHaveBeenCalled();
});

it('fails closed without an account bridge and never connects on mount', async () => {
  bridge.available = false;
  render(<LinkedinConnection enabled privacyKey="owner:1" />);
  expect(await screen.findByRole('status')).toHaveProperty('textContent', expect.stringContaining('Could not read LinkedIn accounts'));
  expect(bridge.command).not.toHaveBeenCalled();
});

it('reads connection state only, with no policy or posting controls', async () => {
  bridge.read.mockResolvedValue({ view: { accounts: [], posts: [] }, notice: null });
  render(<LinkedinConnection enabled privacyKey="owner:1" />);
  await screen.findByText('Social accounts');
  expect(bridge.read).toHaveBeenCalledExactlyOnceWith('social.workspace', {});
  expect(bridge.command).not.toHaveBeenCalled();
  expect(screen.queryByText(/Prepare browser|Posting policy|Daily invitation/)).toBeNull();
});

it('ignores a previous owner read after becoming read-only', async () => {
  let resolve: (value: unknown) => void = () => undefined;
  bridge.read.mockReturnValue(new Promise(done => { resolve = done; }));
  const view = render(<LinkedinConnection enabled privacyKey="owner:1" />);
  await waitFor(() => expect(bridge.read).toHaveBeenCalledTimes(1));
  view.rerender(<LinkedinConnection enabled={false} privacyKey="owner:2" />);
  await act(async () => { resolve({ view: { accounts: [{ platform: 'linkedin', displayName: 'Previous private account' }], posts: [] } }); });
  expect(screen.queryByText(/Previous private account/)).toBeNull();
  expect(bridge.command).not.toHaveBeenCalled();
});

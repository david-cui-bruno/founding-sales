// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PresentationRoot } from '../../app/PresentationRoot';
import { NativeDeskRoute } from './NativeDeskRoute';
import { dailyFixture, localSnapshot, nativeDeskFixture } from './nativeDesk.fixture';

afterEach(cleanup);
it.each([
  ['today', 'No conversations queued.'],
  ['accounts', 'Your account library starts here.'],
  ['campaigns', 'No frozen campaigns to review.'],
] as const)('gives an empty %s surface a relevant welcome without asking for nonexistent work', async (surface, title) => {
  const f = nativeDeskFixture(dailyFixture({ workspaceId: null, accounts: [], calls: { accountIds: [], workloadConflict: false }, answers: [] }));
  render(<PresentationRoot><NativeDeskRoute onOpenImport={(): void => undefined} firstUse={f.firstUse} api={f.api} surface={surface} onOpenLead={vi.fn()} /></PresentationRoot>);
  await screen.findByTestId('native-desk');
  expect(screen.getByRole('heading', { name: title })).toBeTruthy();
  expect(screen.queryByText(/Select an item/)).toBeNull();
  expect(screen.getByText(/Local snapshot · remote freshness unknown/)).toBeTruthy();
  expect(screen.getByText(/Worker unavailable/)).toBeTruthy();
  expect(f.calls.every(call => ['daily.get', 'delegation.status', 'localWorkspace.get', 'localWorkspace.getCommitments'].includes(call.method))).toBe(true);
});
it('keeps refresh accessible and icon-only beside persistent truthful worker status', async () => {
  const f = nativeDeskFixture();
  render(<PresentationRoot><NativeDeskRoute onOpenImport={(): void => undefined} firstUse={f.firstUse} api={f.api} onOpenLead={vi.fn()} /></PresentationRoot>);
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
  render(<PresentationRoot><NativeDeskRoute onOpenImport={(): void => undefined} firstUse={f.firstUse} api={f.api} onOpenLead={vi.fn()} /></PresentationRoot>);
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
  render(<PresentationRoot><NativeDeskRoute onOpenImport={(): void => undefined} firstUse={f.firstUse} api={f.api} onOpenLead={vi.fn()} /></PresentationRoot>);
  await screen.findByTestId('native-desk');
  expect(screen.getByRole('navigation', { name: 'Today queue' }).tabIndex).toBe(0);
});

it('keeps the Calls label text separate from its decorative icon', async () => {
  const f = nativeDeskFixture();
  render(<PresentationRoot><NativeDeskRoute onOpenImport={(): void => undefined} firstUse={f.firstUse} api={f.api} onOpenLead={vi.fn()} /></PresentationRoot>);
  await screen.findByTestId('native-desk');
  const heading = screen.getByRole('heading', { name: /^Calls/ });
  const label = heading.querySelector('.native-desk__lane-label')!;
  expect(label.children).toHaveLength(0);
  expect(heading.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
});

it.each(['today', 'accounts', 'campaigns'] as const)('marks unresolved and first-failed %s as presentation only', async surface => {
  const f = nativeDeskFixture();
  let reject!: (error: Error) => void;
  f.api.daily.get = vi.fn(() => new Promise<ReturnType<typeof dailyFixture>>((_resolve, rejectPromise) => { reject = rejectPromise; }));
  const view = render(<PresentationRoot><NativeDeskRoute onOpenImport={(): void => undefined} firstUse={f.firstUse} api={f.api} surface={surface} onOpenLead={vi.fn()} /></PresentationRoot>);
  const presentation = view.container.querySelector('.presentation-root');
  const pending = screen.getByText('Loading daily workspace…').closest('section')!;
  expect(pending.getAttribute('data-presentation')).toBe('native-a');
  expect(pending.classList.contains('native-desk--pending')).toBe(true);
  expect(pending.hasAttribute('data-workflow-mode')).toBe(false);
  await waitFor(() => expect(f.api.daily.get).toHaveBeenCalledOnce());
  await act(async () => reject(new Error('unavailable')));
  expect(screen.getByText('Daily workspace unavailable. Retry the local read.').getAttribute('role')).toBe('status');
  expect(view.container.querySelector('.presentation-root')).toBe(presentation);
  expect(presentation?.getAttribute('data-presentation')).toBe('native-a');
  expect(pending.hasAttribute('data-workflow-mode')).toBe(false);
});
it('uses A informational chrome for unknown authority without inventing a workflow mode', async () => {
  const f = nativeDeskFixture(dailyFixture({ workflowMode: 'unknown' }));
  f.api.localWorkspace.get = vi.fn(async () => localSnapshot({ workflowMode: 'legacy' }));
  render(<PresentationRoot><NativeDeskRoute onOpenImport={(): void => undefined} firstUse={f.firstUse} api={f.api} onOpenLead={vi.fn()} /></PresentationRoot>);
  const section = (await screen.findByText(/Workflow mode unavailable or inconsistent/)).closest('section')!;
  expect(section.getAttribute('data-presentation')).toBe('native-a');
  expect(section.hasAttribute('data-workflow-mode')).toBe(false);
});
it.each(['today', 'accounts', 'campaigns'] as const)('retains common presentation when actual %s legacy is confirmed', async surface => {
  const f = nativeDeskFixture(dailyFixture({ workflowMode: 'legacy' }));
  const view = render(<PresentationRoot><NativeDeskRoute onOpenImport={(): void => undefined} firstUse={f.firstUse} api={f.api} surface={surface} legacy={<p>Actual legacy Today</p>} onOpenLead={vi.fn()} /></PresentationRoot>);
  await screen.findByText(surface === 'today' ? 'Actual legacy Today' : /Legacy workflow is active/);
  const root = view.container.querySelector('.presentation-root')!;
  expect(root.getAttribute('data-presentation')).toBe('native-a');
  expect(root.hasAttribute('data-workflow-mode')).toBe(false);
  expect(root.querySelector('[data-presentation]')).toBeNull();
});
it('marks the full desk without replacing its authoritative workflow mode', async () => {
  const f = nativeDeskFixture();
  render(<PresentationRoot><NativeDeskRoute onOpenImport={(): void => undefined} firstUse={f.firstUse} api={f.api} onOpenLead={vi.fn()} /></PresentationRoot>);
  const root = await screen.findByTestId('native-desk');
  expect(root.getAttribute('data-presentation')).toBe('native-a');
  expect(root.getAttribute('data-workflow-mode')).toBe('meeting_first');
});

it('selects A on the first failed daily read independently of pending assertions', async () => {
  const f = nativeDeskFixture();
  f.api.daily.get = vi.fn(async () => { throw new Error('unavailable'); });
  render(<PresentationRoot><NativeDeskRoute onOpenImport={(): void => undefined} firstUse={f.firstUse} api={f.api} onOpenLead={vi.fn()} /></PresentationRoot>);
  const section = (await screen.findByText('Daily workspace unavailable. Retry the local read.')).closest('section')!;
  expect(section.getAttribute('data-presentation')).toBe('native-a');
  expect(section.hasAttribute('data-workflow-mode')).toBe(false);
});

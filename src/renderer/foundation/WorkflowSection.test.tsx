// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkflowSection } from './WorkflowSection';
import { dailyFixture, localSnapshot, nativeDeskFixture } from '../features/today/nativeDesk.fixture';
import type { LocalWorkflowReceipt, LocalWorkspaceSnapshot } from '../../shared/contracts/localWorkspaceContract';
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('does not invent an applied receipt from mode alone or persist command identities', async () => {
  const f = nativeDeskFixture();
  const storage = vi.spyOn(Storage.prototype, 'setItem');
  f.setLocalSnapshot(localSnapshot({ workflowMode: 'meeting_first', transitionReceipt: null }));
  render(<WorkflowSection api={f.api.localWorkspace} />);
  await screen.findByText(/its transition receipt is unavailable/);
  expect(screen.queryByText('Native Desk is active.')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Switch to Native Desk' })).toBeNull();
  expect(f.calls.map(c => c.method)).toEqual(['localWorkspace.get']);
  expect(storage).not.toHaveBeenCalled();
});
it('holds failed initial status and enables acknowledgement only after a successful read', async () => {
  const f = nativeDeskFixture(dailyFixture({ workflowMode: 'legacy' }));
  vi.spyOn(f.api.localWorkspace, 'get').mockRejectedValueOnce(Error('private internal data'));
  render(<WorkflowSection api={f.api.localWorkspace} />);
  await screen.findByText(/Workflow status unavailable/);
  expect(screen.queryByRole('checkbox')).toBeNull();
  expect(screen.queryByText(/private internal data/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Check status' }));
  await screen.findByRole('checkbox', { name: /one-way local change/ });
  expect(f.calls.filter(c => c.method === 'localWorkspace.transition')).toHaveLength(0);
});
it('ignores late initial status after API replacement', async () => {
  const first = nativeDeskFixture(dailyFixture({ workflowMode: 'legacy' }));
  const second = nativeDeskFixture();
  let resolve!: (value: LocalWorkspaceSnapshot) => void;
  first.api.localWorkspace.get = () => new Promise(done => { resolve = done; });
  const view = render(<WorkflowSection api={first.api.localWorkspace} />);
  view.rerender(<WorkflowSection api={second.api.localWorkspace} />);
  await screen.findByText(/its transition receipt is unavailable/);
  await act(async () => resolve(localSnapshot({ workflowMode: 'legacy' })));
  expect(screen.queryByRole('checkbox')).toBeNull();
});
it('ignores a late transition response after navigation and recovers canonical receipt on reopening', async () => {
  const f = nativeDeskFixture(dailyFixture({ workflowMode: 'legacy' }));
  const transition = f.api.localWorkspace.transition;
  let release!: () => void;
  let committed!: LocalWorkflowReceipt;
  f.api.localWorkspace.transition = async command => {
    expect(Object.isFrozen(command)).toBe(true);
    committed = await transition(command);
    return new Promise(done => { release = () => done(committed); });
  };
  const storage = vi.spyOn(Storage.prototype, 'setItem');
  const view = render(<WorkflowSection api={f.api.localWorkspace} />);
  fireEvent.click(await screen.findByRole('checkbox', { name: /one-way local change/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Switch to Native Desk' }));
  await waitFor(() => expect(release).toBeTypeOf('function'));
  view.unmount();
  render(<WorkflowSection api={f.api.localWorkspace} />);
  await screen.findByText('Native Desk is active.');
  await act(async () => release());
  expect(screen.getByText(new RegExp(committed.manifestId))).toBeTruthy();
  expect(f.calls.filter(c => c.method === 'localWorkspace.transition')).toHaveLength(1);
  expect(storage).not.toHaveBeenCalled();
});
it('rejects a mismatched transition receipt and preserves the exact request for explicit retry', async () => {
  const f = nativeDeskFixture(dailyFixture({ workflowMode: 'legacy' }));
  const transition = f.api.localWorkspace.transition;
  f.api.localWorkspace.transition = async command => ({ ...await transition(command), commandId: 'other-command' });
  render(<WorkflowSection api={f.api.localWorkspace} />);
  fireEvent.click(await screen.findByRole('checkbox', { name: /one-way local change/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Switch to Native Desk' }));
  await screen.findByText(/Transition result is unknown/);
  expect(screen.queryByText('Native Desk is active.')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Check status' }));
  await screen.findByText('Native Desk is active.');
  expect(f.calls.filter(c => c.method === 'localWorkspace.transition')).toHaveLength(1);
});

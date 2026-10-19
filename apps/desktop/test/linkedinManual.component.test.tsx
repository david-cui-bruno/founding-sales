/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { LinkedinManualView } from '@fss/contracts';
import { LinkedinManualLedger, type LinkedinManualPorts } from '../src/renderer/social/LinkedinManualLedger.tsx';
import { DraftsProvider } from '../src/renderer/app/drafts.tsx';
const id = (digit: string) => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const ledgerId = id('1');
const initial = (): LinkedinManualView => ({
  accounts: [{ id: id('2'), displayName: 'Synthetic owner account' }],
  choices: [{ personId: id('3'), firmId: id('4'), claimId: id('5'), claimRevision: 1, relationshipId: id('6'), relationshipRevision: 1, personName: 'Sam Example', firmName: 'Example Firm', profile: 'https://www.linkedin.com/in/synthetic-example' }],
  ledgers: [], history: [], nextBefore: null, coverage: 'manual_owner_assertions_only',
});
const bound = (): LinkedinManualView => ({ ...initial(), ledgers: [{ id: ledgerId, accountId: id('2'), personId: id('3'), firmId: id('4'), personName: 'Sam Example', firmName: 'Example Firm', profile: 'https://www.linkedin.com/in/synthetic-example', bindingCurrent: true, connectionState: 'unknown', handoffRequired: false, sendingPermission: false, nativeObservation: false }] });
function ports(view = initial()): LinkedinManualPorts {
  return { read: vi.fn(async () => ({ view, reason: null })), bind: vi.fn(async () => ({ accepted: true, view: bound(), reason: null })), record: vi.fn(async () => ({ accepted: true, view: bound(), reason: null })) };
}
afterEach(cleanup);
it('lets the owner bind an existing CRM identity and record manual history without any send/Enable control', async () => {
  const api = ports();
  render(<LinkedinManualLedger ports={api} />);
  await screen.findByText(/You recorded this activity yourself/);
  fireEvent.change(screen.getByLabelText('LinkedIn ledger account'), { target: { value: id('2') } });
  fireEvent.change(screen.getByLabelText('Person, Firm and profile'), { target: { value: '0' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add manual ledger' }));
  await waitFor(() => expect(api.bind).toHaveBeenCalledOnce());
  await screen.findByText(/Connection: unknown/);
  fireEvent.change(screen.getByLabelText('Activity kind'), { target: { value: 'reply' } });
  fireEvent.change(screen.getByLabelText('Activity date and time'), { target: { value: '2026-10-01T13:00' } });
  fireEvent.click(screen.getByRole('button', { name: 'Record manual activity' }));
  await waitFor(() => expect(api.record).toHaveBeenCalledWith(expect.objectContaining({ ledgerId, kind: 'reply', connectionState: null, expectedRevision: 0 })));
  expect(screen.queryByRole('button', { name: /send|enable|invite now/i })).toBeNull();
});
it('shows latched handoff and retained corrections after remount/readback', async () => {
  const view = bound();
  view.ledgers[0]!.handoffRequired = true;
  view.history = [{ ledgerId, entryId: id('7'), expectedRevision: 0, revision: 1, sequence: '1', kind: 'reply', connectionState: null, occurredAt: '2026-10-01T13:00:00.000Z', recordedAt: '2026-10-01T14:00:00.000Z', voided: false, correction: null, ownerAssertion: true, channel: 'linkedin' }];
  const api = ports(view);
  const first = render(<LinkedinManualLedger ports={api} />);
  await screen.findByText(/Follow-up stopped across channels/);
  fireEvent.click(screen.getByRole('button', { name: /Correct record/ }));
  fireEvent.click(screen.getByLabelText('Mark record incorrect, retain history'));
  fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));
  await waitFor(() => expect(api.record).toHaveBeenCalledWith(expect.objectContaining({ entryId: id('7'), expectedRevision: 1, voided: true, correction: 'void' })));
  first.unmount();
  render(<LinkedinManualLedger ports={api} />);
  await screen.findByText(/Follow-up stopped across channels/);
  expect(screen.getByText(/Corrections never resume/)).toBeTruthy();
});
it('retries an uncertain acknowledgement with the identical command and entry IDs', async () => {
  const api = ports(bound());
  vi.mocked(api.record).mockResolvedValueOnce({ accepted: false, view: null, reason: 'offline' });
  render(<LinkedinManualLedger ports={api} />);
  await screen.findByText(/Connection: unknown/);
  fireEvent.change(screen.getByLabelText('Activity date and time'), { target: { value: '2026-10-01T13:00' } });
  fireEvent.click(screen.getByRole('button', { name: 'Record manual activity' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Retry saving this record' }));
  await waitFor(() => expect(api.record).toHaveBeenCalledTimes(2));
  expect(vi.mocked(api.record).mock.calls[0]![0]).toEqual(vi.mocked(api.record).mock.calls[1]![0]);
});

it('requires an explicit connection assertion and keeps genuine missing evidence visibly unavailable', async () => {
  const view = bound();
  view.ledgers[0] = { ...view.ledgers[0]!, bindingCurrent: false, profile: null, personName: null, firmName: null };
  const api = ports(view);
  render(<LinkedinManualLedger ports={api} />);
  await screen.findByText(/CRM\/profile evidence changed/);
  fireEvent.change(screen.getByLabelText('Activity kind'), { target: { value: 'connection' } });
  fireEvent.change(screen.getByLabelText('Owner-recorded connection state'), { target: { value: 'pending' } });
  fireEvent.click(screen.getByRole('button', { name: 'Record manual activity' }));
  await waitFor(() => expect(api.record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'connection', connectionState: 'pending' })));
  vi.mocked(api.read).mockResolvedValue({ view: null, reason: 'offline' });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh manual ledger' }));
  await screen.findByText(/Manual ledger unavailable/);
  expect(screen.queryByText(/Connection: unknown/)).toBeNull();
});

it('does not expose the previous session record when its delayed read completes', async () => {
  let release!: (answer: { view: LinkedinManualView; reason: null }) => void;
  const oldPorts = ports();
  vi.mocked(oldPorts.read).mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const nextPorts = ports(initial());
  const mounted = render(<DraftsProvider key="old"><LinkedinManualLedger ports={oldPorts} /></DraftsProvider>);
  await waitFor(() => expect(oldPorts.read).toHaveBeenCalled());
  mounted.rerender(<DraftsProvider key="new"><LinkedinManualLedger ports={nextPorts} /></DraftsProvider>);
  await waitFor(() => expect(nextPorts.read).toHaveBeenCalled());
  release({ view: bound(), reason: null });
  await waitFor(() => expect(screen.queryByText(/Connection: unknown/)).toBeNull());
});

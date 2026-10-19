// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RecordingsToSort } from '../src/renderer/recordings/RecordingsToSort.tsx';
import { resetRecordingsMemory, type RecordingsPorts } from '../src/renderer/recordings/recordingsMemory.ts';
import type { RecordingItem, RecordingsView } from '../src/shared/recordings.ts';
import { ManualSocialDestination, type ManualDestinationPorts } from '../src/renderer/social/ManualDestination.tsx';
import { factSourceLine, researchNotice } from '../src/renderer/researchView.ts';

const empty: RecordingsView = { folder: { path: '/fictional/recordings', isDefault: false, available: true }, items: [], notice: null };
const item: RecordingItem = { itemId: 'a'.repeat(32), version: 1, folderName: 'Fictional demo', startedAt: '2026-10-05T18:00:00.000Z', state: 'needs_matching', meetingId: null, uploaded: 0, total: 1, failure: null, choices: [] };
function ports(state: RecordingsPorts['state']): RecordingsPorts {
  return { state, chooseMeeting: vi.fn(async () => empty), ignore: vi.fn(async () => empty), retry: vi.fn(async () => empty) };
}
afterEach(() => { cleanup(); resetRecordingsMemory(); });

it('distinguishes an unreadable recordings list from empty and recovers with a read only', async () => {
  const api = ports(vi.fn<RecordingsPorts['state']>().mockRejectedValueOnce(new Error('fixture offline')).mockResolvedValue(empty));
  render(<RecordingsToSort ports={api} />);
  await screen.findByText(/Could not refresh recordings/);
  fireEvent.click(screen.getByRole('button', { name: 'Retry recordings' }));
  await waitFor(() => expect(screen.queryByTestId('recordings-to-sort')).toBeNull());
  expect(api.chooseMeeting).not.toHaveBeenCalled(); expect(api.ignore).not.toHaveBeenCalled(); expect(api.retry).not.toHaveBeenCalled();
});

it('explains a disabled meeting choice without inventing a match or changing the recording', async () => {
  const api = ports(async () => ({ ...empty, items: [item] }));
  render(<RecordingsToSort ports={api} />);
  await screen.findByText('No matching meetings found. Check the meeting time and calendar connection.');
  expect((screen.getByRole('button', { name: 'Choose meeting' }) as HTMLButtonElement).disabled).toBe(true);
  expect(api.chooseMeeting).not.toHaveBeenCalled();
});

it('collapses optional destination setup but exposes an uncertain registration and exact retry', async () => {
  const register = vi.fn<ManualDestinationPorts['register']>().mockResolvedValue({ accepted: false, reason: 'offline' });
  const { container } = render(<ManualSocialDestination collapsed ports={{ register }} onAdded={() => undefined} />);
  const details = container.querySelector('details');
  expect(details?.open).toBe(false);
  fireEvent.click(screen.getByText('Add a manual destination', { selector: 'summary' }));
  fireEvent.change(screen.getByLabelText('Account or Page identity'), { target: { value: 'fictional-page' } });
  fireEvent.change(screen.getByLabelText('Destination label'), { target: { value: 'Fictional Page' } });
  fireEvent.click(screen.getByLabelText('I reviewed this destination identity. This does not connect or verify provider access.'));
  fireEvent.click(screen.getByRole('button', { name: 'Add manual destination' }));
  await screen.findByText('No definite answer. Retry the same registration.');
  expect(details?.open).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Retry same registration' }));
  await waitFor(() => expect(register).toHaveBeenCalledTimes(2));
  expect(register.mock.calls[1]?.[0]).toEqual(register.mock.calls[0]?.[0]);
});

it('keeps research allowances conditional and sources truthful with plain fact labels', () => {
  expect(researchNotice('daily_cost_ceiling')).toBe('Research allowance used. Future runs depend on settings and holds.');
  expect(factSourceLine({ key: 'portfolio_size', sourceReference: 'https://example.test/about', retrievedAt: '2026-10-05T12:00:00.000Z', firstParty: false })).toBe('Portfolio size · example.test · 5 Oct 2026 · another source');
});

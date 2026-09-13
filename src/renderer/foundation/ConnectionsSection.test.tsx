// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { OutreachStatus } from '../../shared/contracts/outreachContract';
import { ConnectionsSection } from './ConnectionsSection';

const saved: OutreachStatus = { model: 'ready', modelName: 'saved-model', gmail: 'unconfigured', accountEmail: null, senderName: 'Saved Founder', postalAddress: '123 Saved St' };
function api() {
  const forbidden = vi.fn(async (): Promise<never> => { throw Error('Unexpected outreach action'); });
  return { status: vi.fn(async () => saved), configure: vi.fn(async () => saved), connectGmail: vi.fn(async () => saved), disconnectGmail: vi.fn(async () => saved), openDraft: forbidden, saveDraft: forbidden, generateDraft: forbidden, sendDraft: forbidden, inspectLocalAuthority: forbidden };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const refresh = () => screen.getByRole('button', { name: 'Refresh connection status' });
const disabled = (name: string) => (screen.getByRole('button', { name }) as HTMLButtonElement).disabled;
afterEach(cleanup);

it('recovers an initial read failure in place without starting any connection or outreach', async () => {
  const bridge = api(); bridge.status.mockRejectedValueOnce(Error('private-credential-diagnostic'));
  render(<ConnectionsSection api={bridge} />);
  await screen.findByRole('alert');
  for (const name of ['Save connections', 'Connect Gmail', 'Disconnect Gmail']) expect(disabled(name)).toBe(true);
  expect(screen.queryByText(/private-credential/)).toBeNull();
  fireEvent.change(screen.getByLabelText('Sender name'), { target: { value: 'My edited name' } });
  fireEvent.change(screen.getByLabelText('OpenAI API key'), { target: { value: 'entered-secret' } });
  fireEvent.click(refresh());
  await waitFor(() => expect(disabled('Save connections')).toBe(false));
  expect(bridge.status).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('alert')).toBeNull();
  expect((screen.getByLabelText('Sender name') as HTMLInputElement).value).toBe('My edited name');
  expect((screen.getByLabelText('OpenAI model') as HTMLInputElement).value).toBe('saved-model');
  expect((screen.getByLabelText('Postal address') as HTMLTextAreaElement).value).toBe('123 Saved St');
  expect((screen.getByLabelText('OpenAI API key') as HTMLInputElement).value).toBe('entered-secret');
  for (const method of ['configure', 'connectGmail', 'disconnectGmail', 'sendDraft'] as const) expect(bridge[method]).not.toHaveBeenCalled();
});

it('holds commands during refresh, keeps edits, and permits another explicit attempt after malformed status', async () => {
  const bridge = api(); const reading = deferred<OutreachStatus>();
  render(<ConnectionsSection api={bridge} />);
  await waitFor(() => expect(disabled('Save connections')).toBe(false));
  bridge.status.mockReturnValueOnce(reading.promise);
  fireEvent.click(refresh()); fireEvent.click(refresh());
  for (const name of ['Save connections', 'Connect Gmail', 'Disconnect Gmail', 'Refresh connection status']) expect(disabled(name)).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Connect Gmail' }));
  fireEvent.change(screen.getByLabelText('Postal address'), { target: { value: '456 Edited St' } });
  await act(async () => reading.resolve({ ...saved, model: 'invalid' } as unknown as OutreachStatus));
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(disabled('Save connections')).toBe(true);
  expect(bridge.status).toHaveBeenCalledTimes(2);
  expect(bridge.connectGmail).not.toHaveBeenCalled();
  fireEvent.click(refresh());
  await waitFor(() => expect(disabled('Save connections')).toBe(false));
  expect(bridge.status).toHaveBeenCalledTimes(3);
  expect((screen.getByLabelText('Postal address') as HTMLTextAreaElement).value).toBe('456 Edited St');
});

it.each(['resolve', 'reject'] as const)('ignores an old API read that will %s even when the same API returns', async outcome => {
  const first = api(); const other = api(); const obsolete = deferred<OutreachStatus>(); const current = deferred<OutreachStatus>();
  first.status.mockReturnValueOnce(obsolete.promise).mockReturnValueOnce(current.promise);
  const view = render(<ConnectionsSection api={first} />);
  view.rerender(<ConnectionsSection api={other} />);
  await waitFor(() => expect(disabled('Save connections')).toBe(false));
  view.rerender(<ConnectionsSection api={first} />);
  await act(async () => {
    if (outcome === 'resolve') obsolete.resolve({ ...saved, senderName: 'Obsolete person' });
    else obsolete.reject(Error('Obsolete private failure'));
  });
  expect(disabled('Save connections')).toBe(true);
  expect(disabled('Refresh connection status')).toBe(true);
  expect(screen.queryByRole('alert')).toBeNull();
  expect((screen.getByLabelText('Sender name') as HTMLInputElement).value).not.toBe('Obsolete person');
  await act(async () => current.resolve({ ...saved, senderName: 'Current person' }));
  expect(disabled('Save connections')).toBe(false);
  expect((screen.getByLabelText('Sender name') as HTMLInputElement).value).toBe('Current person');
  expect(first.status).toHaveBeenCalledTimes(2);
});

it('does not let an old command overwrite the replacement API or unlock its current command', async () => {
  const first = api(); const other = api(); const obsolete = deferred<OutreachStatus>(); const current = deferred<OutreachStatus>();
  first.connectGmail.mockReturnValueOnce(obsolete.promise);
  other.configure.mockReturnValueOnce(current.promise);
  const view = render(<ConnectionsSection api={first} />);
  await waitFor(() => expect(disabled('Connect Gmail')).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Connect Gmail' }));
  view.rerender(<ConnectionsSection api={other} />);
  await waitFor(() => expect(disabled('Save connections')).toBe(false));
  fireEvent.change(screen.getByLabelText('OpenAI API key'), { target: { value: 'new-api-secret' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save connections' }));
  await act(async () => obsolete.resolve({ ...saved, accountEmail: 'obsolete@example.com' }));
  expect(disabled('Refresh connection status')).toBe(true);
  expect(disabled('Save connections')).toBe(true);
  expect(screen.queryByText(/obsolete@example.com|Gmail connection completed/)).toBeNull();
  expect((screen.getByLabelText('OpenAI API key') as HTMLInputElement).value).toBe('new-api-secret');
  await act(async () => current.resolve(saved));
  expect(disabled('Refresh connection status')).toBe(false);
  expect((screen.getByLabelText('OpenAI API key') as HTMLInputElement).value).toBe('');
});

it('disables refresh when the bridge is unavailable', () => {
  render(<ConnectionsSection />);
  expect(disabled('Refresh connection status')).toBe(true);
  expect(disabled('Save connections')).toBe(true);
});

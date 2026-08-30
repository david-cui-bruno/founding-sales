// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppleSpikePreloadApi } from '../../shared/preload';
import { AppleSpikePanel } from './AppleSpikePanel';

const readyStatus = {
  enabled: true,
  bridge: { state: 'ready', helperVersion: '1.0.0', protocolVersion: 1 },
} as const;

function fakeApi(overrides: Partial<AppleSpikePreloadApi> = {}): AppleSpikePreloadApi {
  return {
    getStatus: vi.fn(async () => readyStatus),
    probeCapabilities: vi.fn(async () => ({
      action: 'probe_capabilities',
      outcome: 'completed',
      capabilities: {
        contacts: 'notDetermined',
        accessibility: 'notDetermined',
        callObservationAvailable: false,
        recordingControlAvailable: false,
      },
    })),
    requestContacts: vi.fn(async () => ({
      action: 'request_contacts', outcome: 'completed', contactAccess: 'full',
    })),
    promptAccessibility: vi.fn(async () => ({
      action: 'prompt_accessibility', outcome: 'completed', accessibilityTrusted: true,
    })),
    scanRecentNotes: vi.fn(async () => ({
      action: 'scan_recent_notes', outcome: 'completed', artifactCount: 0, truncated: false,
    })),
    scanTestMessages: vi.fn(async () => ({
      action: 'scan_test_messages', outcome: 'completed', sentCount: 0, receivedCount: 0, latestAt: null,
    })),
    startCallObservation: vi.fn(async () => ({
      action: 'start_call_observation', outcome: 'completed', observation: 'started',
    })),
    stopCallObservation: vi.fn(async () => ({
      action: 'stop_call_observation', outcome: 'completed', observation: 'stopped',
    })),
    sendTestMessage: vi.fn(async () => ({
      action: 'send_test_message', outcome: 'completed', delivery: 'sent',
    })),
    ...overrides,
  } as AppleSpikePreloadApi;
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('AppleSpikePanel', () => {
  it('stays hidden when the CLI-controlled status is disabled', async () => {
    const api = fakeApi({
      getStatus: vi.fn(async () => ({
        enabled: false,
        bridge: { state: 'disabled', reason: 'not_packaged_or_configured' },
      } as const)),
    });

    render(<AppleSpikePanel api={api} />);

    await waitFor(() => expect(api.getStatus).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('region', { name: 'Apple feasibility spike' })).toBeNull();
  });

  it('separates status, read-only, permission, and manual actions without false recording claims', async () => {
    render(<AppleSpikePanel api={fakeApi()} />);

    await screen.findByRole('region', { name: 'Apple feasibility spike' });
    expect(screen.getByRole('heading', { name: 'Read-only checks' })).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'Permission requests' })).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'Manual test actions' })).not.toBeNull();
    expect(screen.getByText(/manual Apple recording control/i)).not.toBeNull();
    expect(document.body.textContent?.toLowerCase()).not.toContain('recording armed');
    expect(document.body.textContent?.toLowerCase()).not.toContain('recording verified');
  });

  it('refreshes a starting helper status until it reaches a terminal state', async () => {
    vi.useFakeTimers();
    const getStatus = vi
      .fn<AppleSpikePreloadApi['getStatus']>()
      .mockResolvedValueOnce({ enabled: true, bridge: { state: 'starting' } })
      .mockResolvedValueOnce(readyStatus);
    render(<AppleSpikePanel api={fakeApi({ getStatus })} />);

    await act(async () => Promise.resolve());
    expect(screen.getByText('Helper starting')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Probe capabilities' }).hasAttribute('disabled')).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(1_000));

    expect(screen.getByText('Helper ready · v1.0.0')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Probe capabilities' }).hasAttribute('disabled')).toBe(false);
    expect(getStatus).toHaveBeenCalledTimes(2);
  });

  it('continues bounded refresh after ready and reflects a later degraded status', async () => {
    vi.useFakeTimers();
    const getStatus = vi
      .fn<AppleSpikePreloadApi['getStatus']>()
      .mockResolvedValueOnce(readyStatus)
      .mockResolvedValueOnce({
        enabled: true,
        bridge: {
          state: 'degraded',
          code: 'helper_exited',
          message: 'Apple integration helper exited unexpectedly.',
        },
      })
      .mockResolvedValueOnce({
        enabled: true,
        bridge: {
          state: 'disabled',
          reason: 'not_packaged_or_configured',
        },
      });
    render(<AppleSpikePanel api={fakeApi({ getStatus })} />);

    await act(async () => Promise.resolve());
    expect(screen.getByText('Helper ready · v1.0.0')).not.toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(1_000));

    expect(screen.getByText('Apple integration helper exited unexpectedly.')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Probe capabilities' }).hasAttribute('disabled')).toBe(true);
    expect(getStatus).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(screen.getByText('Helper unavailable')).not.toBeNull();
    expect(getStatus).toHaveBeenCalledTimes(3);
  });

  it('pauses status refresh while hidden and refreshes immediately on visibility and focus', async () => {
    vi.useFakeTimers();
    let visibility: DocumentVisibilityState = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    const getStatus = vi.fn<AppleSpikePreloadApi['getStatus']>(async () => readyStatus);
    render(<AppleSpikePanel api={fakeApi({ getStatus })} />);
    await act(async () => Promise.resolve());

    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(getStatus).toHaveBeenCalledTimes(1);

    visibility = 'visible';
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(getStatus).toHaveBeenCalledTimes(2);

    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(getStatus).toHaveBeenCalledTimes(3);
  });

  it('ignores a stale StrictMode status response from the cleaned-up effect generation', async () => {
    vi.useFakeTimers();
    const stale = deferred<Awaited<ReturnType<AppleSpikePreloadApi['getStatus']>>>();
    const current = deferred<Awaited<ReturnType<AppleSpikePreloadApi['getStatus']>>>();
    const getStatus = vi
      .fn<AppleSpikePreloadApi['getStatus']>()
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(current.promise);
    render(
      <StrictMode>
        <AppleSpikePanel api={fakeApi({ getStatus })} />
      </StrictMode>,
    );
    expect(getStatus).toHaveBeenCalledTimes(2);

    await act(async () => current.resolve(readyStatus));
    expect(screen.getByText('Helper ready · v1.0.0')).not.toBeNull();
    await act(async () => stale.resolve({
      enabled: true,
      bridge: {
        state: 'degraded',
        code: 'helper_exited',
        message: 'Stale helper failure.',
      },
    }));

    expect(screen.getByText('Helper ready · v1.0.0')).not.toBeNull();
    expect(screen.queryByText('Stale helper failure.')).toBeNull();
  });

  it('cancels pending status work and future refresh on unmount', async () => {
    vi.useFakeTimers();
    const pending = deferred<Awaited<ReturnType<AppleSpikePreloadApi['getStatus']>>>();
    const getStatus = vi.fn<AppleSpikePreloadApi['getStatus']>(() => pending.promise);
    const view = render(<AppleSpikePanel api={fakeApi({ getStatus })} />);
    expect(getStatus).toHaveBeenCalledTimes(1);

    view.unmount();
    await act(async () => pending.resolve(readyStatus));
    await act(async () => vi.advanceTimersByTimeAsync(5_000));

    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('region', { name: 'Apple feasibility spike' })).toBeNull();
  });

  it('requires the exact typed call phrase and disables double-submit', async () => {
    let resolve!: (value: {
      action: 'start_call_observation';
      outcome: 'completed';
      observation: 'started';
    }) => void;
    const pending = new Promise<{
      action: 'start_call_observation';
      outcome: 'completed';
      observation: 'started';
    }>((resolvePromise) => { resolve = resolvePromise; });
    const startCallObservation = vi.fn(() => pending);
    const api = fakeApi({ startCallObservation });
    render(<AppleSpikePanel api={api} />);
    await screen.findByRole('region', { name: 'Apple feasibility spike' });
    const button = screen.getByRole('button', { name: 'Start call observation' });

    expect(button.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText('Type call consent phrase'), {
      target: { value: 'I consent' },
    });
    expect(button.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText('Type call consent phrase'), {
      target: { value: 'I CONSENT TO THIS TEST CALL' },
    });
    expect(button.hasAttribute('disabled')).toBe(false);
    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(startCallObservation).toHaveBeenCalledTimes(1);
    expect(startCallObservation).toHaveBeenCalledWith({
      confirmation: 'I CONSENT TO THIS TEST CALL',
    });
    resolve({ action: 'start_call_observation', outcome: 'completed', observation: 'started' });
    await screen.findByText('Call observation started.');
    expect((screen.getByLabelText('Type call consent phrase') as HTMLInputElement).value).toBe('');
    expect(button.hasAttribute('disabled')).toBe(true);
    fireEvent.click(button);
    expect(startCallObservation).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText('Type call consent phrase'), {
      target: { value: 'I CONSENT TO THIS TEST CALL' },
    });
    fireEvent.click(button);
    await waitFor(() => expect(startCallObservation).toHaveBeenCalledTimes(2));
    expect(document.body.textContent?.toLowerCase()).not.toContain('recording armed');
    expect(document.body.textContent?.toLowerCase()).not.toContain('recording verified');
  });

  it('clears message consent whenever the approved handle or body changes', async () => {
    render(<AppleSpikePanel api={fakeApi()} />);
    await screen.findByRole('region', { name: 'Apple feasibility spike' });
    const consent = screen.getByLabelText('Type message consent phrase') as HTMLInputElement;
    const send = screen.getByRole('button', { name: 'Send test message' });
    fireEvent.change(screen.getByLabelText('Test message phone number'), {
      target: { value: '+15555550100' },
    });
    fireEvent.change(screen.getByLabelText('Test message body'), {
      target: { value: 'Approved body' },
    });
    fireEvent.change(consent, {
      target: { value: 'I CONSENT TO THIS TEST MESSAGE' },
    });
    expect(send.hasAttribute('disabled')).toBe(false);

    fireEvent.change(screen.getByLabelText('Test message body'), {
      target: { value: 'Changed body' },
    });
    expect(consent.value).toBe('');
    expect(send.hasAttribute('disabled')).toBe(true);

    fireEvent.change(consent, {
      target: { value: 'I CONSENT TO THIS TEST MESSAGE' },
    });
    fireEvent.change(screen.getByLabelText('Test message phone number'), {
      target: { value: '+15555550101' },
    });
    expect(consent.value).toBe('');
    expect(send.hasAttribute('disabled')).toBe(true);
  });

  it('snapshots an in-flight message, consumes consent, and requires retyping after failure', async () => {
    const first = deferred<Awaited<ReturnType<AppleSpikePreloadApi['sendTestMessage']>>>();
    const sendTestMessage = vi
      .fn<AppleSpikePreloadApi['sendTestMessage']>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({
        action: 'send_test_message',
        outcome: 'completed',
        delivery: 'sent',
      });
    const getStatus = vi.fn<AppleSpikePreloadApi['getStatus']>(async () => readyStatus);
    render(<AppleSpikePanel api={fakeApi({ getStatus, sendTestMessage })} />);
    await screen.findByRole('region', { name: 'Apple feasibility spike' });
    const consent = screen.getByLabelText('Type message consent phrase') as HTMLInputElement;
    const send = screen.getByRole('button', { name: 'Send test message' });
    fireEvent.change(screen.getByLabelText('Test message phone number'), {
      target: { value: '+15555550100' },
    });
    fireEvent.change(screen.getByLabelText('Test message body'), {
      target: { value: 'Original body' },
    });
    fireEvent.change(consent, {
      target: { value: 'I CONSENT TO THIS TEST MESSAGE' },
    });

    fireEvent.click(send);
    fireEvent.click(send);
    expect(consent.value).toBe('');
    expect(send.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText('Test message phone number'), {
      target: { value: '+15555550101' },
    });
    fireEvent.change(screen.getByLabelText('Test message body'), {
      target: { value: 'Edited while pending' },
    });
    expect(sendTestMessage).toHaveBeenCalledTimes(1);
    expect(sendTestMessage).toHaveBeenCalledWith({
      normalizedHandle: '+15555550100',
      body: 'Original body',
      confirmation: 'I CONSENT TO THIS TEST MESSAGE',
    });

    await act(async () => first.reject(new Error('/private/raw send failure')));
    await screen.findByText('The Apple feasibility operation could not be completed safely.');
    await waitFor(() => expect(getStatus).toHaveBeenCalledTimes(2));
    fireEvent.click(send);
    expect(sendTestMessage).toHaveBeenCalledTimes(1);

    fireEvent.change(consent, {
      target: { value: 'I CONSENT TO THIS TEST MESSAGE' },
    });
    fireEvent.click(send);
    await waitFor(() => expect(sendTestMessage).toHaveBeenCalledTimes(2));
    expect(sendTestMessage).toHaveBeenNthCalledWith(2, {
      normalizedHandle: '+15555550101',
      body: 'Edited while pending',
      confirmation: 'I CONSENT TO THIS TEST MESSAGE',
    });
  });

  it('refreshes helper status immediately after an operation fails', async () => {
    const getStatus = vi
      .fn<AppleSpikePreloadApi['getStatus']>()
      .mockResolvedValueOnce(readyStatus)
      .mockResolvedValueOnce({
        enabled: true,
        bridge: {
          state: 'degraded',
          code: 'helper_transport_failed',
          message: 'Apple integration helper communication failed.',
        },
      });
    const requestContacts = vi.fn<AppleSpikePreloadApi['requestContacts']>(async () => {
      throw new Error('/private/raw permission failure');
    });
    render(<AppleSpikePanel api={fakeApi({ getStatus, requestContacts })} />);
    await screen.findByText('Helper ready · v1.0.0');

    fireEvent.click(screen.getByRole('button', { name: 'Request Contacts access' }));

    expect(await screen.findByText('Apple integration helper communication failed.')).not.toBeNull();
    expect(getStatus).toHaveBeenCalledTimes(2);
  });

  it('passes only a validated handle, bounded body, and exact phrase to a test send', async () => {
    const sendTestMessage = vi.fn(async () => ({
      action: 'send_test_message' as const,
      outcome: 'completed' as const,
      delivery: 'sent' as const,
    }));
    render(<AppleSpikePanel api={fakeApi({ sendTestMessage })} />);
    await screen.findByRole('region', { name: 'Apple feasibility spike' });
    const send = screen.getByRole('button', { name: 'Send test message' });

    fireEvent.change(screen.getByLabelText('Test message phone number'), {
      target: { value: '+15555550100' },
    });
    fireEvent.change(screen.getByLabelText('Test message body'), {
      target: { value: 'Synthetic test' },
    });
    fireEvent.change(screen.getByLabelText('Type message consent phrase'), {
      target: { value: 'I CONSENT TO THIS TEST MESSAGE' },
    });
    expect(send.hasAttribute('disabled')).toBe(false);
    fireEvent.click(send);

    await waitFor(() => expect(sendTestMessage).toHaveBeenCalledWith({
      normalizedHandle: '+15555550100',
      body: 'Synthetic test',
      confirmation: 'I CONSENT TO THIS TEST MESSAGE',
    }));
    expect((screen.getByLabelText('Type message consent phrase') as HTMLInputElement).value).toBe('');
    expect(send.hasAttribute('disabled')).toBe(true);
    fireEvent.click(send);
    expect(sendTestMessage).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText('Type message consent phrase'), {
      target: { value: 'I CONSENT TO THIS TEST MESSAGE' },
    });
    fireEvent.click(send);
    await waitFor(() => expect(sendTestMessage).toHaveBeenCalledTimes(2));
  });

  it('consumes call consent when starting observation fails', async () => {
    const startCallObservation = vi.fn<AppleSpikePreloadApi['startCallObservation']>(async () => {
      throw new Error('/private/raw call failure');
    });
    render(<AppleSpikePanel api={fakeApi({ startCallObservation })} />);
    await screen.findByRole('region', { name: 'Apple feasibility spike' });
    const consent = screen.getByLabelText('Type call consent phrase') as HTMLInputElement;
    const start = screen.getByRole('button', { name: 'Start call observation' });
    fireEvent.change(consent, {
      target: { value: 'I CONSENT TO THIS TEST CALL' },
    });

    fireEvent.click(start);

    await screen.findByText('The Apple feasibility operation could not be completed safely.');
    expect(consent.value).toBe('');
    expect(start.hasAttribute('disabled')).toBe(true);
    fireEvent.click(start);
    expect(startCallObservation).toHaveBeenCalledTimes(1);
  });

  it('shows capability unavailable as an unavailable outcome, not success', async () => {
    const api = fakeApi({
      scanRecentNotes: vi.fn(async () => ({
        action: 'scan_recent_notes',
        outcome: 'capability_unavailable',
        message: 'This Apple feasibility operation is unavailable on this Mac.',
      } as const)),
    });
    render(<AppleSpikePanel api={api} />);
    await screen.findByRole('region', { name: 'Apple feasibility spike' });

    fireEvent.click(screen.getByRole('button', { name: 'Scan recent call notes' }));

    expect((await screen.findByRole('status')).textContent).toContain('unavailable on this Mac');
    expect(screen.getByRole('status').textContent?.toLowerCase()).not.toContain('complete');
  });
});

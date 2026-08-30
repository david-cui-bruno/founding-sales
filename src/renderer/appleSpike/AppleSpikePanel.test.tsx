// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
      action: 'probe_capabilities', outcome: 'completed', capabilities: {},
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
    await act(async () => vi.advanceTimersByTimeAsync(500));

    expect(screen.getByText('Helper ready · v1.0.0')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Probe capabilities' }).hasAttribute('disabled')).toBe(false);
    expect(getStatus).toHaveBeenCalledTimes(2);
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
    fireEvent.click(button);
    fireEvent.click(button);
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(startCallObservation).toHaveBeenCalledTimes(1);
    expect(startCallObservation).toHaveBeenCalledWith({
      confirmation: 'I CONSENT TO THIS TEST CALL',
    });
    resolve({ action: 'start_call_observation', outcome: 'completed', observation: 'started' });
    await screen.findByText('Call observation started.');
    expect(document.body.textContent?.toLowerCase()).not.toContain('recording armed');
    expect(document.body.textContent?.toLowerCase()).not.toContain('recording verified');
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

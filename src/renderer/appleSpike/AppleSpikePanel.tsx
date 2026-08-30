import { useEffect, useMemo, useRef, useState } from 'react';

import {
  APPLE_TEST_CALL_CONSENT,
  APPLE_TEST_MESSAGE_CONSENT,
  scanTestMessagesInputSchema,
  sendTestMessageInputSchema,
  type AppleSpikeResult,
  type AppleSpikeStatus,
} from '../../shared/appleSpikeContract';
import type { AppleSpikePreloadApi } from '../../shared/preload';

type AppleSpikePanelProps = {
  api: AppleSpikePreloadApi;
};

const safeResultMessage = (result: AppleSpikeResult): string => {
  if (result.outcome === 'capability_unavailable') return result.message;
  switch (result.action) {
    case 'probe_capabilities':
      return `Capability probe returned ${Object.keys(result.capabilities).length} fixed flags.`;
    case 'request_contacts':
      return `Contacts access: ${result.contactAccess.replace('_', ' ')}.`;
    case 'prompt_accessibility':
      return result.accessibilityTrusted
        ? 'Accessibility access is available.'
        : 'Accessibility access is not available.';
    case 'scan_recent_notes':
      return `Recent Notes scan found ${result.artifactCount} candidate call notes${result.truncated ? ' (bounded result)' : ''}.`;
    case 'scan_test_messages':
      return `Test activity: ${result.sentCount} sent, ${result.receivedCount} received.`;
    case 'start_call_observation':
      return 'Call observation started.';
    case 'stop_call_observation':
      return 'Call observation stopped.';
    case 'send_test_message':
      return 'Test message sent.';
  }
};

const bridgeStatusLabel = (status: AppleSpikeStatus): string => {
  switch (status.bridge.state) {
    case 'ready':
      return `Helper ready · v${status.bridge.helperVersion}`;
    case 'starting':
      return 'Helper starting';
    case 'disabled':
      return 'Helper unavailable';
    case 'degraded':
      return status.bridge.message;
  }
};

export const AppleSpikePanel = ({ api }: AppleSpikePanelProps) => {
  const mounted = useRef(true);
  const [status, setStatus] = useState<AppleSpikeStatus>();
  const [pendingAction, setPendingAction] = useState<string>();
  const [resultMessage, setResultMessage] = useState<string>();
  const [callConsent, setCallConsent] = useState('');
  const [activityHandle, setActivityHandle] = useState('');
  const [messageHandle, setMessageHandle] = useState('');
  const [messageBody, setMessageBody] = useState('');
  const [messageConsent, setMessageConsent] = useState('');

  useEffect(() => {
    mounted.current = true;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const loadStatus = async (): Promise<void> => {
      try {
        const nextStatus = await api.getStatus();
        if (!mounted.current) return;
        setStatus(nextStatus);
        if (nextStatus.enabled && nextStatus.bridge.state === 'starting') {
          refreshTimer = setTimeout(() => void loadStatus(), 500);
        }
      } catch {
        if (mounted.current) setStatus(undefined);
      }
    };
    void loadStatus();
    return () => {
      mounted.current = false;
      if (refreshTimer !== undefined) clearTimeout(refreshTimer);
    };
  }, [api]);

  const activityHandleValid = useMemo(
    () => scanTestMessagesInputSchema.safeParse({ normalizedHandle: activityHandle }).success,
    [activityHandle],
  );
  const messageValid = useMemo(
    () => sendTestMessageInputSchema.safeParse({
      normalizedHandle: messageHandle,
      body: messageBody,
      confirmation: messageConsent,
    }).success,
    [messageBody, messageConsent, messageHandle],
  );

  if (status?.enabled !== true) return null;

  const run = async (action: string, operation: () => Promise<AppleSpikeResult>): Promise<void> => {
    if (pendingAction !== undefined || status.bridge.state !== 'ready') return;
    setPendingAction(action);
    setResultMessage(undefined);
    try {
      const result = await operation();
      if (mounted.current) setResultMessage(safeResultMessage(result));
    } catch {
      if (mounted.current) setResultMessage('The Apple feasibility operation could not be completed safely.');
    } finally {
      if (mounted.current) setPendingAction(undefined);
    }
  };

  const busy = pendingAction !== undefined || status.bridge.state !== 'ready';

  return (
    <section className="apple-spike" aria-label="Apple feasibility spike">
      <header className="apple-spike__header">
        <div>
          <p className="apple-spike__eyebrow">Local macOS feasibility</p>
          <h2>Apple feasibility spike</h2>
        </div>
        <p className="apple-spike__bridge-state" aria-live="polite">
          {bridgeStatusLabel(status)}
        </p>
      </header>

      <p className="apple-spike__notice">
        These controls are test-only and manual. Call observation does not guarantee capture;
        use the manual Apple recording control whenever automatic control is unavailable.
      </p>

      <div className="apple-spike__grid">
        <section aria-labelledby="apple-read-only">
          <h3 id="apple-read-only">Read-only checks</h3>
          <div className="apple-spike__actions">
            <button type="button" disabled={busy} onClick={() => void run(
              'probe_capabilities',
              () => api.probeCapabilities(),
            )}>
              Probe capabilities
            </button>
            <button type="button" disabled={busy} onClick={() => void run(
              'scan_recent_notes',
              () => api.scanRecentNotes(),
            )}>
              Scan recent call notes
            </button>
          </div>
          <label htmlFor="activity-handle">Messages activity phone number</label>
          <input
            id="activity-handle"
            inputMode="tel"
            placeholder="+15555550100"
            value={activityHandle}
            onChange={(event) => setActivityHandle(event.target.value)}
          />
          <button
            type="button"
            disabled={busy || !activityHandleValid}
            onClick={() => void run(
              'scan_test_messages',
              () => api.scanTestMessages({ normalizedHandle: activityHandle }),
            )}
          >
            Scan test message activity
          </button>
        </section>

        <section aria-labelledby="apple-permissions">
          <h3 id="apple-permissions">Permission requests</h3>
          <p>macOS shows its own permission prompt when one is required.</p>
          <div className="apple-spike__actions">
            <button type="button" disabled={busy} onClick={() => void run(
              'request_contacts',
              () => api.requestContacts(),
            )}>
              Request Contacts access
            </button>
            <button type="button" disabled={busy} onClick={() => void run(
              'prompt_accessibility',
              () => api.promptAccessibility(),
            )}>
              Request Accessibility access
            </button>
          </div>
        </section>

        <section className="apple-spike__manual" aria-labelledby="apple-manual">
          <h3 id="apple-manual">Manual test actions</h3>

          <fieldset>
            <legend>Call observation</legend>
            <p>Type <code>{APPLE_TEST_CALL_CONSENT}</code> to enable the final start control.</p>
            <label htmlFor="call-consent">Type call consent phrase</label>
            <input
              id="call-consent"
              autoComplete="off"
              value={callConsent}
              onChange={(event) => setCallConsent(event.target.value)}
            />
            <div className="apple-spike__actions">
              <button
                type="button"
                disabled={busy || callConsent !== APPLE_TEST_CALL_CONSENT}
                onClick={() => void run(
                  'start_call_observation',
                  () => api.startCallObservation({ confirmation: APPLE_TEST_CALL_CONSENT }),
                )}
              >
                Start call observation
              </button>
              <button type="button" disabled={busy} onClick={() => void run(
                'stop_call_observation',
                () => api.stopCallObservation(),
              )}>
                Stop call observation
              </button>
            </div>
          </fieldset>

          <fieldset>
            <legend>One test message</legend>
            <label htmlFor="message-handle">Test message phone number</label>
            <input
              id="message-handle"
              inputMode="tel"
              placeholder="+15555550100"
              value={messageHandle}
              onChange={(event) => setMessageHandle(event.target.value)}
            />
            <label htmlFor="message-body">Test message body</label>
            <textarea
              id="message-body"
              rows={3}
              value={messageBody}
              onChange={(event) => setMessageBody(event.target.value)}
            />
            <p>Type <code>{APPLE_TEST_MESSAGE_CONSENT}</code> to enable the final send control.</p>
            <label htmlFor="message-consent">Type message consent phrase</label>
            <input
              id="message-consent"
              autoComplete="off"
              value={messageConsent}
              onChange={(event) => setMessageConsent(event.target.value)}
            />
            <button
              type="button"
              disabled={busy || !messageValid}
              onClick={() => void run(
                'send_test_message',
                () => api.sendTestMessage({
                  normalizedHandle: messageHandle,
                  body: messageBody,
                  confirmation: APPLE_TEST_MESSAGE_CONSENT,
                }),
              )}
            >
              Send test message
            </button>
          </fieldset>
        </section>
      </div>

      {resultMessage !== undefined && (
        <p className="apple-spike__result" role="status" aria-live="polite">
          {resultMessage}
        </p>
      )}
    </section>
  );
};

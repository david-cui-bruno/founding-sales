import { useEffect, useMemo, useRef, useState } from 'react';

import {
  APPLE_TEST_CALL_CONSENT,
  APPLE_TEST_MESSAGE_CONSENT,
  scanTestMessagesInputSchema,
  sendTestMessageInputSchema,
  type AppleSpikeObservationEvidence,
  type AppleSpikeResult,
  type AppleSpikeStatus,
} from '../../shared/appleSpikeContract';
import type { AppleSpikePreloadApi } from '../../shared/preload';

type AppleSpikePanelProps = {
  api: AppleSpikePreloadApi;
};

type ObservationEvidenceByCategory = {
  capability?: Extract<AppleSpikeObservationEvidence, { kind: 'capability' }>;
  identity?: Extract<AppleSpikeObservationEvidence, { kind: 'identity' }>;
  callState?: Extract<AppleSpikeObservationEvidence, { kind: 'call_state' }>;
};

type EvidenceSubscriptionState = 'idle' | 'pending' | 'ready' | 'failed';

const statusValueLabel = (value: string): string => value === 'notDetermined'
  ? 'not determined'
  : value;

const availabilityLabel = (available: boolean): string => available
  ? 'available'
  : 'unavailable';

const safeResultMessage = (result: AppleSpikeResult): string => {
  if (result.outcome === 'capability_unavailable') return result.message;
  switch (result.action) {
    case 'probe_capabilities': {
      const capabilities = result.capabilities;
      return [
        `Contacts: ${statusValueLabel(capabilities.contacts)}.`,
        `Accessibility: ${statusValueLabel(capabilities.accessibility)}.`,
        `Call-observation adapter: ${availabilityLabel(capabilities.callObservationAvailable)}.`,
        `Recording control: ${availabilityLabel(capabilities.recordingControlAvailable)}.`,
        `Manual recording fallback: ${capabilities.recordingControlAvailable ? 'available' : 'required'}.`,
      ].join(' ');
    }
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
      return 'Call observation started; waiting for native evidence.';
    case 'stop_call_observation':
      return 'Call observation stopped.';
    case 'send_test_message':
      return 'Test message sent.';
  }
};

const degradationReasonLabels = {
  accessibilityDenied: 'accessibility denied',
  phoneUIUnavailable: 'Phone UI unavailable',
  unsupportedPhoneUIVersion: 'unsupported Phone UI version',
  ambiguousPhoneState: 'ambiguous Phone state',
  noMacVisibleCall: 'no Mac-visible call',
  snapshotFailed: 'Phone UI snapshot failed',
  traversalDepthExceeded: 'Phone UI traversal depth exceeded',
  traversalNodeLimitExceeded: 'Phone UI traversal node limit exceeded',
  traversalCycleDetected: 'Phone UI traversal cycle detected',
  traversalDeadlineExceeded: 'Phone UI traversal deadline exceeded',
} as const satisfies Record<
  Extract<AppleSpikeObservationEvidence, {
    kind: 'capability';
    available: false;
  }>['reason'],
  string
>;

const observationEvidenceLabel = (evidence: AppleSpikeObservationEvidence): string => {
  switch (evidence.kind) {
    case 'capability':
      if (evidence.available === true) {
        return 'Call-observation capability: available.';
      }
      return `Call-observation capability: degraded — ${degradationReasonLabels[evidence.reason]}.`;
    case 'call_state':
      return `Call state: ${evidence.outgoing ? 'outgoing' : 'incoming'}, ${
        evidence.connected ? 'connected' : 'not connected'
      }, ${evidence.ended ? 'ended' : 'active'}, ${evidence.onHold ? 'on hold' : 'not on hold'}.`;
    case 'identity':
      return `Call identity: ${evidence.identity}.`;
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
  const operationInFlight = useRef(false);
  const operationGeneration = useRef(0);
  const [status, setStatus] = useState<AppleSpikeStatus>();
  const [statusRefreshRequest, setStatusRefreshRequest] = useState(0);
  const [pendingAction, setPendingAction] = useState<string>();
  const [resultMessage, setResultMessage] = useState<string>();
  const [callConsent, setCallConsent] = useState('');
  const [activityHandle, setActivityHandle] = useState('');
  const [messageHandle, setMessageHandle] = useState('');
  const [messageBody, setMessageBody] = useState('');
  const [messageConsent, setMessageConsent] = useState('');
  const [observationEvidence, setObservationEvidence] = useState<
    ObservationEvidenceByCategory
  >({});
  const [evidenceSubscriptionState, setEvidenceSubscriptionState] = useState<
    EvidenceSubscriptionState
  >('idle');

  useEffect(() => {
    let cancelled = false;
    let requestGeneration = 0;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;

    const clearRefreshTimer = (): void => {
      if (refreshTimer !== undefined) {
        clearTimeout(refreshTimer);
        refreshTimer = undefined;
      }
    };

    const scheduleRefresh = (): void => {
      clearRefreshTimer();
      if (cancelled || document.visibilityState === 'hidden') return;
      refreshTimer = setTimeout(() => void loadStatus(), 1_000);
    };

    const loadStatus = async (): Promise<void> => {
      clearRefreshTimer();
      if (cancelled || document.visibilityState === 'hidden') return;
      const generation = ++requestGeneration;
      let continueRefreshing = true;
      try {
        const nextStatus = await api.getStatus();
        if (cancelled || generation !== requestGeneration) return;
        setStatus(nextStatus);
        continueRefreshing = nextStatus.enabled;
      } catch {
        if (cancelled || generation !== requestGeneration) return;
      } finally {
        if (
          !cancelled
          && generation === requestGeneration
          && continueRefreshing
        ) {
          scheduleRefresh();
        }
      }
    };

    const invalidatePendingStatus = (): void => {
      requestGeneration += 1;
      clearRefreshTimer();
    };

    const handleVisibilityChange = (): void => {
      invalidatePendingStatus();
      if (document.visibilityState !== 'hidden') void loadStatus();
    };

    const handleFocus = (): void => {
      if (document.visibilityState === 'hidden') return;
      invalidatePendingStatus();
      void loadStatus();
    };

    void loadStatus();
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleFocus);

    return () => {
      cancelled = true;
      invalidatePendingStatus();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleFocus);
    };
  }, [api, statusRefreshRequest]);

  useEffect(() => () => {
    operationGeneration.current += 1;
    operationInFlight.current = false;
  }, []);

  useEffect(() => {
    setEvidenceSubscriptionState('idle');
    if (status?.enabled !== true || status.bridge.state !== 'ready') {
      setObservationEvidence({});
      return undefined;
    }
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    setEvidenceSubscriptionState('pending');
    void api.subscribeObservationEvidence((evidence) => {
      if (cancelled) return;
      setObservationEvidence((current) => {
        switch (evidence.kind) {
          case 'capability':
            return { ...current, capability: evidence };
          case 'identity':
            return { ...current, identity: evidence };
          case 'call_state':
            return { ...current, callState: evidence };
        }
      });
    }).then((cleanup) => {
      if (cancelled) {
        cleanup();
        return;
      }
      unsubscribe = cleanup;
      setEvidenceSubscriptionState('ready');
    }).catch(() => {
      if (!cancelled) {
        setObservationEvidence({});
        setEvidenceSubscriptionState('failed');
      }
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [api, status?.bridge.state, status?.enabled]);

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

  const run = async (
    action: string,
    operation: () => Promise<AppleSpikeResult>,
    onCompleted?: (result: AppleSpikeResult) => void,
  ): Promise<void> => {
    if (
      operationInFlight.current
      || pendingAction !== undefined
      || status.bridge.state !== 'ready'
    ) return;
    operationInFlight.current = true;
    const generation = ++operationGeneration.current;
    setPendingAction(action);
    setResultMessage(undefined);
    try {
      const result = await operation();
      if (generation === operationGeneration.current) {
        onCompleted?.(result);
        setResultMessage(safeResultMessage(result));
      }
    } catch {
      if (generation === operationGeneration.current) {
        setResultMessage('The Apple feasibility operation could not be completed safely.');
        setStatusRefreshRequest((request) => request + 1);
      }
    } finally {
      if (generation === operationGeneration.current) {
        operationInFlight.current = false;
        setPendingAction(undefined);
      }
    }
  };

  const busy = pendingAction !== undefined || status.bridge.state !== 'ready';

  const startCallObservation = (): void => {
    if (
      busy
      || evidenceSubscriptionState !== 'ready'
      || callConsent !== APPLE_TEST_CALL_CONSENT
    ) return;
    const input = { confirmation: APPLE_TEST_CALL_CONSENT } as const;
    setCallConsent('');
    setObservationEvidence({});
    void run(
      'start_call_observation',
      () => api.startCallObservation(input),
    );
  };

  const sendTestMessage = (): void => {
    if (busy) return;
    const parsed = sendTestMessageInputSchema.safeParse({
      normalizedHandle: messageHandle,
      body: messageBody,
      confirmation: messageConsent,
    });
    if (!parsed.success) return;
    const input = parsed.data;
    setMessageConsent('');
    void run('send_test_message', () => api.sendTestMessage(input));
  };

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
                disabled={
                  busy
                  || evidenceSubscriptionState !== 'ready'
                  || callConsent !== APPLE_TEST_CALL_CONSENT
                }
                onClick={startCallObservation}
              >
                Start call observation
              </button>
              <button type="button" disabled={busy} onClick={() => void run(
                'stop_call_observation',
                () => api.stopCallObservation(),
                (result) => {
                  if (
                    result.action === 'stop_call_observation'
                    && result.outcome === 'completed'
                  ) {
                    setObservationEvidence({});
                  }
                },
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
              onChange={(event) => {
                setMessageHandle(event.target.value);
                setMessageConsent('');
              }}
            />
            <label htmlFor="message-body">Test message body</label>
            <textarea
              id="message-body"
              rows={3}
              value={messageBody}
              onChange={(event) => {
                setMessageBody(event.target.value);
                setMessageConsent('');
              }}
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
              onClick={sendTestMessage}
            >
              Send test message
            </button>
          </fieldset>
        </section>
      </div>

      <section
        className="apple-spike__evidence"
        aria-labelledby="apple-observation-evidence"
      >
        <h3 id="apple-observation-evidence">Native observation evidence</h3>
        <div aria-live="polite">
          {observationEvidence.capability === undefined
            && observationEvidence.identity === undefined
            && observationEvidence.callState === undefined
            && <p>Waiting for sanitized native evidence.</p>}
          {observationEvidence.capability !== undefined
            && <p>{observationEvidenceLabel(observationEvidence.capability)}</p>}
          {observationEvidence.identity !== undefined
            && <p>{observationEvidenceLabel(observationEvidence.identity)}</p>}
          {observationEvidence.callState !== undefined
            && <p>{observationEvidenceLabel(observationEvidence.callState)}</p>}
          {evidenceSubscriptionState === 'failed' && (
            <p>Observation evidence subscription unavailable; Start remains disabled.</p>
          )}
        </div>
      </section>

      {resultMessage !== undefined && (
        <p className="apple-spike__result" role="status" aria-live="polite">
          {resultMessage}
        </p>
      )}
    </section>
  );
};

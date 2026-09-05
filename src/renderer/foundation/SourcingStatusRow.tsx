import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  PollDegradedReason,
  SourcingStatus,
} from '../../shared/contracts/sourcingContract';
import { StatusBadge, type StatusBadgeTone } from '../components/StatusBadge';

export type SourcingStatusApi = {
  status(): Promise<SourcingStatus>;
  retry(): Promise<SourcingStatus>;
};

const CREDENTIAL_LABELS: Record<SourcingStatus['credentialState'], string> = {
  keychain: 'keychain',
  file: 'file (import pending)',
  none: 'none',
};

const CREDENTIAL_TONES: Record<SourcingStatus['credentialState'], StatusBadgeTone> = {
  keychain: 'success',
  file: 'warning',
  none: 'danger',
};

const REASON_LABELS: Record<PollDegradedReason, string> = {
  POLL_EXCEEDED_TOTAL_DEADLINE: 'Poll exceeded its total deadline',
  NO_SUCCESS_WITHIN_TWO_CADENCES: 'No successful poll within 30 minutes',
  BACKLOG_PERSISTED_ACROSS_POLLS: 'Backlog persisted across completed polls',
  CREDENTIALS_WITHOUT_COMPLETED_POLL: 'Credentials are configured but no poll has completed',
};

export function formatRelativeLastPoll(
  lastPolledAt: string | null,
  now: () => number = Date.now,
): string {
  if (lastPolledAt === null) return 'never';
  const minutes = Math.floor((now() - Date.parse(lastPolledAt)) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const COUNTER_LABELS = [
  ['imported', 'Imported'], ['replayed', 'Replayed'],
  ['needsIdentity', 'Needs identity'], ['scoreUpdates', 'Score updates'],
  ['quarantined', 'Quarantined'],
] as const;

const POLL_TOTAL_DEADLINE_MS = 14 * 60_000;

export const SourcingStatusRow = ({ api }: { api: SourcingStatusApi }) => {
  const [status, setStatus] = useState<SourcingStatus | 'loading' | 'unavailable'>('loading');
  const [retrying, setRetrying] = useState(false);
  const active = useRef(true);
  const refresh = useRef<Promise<void> | null>(null);

  const load = useCallback((): Promise<void> => {
    if (refresh.current !== null) return refresh.current;
    const request = api.status().then(
      (value) => {
        refresh.current = null;
        if (active.current) setStatus(value);
      },
      () => {
        refresh.current = null;
        if (active.current) setStatus('unavailable');
      },
    );
    refresh.current = request;
    return request;
  }, [api]);

  useEffect(() => {
    active.current = true;
    void load();
    const interval = setInterval(() => { void load(); }, 60_000);
    return () => {
      active.current = false;
      clearInterval(interval);
    };
  }, [load]);

  const retry = async (): Promise<void> => {
    const runningIsFresh = typeof status !== 'string'
      && status.execution.state === 'running'
      && status.execution.startedAt !== null
      && Date.now() - Date.parse(status.execution.startedAt) <= POLL_TOTAL_DEADLINE_MS;
    if (retrying || runningIsFresh) return;
    setRetrying(true);
    try {
      const value = await api.retry();
      if (active.current) setStatus(value);
    } catch {
      if (active.current) setStatus('unavailable');
    } finally {
      if (active.current) setRetrying(false);
      await load();
    }
  };

  if (status === 'loading') return <p className="settings__quiet">Sourcing inbox: checking…</p>;
  if (status === 'unavailable') return <p className="settings__quiet">Sourcing inbox: unavailable</p>;
  const relative = formatRelativeLastPoll(status.execution.lastCompletedAt);
  const running = status.execution.state === 'running';
  const runningIsFresh = running
    && status.execution.startedAt !== null
    && Date.now() - Date.parse(status.execution.startedAt) <= POLL_TOTAL_DEADLINE_MS;
  return (
    <>
      <div className="settings__row">
        <span className="settings__row-label">Status</span>
        <StatusBadge
          tone={status.health.status === 'degraded' ? 'danger' : CREDENTIAL_TONES[status.credentialState]}
          label={`Sourcing inbox: ${CREDENTIAL_LABELS[status.credentialState]}, last success ${relative}`}
        />
      </div>
      <div className="settings__row">
        <span className="settings__row-label">Poll</span>
        <span>{running ? 'Running' : 'Idle'}</span>
      </div>
      <div className="settings__row">
        <span className="settings__row-label">Backlog</span>
        <span className="numeric">{status.execution.backlogCount ?? 'Unknown'}</span>
      </div>
      {status.health.reasons.length > 0 && (
        <ul aria-label="Sourcing health reasons">
          {status.health.reasons.map((reason) => <li key={reason}>{REASON_LABELS[reason]}</li>)}
        </ul>
      )}
      <button
        type="button"
        className="settings__action"
        disabled={retrying || runningIsFresh}
        onClick={() => { void retry(); }}
      >
        {retrying ? 'Retrying…' : 'Retry sourcing poll'}
      </button>
      <dl className="settings__counters">
        {COUNTER_LABELS.map(([key, label]) => (
          <div key={key} className="settings__counter">
            <dt>{label}</dt><dd className="numeric">{status.counters[key]}</dd>
          </div>
        ))}
      </dl>
    </>
  );
};

import { useEffect, useState } from 'react';

import type { SourcingStatus } from '../../shared/contracts/sourcingContract';
import { StatusBadge, type StatusBadgeTone } from '../components/StatusBadge';

export type SourcingStatusApi = {
  status(): Promise<SourcingStatus>;
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

/** Compact relative time for the last poll; exact time stays in the title. */
export function formatRelativeLastPoll(
  lastPolledAt: string | null,
  now: () => number = Date.now,
): string {
  if (lastPolledAt === null) {
    return 'never';
  }
  const elapsedMs = now() - Date.parse(lastPolledAt);
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const COUNTER_LABELS = [
  ['imported', 'Imported'],
  ['replayed', 'Replayed'],
  ['needsIdentity', 'Needs identity'],
  ['scoreUpdates', 'Score updates'],
  ['quarantined', 'Quarantined'],
] as const;

/**
 * Read-only sourcing inbox status for Settings → Sourcing: a credential
 * badge with the relative last poll, plus the session counters in a quiet
 * definition grid. Never blocks diagnostics on a sourcing failure; an
 * unreachable status renders as unavailable.
 */
export const SourcingStatusRow = ({ api }: { api: SourcingStatusApi }) => {
  const [status, setStatus] = useState<SourcingStatus | 'loading' | 'unavailable'>(
    'loading',
  );

  useEffect(() => {
    let active = true;
    api.status().then(
      (value) => {
        if (active) setStatus(value);
      },
      () => {
        if (active) setStatus('unavailable');
      },
    );
    return () => {
      active = false;
    };
  }, [api]);

  if (status === 'loading') {
    return <p className="settings__quiet">Sourcing inbox: checking…</p>;
  }
  if (status === 'unavailable') {
    return <p className="settings__quiet">Sourcing inbox: unavailable</p>;
  }
  const relative = formatRelativeLastPoll(status.lastPolledAt);
  return (
    <>
      <div className="settings__row">
        <span className="settings__row-label">Status</span>
        <StatusBadge
          tone={CREDENTIAL_TONES[status.credentialState]}
          label={`Sourcing inbox: ${
            CREDENTIAL_LABELS[status.credentialState]
          }, last poll ${relative}`}
        />
      </div>
      <dl className="settings__counters">
        {COUNTER_LABELS.map(([key, label]) => (
          <div key={key} className="settings__counter">
            <dt>{label}</dt>
            <dd className="numeric">{status.counters[key]}</dd>
          </div>
        ))}
      </dl>
    </>
  );
};

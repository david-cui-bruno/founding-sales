import { useEffect, useState } from 'react';

import type { SourcingStatus } from '../../shared/contracts/sourcingContract';

export type SourcingStatusApi = {
  status(): Promise<SourcingStatus>;
};

const CREDENTIAL_LABELS: Record<SourcingStatus['credentialState'], string> = {
  keychain: 'keychain',
  file: 'file (import pending)',
  none: 'none',
};

/**
 * Read-only sourcing inbox row for the foundation diagnostics section:
 * credential state plus last poll time. Never blocks diagnostics on a
 * sourcing failure; an unreachable status renders as unavailable.
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
    return <p className="diagnostics__status">Sourcing inbox: checking…</p>;
  }
  if (status === 'unavailable') {
    return <p className="diagnostics__status">Sourcing inbox: unavailable</p>;
  }
  const lastPoll = status.lastPolledAt === null
    ? 'never'
    : new Date(status.lastPolledAt).toLocaleString();
  return (
    <p className="diagnostics__status">
      Sourcing inbox: {CREDENTIAL_LABELS[status.credentialState]}, last poll {lastPoll}
    </p>
  );
};

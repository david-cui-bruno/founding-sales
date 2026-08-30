import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { AppHealth } from '../shared/healthContract';
import { AppleSpikePanel } from './appleSpike/AppleSpikePanel';

export type DiagnosticsState =
  | { status: 'loading' }
  | { status: 'ready'; health: AppHealth }
  | { status: 'failed' };

type DiagnosticsScreenProps = {
  state: DiagnosticsState;
  onRetry: () => void;
  children?: ReactNode;
};

export const DiagnosticsScreen = ({
  state,
  onRetry,
  children,
}: DiagnosticsScreenProps) => (
  <main className="diagnostics" aria-labelledby="app-title">
    <header className="diagnostics__header">
      <p className="diagnostics__eyebrow">Local foundation diagnostics</p>
      <h1 id="app-title">Callie Founder Sales System</h1>
    </header>

    {state.status === 'loading' && (
      <p role="status">Checking local foundation…</p>
    )}

    {state.status === 'ready' && <HealthDetails health={state.health} />}

    {state.status === 'failed' && (
      <section
        className="diagnostics__failure"
        aria-labelledby="database-error"
        aria-live="assertive"
        role="alert"
      >
        <h2 id="database-error">The local database could not be opened</h2>
        <p>
          Error code: <code>LOCAL_DATABASE_UNAVAILABLE</code>
        </p>
        <button type="button" onClick={onRetry}>
          Retry
        </button>
      </section>
    )}
    {children}
  </main>
);

const HealthDetails = ({ health }: { health: AppHealth }) => (
  <section aria-label="Foundation health">
    <p className="diagnostics__status" role="status">
      SQLite ready
    </p>
    <p className="diagnostics__status">
      {health.fts5Available ? 'FTS5 available' : 'FTS5 unavailable'}
    </p>
    <dl className="diagnostics__details">
      <div>
        <dt>App version</dt>
        <dd>{health.appVersion}</dd>
      </div>
      <div>
        <dt>Schema</dt>
        <dd>Schema {health.schemaVersion}</dd>
      </div>
      <div>
        <dt>Database location</dt>
        <dd>
          <code>{health.databasePath}</code>
        </dd>
      </div>
      <div>
        <dt>Active job count</dt>
        <dd>{health.pendingJobs}</dd>
      </div>
      <div>
        <dt>Recovery count</dt>
        <dd>{health.interruptedJobsRecovered}</dd>
      </div>
    </dl>
  </section>
);

export const App = () => {
  const [state, setState] = useState<DiagnosticsState>({ status: 'loading' });
  const mounted = useRef(true);
  const latestRequest = useRef(0);

  const loadHealth = useCallback(async () => {
    const request = ++latestRequest.current;
    if (mounted.current) {
      setState({ status: 'loading' });
    }

    try {
      const health = await window.callie.health.get();
      if (mounted.current && request === latestRequest.current) {
        setState({ status: 'ready', health });
      }
    } catch {
      if (mounted.current && request === latestRequest.current) {
        setState({ status: 'failed' });
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void loadHealth();

    return () => {
      mounted.current = false;
      latestRequest.current += 1;
    };
  }, [loadHealth]);

  return (
    <DiagnosticsScreen state={state} onRetry={() => void loadHealth()}>
      <AppleSpikePanel api={window.callie.appleSpike} />
    </DiagnosticsScreen>
  );
};

import type { ReactNode } from 'react';

import type { AppHealth } from '../../shared/healthContract';

export type DiagnosticsState =
  | { status: 'loading' }
  | { status: 'ready'; health: AppHealth }
  | { status: 'failed' };

type DiagnosticsScreenProps = {
  state: DiagnosticsState;
  onRetry: () => void;
  children?: ReactNode;
};

/**
 * Foundation diagnostics extracted from the root App. Failure copy stays
 * stable and never exposes raw errors or internal paths.
 */
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
      Encrypted SQLite ready
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

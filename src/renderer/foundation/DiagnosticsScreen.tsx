import type { ReactNode } from 'react';

import type { AppHealth } from '../../shared/healthContract';
import type { HealthObservation } from './useFoundationHealth';

export type DiagnosticsState =
  | { status: 'loading' }
  | { status: 'ready'; health: AppHealth }
  | { status: 'failed' };

type DiagnosticsScreenProps = {
  state: DiagnosticsState;
  onRetry: () => void;
  observation?: HealthObservation;
  children?: ReactNode;
};

/**
 * Foundation diagnostics extracted from the root App. Failure copy stays
 * stable and never exposes raw errors or internal paths.
 */
export const DiagnosticsScreen = ({
  state,
  onRetry,
  observation,
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
        aria-labelledby="diagnostic-read-error"
        aria-live="assertive"
        role="alert"
      >
        <h2 id="diagnostic-read-error">The diagnostic read could not be completed</h2>
        <p>
          Error code: <code>DIAGNOSTIC_READ_FAILED</code>
        </p>
        <button type="button" onClick={onRetry}>
          Retry
        </button>
      </section>
    )}
    <HealthObservationStatus observation={observation} onRetry={onRetry} />
    {children}
  </main>
);

/** Renderer observation only. Never a dialog, focus target or domain permission. */
export function HealthObservationStatus({ observation, onRetry }: { observation?: HealthObservation; onRetry(): void }) {
  return <section className="health-observation" aria-label="Diagnostic observation">
    {observation?.checkedAt ? <p>Last successful read: <time dateTime={observation.checkedAt}>{observation.checkedAt}</time>{observation.refreshFailed ? ' (stale)' : ''}</p> : <p>Last read time unavailable</p>}
    {observation?.refreshing && <p role="status">Refreshing diagnostics…</p>}
    {observation?.refreshFailed && observation.checkedAt && <p role="alert">Diagnostics refresh could not be confirmed. The last successful read is stale. Your work is kept.</p>}
    <button type="button" onClick={onRetry}>Refresh diagnostics</button>
  </section>;
}

export const HealthDetails = ({ health }: { health: AppHealth }) => (
  <section aria-label="Foundation health">
    {(!health.domainReady || health.domainStatus !== 'ready') && <p role="status">The startup audit is blocked or inconsistent. Normal workspace routes are unavailable. Refresh diagnostics reads the existing foundation only, it does not repair or reinitialize it.</p>}
    <p className="diagnostics__status" role="status">
      Encrypted SQLite ready
    </p>
    <p className="diagnostics__status">
      {health.fts5Available ? 'FTS5 available' : 'FTS5 unavailable'}
    </p>
    <dl className="diagnostics__details">
      <div><dt>Domain status</dt><dd>{health.domainStatus}</dd></div>
      <div><dt>Startup audit evaluated at</dt><dd><time dateTime={health.domainStartupEvaluatedAt}>{health.domainStartupEvaluatedAt}</time></dd></div>
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

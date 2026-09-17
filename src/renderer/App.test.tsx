import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AppHealth } from '../shared/healthContract';
import { DiagnosticsScreen, type DiagnosticsState } from './App';

const health: AppHealth = {
  appVersion: '1.0.0',
  schemaVersion: 2,
  databasePath: '/tmp/callie.sqlite3',
  databaseEncrypted: true,
  cipherVersion: 'SQLite3 Multiple Ciphers 2.3.5',
  fts5Available: true,
  pendingJobs: 2,
  interruptedJobsRecovered: 1,
  domainStatus: 'ready',
  domainReady: true,
  domainBlockingViolationCount: 0,
  domainRepairableIssueCount: 0,
  domainProjectionRefreshCandidateCount: 0,
  pendingProjectionRebuilds: 0,
  domainStartupEvaluatedAt: '2026-08-30T12:00:00.000Z',
};

const renderState = (state: DiagnosticsState): string =>
  renderToStaticMarkup(
    <DiagnosticsScreen state={state} onRetry={vi.fn()} />,
  );

describe('DiagnosticsScreen', () => {
  it('renders the local foundation loading state', () => {
    expect(renderState({ status: 'loading' })).toContain(
      'Checking local foundation…',
    );
  });

  it('renders the structured ready health values', () => {
    const markup = renderState({ status: 'ready', health });

    expect(markup).toContain('Callie Founder Sales System');
    expect(markup).toContain('Encrypted SQLite ready');
    expect(markup).toContain('FTS5 available');
    expect(markup).toContain('Schema 2');
    expect(markup).toContain('1.0.0');
    expect(markup).toContain('/tmp/callie.sqlite3');
    expect(markup).toContain('Active job count');
    expect(markup).toContain('Recovery count');
    expect(markup).toContain('2');
    expect(markup).toContain('1');
  });

  it('renders a safe failed state without raw IPC errors', () => {
    const markup = renderState({ status: 'failed' });

    expect(markup).toContain('The diagnostic read could not be completed');
    expect(markup).toContain('DIAGNOSTIC_READ_FAILED');
    expect(markup).not.toContain('database unavailable at /private');
  });

  it('renders a Retry button for a failed health request', () => {
    const markup = renderState({ status: 'failed' });

    expect(markup).toContain('<button type="button">Retry</button>');
  });
});

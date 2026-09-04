// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppHealth } from '../../shared/healthContract';
import type { SourcingStatus } from '../../shared/contracts/sourcingContract';
import type { DensityState } from '../app/useDensity';
import type { ThemeState } from '../app/useTheme';
import { SettingsScreen } from './SettingsScreen';
import { formatRelativeLastPoll, SourcingStatusRow } from './SourcingStatusRow';

const health: AppHealth = {
  appVersion: '1.2.3',
  schemaVersion: 9,
  databasePath: '/Users/founder/Library/callie.sqlite3',
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
  operationalStatus: 'ready',
  sourcing: {
    status: 'healthy', reasons: [], lastSuccessAgeMs: null,
    state: {
      state: 'idle', pollId: null, startedAt: null, lastCompletedAt: null,
      consecutiveFailures: 0, lastFailureAt: null, lastFailureCode: null,
      backlogCount: null,
    },
  },
};

const theme: ThemeState = {
  preference: 'system',
  resolvedTheme: 'light',
  setPreference: vi.fn(),
};

const density: DensityState = {
  density: 'comfortable',
  setDensity: vi.fn(),
};

function renderSettings(
  overrides: Partial<Parameters<typeof SettingsScreen>[0]> = {},
) {
  return render(
    <SettingsScreen
      state={{ status: 'ready', health }}
      onRetry={vi.fn()}
      theme={theme}
      density={density}
      {...overrides}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SettingsScreen', () => {
  it('renders a master-detail with six sections and Diagnostics selected by default', () => {
    renderSettings();

    const sections = screen.getByRole('navigation', { name: 'Settings sections' });
    for (const label of [
      'Appearance', 'Data & storage', 'Sourcing',
      'Diagnostics', 'Keyboard shortcuts', 'About',
    ]) {
      expect(within(sections).getByRole('button', { name: label })).toBeTruthy();
    }

    // Diagnostics is the default detail: its exact strings are visible
    // without a click, and the other sections stay unrendered.
    expect(
      within(sections)
        .getByRole('button', { name: 'Diagnostics' })
        .getAttribute('aria-current'),
    ).toBe('true');
    expect(screen.getByRole('region', { name: 'Diagnostics' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Appearance' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'About' })).toBeNull();
  });

  it('shows only the selected section in the detail pane', () => {
    renderSettings();

    fireEvent.click(screen.getByRole('button', { name: 'Appearance' }));

    expect(screen.getByRole('region', { name: 'Appearance' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Diagnostics' })).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Appearance' }).getAttribute('aria-current'),
    ).toBe('true');
    expect(
      screen.getByRole('button', { name: 'Diagnostics' }).getAttribute('aria-current'),
    ).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Sourcing' }));
    expect(screen.getByRole('region', { name: 'Sourcing' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Appearance' })).toBeNull();
  });

  it('keeps the exact diagnostics strings the packaged E2E asserts', () => {
    renderSettings();

    expect(screen.getByText('Encrypted SQLite ready')).toBeTruthy();
    expect(screen.getByText('FTS5 available')).toBeTruthy();
    expect(screen.getByText('Schema 9')).toBeTruthy();
    expect(screen.getByText('Operations ready')).toBeTruthy();
  });

  it('shows the database path in monospace with copy and reveal actions', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const revealDatabase = vi.fn(async () => ({ revealed: true }));
    renderSettings({ shell: { revealDatabase } });
    fireEvent.click(screen.getByRole('button', { name: 'Data & storage' }));

    expect(
      screen.getByText('/Users/founder/Library/callie.sqlite3'),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Copy path' }));
    expect(writeText).toHaveBeenCalledWith('/Users/founder/Library/callie.sqlite3');

    fireEvent.click(screen.getByRole('button', { name: 'Reveal in Finder' }));
    expect(revealDatabase).toHaveBeenCalledTimes(1);
  });

  it('hides the reveal action when no shell api is wired', () => {
    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Data & storage' }));

    expect(screen.queryByRole('button', { name: 'Reveal in Finder' })).toBeNull();
  });

  it('lists the keyboard cheat sheet and about facts', () => {
    renderSettings();

    fireEvent.click(screen.getByRole('button', { name: 'Keyboard shortcuts' }));
    expect(screen.getByText('⌘K')).toBeTruthy();
    expect(screen.getByText('J / K')).toBeTruthy();
    expect(screen.getByText('E / H / P')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'About' }));
    const about = screen.getByRole('region', { name: 'About' });
    expect(about.textContent).toContain('1.2.3');
    expect(about.textContent).toContain('9');
  });

  it('keeps the stable failure copy without raw errors', () => {
    renderSettings({ state: { status: 'failed' } });

    expect(screen.getByRole('alert').textContent).toContain(
      'The local database could not be opened',
    );
    expect(screen.getByText('LOCAL_DATABASE_UNAVAILABLE')).toBeTruthy();
  });
});

describe('SourcingStatusRow', () => {
  const sourcingStatus: SourcingStatus = {
    lastPolledAt: '2026-08-31T15:00:00.000Z',
    lastKey: null as string | null,
    backlogCount: null as number | null,
    counters: {
      imported: 4, replayed: 1, needsIdentity: 2, scoreUpdates: 3, quarantined: 0,
    },
    credentialState: 'keychain' as const,
    hmacSaltState: 'set' as const,
    execution: {
      state: 'idle' as const, pollId: null, startedAt: null,
      lastCompletedAt: '2026-08-31T15:00:00.000Z', consecutiveFailures: 0,
      lastFailureAt: null, lastFailureCode: null, backlogCount: 0,
    },
    health: {
      status: 'healthy' as const, reasons: [], lastSuccessAgeMs: 0,
      state: {
        state: 'idle' as const, pollId: null, startedAt: null,
        lastCompletedAt: '2026-08-31T15:00:00.000Z', consecutiveFailures: 0,
        lastFailureAt: null, lastFailureCode: null, backlogCount: 0,
      },
    },
  };

  it('renders a success badge for keychain credentials with the counters', async () => {
    render(
      <SourcingStatusRow
        api={{ status: vi.fn(async () => sourcingStatus), retry: vi.fn(async () => sourcingStatus) }}
      />,
    );

    const badge = await screen.findByText(/^Sourcing inbox: keychain, last success/);
    expect(badge.closest('.status-badge--success')).not.toBeNull();
    expect(screen.getByText('Imported')).toBeTruthy();
    expect(screen.getByText('Quarantined')).toBeTruthy();
    expect(screen.getByText('4')).toBeTruthy();
  });

  it('renders warning for file credentials and danger for none', async () => {
    const { unmount } = render(
      <SourcingStatusRow
        api={{
          status: vi.fn(async () => ({
            ...sourcingStatus, credentialState: 'file' as const,
          })),
          retry: vi.fn(async () => ({
            ...sourcingStatus, credentialState: 'file' as const,
          })),
        }}
      />,
    );
    const fileBadge = await screen.findByText(/^Sourcing inbox: file/);
    expect(fileBadge.closest('.status-badge--warning')).not.toBeNull();
    unmount();

    render(
      <SourcingStatusRow
        api={{
          status: vi.fn(async () => ({
            ...sourcingStatus,
            credentialState: 'none' as const,
            lastPolledAt: null,
          })),
          retry: vi.fn(async () => sourcingStatus),
        }}
      />,
    );
    const noneBadge = await screen.findByText(
      /^Sourcing inbox: none, last success/,
    );
    expect(noneBadge.closest('.status-badge--danger')).not.toBeNull();
  });

  it('never blocks settings on a sourcing failure', async () => {
    render(
      <SourcingStatusRow
        api={{
          status: vi.fn(async () => { throw new Error('boom'); }),
          retry: vi.fn(async () => { throw new Error('boom'); }),
        }}
      />,
    );

    expect(await screen.findByText('Sourcing inbox: unavailable')).toBeTruthy();
  });

  it('refreshes at a one-minute cadence and immediately after Retry', async () => {
    const interval = vi.spyOn(globalThis, 'setInterval').mockImplementation(() => 1 as never);
    vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined);
    let resolveInitial!: (value: typeof sourcingStatus) => void;
    const initial = new Promise<typeof sourcingStatus>((resolve) => {
      resolveInitial = resolve;
    });
    const status = vi.fn()
      .mockReturnValueOnce(initial)
      .mockResolvedValue(sourcingStatus);
    let resolveRetry!: (value: typeof sourcingStatus) => void;
    const retry = vi.fn(() => new Promise<typeof sourcingStatus>((resolve) => {
      resolveRetry = resolve;
    }));
    const api = { status, retry };
    render(<SourcingStatusRow api={api} />);
    expect(status).toHaveBeenCalledTimes(1);
    expect(interval).toHaveBeenCalledWith(expect.any(Function), 60_000);
    await act(async () => {
      resolveInitial(sourcingStatus);
      await initial;
      await Promise.resolve();
    });
    await screen.findByText(/^Sourcing inbox: keychain, last success/);

    fireEvent.click(screen.getByRole('button', { name: 'Retry sourcing poll' }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Retrying…' }).hasAttribute('disabled')).toBe(true);
    resolveRetry(sourcingStatus);
    await waitFor(() => expect(status).toHaveBeenCalledTimes(2));
  });
});

describe('formatRelativeLastPoll', () => {
  const now = () => Date.parse('2026-08-31T15:00:00.000Z');

  it('formats never, just now, minutes, hours, and days', () => {
    expect(formatRelativeLastPoll(null, now)).toBe('never');
    expect(formatRelativeLastPoll('2026-08-31T14:59:40.000Z', now)).toBe('just now');
    expect(formatRelativeLastPoll('2026-08-31T14:45:00.000Z', now)).toBe('15m ago');
    expect(formatRelativeLastPoll('2026-08-31T12:00:00.000Z', now)).toBe('3h ago');
    expect(formatRelativeLastPoll('2026-08-28T15:00:00.000Z', now)).toBe('3d ago');
  });
});

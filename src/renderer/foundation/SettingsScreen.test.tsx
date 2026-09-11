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
  it.each([
    ['healthy', null, 'Not checked'],
    ['healthy', '2026-09-10T15:00:00.000Z', 'No sourcing degradation reported'],
    ['degraded', '2026-09-10T15:00:00.000Z', 'Sourcing degradation reported'],
  ] as const)('reports sourcing %s completed=%s without a whole-product readiness claim', (status, lastCompletedAt, label) => {
    renderSettings({ state: { status: 'ready', health: { ...health, sourcing: { ...health.sourcing, status, state: { ...health.sourcing.state, lastCompletedAt } } } } });
    expect(screen.getByText('Sourcing monitor')).toBeTruthy();
    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.queryByText(/Operations ready|Operations degraded/)).toBeNull();
    expect(screen.getByText('Last read time unavailable')).toBeTruthy();
    expect(screen.getByText(health.domainStartupEvaluatedAt)).toBeTruthy();
    if (lastCompletedAt) expect(screen.getByText(lastCompletedAt)).toBeTruthy();
  });

  it('keeps renderer read time distinct and stale while explicit Refresh invokes only its callback', () => {
    const onRetry = vi.fn();
    const observation = { checkedAt: '2026-09-10T16:00:00.000Z', refreshing: false, refreshFailed: true };
    render(<SettingsScreen state={{ status: 'ready', health }} onRetry={onRetry} theme={theme} density={density} {...{ observation }} />);
    expect(screen.getByText(/Last successful read/).textContent).toContain(observation.checkedAt);
    expect(screen.getByRole('alert').textContent).toContain('stale');
    expect(screen.getByText(health.domainStartupEvaluatedAt)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh diagnostics' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

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
    expect(screen.getByText('Sourcing monitor')).toBeTruthy();
    expect(screen.getByText('Not checked')).toBeTruthy();
    expect(screen.queryByText('Operations ready')).toBeNull();
  });

  it('shows the database path in monospace with copy and reveal actions', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const revealDatabase = vi.fn(async () => ({ revealed: true }));
    renderSettings({ shell: { revealDatabase, revealLogDirectory: vi.fn() } });
    fireEvent.click(screen.getByRole('button', { name: 'Data & storage' }));

    expect(
      screen.getByText('/Users/founder/Library/callie.sqlite3'),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Copy path' }));
    expect(writeText).toHaveBeenCalledWith('/Users/founder/Library/callie.sqlite3');

    fireEvent.click(screen.getByRole('button', { name: 'Reveal in Finder' }));
    expect(revealDatabase).toHaveBeenCalledTimes(1);
  });

  it('explains 14-day retained logs and reveals them without a renderer path', async () => {
    const revealLogDirectory = vi.fn(async () => ({ revealed: true }));
    renderSettings({ shell: { revealDatabase: vi.fn(), revealLogDirectory } });

    fireEvent.click(screen.getByRole('button', { name: 'Data & storage' }));
    expect(screen.getByText(/retained for 14 days/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reveal logs in Finder' }));

    await waitFor(() => expect(revealLogDirectory).toHaveBeenCalledTimes(1));
    expect(revealLogDirectory).toHaveBeenCalledWith();
  });

  it('hides the reveal action when no shell api is wired', () => {
    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Data & storage' }));

    expect(screen.queryByRole('button', { name: 'Reveal in Finder' })).toBeNull();
  });

  it('lists the keyboard cheat sheet and about facts', () => {
    renderSettings();

    fireEvent.click(screen.getByRole('button', { name: 'Keyboard shortcuts' }));
    expect(screen.getByText('Cmd/Ctrl+K')).toBeTruthy();
    expect(screen.getByText('Legacy Today rows')).toBeTruthy();
    expect(screen.getByText('Native Desk rows')).toBeTruthy();
    expect(screen.getByText('Leads rows')).toBeTruthy();
    expect(screen.queryByText('E / H / P')).toBeNull();
    const shortcuts = screen.getByRole('region', { name: 'Keyboard shortcuts' });
    expect(shortcuts.textContent).toContain('Friday, Inbox');
    expect(shortcuts.textContent).not.toContain('Friday, Review');
    expect(shortcuts.textContent).toContain('tomorrow 09:00 local');
    expect(shortcuts.textContent).toContain('Editing fields and open overlays own their keys');

    fireEvent.click(screen.getByRole('button', { name: 'About' }));
    const about = screen.getByRole('region', { name: 'About' });
    expect(about.textContent).toContain('1.2.3');
    expect(about.textContent).toContain('9');
  });

  it('keeps the stable failure copy without raw errors', () => {
    renderSettings({ state: { status: 'failed' } });

    expect(screen.getByRole('alert').textContent).toContain(
      'The diagnostic read could not be completed',
    );
    expect(screen.getByText('DIAGNOSTIC_READ_FAILED')).toBeTruthy();
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

  it('allows accessible Retry for an expired running owner while coalescing a fresh one', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-01T12:15:00.001Z'));
    const retry = vi.fn(async () => sourcingStatus);
    const expiredRunning: SourcingStatus = {
      ...sourcingStatus,
      execution: {
        ...sourcingStatus.execution,
        state: 'running',
        pollId: 'expired-poll',
        startedAt: '2026-09-01T12:00:00.000Z',
      },
      health: {
        ...sourcingStatus.health,
        status: 'degraded',
        reasons: ['POLL_EXCEEDED_TOTAL_DEADLINE'],
        state: {
          ...sourcingStatus.health.state,
          state: 'running',
          pollId: 'expired-poll',
          startedAt: '2026-09-01T12:00:00.000Z',
        },
      },
    };
    render(<SourcingStatusRow api={{ status: async () => expiredRunning, retry }} />);

    const button = await screen.findByRole('button', { name: 'Retry sourcing poll' });
    expect(button.hasAttribute('disabled')).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
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

describe('Data & storage recovery flow', () => {
  const incomplete: import('../../shared/contracts/recoveryContract').RecoveryReadinessStatus = { setupCompletedAt: null, lastRestoreDrillAt: null, outreachReady: false, backup: { status: 'missing' as const, createdAt: null, verifiedAt: null } };
  function provider() {
    return { status: vi.fn(async () => incomplete), beginSetup: vi.fn(async () => ({ sessionId: 'fixture-session', material: 'synthetic-private-material', generatedAt: new Date().toISOString() })), saveSetupMaterial: vi.fn(async () => ({ kind: 'cancelled' as const })), completeSetup: vi.fn(async () => ({ ...incomplete, setupCompletedAt: new Date().toISOString() })), selectAndRunRestoreDrill: vi.fn(async () => ({ kind: 'cancelled' as const })) };
  }
  async function data(recovery = provider()) {
    const view = renderSettings({ recovery });
    expect(recovery.status).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Data & storage' }));
    await screen.findByText('Recovery setup/drill incomplete');
    return { recovery, ...view };
  }
  async function begin() {
    fireEvent.click(screen.getByLabelText('I understand this reveals private recovery material'));
    fireEvent.click(screen.getByRole('button', { name: 'Begin recovery setup' }));
    await screen.findByText('synthetic-private-material');
  }
  it('requires confirmation, shows once, copies only on explicit click and completes separately from Save', async () => {
    const copy = vi.fn(async () => undefined); Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
    const { recovery } = await data();
    expect((screen.getByRole('button', { name: 'Begin recovery setup' }) as HTMLButtonElement).disabled).toBe(true);
    await begin(); expect(copy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Copy recovery material' }));
    await waitFor(() => expect(copy).toHaveBeenCalledWith('synthetic-private-material'));
    fireEvent.click(screen.getByRole('button', { name: 'Save recovery material' }));
    await waitFor(() => expect(recovery.saveSetupMaterial).toHaveBeenCalledWith({ sessionId: 'fixture-session' }));
    expect(recovery.completeSetup).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('I stored the recovery material privately'));
    fireEvent.click(screen.getByRole('button', { name: 'Complete recovery setup' }));
    await waitFor(() => expect(screen.queryByText('synthetic-private-material')).toBeNull());
    expect(recovery.completeSetup).toHaveBeenCalledWith({ sessionId: 'fixture-session', founderConfirmed: true });
    expect(screen.getByText('Recovery setup/drill incomplete')).toBeTruthy();
  });
  it('clears material on navigation and never puts it in diagnostics or storage', async () => {
    const storage = vi.spyOn(Storage.prototype, 'setItem'); await data(); await begin();
    fireEvent.click(screen.getByRole('button', { name: 'Diagnostics' }));
    expect(screen.queryByText('synthetic-private-material')).toBeNull();
    expect(storage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Data & storage' }));
    await screen.findByText('Recovery setup/drill incomplete');
    expect(screen.queryByText('synthetic-private-material')).toBeNull();
  });
  it('expires one-time material at ten minutes', async () => {
    await data(); vi.useFakeTimers();
    try {
      await act(async () => {
        fireEvent.click(screen.getByLabelText('I understand this reveals private recovery material'));
        fireEvent.click(screen.getByRole('button', { name: 'Begin recovery setup' }));
      });
      expect(screen.getByText('synthetic-private-material')).toBeTruthy();
      await act(async () => { vi.advanceTimersByTime(10 * 60_000); });
      expect(screen.queryByText('synthetic-private-material')).toBeNull();
    } finally { vi.useRealTimers(); }
    // A separate fixture returns already expired material, which must never render.
    cleanup(); const recovery = provider(); recovery.beginSetup.mockResolvedValue({ sessionId: 'expired', material: 'expired-secret', generatedAt: '2000-01-01T00:00:00.000Z' });
    await data(recovery);
    fireEvent.click(screen.getByLabelText('I understand this reveals private recovery material'));
    fireEvent.click(screen.getByRole('button', { name: 'Begin recovery setup' }));
    await screen.findByRole('alert'); expect(screen.queryByText('expired-secret')).toBeNull();
  });
  it('releases the action lock after expiry invalidates a pending Save result', async () => {
    const recovery = provider(); let resolve!: (value: { kind: 'cancelled' }) => void;
    recovery.saveSetupMaterial.mockImplementation(() => new Promise((r) => { resolve = r; }));
    await data(recovery); vi.useFakeTimers();
    try {
      await act(async () => {
        fireEvent.click(screen.getByLabelText('I understand this reveals private recovery material'));
        fireEvent.click(screen.getByRole('button', { name: 'Begin recovery setup' }));
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save recovery material' }));
      await act(async () => { vi.advanceTimersByTime(10 * 60_000); resolve({ kind: 'cancelled' }); });
      expect((screen.getByRole('button', { name: 'Refresh recovery status' }) as HTMLButtonElement).disabled).toBe(false);
      expect(screen.queryByText('synthetic-private-material')).toBeNull();
    } finally { vi.useRealTimers(); }
  });
  it('clears explicit pasted material on submit and cancel, never includes it in errors', async () => {
    const { recovery } = await data();
    fireEvent.change(screen.getByLabelText('Recovery material source'), { target: { value: 'paste' } });
    fireEvent.change(screen.getByLabelText('Paste saved recovery material'), { target: { value: 'synthetic-secret' } });
    fireEvent.click(screen.getByLabelText('I confirm this tests only a temporary backup copy'));
    recovery.selectAndRunRestoreDrill.mockRejectedValue(new Error('synthetic-secret /private/path'));
    fireEvent.click(screen.getByRole('button', { name: 'Select backup and run restore drill' }));
    expect((screen.getByLabelText('Paste saved recovery material') as HTMLTextAreaElement).value).toBe('');
    await screen.findByRole('alert'); expect(screen.queryByText(/synthetic-secret/)).toBeNull(); expect(screen.queryByText(/\/private\/path/)).toBeNull();
    expect(recovery.selectAndRunRestoreDrill).toHaveBeenCalledWith({ founderConfirmed: true, materialSource: 'paste', recoveryMaterial: 'synthetic-secret' });
    fireEvent.change(screen.getByLabelText('Paste saved recovery material'), { target: { value: 'discard' } });
    fireEvent.click(screen.getByRole('button', { name: 'Clear recovery input' }));
    expect((screen.getByLabelText('Paste saved recovery material') as HTMLTextAreaElement).value).toBe('');
  });
  it('shows actual backup creation age separately from verification and never equates it to drill time', async () => {
    const recovery = provider();
    recovery.status.mockResolvedValue({ ...incomplete, backup: { status: 'available', createdAt: '2020-01-01T00:00:00.000Z', verifiedAt: '2026-09-06T12:00:00.000Z' } } as never);
    await data(recovery);
    expect(screen.getByText(/Backup is stale/)).toBeTruthy();
    expect(screen.getByText(/Backup created: 2020-01-01/)).toBeTruthy();
    expect(screen.getByText(/Backup verified: 2026-09-06/)).toBeTruthy();
    expect(screen.getByText('Last successful restore drill: Not completed')).toBeTruthy();
  });
  it('shows aggregate receipt and recovery completion only after the drill commits', async () => {
    const recovery = provider(); let resolve!: (value: unknown) => void;
    recovery.selectAndRunRestoreDrill.mockImplementation(() => new Promise((r) => { resolve = r; }) as never);
    await data(recovery);
    recovery.status.mockResolvedValue({ ...incomplete, setupCompletedAt: '2026-09-06T12:00:00.000Z', lastRestoreDrillAt: '2026-09-06T12:01:00.000Z', outreachReady: true });
    fireEvent.click(screen.getByLabelText('I confirm this tests only a temporary backup copy'));
    fireEvent.click(screen.getByRole('button', { name: 'Select backup and run restore drill' }));
    expect(screen.getByText('Recovery setup/drill incomplete')).toBeTruthy();
    await act(async () => resolve({ kind: 'completed', receipt: { backupTimestamp: '2026-09-06T11:00:00.000Z', backupSha256: 'a'.repeat(64), schemaVersion: 2, verifiedAt: '2026-09-06T12:01:00.000Z', aggregateCounts: { people: 2, prospects: 1, sourceEvents: 3 } } }));
    expect(screen.getByText('Recovery setup/drill complete')).toBeTruthy();
    expect(screen.getByText('People: 2. Prospects: 1. Source events: 3.')).toBeTruthy();
  });
  it('does not advertise readiness when the status read fails', async () => {
    const recovery = provider(); recovery.status.mockRejectedValue(new Error('private diagnostic text'));
    renderSettings({ recovery }); fireEvent.click(screen.getByRole('button', { name: 'Data & storage' }));
    await screen.findByRole('alert');
    expect(screen.queryByText('Recovery setup/drill complete')).toBeNull();
    expect(screen.queryByText(/private diagnostic text/)).toBeNull();
  });
  it('ignores late begin results after leaving Data & storage', async () => {
    const recovery = provider(); let resolve!: (value: Awaited<ReturnType<typeof recovery.beginSetup>>) => void;
    recovery.beginSetup.mockImplementation(() => new Promise((r) => { resolve = r; }));
    await data(recovery); fireEvent.click(screen.getByLabelText('I understand this reveals private recovery material'));
    fireEvent.click(screen.getByRole('button', { name: 'Begin recovery setup' }));
    fireEvent.click(screen.getByRole('button', { name: 'Diagnostics' }));
    await act(async () => resolve({ sessionId: 'late', material: 'late-secret', generatedAt: new Date().toISOString() }));
    expect(screen.queryByText('late-secret')).toBeNull();
  });
});

const outreachStatus: import('../../shared/contracts/outreachContract').OutreachStatus = { model: 'unconfigured' as const, modelName: '', gmail: 'unconfigured' as const, accountEmail: null, senderName: '', postalAddress: '' };
function connectionsApi() {
  const unavailable = async (): Promise<never> => { throw new Error('Not used by settings'); };
  return { status: vi.fn(async () => outreachStatus), configure: vi.fn(async () => outreachStatus), connectGmail: vi.fn(async () => outreachStatus), disconnectGmail: vi.fn(async () => outreachStatus), openDraft: unavailable, saveDraft: unavailable, generateDraft: unavailable, sendDraft: unavailable, inspectLocalAuthority: unavailable };
}
it('exposes user-owned connection setup only through explicit save/connect/disconnect and never retains secret fields', async () => {
  const api = connectionsApi(); renderSettings({ outreachApi: api });
  fireEvent.click(screen.getByRole('button', { name: 'Connections' }));
  await screen.findByLabelText('OpenAI API key');
  expect(api.connectGmail).not.toHaveBeenCalled(); expect(api.configure).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('OpenAI API key'), { target: { value: 'fixture-key' } });
  fireEvent.change(screen.getByLabelText('OpenAI model'), { target: { value: 'fixture-model' } });
  fireEvent.change(screen.getByLabelText('Sender name'), { target: { value: 'Fictional Founder' } });
  fireEvent.change(screen.getByLabelText('Postal address'), { target: { value: '123 Fictional St' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save connections' }));
  await waitFor(() => expect(api.configure).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'fixture-key', model: 'fixture-model', senderName: 'Fictional Founder', postalAddress: '123 Fictional St' })));
  await waitFor(() => expect((screen.getByLabelText('OpenAI API key') as HTMLInputElement).value).toBe(''));
  fireEvent.click(screen.getByRole('button', { name: 'Connect Gmail' })); await waitFor(() => expect(api.connectGmail).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole('button', { name: 'Disconnect Gmail' })); await waitFor(() => expect(api.disconnectGmail).toHaveBeenCalledOnce());
  expect(screen.getByText(/Review replies in Gmail/)).toBeTruthy();
});
it('renders a safe setup error instead of raw provider secrets', async () => {
  const api = connectionsApi(); api.status.mockRejectedValueOnce(new Error('fixture-secret-that-must-not-render'));
  renderSettings({ outreachApi: api }); fireEvent.click(screen.getByRole('button', { name: 'Connections' }));
  expect(await screen.findByRole('alert')).toBeTruthy(); expect(screen.queryByText(/fixture-secret/)).toBeNull();
});
it('never erases existing sender settings when credentials are entered during a slow status read', async () => {
  const api = connectionsApi(); let resolve!: (value: typeof outreachStatus) => void;
  api.status.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  renderSettings({ outreachApi: api }); fireEvent.click(screen.getByRole('button', { name: 'Connections' }));
  fireEvent.change(screen.getByLabelText('OpenAI API key'), { target: { value: 'fixture-key' } });
  expect((screen.getByRole('button', { name: 'Save connections' }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => resolve({ ...outreachStatus, modelName: 'saved-model', senderName: 'Saved Founder', postalAddress: '123 Saved St' }));
  expect((screen.getByLabelText('Sender name') as HTMLInputElement).value).toBe('Saved Founder');
  fireEvent.click(screen.getByRole('button', { name: 'Save connections' }));
  await waitFor(() => expect(api.configure).toHaveBeenCalledWith(expect.objectContaining({ senderName: 'Saved Founder', postalAddress: '123 Saved St' })));
});

describe('Local workflow transition', () => {
  const receipt: import('../../shared/contracts/localWorkspaceContract').LocalWorkflowReceipt = { commandId: 'committed-command', manifestId: 'committed-manifest', mode: 'meeting_first' as const, revision: 1, occurredAt: '2026-09-09T12:00:00.000Z', cancelledActionIds: [], stoppedEnrollmentIds: [], preservedActionIds: ['not-a-due-count'], parkedPersonIds: [], callbackEvidenceIds: [], unknownDraftIds: [], parkedReviewActions: [], parkedActions: [] };
  function localApi() {
    const snapshot: import('../../shared/contracts/localWorkspaceContract').LocalWorkspaceSnapshot = { scope: 'local_database', generatedAt: receipt.occurredAt, workflowMode: 'legacy', transitionReceipt: null, accounts: { state: 'available', snapshots: [] } };
    const unavailableCompanyIntake = async () => { throw Error('Company intake unavailable in this fixture'); };
    return { get: vi.fn(async () => snapshot), getCompany: vi.fn(async () => { throw Error('Selected company detail unavailable in this fixture'); }), researchCompany: vi.fn(unavailableCompanyIntake), getCompanyResearchStatus: vi.fn(unavailableCompanyIntake), getCallSettings: async () => { throw Error('Call capacity unavailable in this fixture'); }, updateCallSettings: async () => { throw Error('Call capacity unavailable in this fixture'); }, linkCompanyPerson: vi.fn(unavailableCompanyIntake), getCommitments: vi.fn(), reviewCompany: vi.fn(unavailableCompanyIntake), createCompany: vi.fn(unavailableCompanyIntake), getCompanyCreateStatus: vi.fn(unavailableCompanyIntake), transition: vi.fn(async (command: import('../../shared/contracts/localWorkspaceContract').LocalWorkflowTransition) => ({ ...receipt, commandId: command.commandId, manifestId: command.manifestId })) };
  }
  async function open(api = localApi()) {
    const view = renderSettings({ localWorkspaceApi: api });
    expect(api.get).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Data & storage' }));
    await screen.findByRole('checkbox', { name: /one-way local change/i });
    return { api, ...view };
  }
  it('reads only in Data & storage and requires acknowledgement before one immutable submission', async () => {
    const { api } = await open();
    const button = screen.getByRole('button', { name: 'Switch to Native Desk' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(api.transition).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox', { name: /one-way local change/i }));
    fireEvent.click(button); fireEvent.click(button);
    await screen.findByText(/Native Desk is active/i);
    expect(api.transition).toHaveBeenCalledTimes(1);
    expect(api.transition.mock.calls[0][0]).toEqual({ commandId: expect.any(String), expectedMode: 'legacy', manifestId: expect.any(String) });
  });
  it('recovers a lost response through canonical status and reopens without submitting', async () => {
    const api = localApi();
    api.transition.mockImplementation(async () => { api.get.mockResolvedValue({ ...(await localApi().get()), workflowMode: 'meeting_first', transitionReceipt: receipt }); throw Error('lost response'); });
    await open(api);
    fireEvent.click(screen.getByRole('checkbox', { name: /one-way local change/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Native Desk' }));
    await screen.findByText(/result is unknown/i);
    fireEvent.click(screen.getByRole('button', { name: 'Check status' }));
    await screen.findByText(/Native Desk is active/i);
    expect(screen.getByText(/committed-manifest/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Diagnostics' }));
    fireEvent.click(screen.getByRole('button', { name: 'Data & storage' }));
    await screen.findByText(/Native Desk is active/i);
    expect(api.transition).toHaveBeenCalledTimes(1);
  });
  it('holds failed status and retries only the exact in-view request', async () => {
    const api = localApi(); api.transition.mockRejectedValueOnce(Error('lost'));
    await open(api);
    fireEvent.click(screen.getByRole('checkbox', { name: /one-way local change/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Native Desk' }));
    await screen.findByText(/result is unknown/i);
    const original = api.transition.mock.calls[0][0];
    api.get.mockRejectedValueOnce(Error('private error'));
    fireEvent.click(screen.getByRole('button', { name: 'Check status' }));
    await screen.findByText(/Workflow status unavailable/i);
    expect(screen.queryByRole('button', { name: 'Switch to Native Desk' })).toBeNull();
    expect(screen.queryByText(/private error/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Check status' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Retry same transition' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Retry same transition' }));
    await screen.findByText(/Native Desk is active/i);
    expect(api.transition.mock.calls[1][0]).toBe(original);
  });
});


// Task8 additions. All original bytes above are retained verbatim.
// New production modules are deliberately NOT imported at top level: the first
// case reaches a behavioral missing-Phone RED in this existing test root.
import type { PhoneSetupApi, PhoneSetupStatus } from '../../shared/contracts/phoneSetupContract';
import type { CalliePreloadApi } from '../../shared/preload';
import { renderRoute, type RouteContext } from '../app/routeRegistry';
import { useHashRoute } from '../app/useHashRoute';
import { PresentationRoot } from '../app/PresentationRoot';
import { dailyFixture, firstUseFixture, nativeDeskFixture } from '../features/today/nativeDesk.fixture';

// Variable import avoids eager Vite resolution of a planned-absent module in
// the baseline Settings root. Only helper-specific cases load the real helper.
async function task8Navigation(): Promise<{ openSettingsSection(section: 'connections' | 'phone' | 'worker' | 'call-capacity'): void }> {
  const modulePath = './settingsNavigation';
  return import(/* @vite-ignore */ modulePath);
}
const task8Key = 'callie.settings.section';
const task8Time = '2026-09-10T23:00:00.000Z';
const task8Candidate = (value = 'candidate_A'): PhoneSetupStatus => ({ state: 'needs_confirmation', candidateFingerprint: value, confirmedAt: null });
const task8Configured = (value = 'candidate_A'): PhoneSetupStatus => ({ state: 'configured', candidateFingerprint: value, confirmedAt: task8Time });
const task8Empty: PhoneSetupStatus = { state: 'unconfigured', candidateFingerprint: null, confirmedAt: null };
function task8Phone(value = 'candidate_A') {
  return {
    status: vi.fn<PhoneSetupApi['status']>(async () => task8Candidate(value)),
    confirm: vi.fn<PhoneSetupApi['confirm']>(async input => task8Configured(input.expectedFingerprint)),
    clear: vi.fn<PhoneSetupApi['clear']>(async () => task8Empty),
  } satisfies PhoneSetupApi;
}
function task8Settings(phoneSetupApi?: PhoneSetupApi) {
  return render(<SettingsScreen state={{ status: 'ready', health }} onRetry={vi.fn()} theme={theme} density={density} {...{ phoneSetupApi }} />);
}
function task8Active(label: string) {
  expect(within(screen.getByRole('navigation', { name: 'Settings sections' })).getByRole('button', { name: label }).getAttribute('aria-current')).toBe('true');
}
async function task8Controls(value = 'candidate_A') {
  const region = await screen.findByRole('region', { name: 'Phone handoff' });
  expect(within(region).getByRole('heading', { name: 'Phone handoff' })).toBeTruthy();
  expect(within(region).getByText(value, { exact: true })).toBeTruthy();
  for (const name of ['Confirm phone setup', 'Clear phone setup']) {
    expect(within(region).getByRole('button', { name }).hasAttribute('disabled')).toBe(false);
  }
  task8Active('Phone');
  expect(screen.queryByRole('region', { name: 'Connections' })).toBeNull();
  return region;
}
async function task8Isolated(body: () => Promise<void>) {
  const prior = sessionStorage.getItem(task8Key);
  const href = location.href;
  sessionStorage.removeItem(task8Key);
  try { await body(); }
  finally {
    cleanup(); vi.restoreAllMocks();
    if (prior === null) sessionStorage.removeItem(task8Key); else sessionStorage.setItem(task8Key, prior);
    window.history.replaceState(null, '', href);
  }
}
function task8Deferred() {
  let resolve!: (value: PhoneSetupStatus) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<PhoneSetupStatus>((yes, no) => { resolve = yes; reject = no; });
  const joined = promise.then((): void => undefined, (): void => undefined);
  return { promise, resolve, reject, joined };
}
async function task8Settle(pending: ReturnType<typeof task8Deferred>, value = task8Empty) {
  await act(async () => { pending.resolve(value); await pending.joined; });
}

// Complete typed API, no incomplete interface casts and no shared pending spy.
// Unused methods each have a separate named throwing guard. NativeDesk fixture
// methods are separately audited by their recorded calls, including all commands.
function task8RouteFixture(phoneSetup = task8Phone()) {
  const native = nativeDeskFixture(dailyFixture({ answers: [] }));
  const forbidden: string[] = [];
  const deny = (name: string) => vi.fn((..._args: unknown[]): never => { void _args; forbidden.push(name); throw Error(`Unexpected task8 capability: ${name}`); });
  const api: CalliePreloadApi = {
    ...native.api,
    health: { get: vi.fn(async () => health) },
    phoneSetup,
    discovery: { get: deny('discovery.get'), getBrief: deny('discovery.getBrief'), begin: deny('discovery.begin'), override: deny('discovery.override') },
    outreach: {
      status: deny('outreach.status'), inspectLocalAuthority: deny('outreach.inspectLocalAuthority'),
      configure: deny('outreach.configure'), connectGmail: deny('outreach.connectGmail'), disconnectGmail: deny('outreach.disconnectGmail'),
      openDraft: deny('outreach.openDraft'), saveDraft: deny('outreach.saveDraft'), generateDraft: deny('outreach.generateDraft'), sendDraft: deny('outreach.sendDraft'),
    },
    today: {
      get: deny('today.get'), complete: deny('today.complete'), snooze: deny('today.snooze'), pin: deny('today.pin'),
      logPastActivity: deny('today.logPastActivity'), getLeadTriageSnapshot: deny('today.getLeadTriageSnapshot'), addLeadNote: deny('today.addLeadNote'),
      logCallOutcome: deny('today.logCallOutcome'), markActivityInError: deny('today.markActivityInError'), getTriageQueue: deny('today.getTriageQueue'), setReviewPosition: deny('today.setReviewPosition'),
    },
    pipeline: { get: deny('pipeline.get') },
    review: { list: deny('review.list'), resolve: deny('review.resolve') },
    friday: { getCurrent: deny('friday.getCurrent'), getDrilldown: deny('friday.getDrilldown'), createJob: deny('friday.createJob'), fillJob: deny('friday.fillJob'), cancelJob: deny('friday.cancelJob') },
    imports: { preview: deny('imports.preview'), remap: deny('imports.remap'), commit: deny('imports.commit'), status: deny('imports.status') },
    conversations: { list: deny('conversations.list'), get: deny('conversations.get'), attachTranscript: deny('conversations.attachTranscript') },
    learnings: { list: deny('learnings.list'), capture: deny('learnings.capture'), addEvidence: deny('learnings.addEvidence'), updateStatus: deny('learnings.updateStatus') },
    sourcing: { pollNow: deny('sourcing.pollNow'), status: deny('sourcing.status'), retry: deny('sourcing.retry'), setHmacSalt: deny('sourcing.setHmacSalt') },
    shell: { revealDatabase: deny('shell.revealDatabase'), revealLogDirectory: deny('shell.revealLogDirectory') },
    recovery: { status: deny('recovery.status'), beginSetup: deny('recovery.beginSetup'), saveSetupMaterial: deny('recovery.saveSetupMaterial'), completeSetup: deny('recovery.completeSetup'), selectAndRunRestoreDrill: deny('recovery.selectAndRunRestoreDrill') },
    appleSpike: {
      getStatus: deny('appleSpike.getStatus'), probeCapabilities: deny('appleSpike.probeCapabilities'), requestContacts: deny('appleSpike.requestContacts'),
      promptAccessibility: deny('appleSpike.promptAccessibility'), scanRecentNotes: deny('appleSpike.scanRecentNotes'), scanTestMessages: deny('appleSpike.scanTestMessages'),
      startCallObservation: deny('appleSpike.startCallObservation'), stopCallObservation: deny('appleSpike.stopCallObservation'), sendTestMessage: deny('appleSpike.sendTestMessage'), subscribeObservationEvidence: deny('appleSpike.subscribeObservationEvidence'),
    },
  };
  const context: RouteContext = {
    api, firstUse: firstUseFixture(), health: { status: 'ready', health, retry: vi.fn() }, theme, density,
    openLead: vi.fn(), openImport: vi.fn(), onReviewRequestStart: () => Symbol('task8-review'),
    onReviewRequestFailed: vi.fn(), onReviewSnapshot: vi.fn(), onReviewResolved: vi.fn(),
  };
  const assertReadOnly = () => {
    expect(forbidden).toEqual([]);
    const allowed = new Set(['daily.get', 'delegation.status', 'localWorkspace.get', 'localWorkspace.getCommitments']);
    expect(native.calls.filter(call => !allowed.has(call.method))).toEqual([]);
    expect(native.calls.some(call => call.method === 'daily.get')).toBe(true);
    expect(phoneSetup.confirm).not.toHaveBeenCalled(); expect(phoneSetup.clear).not.toHaveBeenCalled();
  };
  return { api, context, native, forbidden, assertReadOnly };
}
function Task8RealRoutes({ context }: { context: RouteContext }) {
  const { route } = useHashRoute('today');
  return <PresentationRoot><div key={route}>{renderRoute(route, context)}</div></PresentationRoot>;
}

describe('Task8 real Settings destination integration', () => {
  it('baseline behavioral RED: real Settings exposes actual Phone controls with no new module import', async () => task8Isolated(async () => {
    const api = task8Phone(); task8Settings(api);
    fireEvent.click(screen.getByRole('button', { name: 'Phone' }));
    await screen.findByText('candidate_A'); await task8Controls();
    expect(api.status).toHaveBeenCalledTimes(1); expect(api.confirm).not.toHaveBeenCalled(); expect(api.clear).not.toHaveBeenCalled();
  }), 10_000);

  it('actual company-call hold anchor routes Today to Phone controls without commands', async () => task8Isolated(async () => {
    location.hash = '#/today';
    const f = task8RouteFixture(); render(<Task8RealRoutes context={f.context} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Call · Account A' }));
    expect(screen.getByText(/Call handoff unavailable in this account view/)).toBeTruthy();
    expect(screen.getByText(/Selection alone never places a call/)).toBeTruthy();
    const anchor = screen.getByRole('link', { name: 'Review phone setup' });
    expect(anchor.getAttribute('href')).toBe('#/settings');
    expect(anchor.closest('section')?.textContent).toContain('Call handoff unavailable');
    expect(sessionStorage.getItem(task8Key)).toBeNull();
    fireEvent.click(anchor);
    // Real anchor default navigation in jsdom, no manual helper or storage seed.
    await waitFor(() => expect(location.hash).toBe('#/settings'));
    await screen.findByText('candidate_A'); await task8Controls();
    expect(sessionStorage.getItem(task8Key)).toBeNull();
    expect(screen.queryByText(/Apple spike/i)).toBeNull();
    expect(screen.queryByLabelText(/API key/i)).toBeNull();
    expect(f.api.phoneSetup.status).toHaveBeenCalledTimes(1);
    f.assertReadOnly();
  }), 10_000);

  it('pre-mount Phone intent is consumed and cannot hijack a later remount', async () => task8Isolated(async () => {
    const { openSettingsSection } = await task8Navigation();
    const api = task8Phone(); openSettingsSection('phone');
    const view = task8Settings(api); await screen.findByText('candidate_A'); await task8Controls();
    expect(sessionStorage.getItem(task8Key)).toBeNull(); view.unmount(); task8Settings(api);
    task8Active('Diagnostics'); expect(screen.queryByRole('region', { name: 'Phone handoff' })).toBeNull();
    expect(api.status).toHaveBeenCalledTimes(1);
  }), 10_000);

  it('same-mounted helper event selects Phone without remount and consumes replay intent', async () => task8Isolated(async () => {
    const { openSettingsSection } = await task8Navigation();
    const api = task8Phone(); const view = task8Settings(api);
    const rail = screen.getByRole('navigation', { name: 'Settings sections' }); task8Active('Diagnostics');
    act(() => openSettingsSection('phone'));
    await screen.findByText('candidate_A'); await task8Controls();
    expect(screen.getByRole('navigation', { name: 'Settings sections' })).toBe(rail);
    expect(sessionStorage.getItem(task8Key)).toBeNull(); view.unmount(); task8Settings(api); task8Active('Diagnostics');
  }), 10_000);

  it.each(['event', 'storage'] as const)('preserves legacy Connections %s and consumes it', async mode => task8Isolated(async () => {
    if (mode === 'storage') sessionStorage.setItem(task8Key, 'connections');
    const view = task8Settings(task8Phone());
    if (mode === 'event') {
      sessionStorage.setItem(task8Key, 'connections');
      act(() => window.dispatchEvent(new Event('callie:open-connections')));
    }
    task8Active('Connections'); expect(screen.getByRole('region', { name: 'Connections' })).toBeTruthy();
    expect(sessionStorage.getItem(task8Key)).toBeNull(); view.unmount(); task8Settings(); task8Active('Diagnostics');
  }), 10_000);

  it.each(['nonsense', ''] as const)('clears invalid or unimplemented initial intent %s and defaults Diagnostics', async value => task8Isolated(async () => {
    sessionStorage.setItem(task8Key, value); task8Settings(task8Phone()); task8Active('Diagnostics');
    expect(sessionStorage.getItem(task8Key)).toBeNull();
    expect(screen.queryByRole('region', { name: 'Worker connection' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Call capacity' })).toBeNull();
  }), 10_000);

  it.each([
    { name: 'unknown', detail: 'nonsense' }, { name: 'empty', detail: '' },
    { name: 'object', detail: { section: 'phone' } }, { name: 'null', detail: null }, { name: 'plain Event', detail: undefined },
  ])('invalid mounted $name retains active section and clears storage', async ({ detail }) => task8Isolated(async () => {
    const api = task8Phone(); task8Settings(api); fireEvent.click(screen.getByRole('button', { name: 'Appearance' }));
    sessionStorage.setItem(task8Key, 'phone');
    act(() => window.dispatchEvent(detail === undefined ? new Event('callie:open-settings-section') : new CustomEvent('callie:open-settings-section', { detail })));
    task8Active('Appearance'); expect(sessionStorage.getItem(task8Key)).toBeNull(); expect(api.status).not.toHaveBeenCalled();
  }), 10_000);

  it.each([
    ['call-capacity', 'Call capacity'], ['appearance', 'Appearance'], ['data', 'Data & storage'], ['sourcing', 'Sourcing'],
    ['diagnostics', 'Diagnostics'], ['shortcuts', 'Keyboard shortcuts'], ['about', 'About'], ['connections', 'Connections'],
  ] as const)('implemented %s remains selectable through validated event and rail', async (id, label) => task8Isolated(async () => {
    sessionStorage.setItem(task8Key, id);
    const initial = task8Settings(); task8Active(label); expect(sessionStorage.getItem(task8Key)).toBeNull();
    initial.unmount();
    task8Settings(); task8Active('Diagnostics');
    act(() => window.dispatchEvent(new CustomEvent('callie:open-settings-section', { detail: id })));
    task8Active(label); fireEvent.click(screen.getByRole('button', { name: 'Diagnostics' })); task8Active('Diagnostics');
    fireEvent.click(screen.getByRole('button', { name: label })); task8Active(label);
  }), 10_000);

  it.each(['getItem', 'removeItem'] as const)('storage %s failure does not break mounted event or rail navigation', async method => task8Isolated(async () => {
    const failure = vi.spyOn(Storage.prototype, method).mockImplementation(() => { throw Error('private-storage-error'); });
    const api = task8Phone(); task8Settings(api); task8Active('Diagnostics');
    act(() => window.dispatchEvent(new CustomEvent('callie:open-settings-section', { detail: 'phone' })));
    await screen.findByText('candidate_A'); await task8Controls();
    expect(screen.queryByText(/private-storage-error/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Appearance' })); task8Active('Appearance'); failure.mockRestore();
  }), 10_000);

  it('failed setItem still reaches mounted Phone via helper event', async () => task8Isolated(async () => {
    const { openSettingsSection } = await task8Navigation(); task8Settings(task8Phone());
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw Error('storage blocked'); });
    act(() => openSettingsSection('phone')); await screen.findByText('candidate_A'); await task8Controls(); set.mockRestore();
  }), 10_000);

  it('missing optional Settings phone API renders unavailable rather than AppleSpike fallback', async () => task8Isolated(async () => {
    task8Settings(); fireEvent.click(screen.getByRole('button', { name: 'Phone' }));
    await screen.findByText('Unavailable', { exact: true }); task8Active('Phone');
    expect(screen.queryByText('Unconfigured', { exact: true })).toBeNull();
    expect(screen.queryByText(/Apple spike/i)).toBeNull();
  }), 10_000);

  it.each(['Confirm', 'Clear'] as const)('real route unmount during %s settles while absent, then observes afresh', async action => task8Isolated(async () => {
    location.hash = '#/settings'; sessionStorage.setItem(task8Key, 'phone');
    const api = task8Phone(); const pending = task8Deferred();
    if (action === 'Confirm') api.confirm.mockReturnValueOnce(pending.promise); else api.clear.mockReturnValueOnce(pending.promise);
    const f = task8RouteFixture(api);
    try {
      render(<Task8RealRoutes context={f.context} />);
      await screen.findByText('candidate_A'); fireEvent.click(screen.getByRole('button', { name: `${action} phone setup` }));
      act(() => { location.hash = '#/today'; window.dispatchEvent(new HashChangeEvent('hashchange')); });
      await screen.findByRole('button', { name: 'Call · Account A' });
      expect(screen.queryByRole('region', { name: 'Phone handoff' })).toBeNull();
      await task8Settle(pending, action === 'Confirm' ? task8Configured() : task8Empty);
      expect(screen.queryByText(task8Time)).toBeNull(); expect(screen.queryByRole('alert')).toBeNull();
      api.status.mockResolvedValue(task8Candidate('candidate_B'));
      fireEvent.click(screen.getByRole('button', { name: 'Call · Account A' }));
      fireEvent.click(screen.getByRole('link', { name: 'Review phone setup' }));
      await screen.findByText('candidate_B'); await task8Controls('candidate_B');
      expect(api.status).toHaveBeenCalledTimes(2);
      fireEvent.click(screen.getByRole('button', { name: 'Confirm phone setup' })); await screen.findByText(task8Time);
      expect(api.confirm).toHaveBeenLastCalledWith({ expectedFingerprint: 'candidate_B' });
      expect(f.forbidden).toEqual([]);
    } finally { await task8Settle(pending); }
  }), 10_000);

  it.each(['Confirm', 'Clear'] as const)('old unmounted %s finally cannot unlock new mounted pending Confirm', async action => task8Isolated(async () => {
    location.hash = '#/settings'; sessionStorage.setItem(task8Key, 'phone');
    const api = task8Phone(); const old = task8Deferred(); const fresh = task8Deferred();
    if (action === 'Confirm') api.confirm.mockReturnValueOnce(old.promise); else api.clear.mockReturnValueOnce(old.promise);
    const f = task8RouteFixture(api);
    try {
      render(<Task8RealRoutes context={f.context} />);
      await screen.findByText('candidate_A'); fireEvent.click(screen.getByRole('button', { name: `${action} phone setup` }));
      act(() => { location.hash = '#/today'; window.dispatchEvent(new HashChangeEvent('hashchange')); });
      fireEvent.click(await screen.findByRole('button', { name: 'Call · Account A' }));
      api.status.mockResolvedValue(task8Candidate('candidate_B')); api.confirm.mockReturnValueOnce(fresh.promise);
      fireEvent.click(screen.getByRole('link', { name: 'Review phone setup' })); await screen.findByText('candidate_B');
      fireEvent.click(screen.getByRole('button', { name: 'Confirm phone setup' }));
      await task8Settle(old, action === 'Confirm' ? task8Configured() : task8Empty);
      for (const name of ['Confirm phone setup', 'Clear phone setup', 'Refresh phone setup']) {
        const control = screen.getByRole('button', { name }); expect(control.hasAttribute('disabled')).toBe(true); fireEvent.click(control);
      }
      expect(api.status).toHaveBeenCalledTimes(2); expect(api.confirm).toHaveBeenCalledTimes(action === 'Confirm' ? 2 : 1);
      expect(api.clear).toHaveBeenCalledTimes(action === 'Clear' ? 1 : 0);
      await task8Settle(fresh, task8Configured('candidate_B')); await screen.findByText(task8Time);
      expect(screen.getByText('candidate_B')).toBeTruthy(); expect(screen.queryByText('candidate_A')).toBeNull();
      expect(screen.getByRole('button', { name: 'Clear phone setup' }).hasAttribute('disabled')).toBe(false);
    } finally { await task8Settle(old); await task8Settle(fresh); }
  }), 10_000);
  it('actual hold anchor still navigates when setItem fails without inventing pre-mount intent retention', async () => task8Isolated(async () => {
    location.hash = '#/today'; const f = task8RouteFixture(); const view = render(<Task8RealRoutes context={f.context} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Call · Account A' }));
    const anchor = screen.getByRole('link', { name: 'Review phone setup' }); expect(anchor.getAttribute('href')).toBe('#/settings');
    const events: Event[] = []; const listener = (event: Event) => { events.push(event); };
    window.addEventListener('callie:open-settings-section', listener);
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw Error('storage blocked'); });
    try {
      fireEvent.click(anchor);
      // Unmount the destination owner before default navigation delivers. This
      // case checks the real anchor and event only, not impossible retained intent.
      view.unmount();
      await waitFor(() => expect(location.hash).toBe('#/settings'));
      expect(events).toHaveLength(1); const event = events[0];
      if (!(event instanceof CustomEvent)) throw Error('Expected section CustomEvent');
      expect(event.detail).toBe('phone'); expect(sessionStorage.getItem(task8Key)).toBeNull(); f.assertReadOnly();
    } finally { set.mockRestore(); window.removeEventListener('callie:open-settings-section', listener); }
  }), 10_000);

  it.each(['Confirm', 'Clear'] as const)('new route success survives late unmounted %s result', async action => task8Isolated(async () => {
    location.hash = '#/settings'; sessionStorage.setItem(task8Key, 'phone');
    const api = task8Phone(); const old = task8Deferred();
    if (action === 'Confirm') api.confirm.mockReturnValueOnce(old.promise); else api.clear.mockReturnValueOnce(old.promise);
    const f = task8RouteFixture(api);
    try {
      render(<Task8RealRoutes context={f.context} />);
      await screen.findByText('candidate_A'); fireEvent.click(screen.getByRole('button', { name: `${action} phone setup` }));
      act(() => { location.hash = '#/today'; window.dispatchEvent(new HashChangeEvent('hashchange')); });
      fireEvent.click(await screen.findByRole('button', { name: 'Call · Account A' }));
      api.status.mockResolvedValue(task8Candidate('candidate_B'));
      fireEvent.click(screen.getByRole('link', { name: 'Review phone setup' })); await screen.findByText('candidate_B');
      fireEvent.click(screen.getByRole('button', { name: 'Confirm phone setup' })); await screen.findByText(task8Time);
      await task8Settle(old, action === 'Confirm' ? task8Configured() : task8Empty);
      expect(screen.getByText('candidate_B')).toBeTruthy(); expect(screen.queryByText('candidate_A')).toBeNull();
      expect(screen.getByText('Configured', { exact: true })).toBeTruthy();
      expect(api.status).toHaveBeenCalledTimes(2);
      expect(api.confirm).toHaveBeenLastCalledWith({ expectedFingerprint: 'candidate_B' });
      expect(screen.getByRole('button', { name: 'Clear phone setup' }).hasAttribute('disabled')).toBe(false);
      fireEvent.click(screen.getByRole('button', { name: 'Clear phone setup' })); await screen.findByText('Unconfigured', { exact: true });
      expect(f.forbidden).toEqual([]);
    } finally { await task8Settle(old); }
  }), 10_000);
});


// Task9 append-only additions. Accepted Task8 prefix is byte-for-byte unchanged.
// No import of WorkerSetupSection here: baseline S01 collects in this existing root.
import { OutboundComposer } from '../features/leadInspector/OutboundComposer';

type Task9Api = Pick<CalliePreloadApi['delegation'], 'status' | 'pair'>;
type Task9Status = Awaited<ReturnType<Task9Api['status']>>;
type Task9Receipt = Awaited<ReturnType<Task9Api['pair']>>;
const task9Empty: Task9Status = { state: 'unconfigured', workspaceId: null, endpoint: null, configuration: null };
const task9Endpoint = 'https://worker.fixture.invalid';
const task9Workspace = 'fictional-workspace';
const task9Code = 'A'.repeat(43);
const task9Receipt: Task9Receipt = { state: 'paired', workspaceId: task9Workspace, pairingId: 'fictional-pairing' };
const task9Disclosure = 'Remote owner and mailbox/calendar grants are not established by this local read.';
function task9Api() {
  return { status: vi.fn<Task9Api['status']>(async () => task9Empty), pair: vi.fn<Task9Api['pair']>(async () => task9Receipt) } satisfies Task9Api;
}
function task9Field(name: string): HTMLInputElement {
  const input = screen.getByLabelText(name);
  if (!(input instanceof HTMLInputElement)) throw Error('Expected actual Worker input');
  return input;
}
function task9Fill(code = task9Code) {
  fireEvent.change(task9Field('Endpoint'), { target: { value: task9Endpoint } });
  fireEvent.change(task9Field('Expected workspace ID'), { target: { value: task9Workspace } });
  fireEvent.change(task9Field('Pairing code'), { target: { value: code } });
  expect(task9Field('Pairing code').value).toBe(code);
}
async function task9Controls(label = 'Unconfigured') {
  const region = await screen.findByRole('region', { name: 'Worker connection' });
  await within(region).findByText(label, { exact: true });
  expect(within(region).getByRole('heading', { name: 'Worker connection' })).toBeTruthy();
  expect(within(region).getByText(task9Disclosure)).toBeTruthy();
  for (const name of ['Endpoint', 'Expected workspace ID', 'Pairing code']) expect(within(region).getByLabelText(name)).toBeTruthy();
  for (const name of ['Pair worker', 'Refresh worker status']) expect(within(region).getByRole('button', { name })).toBeTruthy();
  task8Active('Worker connection');
  expect(screen.queryByRole('region', { name: 'Connections' })).toBeNull();
  return region;
}
function task9Settings(delegationApi?: Task9Api) {
  return render(<SettingsScreen state={{ status: 'ready', health }} onRetry={vi.fn()} theme={theme} density={density} {...{ delegationApi }} />);
}
async function task9Isolated(body: () => Promise<void>) {
  const saved: Array<[Storage, Array<[string, string]>]> = [localStorage, sessionStorage].map(storage => [storage, Object.keys(storage).map(key => [key, storage.getItem(key) ?? ''])]);
  const descriptor = Object.getOwnPropertyDescriptor(window, 'callie');
  try { await task8Isolated(body); }
  finally {
    if (descriptor) Object.defineProperty(window, 'callie', descriptor);
    else Reflect.deleteProperty(window, 'callie');
    for (const [storage, values] of saved) { storage.clear(); for (const [key, value] of values) storage.setItem(key, value); }
  }
}
function task9Deferred<T>(fallback: T) {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  const joined = promise.then((): void => undefined, (): void => undefined);
  return { resolve, promise, joined, fallback };
}
async function task9Settle<T>(pending: ReturnType<typeof task9Deferred<T>>) {
  await act(async () => { pending.resolve(pending.fallback); await pending.joined; });
}
// Full Callie API inherits the accepted complete fixture, then gives every
// Task9-sensitive capability its own named guard. Pair never enters native.calls.
function task9RouteFixture(worker = task9Api()) {
  const base = task8RouteFixture();
  base.native.setSnapshot(dailyFixture({ workspaceId: null, accounts: [], calls: { accountIds: [], workloadConflict: false }, answers: [], meetings: [], campaigns: [], ownerStatus: [], transport: [] }));
  const forbidden: string[] = [];
  const deny = (name: string) => vi.fn((..._args: unknown[]): never => { void _args; forbidden.push(name); throw Error(`Unexpected Task9 capability: ${name}`); });
  const api: CalliePreloadApi = {
    ...base.api,
    delegation: {
      ...base.api.delegation, status: worker.status, pair: worker.pair,
      configure: deny('delegation.configure'), configureResearch: deny('delegation.configureResearch'), configurePolicy: deny('delegation.configurePolicy'),
      bootstrap: deny('delegation.bootstrap'), submit: deny('delegation.submit'), sync: deny('delegation.sync'), beginPhone: deny('delegation.beginPhone'),
      prepareRequestedFollowup: deny('delegation.prepareRequestedFollowup'), getRequestedFollowup: deny('delegation.getRequestedFollowup'),
      editRequestedFollowup: deny('delegation.editRequestedFollowup'), approveRequestedFollowup: deny('delegation.approveRequestedFollowup'),
      policyImport: { selectAndPreview: deny('policyImport.selectAndPreview'), confirm: deny('policyImport.confirm'), resume: deny('policyImport.resume'), status: deny('policyImport.status') },
    },
    localWorkspace: {
      ...base.api.localWorkspace, researchCompany: deny('localWorkspace.researchCompany'), reviewCompany: deny('localWorkspace.reviewCompany'),
      createCompany: deny('localWorkspace.createCompany'), linkCompanyPerson: deny('localWorkspace.linkCompanyPerson'), transition: deny('localWorkspace.transition'),
    },
    leadDetail: { ...base.api.leadDetail, beginOutbound: deny('leadDetail.beginOutbound'), confirmTransition: deny('leadDetail.confirmTransition'), findContactInfo: deny('leadDetail.findContactInfo') },
  };
  const context: RouteContext = { ...base.context, api };
  const assertNoActivation = () => {
    expect(forbidden).toEqual([]); expect(base.forbidden).toEqual([]);
    expect(base.native.calls.filter(call => !new Set(['daily.get', 'localWorkspace.get', 'localWorkspace.getCommitments']).has(call.method))).toEqual([]);
    expect(api.phoneSetup.confirm).not.toHaveBeenCalled(); expect(api.phoneSetup.clear).not.toHaveBeenCalled();
  };
  return { ...base, api, context, worker, forbidden, assertNoActivation };
}
async function task9Hold(which: 'details' | 'welcome') {
  await screen.findByText('Worker unavailable', { selector: 'summary' });
  const desk = screen.getByTestId('native-desk');
  const details = desk.querySelector('details.native-desk__connection');
  const welcome = desk.querySelector('.native-desk__welcome');
  if (!(details instanceof HTMLDetailsElement) || !(welcome instanceof HTMLElement)) throw Error('Real worker hold branches were not reachable');
  if (which === 'details') {
    const summary = details.querySelector('summary');
    if (!summary) throw Error('Missing real connection summary');
    fireEvent.click(summary);
    // jsdom implements the native details toggle on summary activation.
    await waitFor(() => expect(details.open).toBe(true));
  }
  const anchor = within(which === 'details' ? details : welcome).getByRole('link', { name: 'Review Settings' });
  expect(anchor.getAttribute('href')).toBe('#/settings');
  expect(sessionStorage.getItem(task8Key)).toBeNull();
  fireEvent.click(anchor);
  await waitFor(() => expect(location.hash).toBe('#/settings'));
  await task9Controls(); expect(sessionStorage.getItem(task8Key)).toBeNull();
}
function Task9ComposerRoutes({ context }: { context: RouteContext }) {
  const { route } = useHashRoute('today');
  // Actual existing composer is the source surface, never a fake Settings route.
  return <PresentationRoot>{route === 'settings' ? renderRoute(route, context) :
    <OutboundComposer channel="email" recipientLabel="person@fixture.invalid" personId="fictional-person" contactMethodId="fictional-email" api={context.api.outreach} onClose={vi.fn()} />}</PresentationRoot>;
}

describe('Task9 real Settings destination integration', () => {
  it('S01 baseline behavioral RED: real Settings exposes Worker fields without eagerly importing missing Worker module', async () => task9Isolated(async () => {
    const a = task9Api(); task9Settings(a);
    expect(a.status).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Worker connection' })); await task9Controls();
    expect(a.status.mock.calls).toEqual([[]]); expect(a.pair).not.toHaveBeenCalled();
  }), 10_000);

  it.each(['details', 'welcome'] as const)('S02 actual %s worker hold routes through real helper/router to supplied Worker API', async which => task9Isolated(async () => {
    location.hash = '#/today'; const f = task9RouteFixture(); render(<Task8RealRoutes context={f.context} />);
    await screen.findByText('Worker unavailable', { selector: 'summary' });
    await waitFor(() => expect(f.worker.status).toHaveBeenCalledTimes(1));
    const before = f.worker.status.mock.calls.length;
    await task9Hold(which);
    expect(f.worker.status).toHaveBeenCalledTimes(before + 1); expect(f.worker.status.mock.calls.every(call => call.length === 0)).toBe(true);
    expect(screen.getByRole('button', { name: 'Pair worker' }).hasAttribute('disabled')).toBe(false);
    expect(f.worker.pair).not.toHaveBeenCalled(); f.assertNoActivation();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh worker status' }));
    await waitFor(() => expect(f.worker.status).toHaveBeenCalledTimes(before + 2)); await task9Controls(); f.assertNoActivation();
  }), 10_000);

  it('S03 successful explicit Pair on actual reached Worker controls stores no code and causes no activation', async () => task9Isolated(async () => {
    location.hash = '#/today'; const f = task9RouteFixture(); render(<Task8RealRoutes context={f.context} />);
    await task9Hold('welcome'); const reads = f.worker.status.mock.calls.length;
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    const events = vi.spyOn(window, 'dispatchEvent');
    task9Fill(); fireEvent.click(screen.getByRole('button', { name: 'Pair worker' }));
    await screen.findByText('Worker paired', { exact: true });
    expect(f.worker.pair.mock.calls).toEqual([[{ endpoint: task9Endpoint, expectedWorkspaceId: task9Workspace, code: task9Code }]]);
    await expect(f.worker.pair.mock.results[0].value).resolves.toEqual(task9Receipt);
    await waitFor(() => expect(f.worker.status).toHaveBeenCalledTimes(reads + 1));
    await task9Controls(); // Startup captures identity once: still unconfigured is the real allowed state.
    expect(task9Field('Pairing code').value).toBe(''); expect(screen.getByText('Worker paired', { exact: true })).toBeTruthy();
    expect(screen.queryByText('Active', { exact: true })).toBeNull();
    expect(storage).not.toHaveBeenCalled(); expect(events).not.toHaveBeenCalled();
    expect(JSON.stringify(f.native.calls)).not.toContain(task9Code);
    expect(document.body.textContent).not.toContain(task9Code); f.assertNoActivation();
  }), 10_000);

  it('S04 missing optional API ignores a complete window.callie fallback and remains unavailable', async () => task9Isolated(async () => {
    const f = task9RouteFixture(); Object.defineProperty(window, 'callie', { configurable: true, value: f.api });
    task9Settings(); fireEvent.click(screen.getByRole('button', { name: 'Worker connection' }));
    await task9Controls('Unavailable'); expect(f.worker.status).not.toHaveBeenCalled(); expect(f.worker.pair).not.toHaveBeenCalled();
    expect(screen.queryByText('Unconfigured', { exact: true })).toBeNull(); f.assertNoActivation();
  }), 10_000);

  it('S05 actual existing Composer Settings → Connections anchor still reaches Gmail/model controls, not Worker', async () => task9Isolated(async () => {
    location.hash = '#/today'; const f = task9RouteFixture();
    const draft: import('../../shared/contracts/outreachContract').EmailDraft = {
      id: 'fictional-draft', personId: 'fictional-person', salesCycleId: 'fictional-cycle', contactMethodId: 'fictional-email',
      recipient: 'person@fixture.invalid', subject: 'Unsent fictional draft', body: 'Fictional local text', revision: 1,
      status: 'draft', generation: 'none', messageId: null, notice: null, updatedAt: task8Time,
    };
    const openDraft = vi.fn<CalliePreloadApi['outreach']['openDraft']>(async () => draft);
    const outreachRead = vi.fn<CalliePreloadApi['outreach']['status']>(async () => outreachStatus);
    const inspectLocalAuthority = vi.fn<CalliePreloadApi['outreach']['inspectLocalAuthority']>(async () => ({
      draftId: draft.id, expectedRevision: draft.revision, personId: draft.personId, contactMethodId: draft.contactMethodId,
      state: 'held', reason: 'email_authority_unavailable', checkedAt: task8Time,
    }));
    const api: CalliePreloadApi = { ...f.api, outreach: { ...f.api.outreach, openDraft, status: outreachRead, inspectLocalAuthority } };
    render(<Task9ComposerRoutes context={{ ...f.context, api }} />);
    await waitFor(() => expect(openDraft).toHaveBeenCalledWith({ personId: draft.personId, contactMethodId: draft.contactMethodId }));
    await waitFor(() => expect(inspectLocalAuthority).toHaveBeenCalled());
    const anchor = screen.getByRole('link', { name: 'Settings → Connections' }); expect(anchor.getAttribute('href')).toBe('#/settings');
    fireEvent.click(anchor); await waitFor(() => expect(location.hash).toBe('#/settings'));
    await screen.findByLabelText('OpenAI API key'); task8Active('Connections');
    expect(screen.getByLabelText('OpenAI model')).toBeTruthy(); expect(screen.getByRole('button', { name: 'Connect Gmail' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Worker connection' })).toBeNull();
    expect(f.worker.status).not.toHaveBeenCalled(); expect(f.worker.pair).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(task8Key)).toBeNull(); f.assertNoActivation();
  }), 10_000);

  it('S06 existing real Phone hold remains Phone when Worker is implemented', async () => task9Isolated(async () => {
    location.hash = '#/today'; const f = task9RouteFixture();
    f.native.setSnapshot(dailyFixture({ answers: [] })); render(<Task8RealRoutes context={f.context} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Call · Account A' }));
    const anchor = screen.getByRole('link', { name: 'Review phone setup' }); expect(anchor.getAttribute('href')).toBe('#/settings'); fireEvent.click(anchor);
    await waitFor(() => expect(location.hash).toBe('#/settings')); await task8Controls();
    expect(screen.queryByRole('region', { name: 'Worker connection' })).toBeNull();
    expect(f.worker.pair).not.toHaveBeenCalled(); f.assertNoActivation();
  }), 10_000);

  it.each(['status', 'pair'] as const)('S07 actual route unmount pending %s settles absent, then remount reads afresh without code', async action => task9Isolated(async () => {
    location.hash = '#/today'; const f = task9RouteFixture();
    const pendingRead = task9Deferred(task9Empty); const pendingPair = task9Deferred(task9Receipt);
    try {
      render(<Task8RealRoutes context={f.context} />); await task9Hold('welcome');
      const reads = f.worker.status.mock.calls.length;
      if (action === 'status') {
        f.worker.status.mockReturnValueOnce(pendingRead.promise); fireEvent.click(screen.getByRole('button', { name: 'Refresh worker status' }));
        await waitFor(() => expect(f.worker.status).toHaveBeenCalledTimes(reads + 1));
      } else {
        f.worker.pair.mockReturnValueOnce(pendingPair.promise); task9Fill(); fireEvent.click(screen.getByRole('button', { name: 'Pair worker' }));
        await waitFor(() => expect(f.worker.pair).toHaveBeenCalledTimes(1));
      }
      act(() => { location.hash = '#/today'; window.dispatchEvent(new HashChangeEvent('hashchange')); });
      await screen.findByText('Worker unavailable', { selector: 'summary' });
      const absentReads = f.worker.status.mock.calls.length;
      expect(screen.queryByRole('region', { name: 'Worker connection' })).toBeNull();
      await task9Settle(pendingRead); await task9Settle(pendingPair);
      expect(f.worker.status).toHaveBeenCalledTimes(absentReads); expect(screen.queryByText('Worker paired', { exact: true })).toBeNull();
      await task9Hold('welcome'); expect(task9Field('Pairing code').value).toBe('');
      expect(f.worker.status).toHaveBeenCalledTimes(absentReads + 1);
      task9Fill('B'.repeat(43)); fireEvent.click(screen.getByRole('button', { name: 'Pair worker' }));
      await screen.findByText('Worker paired', { exact: true }); f.assertNoActivation();
    } finally { await task9Settle(pendingRead); await task9Settle(pendingPair); }
  }), 10_000);

  it('S08 Worker tab-away discards typed code and section-only remount reads status again', async () => task9Isolated(async () => {
    const a = task9Api(); task9Settings(a); fireEvent.click(screen.getByRole('button', { name: 'Worker connection' }));
    await task9Controls(); task9Fill(); fireEvent.click(screen.getByRole('button', { name: 'Diagnostics' }));
    expect(screen.queryByLabelText('Pairing code')).toBeNull(); expect(a.pair).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Worker connection' })); await task9Controls();
    expect(task9Field('Pairing code').value).toBe(''); expect(a.status).toHaveBeenCalledTimes(2);
  }), 10_000);
});


it.each(['initial helper', 'mounted helper', 'rail'] as const)('S09 Worker %s intent positively selects controls and consumes replay', async mode => task9Isolated(async () => {
  const a = task9Api(); const { openSettingsSection } = await task8Navigation();
  if (mode === 'initial helper') openSettingsSection('worker');
  const view = task9Settings(a);
  if (mode === 'mounted helper') act(() => openSettingsSection('worker'));
  if (mode === 'rail') fireEvent.click(screen.getByRole('button', { name: 'Worker connection' }));
  await task9Controls(); expect(a.status).toHaveBeenCalledTimes(1); expect(sessionStorage.getItem(task8Key)).toBeNull();
  view.unmount(); task9Settings(a); task8Active('Diagnostics');
  expect(screen.queryByRole('region', { name: 'Worker connection' })).toBeNull(); expect(a.pair).not.toHaveBeenCalled();
}), 10_000);

it('S10 old unmounted Pair finally cannot clear or unlock a new real-route pending Pair', async () => task9Isolated(async () => {
  location.hash = '#/today'; const f = task9RouteFixture();
  const old = task9Deferred(task9Receipt); const fresh = task9Deferred(task9Receipt);
  f.worker.pair.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  try {
    render(<Task8RealRoutes context={f.context} />); await task9Hold('welcome'); task9Fill();
    fireEvent.click(screen.getByRole('button', { name: 'Pair worker' })); await waitFor(() => expect(f.worker.pair).toHaveBeenCalledTimes(1));
    act(() => { location.hash = '#/today'; window.dispatchEvent(new HashChangeEvent('hashchange')); });
    await task9Hold('welcome'); expect(task9Field('Pairing code').value).toBe(''); task9Fill('B'.repeat(43));
    fireEvent.click(screen.getByRole('button', { name: 'Pair worker' })); await waitFor(() => expect(f.worker.pair).toHaveBeenCalledTimes(2));
    const before = f.worker.status.mock.calls.length; const currentCode = task9Field('Pairing code').value;
    await task9Settle(old); expect(task9Field('Pairing code').value).toBe(currentCode);
    for (const name of ['Pair worker', 'Refresh worker status']) {
      const control = screen.getByRole('button', { name }); expect(control.hasAttribute('disabled')).toBe(true); fireEvent.click(control);
    }
    expect(f.worker.status).toHaveBeenCalledTimes(before); expect(f.worker.pair).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('Worker paired', { exact: true })).toBeNull();
    await task9Settle(fresh); await screen.findByText('Worker paired', { exact: true });
    expect(task9Field('Pairing code').value).toBe('');
    expect(f.worker.pair).toHaveBeenLastCalledWith({ endpoint: task9Endpoint, expectedWorkspaceId: task9Workspace, code: 'B'.repeat(43) });
    f.assertNoActivation();
  } finally { await task9Settle(old); await task9Settle(fresh); }
}), 10_000);

import { NativeDeskRoute } from '../features/today/NativeDeskRoute';
import type { MeetingFirstAccountCallSettings, UpdateCallSettingsRequest } from '../../shared/contracts/localWorkspaceContract';
import { openSettingsSection } from './settingsNavigation';
describe('Call capacity Settings integration', () => {
  it('uses stored intent, mounted helper and rail, and keeps the same editor on a confirmed save', async () => {
    const native = nativeDeskFixture();
    let stored: MeetingFirstAccountCallSettings = { newCallSlots: null, totalCallCapacity: null, revision: 0, updatedAt: '2026-09-11T12:00:00.000Z' };
    native.api.localWorkspace.getCallSettings = vi.fn(async () => stored);
    native.api.localWorkspace.updateCallSettings = vi.fn(async input => stored = { newCallSlots: input.newCallSlots, totalCallCapacity: input.totalCallCapacity, revision: input.expectedRevision + 1, updatedAt: stored.updatedAt });
    const event = vi.fn(); window.addEventListener('callie:workflow-changed', event);
    sessionStorage.setItem('callie.settings.section', 'call-capacity');
    try {
      renderSettings({ localWorkspaceApi: native.api.localWorkspace });
      await waitFor(() => expect((screen.getByRole('button', { name: 'Save call capacity' }) as HTMLButtonElement).disabled).toBe(false));
      const editor = screen.getByRole('region', { name: 'Call capacity' });
      fireEvent.click(screen.getByRole('button', { name: 'Save call capacity' })); await screen.findByText('Call capacity saved.');
      expect(event).toHaveBeenCalledTimes(1); expect(screen.getByRole('region', { name: 'Call capacity' })).toBe(editor);
      fireEvent.click(screen.getByRole('button', { name: 'Diagnostics' })); expect(screen.queryByRole('region', { name: 'Call capacity' })).toBeNull();
      act(() => openSettingsSection('call-capacity')); await screen.findByRole('region', { name: 'Call capacity' });
      fireEvent.click(screen.getByRole('button', { name: 'Diagnostics' })); fireEvent.click(screen.getByRole('button', { name: 'Call capacity' }));
      await waitFor(() => expect(native.api.localWorkspace.getCallSettings).toHaveBeenCalledTimes(3)); expect(event).toHaveBeenCalledTimes(1);
    } finally { window.removeEventListener('callie:workflow-changed', event); sessionStorage.removeItem('callie.settings.section'); }
  });
  it('simultaneous receiver: actual Settings event refreshes mounted NativeDesk Daily, overview and commitments without remount', async () => {
    const native = nativeDeskFixture(dailyFixture({ answers: [] }));
    let stored: MeetingFirstAccountCallSettings = { newCallSlots: null, totalCallCapacity: null, revision: 0, updatedAt: '2026-09-11T12:00:00.000Z' };
    native.api.localWorkspace.getCallSettings = async () => stored;
    native.api.localWorkspace.updateCallSettings = async (input: UpdateCallSettingsRequest) => {
      stored = { newCallSlots: input.newCallSlots, totalCallCapacity: input.totalCallCapacity, revision: input.expectedRevision + 1, updatedAt: stored.updatedAt };
      native.setSnapshot(dailyFixture({ answers: [], callSettings: { newCallSlots: stored.newCallSlots, totalCallCapacity: stored.totalCallCapacity } })); return stored;
    };
    render(<PresentationRoot><SettingsScreen state={{ status: 'ready', health }} onRetry={vi.fn()} theme={theme} density={density} localWorkspaceApi={native.api.localWorkspace} />
      <NativeDeskRoute api={native.api} firstUse={firstUseFixture()} onOpenLead={vi.fn()} onOpenImport={vi.fn()} /></PresentationRoot>);
    await screen.findByRole('button', { name: 'Call · Account A' });
    const count = (method: string) => native.calls.filter(call => call.method === method).length;
    const before = ['daily.get', 'localWorkspace.get', 'localWorkspace.getCommitments'].map(count);
    fireEvent.click(screen.getByRole('button', { name: 'Call capacity' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Save call capacity' }) as HTMLButtonElement).disabled).toBe(false));
    const editor = screen.getByRole('region', { name: 'Call capacity' });
    fireEvent.change(within(editor).getByLabelText('New call slots configuration'), { target: { value: 'number' } });
    fireEvent.change(within(editor).getByLabelText('New call slots'), { target: { value: '0' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Save call capacity' }));
    await screen.findByText('Call capacity saved.');
    await waitFor(() => expect(['daily.get', 'localWorkspace.get', 'localWorkspace.getCommitments'].map(count)).toEqual(before.map(n => n + 1)));
    expect(screen.getByRole('region', { name: 'Call capacity' })).toBe(editor);
    expect(screen.getByText(/New-call slots:/).textContent).toContain('New-call slots: 0');
  });
});

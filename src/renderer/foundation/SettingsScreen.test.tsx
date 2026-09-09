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
  return { status: vi.fn(async () => outreachStatus), configure: vi.fn(async () => outreachStatus), connectGmail: vi.fn(async () => outreachStatus), disconnectGmail: vi.fn(async () => outreachStatus), openDraft: unavailable, saveDraft: unavailable, generateDraft: unavailable, sendDraft: unavailable };
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
    return { get: vi.fn(async () => snapshot), getCommitments: vi.fn(), reviewCompany: vi.fn(unavailableCompanyIntake), createCompany: vi.fn(unavailableCompanyIntake), getCompanyCreateStatus: vi.fn(unavailableCompanyIntake), transition: vi.fn(async (command: import('../../shared/contracts/localWorkspaceContract').LocalWorkflowTransition) => ({ ...receipt, commandId: command.commandId, manifestId: command.manifestId })) };
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

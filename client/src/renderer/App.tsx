import { useCallback, useEffect, useState } from 'react';
import type { ClientStatus } from '../shared/clientContract';
import { DiagnosticsPage } from './pages/DiagnosticsPage';
import { FirmPage } from './pages/FirmPage';
import { PairPage } from './pages/PairPage';
import { SettingsPage } from './pages/SettingsPage';
import { TodayPage } from './pages/TodayPage';
import { WeekPage } from './pages/WeekPage';

/**
 * The thin client's shell: the Pair page until this Mac holds a device token, then a rail with Today, Week,
 * Diagnostics and Settings and an Unpair button. Today is the landing page: the product is the morning
 * list. On mount a paired shell makes two reads: its own status, and Settings for the pause banner, which
 * belongs to the shell because pausing stops every send whichever page is open. The page shown adds its own.
 *
 * One firm's page (slice S2) is reached from a card, not from the rail: it is a detail of the list, and the client
 * has one window, so opening a firm replaces the page and Back to Today returns to it.
 */
type Page = 'today' | 'week' | 'diagnostics' | 'settings';

const PAGES: { id: Page; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'week', label: 'Week' },
  { id: 'diagnostics', label: 'Diagnostics' },
  { id: 'settings', label: 'Settings' },
];

/**
 * Whether everything is paused, and why (slice S5). The banner is on the shell rather than on one page because
 * pausing stops every send and every poll, whichever page David is looking at. It is read from Settings, once when
 * the shell mounts and again after each command any page sends, and it says nothing at all when nothing is paused:
 * a quiet shell means a running one. A Settings read that fails leaves the banner off rather than guessing.
 */
const PAUSE_REFRESH_MS = 60_000;

export function App() {
  const [status, setStatus] = useState<ClientStatus | null>(null);
  const [page, setPage] = useState<Page>('today');
  const [firmId, setFirmId] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [paused, setPaused] = useState<{ paused: boolean; reason: string | null } | null>(null);

  const refreshPaused = useCallback(async () => {
    try {
      const result = await window.callie.get({ view: '/v1/settings' });
      setPaused(result.outcome === 'ok' ? result.view.paused ?? null : null);
    } catch {
      setPaused(null);
    }
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await window.callie.status());
      setProblem(null);
    } catch {
      setProblem('The client could not read its own status.');
    }
  }, []);

  useEffect(() => { void refreshStatus(); }, [refreshStatus]);
  useEffect(() => {
    if (status?.state !== 'paired') return undefined;
    void refreshPaused();
    const timer = window.setInterval(() => { void refreshPaused(); }, PAUSE_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [status?.state, refreshPaused]);

  /** What every page calls after a command: the pairing status and the pause banner both follow a write. */
  const afterCommand = useCallback(async () => {
    await refreshStatus();
    await refreshPaused();
  }, [refreshStatus, refreshPaused]);

  const unpair = async () => {
    try {
      setStatus(await window.callie.unpair());
      setPage('today');
      setFirmId(null);
    } catch {
      setProblem('The client could not forget the pairing.');
    }
  };

  if (status === null) {
    return (
      <main className="shell shell--starting">
        <p role="status">{problem ?? 'Starting'}</p>
      </main>
    );
  }
  if (status.state === 'unpaired') {
    return <PairPage status={status} onPaired={(paired) => { setStatus(paired); setPage('today'); }} />;
  }
  return (
    <div className="shell">
      <nav className="rail" aria-label="Pages">
        <ul className="rail__pages">
          {PAGES.map((entry) => (
            <li key={entry.id}>
              <button
                type="button"
                className="rail__page"
                aria-current={page === entry.id && firmId === null ? 'page' : undefined}
                onClick={() => { setPage(entry.id); setFirmId(null); }}
              >
                {entry.label}
              </button>
            </li>
          ))}
        </ul>
        <div className="rail__foot">
          <p className="rail__device">Paired as {status.deviceId}</p>
          <button type="button" className="rail__unpair" onClick={() => { void unpair(); }}>Unpair</button>
        </div>
      </nav>
      <main className="content">
        {paused?.paused === true && (
          <p role="status" className="paused-banner">Paused: {paused.reason ?? 'no reason recorded'}</p>
        )}
        {problem && <p role="alert" className="error">{problem}</p>}
        {firmId !== null ? <FirmPage firmId={firmId} onBack={() => setFirmId(null)} onStatusChanged={afterCommand} /> : (
          <>
            {page === 'today' && <TodayPage onStatusChanged={afterCommand} onOpenFirm={setFirmId} />}
            {page === 'week' && <WeekPage />}
            {page === 'diagnostics' && <DiagnosticsPage status={status} onStatusChanged={afterCommand} />}
            {page === 'settings' && <SettingsPage onPausedChanged={refreshPaused} />}
          </>
        )}
      </main>
    </div>
  );
}

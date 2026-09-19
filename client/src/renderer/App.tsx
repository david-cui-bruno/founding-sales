import { useCallback, useEffect, useState } from 'react';
import type { ClientStatus } from '../shared/clientContract';
import { DiagnosticsPage } from './pages/DiagnosticsPage';
import { PairPage } from './pages/PairPage';
import { SettingsPage } from './pages/SettingsPage';
import { TodayPage } from './pages/TodayPage';

/**
 * The thin client's shell: the Pair page until this Mac holds a device token, then a rail with Today,
 * Diagnostics and Settings and an Unpair button. The only automatic call on mount is the status read;
 * the Diagnostics page adds its own read when it mounts.
 */
type Page = 'today' | 'diagnostics' | 'settings';

const PAGES: { id: Page; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'diagnostics', label: 'Diagnostics' },
  { id: 'settings', label: 'Settings' },
];

export function App() {
  const [status, setStatus] = useState<ClientStatus | null>(null);
  const [page, setPage] = useState<Page>('diagnostics');
  const [problem, setProblem] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await window.callie.status());
      setProblem(null);
    } catch {
      setProblem('The client could not read its own status.');
    }
  }, []);

  useEffect(() => { void refreshStatus(); }, [refreshStatus]);

  const unpair = async () => {
    try {
      setStatus(await window.callie.unpair());
      setPage('diagnostics');
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
    return <PairPage status={status} onPaired={(paired) => { setStatus(paired); setPage('diagnostics'); }} />;
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
                aria-current={page === entry.id ? 'page' : undefined}
                onClick={() => setPage(entry.id)}
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
        {problem && <p role="alert" className="error">{problem}</p>}
        {page === 'today' && <TodayPage onStatusChanged={refreshStatus} />}
        {page === 'diagnostics' && <DiagnosticsPage status={status} onStatusChanged={refreshStatus} />}
        {page === 'settings' && <SettingsPage />}
      </main>
    </div>
  );
}

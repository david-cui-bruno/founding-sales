import { useEffect, useState, type JSX } from 'react';
import type { WorkspaceScreenProps } from './workspaceNavigation.ts';
import { BrowserResearchQueue } from './BrowserResearchQueue.tsx';
import { BrowserManualProspects } from './BrowserManualProspects.tsx';
import { BrowserCandidateInventory } from './BrowserCandidateInventory.tsx';
import './workspaceProspects.css';

/** Destinations change presentation only. They never acquire or promote a prospect. */
export function BrowserProspectsWorkspace({ client }: WorkspaceScreenProps): JSX.Element {
  const [view, setView] = useState<'prepared' | 'retained' | 'inventory'>('prepared');
  const [, refreshSession] = useState(0);
  useEffect(() => {
    let epoch = client.epoch;
    setView('prepared');
    return client.subscribe(() => {
      if (epoch !== client.epoch || client.current?.status !== 'signed_in') {
        epoch = client.epoch;
        setView('prepared');
      }
      refreshSession(value => value + 1);
    });
  }, [client]);
  return <section className="workspace-prospects" aria-label="Prospects workspace">
    <header className="prospects-page-heading"><div><p className="prospects-eyebrow">Your prospect supply</p>
      <h1>Prospects</h1><p>Source-backed context for your next conversation.</p></div></header>
    <nav className="prospects-view-switch" aria-label="Prospect supply views">
      <button aria-pressed={view === 'prepared'} onClick={() => setView('prepared')}>Prepared research</button>
      <button aria-pressed={view === 'retained'} onClick={() => setView('retained')}>Retained review</button>
      <button aria-pressed={view === 'inventory'} onClick={() => setView('inventory')}>Source inventory</button>
    </nav>
    {client.current?.status !== 'signed_in' ? <p role="status">Sign in to read your current prospect supply.</p>
      : view === 'prepared' ? <BrowserResearchQueue client={client} workspace />
      : view === 'retained' ? client.current.role === 'admin' ? <BrowserManualProspects client={client} /> : <p role="status">Retained review requires current administrator access.</p>
      : <div className="prospects-secondary"><BrowserCandidateInventory client={client} /></div>}
  </section>;
}

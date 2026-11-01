import { useEffect, useRef, useState, type JSX } from 'react';
import type { CallingSubject } from '@fss/contracts';
import type { WorkspaceScreenProps } from './workspaceNavigation.ts';
import { BrowserResearchQueue } from './BrowserResearchQueue.tsx';
import { PreparedProspects } from './PreparedProspects.tsx';
import { BrowserManualProspects } from './BrowserManualProspects.tsx';
import { BrowserCandidateInventory } from './BrowserCandidateInventory.tsx';
import './workspaceProspects.css';

/** Destinations change presentation only. They never acquire or promote a prospect. */
export function BrowserProspectsWorkspace({ client, onOpenCalling }: WorkspaceScreenProps): JSX.Element {
  const [view, setView] = useState<'prepared' | 'qualified' | 'retained' | 'inventory'>('prepared');
  const scope = useRef(0);
  const mounted = useRef(false);
  const [, refreshSession] = useState(0);
  useEffect(() => {
    mounted.current = true;
    scope.current++;
    let epoch = client.epoch;
    setView('prepared');
    const unsubscribe = client.subscribe(() => {
      if (epoch !== client.epoch || client.current?.status !== 'signed_in') {
        scope.current++;
        epoch = client.epoch;
        setView('prepared');
      }
      refreshSession(value => value + 1);
    });
    return () => { mounted.current = false; unsubscribe(); };
  }, [client]);
  const version = scope.current, epoch = client.epoch;
  const openCalling = (subject: CallingSubject): void => {
    if (mounted.current && scope.current === version && client.isCurrent(epoch) && client.current?.status === 'signed_in') onOpenCalling?.(subject);
  };
  const selectView = (next: typeof view): void => { if (next !== view) { scope.current++; setView(next); } };
  return <section className="workspace-prospects" aria-label="Prospects workspace">
    <header className="prospects-page-heading"><div><p className="prospects-eyebrow">Your prospect supply</p>
      <h1>Prospects</h1><p>Source-backed context for your next conversation.</p></div></header>
    <nav className="prospects-view-switch" aria-label="Prospect supply views">
      <button aria-pressed={view === 'prepared'} onClick={() => selectView('prepared')}>Prepared research</button>
      <button aria-pressed={view === 'qualified'} onClick={() => selectView('qualified')}>Qualified publications</button>
      <button aria-pressed={view === 'retained'} onClick={() => selectView('retained')}>Retained review</button>
      <button aria-pressed={view === 'inventory'} onClick={() => selectView('inventory')}>Source inventory</button>
    </nav>
    {view==='prepared'&&client.pendingResearch()!==null?<p role="status">A saved research request is available in Qualified publications.</p>:null}
    {client.current?.status !== 'signed_in' ? <p role="status">Sign in to read your current prospect supply.</p>
      : view === 'prepared' ? <PreparedProspects client={client} {...(onOpenCalling ? { onOpenCalling: openCalling } : {})} />
      : view === 'qualified' ? <BrowserResearchQueue client={client} {...(onOpenCalling ? { onOpenCalling: openCalling } : {})} />
      : view === 'retained' ? client.current.role === 'admin' ? <BrowserManualProspects client={client} {...(onOpenCalling ? { onOpenCalling: openCalling } : {})} /> : <p role="status">Retained review requires current administrator access.</p>
      : <div className="prospects-secondary"><BrowserCandidateInventory client={client} /></div>}
  </section>;
}

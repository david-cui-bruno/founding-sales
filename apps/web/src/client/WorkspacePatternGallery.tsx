import { useState, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkspaceShell, type WorkspaceTheme } from './WorkspaceShell.tsx';
import { WorkspaceEmptyState, WorkspaceListDetail, WorkspaceNotice } from './WorkspacePatterns.tsx';
import { WorkspaceIcon } from './WorkspaceIcon.tsx';
import type { WorkspaceSection } from './workspaceNavigation.ts';
import './browser.css';

/** Development entrypoint only. The production browser never imports this module. */
function WorkspacePatternGallery(): JSX.Element {
  const [theme, setTheme] = useState<WorkspaceTheme>('light');
  const [section, setSection] = useState<WorkspaceSection>('today');
  const [selection, setSelection] = useState<'work' | 'empty' | 'unavailable' | null>('work');
  const list = <>
    <header className="workspace-list-head"><h1>Workspace patterns</h1><p>Development gallery · no product connection</p></header>
    <div className="workspace-list-scroll"><ul className="workspace-work-list">{(['work', 'empty', 'unavailable'] as const).map(value => <li key={value}><button type="button" className="workspace-work-row" aria-current={selection === value ? 'true' : undefined} onClick={() => { setSelection(value); }}><span className="workspace-work-icon"><WorkspaceIcon name={value === 'work' ? 'reply' : 'clock'} /></span><span className="workspace-work-row-content"><strong>{value === 'work' ? 'Working surface' : value === 'empty' ? 'Empty state' : 'Unavailable state'}</strong><span>Actual shared patterns, not a screenshot</span></span></button></li>)}</ul></div>
  </>;
  return <WorkspaceShell section={section} onNavigate={setSection} theme={theme} onTheme={() => { setTheme(value => value === 'light' ? 'dark' : 'light'); }} signedIn onSignOut={() => { setSelection('empty'); }}>
    <p className="workspace-notice">Development only. No login, product data, saving, calling or sending.</p>
    <div className="workspace-content" data-section="today"><WorkspaceListDetail list={list} listLabel="Pattern examples" detailLabel="Pattern preview" detailOpen={selection !== null} onBack={() => { setSelection(null); }}>
      {selection === 'empty' ? <WorkspaceEmptyState title="No work in this example"><p>Empty means an authorized read returned no work.</p></WorkspaceEmptyState> : selection === 'unavailable' ? <WorkspaceNotice warning action={<button type="button" onClick={() => { setSelection('work'); }}>Return to patterns</button>}>An unavailable read is not an empty list.</WorkspaceNotice> : <>
        <div className="workspace-page-head"><div><p className="workspace-eyebrow">Shared working surface</p><h1>One clear next action</h1><p>Typography, fields, borders and statuses use the production tokens.</p></div></div>
        <section className="workspace-glass"><h2>Working card</h2><label htmlFor="pattern-note">Labeled note<textarea id="pattern-note" placeholder="Sample only. This text is never saved." /></label><div className="workspace-inline-actions"><button type="button" className="workspace-primary">Primary action</button><button type="button">Secondary action</button><button type="button" disabled>Unavailable action</button></div></section>
        <div className="workspace-inline-actions"><WorkspaceNotice>Neutral status</WorkspaceNotice><WorkspaceNotice warning>Action needs attention</WorkspaceNotice></div>
      </>}
    </WorkspaceListDetail></div>
  </WorkspaceShell>;
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<WorkspacePatternGallery />);

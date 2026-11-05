import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import { WORKSPACE_SECTIONS, type WorkspaceSection } from './workspaceNavigation.ts';
import { WorkspaceIcon } from './WorkspaceIcon.tsx';

export type WorkspaceTheme = 'light' | 'dark';
const destinations = [...WORKSPACE_SECTIONS, { id: 'settings', label: 'Settings' } satisfies { id: WorkspaceSection; label: string }];

function SectionSearch({ onNavigate, onClose }: { onNavigate: (section: WorkspaceSection) => void; onClose: () => void }): JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null), input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const matches = destinations.filter(item => item.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal(); input.current?.focus();
    return () => { element.close(); };
  }, []);
  const navigate = (section: WorkspaceSection): void => { onClose(); onNavigate(section); };
  return <dialog ref={dialog} className="workspace-search-dialog" aria-label="Jump to a workspace section" onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <form onSubmit={event => { event.preventDefault(); const first = matches[0]; if (first) navigate(first.id); }}>
      <div className="workspace-search-field"><WorkspaceIcon name="search" /><input ref={input} aria-label="Find a section" placeholder="Jump to a section…" value={query} onChange={event => { setQuery(event.target.value); }} /><button type="button" className="workspace-quiet" aria-label="Close section search" onClick={onClose}><WorkspaceIcon name="close" /></button></div>
      <div className="workspace-search-results">{matches.length ? matches.map(item => <button type="button" key={item.id} onClick={() => { navigate(item.id); }}><WorkspaceIcon name={item.id} />{item.label}</button>) : <p>No matching section.</p>}</div>
    </form>
  </dialog>;
}

/** Presentation only. Selecting a destination never changes channel or source authority. */
export function WorkspaceShell({ section, onNavigate, theme, onTheme, signedIn, onSignOut, children }: {
  section: WorkspaceSection; onNavigate: (section: WorkspaceSection) => void;
  theme: WorkspaceTheme; onTheme: () => void; signedIn: boolean;
  onSignOut: () => void; children: ReactNode;
}): JSX.Element {
  const main = useRef<HTMLElement>(null), searchButton = useRef<HTMLButtonElement>(null);
  const previous = useRef(section);
  const [searchOpen, setSearchOpen] = useState(false);
  const closeSearch = (): void => { setSearchOpen(false); searchButton.current?.focus(); };
  useEffect(() => {
    if (previous.current !== section) main.current?.focus();
    previous.current = section;
  }, [section]);
  useEffect(() => {
    if (!signedIn) return;
    const keydown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.altKey || event.isComposing) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'k') {
        event.preventDefault(); setSearchOpen(value => !value); return;
      }
      const target = event.target;
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], dialog, [role="dialog"]')) return;
      if ((event.metaKey || event.ctrlKey) && event.key === ',') {
        event.preventDefault(); onNavigate('settings'); return;
      }
      if (event.metaKey || event.ctrlKey || event.shiftKey) return;
      const destination = WORKSPACE_SECTIONS[Number(event.key) - 1];
      if (/^[1-5]$/u.test(event.key) && destination) {
        event.preventDefault(); onNavigate(destination.id);
      }
    };
    window.addEventListener('keydown', keydown);
    return () => { window.removeEventListener('keydown', keydown); };
  }, [signedIn, onNavigate]);
  return <div className="browser-workspace" data-theme={theme} data-signed-in={signedIn}>
    <a className="workspace-skip" href="#workspace-main">Skip to workspace</a>
    <header className="browser-sidebar">
      <div className="browser-brand"><span className="workspace-mark" aria-hidden="true">C</span><span>Callie</span></div>
      {signedIn ? <>
        <button ref={searchButton} type="button" className="workspace-section-search" onClick={() => { setSearchOpen(true); }} aria-keyshortcuts="Meta+K Control+K"><WorkspaceIcon name="search" /><span>Search sections</span><kbd>⌘K</kbd></button>
        <nav aria-label="Workspace sections">{WORKSPACE_SECTIONS.map((destination, index) => <button key={destination.id} type="button" aria-current={section === destination.id ? 'page' : undefined} aria-keyshortcuts={String(index + 1)} onClick={() => { onNavigate(destination.id); }}><WorkspaceIcon name={destination.id} /><span>{destination.label}</span></button>)}</nav>
      </> : <p className="workspace-muted">Your private sales workspace</p>}
      <div className="browser-session">
        {signedIn ? <button type="button" aria-current={section === 'settings' ? 'page' : undefined} onClick={() => { onNavigate('settings'); }}><WorkspaceIcon name="settings" /> Settings & account</button> : null}
        <div className="workspace-sidebar-foot"><button type="button" aria-pressed={theme === 'dark'} onClick={onTheme}>{theme === 'dark' ? 'Day mode' : 'Night mode'}</button>{signedIn ? <button type="button" onClick={onSignOut}>Sign out</button> : null}</div>
        {signedIn ? <p className="workspace-shortcuts">1–5 navigate · ⌘K sections · ⌘, settings</p> : null}
      </div>
    </header>
    <div className="workspace-canvas"><main ref={main} id="workspace-main" className="browser-main" tabIndex={-1}>{children}</main></div>
    {signedIn && searchOpen ? <SectionSearch onNavigate={onNavigate} onClose={closeSearch} /> : null}
  </div>;
}

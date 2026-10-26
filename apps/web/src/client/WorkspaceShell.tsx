import { useEffect, useRef, type JSX, type ReactNode } from 'react';
import { WORKSPACE_SECTIONS, type WorkspaceSection } from './workspaceNavigation.ts';

export type WorkspaceTheme = 'light' | 'dark';
const icons: Record<WorkspaceSection, string> = {
  today: 'M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h6v6h-6z',
  prospects: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M20 8v6 M17 11h6',
  calling: 'M5 3h4l2 5-3 2a15 15 0 0 0 6 6l2-3 5 2v4a2 2 0 0 1-2 2C10 21 3 14 3 5a2 2 0 0 1 2-2',
  email: 'M3 5h18v14H3z M3 5l9 7 9-7',
  social: 'M21 11a8 8 0 0 1-8 8H7l-5 3 2-6a8 8 0 1 1 17-5z',
  settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2',
};
function Icon({ section }: { section: WorkspaceSection }): JSX.Element {
  return <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={icons[section]} /></svg>;
}

/** Presentation only. Selecting a destination never changes channel or source authority. */
export function WorkspaceShell({ section, onNavigate, theme, onTheme, signedIn, onSignOut, children }: {
  section: WorkspaceSection; onNavigate: (section: WorkspaceSection) => void;
  theme: WorkspaceTheme; onTheme: () => void; signedIn: boolean;
  onSignOut: () => void; children: ReactNode;
}): JSX.Element {
  const main = useRef<HTMLElement>(null);
  const previous = useRef(section);
  useEffect(() => {
    if (previous.current !== section) main.current?.focus();
    previous.current = section;
  }, [section]);
  useEffect(() => {
    if (!signedIn) return;
    const keydown = (event: KeyboardEvent): void => {
      const target = event.target;
      if (event.defaultPrevented || event.altKey || event.isComposing
        || (target instanceof Element && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], dialog, [role="dialog"]'))) return;
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
  const label = section === 'settings' ? 'Settings' : WORKSPACE_SECTIONS.find(value => value.id === section)?.label;
  return <div className="browser-workspace" data-theme={theme}>
    <a className="workspace-skip" href="#workspace-main">Skip to workspace</a>
    <header className="browser-sidebar">
      <div className="browser-brand"><span className="workspace-mark" aria-hidden="true"><i /><i /><i /></span><span>Callie<span className="workspace-brand-dot">.</span></span></div>
      {signedIn ? <nav aria-label="Workspace sections">{WORKSPACE_SECTIONS.map((destination, index) => <button key={destination.id} type="button" aria-current={section === destination.id ? 'page' : undefined} aria-keyshortcuts={String(index + 1)} onClick={() => { onNavigate(destination.id); }}><Icon section={destination.id} /><span>{destination.label}</span></button>)}</nav> : <p className="workspace-muted">Your private sales workspace</p>}
      <div className="browser-session">
        {signedIn ? <><p className="workspace-eyebrow">Personal workspace</p><button type="button" aria-current={section === 'settings' ? 'page' : undefined} onClick={() => { onNavigate('settings'); }}><Icon section="settings" /> Settings & account</button></> : null}
        <div className="workspace-sidebar-foot"><button type="button" aria-pressed={theme === 'dark'} onClick={onTheme}>{theme === 'dark' ? 'Day mode' : 'Night mode'}</button>{signedIn ? <button type="button" onClick={onSignOut}>Sign out</button> : null}</div>
        {signedIn ? <p className="workspace-shortcuts">1–5 to navigate · ⌘/Ctrl , settings</p> : null}
      </div>
    </header>
    <div className="workspace-canvas"><div className="workspace-topbar"><span><span className="workspace-muted">Workspace</span><span aria-hidden="true"> / </span>{signedIn ? label : 'Sign in'}</span><span className="workspace-private">Private workspace</span></div>
      <main ref={main} id="workspace-main" className="browser-main" tabIndex={-1}>{children}</main>
    </div>
  </div>;
}

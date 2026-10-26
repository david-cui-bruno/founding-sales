import type { JSX } from 'react';
import type { WorkspaceScreenProps } from './workspaceNavigation.ts';
import type { WorkspaceTheme } from './WorkspaceShell.tsx';

export function BrowserSettings({ client, theme, onTheme, onRefresh, busy }: WorkspaceScreenProps & {
  theme: WorkspaceTheme; onTheme: () => void; onRefresh: () => void; busy: boolean;
}): JSX.Element {
  const session = client.current;
  return <div className="workspace-settings"><div className="workspace-page-head"><div><p className="workspace-eyebrow">Personal workspace</p><h1>Settings</h1><p>Account, appearance and current access.</p></div></div>
    <section className="workspace-glass"><h2>Appearance</h2><p>Choose the surface that works for you. This preference stays in this page.</p><button type="button" aria-pressed={theme === 'dark'} onClick={onTheme}>{theme === 'dark' ? 'Switch to day mode' : 'Switch to night mode'}</button></section>
    {session?.status === 'signed_in' ? <section className="workspace-glass"><h2>Account</h2><dl><dt>Workspace</dt><dd>{session.workspaceId}</dd><dt>Role</dt><dd>{session.role}</dd><dt>Access expires</dt><dd><time dateTime={session.expiresAt}>{session.expiresAt}</time></dd></dl><button type="button" disabled={busy} onClick={onRefresh}>Refresh access</button><p className="workspace-muted">Sign out from the sidebar to clear private views and drafts.</p></section> : null}
    <p className="workspace-muted">Source capture, calling and channel setup are not configured here. Existing consent, holds and sending limits remain unchanged.</p>
  </div>;
}

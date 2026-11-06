import {useState,type JSX} from 'react';
import { BrowserBookingLink } from './BrowserBookingLink.tsx';
import type { WorkspaceScreenProps } from './workspaceNavigation.ts';
import type { WorkspaceTheme } from './WorkspaceShell.tsx';
import {CallingSetup} from './CallingSetup.tsx';
import {CallingAudioTest} from './CallingAudioTest.tsx';

export function BrowserSettings({ client, theme, onTheme, onRefresh, busy }: WorkspaceScreenProps & {
  theme: WorkspaceTheme; onTheme: () => void; onRefresh: () => void; busy: boolean;
}): JSX.Element {
  const session = client.current;
  const [audioTestBlocked,setAudioTestBlocked]=useState(false);
  return <div className="workspace-settings">
    <div className="workspace-page-head"><div><h1>Settings</h1><p>Account, appearance and current access.</p></div></div>
    {session?.status === 'signed_in' ? <section className="workspace-glass"><h2>Account</h2><dl><dt>Role</dt><dd>{session.role}</dd><dt>Access expires</dt><dd><time dateTime={session.expiresAt}>{session.expiresAt}</time></dd></dl><button type="button" disabled={busy} onClick={onRefresh}>Refresh access</button><p className="workspace-muted">Sign out from the sidebar to clear private views and drafts.</p></section> : null}
    <section className="workspace-glass"><h2>Appearance</h2><p>This preference stays in the current page.</p><div className="workspace-inline-actions" role="group" aria-label="Appearance">{(['light', 'dark'] as const).map(value => <button key={value} type="button" aria-pressed={theme === value} onClick={() => { if (theme !== value) onTheme(); }}>{value === 'light' ? 'Light' : 'Dark'}</button>)}</div></section>
    {session?.status === 'signed_in' && session.role === 'admin' ? <BrowserBookingLink client={client} /> : null}
    {session?.status === 'signed_in' ? <section className="workspace-calling"><CallingSetup client={client}/><CallingAudioTest client={client} paused={audioTestBlocked} onBlockedChange={setAudioTestBlocked}/></section> : null}
    {session?.status === 'signed_in' ? <section className="workspace-glass"><h2>Diagnostics</h2><dl><dt>Workspace ID</dt><dd>{session.workspaceId}</dd></dl></section> : null}
    <p className="workspace-muted">Source capture, calling and channel setup retain their existing consent, holds and sending limits.</p>
  </div>;
}

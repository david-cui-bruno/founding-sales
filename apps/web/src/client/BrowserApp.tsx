import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { BrowserClient } from './BrowserClient.ts';
import { BrowserResearchQueue } from './BrowserResearchQueue.tsx';
import { BrowserEmailCampaigns } from './BrowserEmailCampaigns.tsx';
import { BrowserReplies } from './BrowserReplies.tsx';
import { BrowserManualProspects } from './BrowserManualProspects.tsx';
import { BrowserSocialReview } from './BrowserSocialReview.tsx';
import { BrowserCandidateInventory } from './BrowserCandidateInventory.tsx';
import { BrowserToday } from './BrowserToday.tsx';
import { BrowserSettings } from './BrowserSettings.tsx';
import { WorkspaceShell, type WorkspaceTheme } from './WorkspaceShell.tsx';
import { ReplyAttempt } from './ReplyAttempt.ts';
import { EmailCampaignClient } from './EmailCampaignClient.ts';
import { PrivateDraftCustody } from './PrivateDraftCustody.ts';
import { VoicePreferenceCustody } from './VoicePreferenceCustody.ts';
import type { WorkspaceScreenProps, WorkspaceSection } from './workspaceNavigation.ts';

export function createBrowserClient(): BrowserClient {
  return new BrowserClient({ fetch: globalThis.fetch.bind(globalThis), storage: globalThis.sessionStorage,
    ...(typeof BroadcastChannel === 'undefined' ? {} : { channel: new BroadcastChannel('callie.browser.session.v1') }),
    navigate: url => { globalThis.location.assign(url); }, randomUUID: () => globalThis.crypto.randomUUID() });
}

function ProspectPage({ client }: WorkspaceScreenProps): JSX.Element {
  const [view, setView] = useState<'worklist' | 'research' | 'inventory'>('worklist');
  return <div><div className="workspace-secondary-nav" role="group" aria-label="Prospect tools"><button aria-pressed={view === 'worklist'} onClick={() => { setView('worklist'); }}>Retained prospects</button>{client.current?.status === 'signed_in' && client.current.role === 'admin' ? <><button aria-pressed={view === 'research'} onClick={() => { setView('research'); }}>Research & firm links</button><button aria-pressed={view === 'inventory'} onClick={() => { setView('inventory'); }}>Source inventory</button></> : null}</div>
    {view === 'worklist' ? client.current?.status === 'signed_in' && client.current.role === 'admin' ? <BrowserManualProspects client={client} /> : <div className="workspace-empty workspace-glass"><h1>Prospects</h1><p>The retained prospect worklist requires administrator access. Existing assigned firms remain available in Today.</p></div> : null}
    {view === 'research' ? <BrowserResearchQueue client={client} /> : null}
    {view === 'inventory' ? <BrowserCandidateInventory client={client} /> : null}
  </div>;
}

/** Compile-compatible seam for issue788's focused Email workspace. Only one existing tool mounts. */
function EmailPage({ client }: WorkspaceScreenProps): JSX.Element {
  const [view, setView] = useState<'replies' | 'outbound'>('replies');
  return <div><div className="workspace-page-head"><div><p className="workspace-eyebrow">Conversations & activity</p><h1>Email</h1><p>Personal replies and existing outbound campaigns.</p></div></div><div className="workspace-tabs" role="group" aria-label="Email view"><button aria-pressed={view === 'replies'} onClick={() => { setView('replies'); }}>Replies</button><button aria-pressed={view === 'outbound'} onClick={() => { setView('outbound'); }}>Outbound activity</button></div>{view === 'replies' ? <BrowserReplies client={client} /> : <BrowserEmailCampaigns client={client} />}</div>;
}

export function BrowserApp({ client: suppliedClient }: { client?: BrowserClient } = {}): JSX.Element {
  const owned = useRef<BrowserClient | null>(null);
  if (owned.current === null) owned.current = suppliedClient ?? createBrowserClient();
  const client = owned.current;
  const [session, setSession] = useState(client.current);
  const [generation, setGeneration] = useState(client.epoch);
  const [section, setSection] = useState<WorkspaceSection>('today');
  const [theme, setTheme] = useState<WorkspaceTheme>('light');
  const [workspaceId, setWorkspaceId] = useState('');
  const [deviceLabel, setDeviceLabel] = useState('Local browser');
  const [notice, setNotice] = useState('Checking browser session…');
  const [busy, setBusy] = useState(false);
  const live = useRef(false), operation = useRef(0), locked = useRef(false);
  useEffect(() => {
    live.current = true;
    let observedGeneration = client.epoch;
    let observedStatus = client.current?.status;
    // Custody must observe invalidation even while its feature page is unmounted.
    // These existing owners neither read product APIs nor replay pending commands.
    const replies = new ReplyAttempt(client), campaigns = new EmailCampaignClient(client);
    const privateDrafts = new PrivateDraftCustody(client), voice = new VoicePreferenceCustody(client);
    const unsubscribe = client.subscribe(() => {
      if (!live.current) return;
      setSession(client.current); setGeneration(client.epoch);
      const signedOutTransition = client.current?.status === 'signed_out' && observedStatus !== 'signed_out';
      observedStatus = client.current?.status;
      if (client.epoch !== observedGeneration || signedOutTransition) {
        observedGeneration = client.epoch; operation.current += 1; locked.current = false;
        privateDrafts.clear(); voice.clear();
        setSection('today'); setBusy(false); setWorkspaceId(''); setDeviceLabel('Local browser');
        setNotice('Session changed. Private views and drafts were cleared.');
      }
    });
    const epoch = client.epoch, mine = ++operation.current;
    void client.refresh().then(() => {
      if (live.current && operation.current === mine && client.isCurrent(epoch)) setNotice('');
    }).catch(() => {
      if (live.current && operation.current === mine) setNotice('Session unavailable. Sign in again or refresh access.');
    });
    return () => {
      live.current = false; operation.current += 1; locked.current = false;
      unsubscribe(); replies.dispose(); campaigns.dispose();
      if (suppliedClient === undefined) client.dispose();
    };
  }, [client, suppliedClient]);
  const run = async (work: () => Promise<unknown>): Promise<void> => {
    if (locked.current) return;
    const epoch = client.epoch, mine = ++operation.current;
    locked.current = true; setBusy(true); setNotice('');
    try { await work(); }
    catch { if (live.current && operation.current === mine && client.isCurrent(epoch)) setNotice('Request unavailable or refused. No action was automatically retried.'); }
    finally { if (live.current && operation.current === mine && client.isCurrent(epoch)) { locked.current = false; setBusy(false); } }
  };
  const logout = async (): Promise<void> => {
    // signOut invalidates synchronously. Fence its confirmation against a later sign-in.
    const result = client.signOut(), epoch = client.epoch, mine = ++operation.current;
    try { await result; if (live.current && operation.current === mine && client.isCurrent(epoch)) setNotice('Signed out.'); }
    catch { if (live.current && operation.current === mine && client.isCurrent(epoch)) setNotice('Local private state cleared. Remote sign-out was not confirmed. Sign in again to check access.'); }
  };
  const navigate = useCallback((destination: WorkspaceSection): void => { setSection(destination); setNotice(''); }, []);
  const toggleTheme = (): void => { setTheme(value => value === 'light' ? 'dark' : 'light'); };
  const signedIn = session?.status === 'signed_in' && generation === client.epoch;
  return <WorkspaceShell section={section} onNavigate={navigate} theme={theme} onTheme={toggleTheme} signedIn={signedIn} onSignOut={() => { void logout(); }}>
    {notice ? <p role="status" className="workspace-notice">{notice}</p> : null}
    {!signedIn ? <section aria-label="Sign in" className="workspace-glass workspace-signin"><p className="workspace-eyebrow">Your private workspace</p><h1>Sign in</h1><p>Use your existing workspace to continue.</p><form onSubmit={event => { event.preventDefault(); void run(() => client.signIn(workspaceId, deviceLabel)); }}><label>Workspace ID<input autoComplete="off" name="workspace" value={workspaceId} onChange={event => { setWorkspaceId(event.target.value); }} required /></label><label>Browser label<input name="deviceLabel" value={deviceLabel} onChange={event => { setDeviceLabel(event.target.value); }} required /></label><div className="workspace-inline-actions"><button type="submit" className="workspace-primary" disabled={busy}>Sign in</button><button type="button" disabled={busy} onClick={() => { void run(() => client.refresh()); }}>Refresh access</button></div></form></section> : <div key={generation}>
      {section === 'today' ? <BrowserToday client={client} onNavigate={navigate} /> : null}
      {section === 'prospects' ? <ProspectPage client={client} onNavigate={navigate} /> : null}
      {section === 'calling' ? <div><div className="workspace-page-head"><div><p className="workspace-eyebrow">Calling workspace</p><h1>Calling</h1></div></div><section className="workspace-glass workspace-empty"><h2>Calling sessions are not available yet.</h2><p>No dialer, session or callable queue is connected here. You can review retained prospects and their existing context without starting a call.</p><button type="button" className="workspace-primary" onClick={() => { navigate('prospects'); }}>Review prospects</button></section></div> : null}
      {section === 'email' ? <EmailPage client={client} onNavigate={navigate} /> : null}
      {section === 'social' ? <BrowserSocialReview client={client} /> : null}
      {section === 'settings' ? <BrowserSettings client={client} theme={theme} onTheme={toggleTheme} busy={busy} onRefresh={() => { void run(() => client.refresh()); }} /> : null}
    </div>}
  </WorkspaceShell>;
}

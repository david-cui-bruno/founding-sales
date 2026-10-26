import { useEffect, useState, type JSX } from 'react';
import { BrowserReplies } from './BrowserReplies.tsx';
import { BrowserEmailCampaigns } from './BrowserEmailCampaigns.tsx';
import { type EmailWorkspaceProps } from './workspaceNavigation.ts';
import { BrowserCallingFollowUps } from './BrowserCallingFollowUps.tsx';
import './workspaceEmail.css';

/** Presentation over existing reply and campaign owners. No new send or scheduling path. */
export function BrowserEmailWorkspace({ client, selectedFollowUpDraftId, onFollowUpDraftSelectionChange }: EmailWorkspaceProps): JSX.Element {
  const [view, setView] = useState<'replies' | 'outbound' | 'followups'>(selectedFollowUpDraftId ? 'followups' : 'replies');
  useEffect(() => { if (selectedFollowUpDraftId) setView('followups'); }, [selectedFollowUpDraftId]);
  const [epoch, setEpoch] = useState(client.epoch);
  const [session, setSession] = useState(client.current);
  useEffect(() => client.subscribe(() => {
    setEpoch(client.epoch);
    setSession(client.current);
    if (client.current?.status !== 'signed_in') setView('replies');
  }), [client]);
  if (session?.status !== 'signed_in' || epoch !== client.epoch) return <></>;
  return <section className="email-workspace" aria-label="Email workspace">
    <header className="email-page-heading"><h1>Email</h1><p>Automatic outbound activity. Personal conversations in your hands.</p></header>
    <nav className="email-view-switch" aria-label="Email views">
      <button aria-pressed={view === 'replies'} onClick={() => { setView('replies'); }}>Replies</button>
      <button aria-pressed={view === 'followups'} onClick={() => { setView('followups'); }}>Follow-ups</button>
      <button aria-pressed={view === 'outbound'} onClick={() => { setView('outbound'); }}>Automatic outreach</button>
    </nav>
    {view === 'replies' ? <BrowserReplies key={`replies:${epoch}`} client={client} /> : view === 'followups' ? <BrowserCallingFollowUps key={`followups:${epoch}`} client={client} selectedFollowUpDraftId={selectedFollowUpDraftId ?? null} {...(onFollowUpDraftSelectionChange ? { onFollowUpDraftSelectionChange } : {})} /> : <>
      <p>Approved campaigns admit eligible qualified Firms automatically, without per-recipient review. Incoming replies remain manual; automatic booking is not available here.</p>
      {session.role === 'admin' ? <BrowserEmailCampaigns key={`outbound:${epoch}`} client={client} /> : <p>Campaign control is available to workspace administrators. No outbound activity is inferred from unavailable controls.</p>}
    </>}
  </section>;
}

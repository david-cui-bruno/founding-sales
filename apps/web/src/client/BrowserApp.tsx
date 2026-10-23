import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { pluralFirmPageResponseSchema, todayListResponseSchema, type PluralFirmPageResponse } from '@fss/contracts';
import type { z } from 'zod';
import { Button } from '../../../desktop/src/renderer/ui/button.tsx';
import { Input } from '../../../desktop/src/renderer/ui/input.tsx';
import { countsLabel } from '../../../desktop/src/renderer/todayView.ts';
import { BrowserClient } from './BrowserClient.ts';
import { BrowserResearchQueue } from './BrowserResearchQueue.tsx';
import { BrowserEmailCampaigns } from './BrowserEmailCampaigns.tsx';
import { BrowserMeetingNotes } from './BrowserMeetingNotes.tsx';
import { BrowserReplies } from './BrowserReplies.tsx';
import { BrowserMeetingPreparation } from './BrowserMeetingPreparation.tsx';
import { BrowserCandidateInventory } from './BrowserCandidateInventory.tsx';

type Today = z.infer<typeof todayListResponseSchema>;
export function createBrowserClient(): BrowserClient {
  return new BrowserClient({ fetch: globalThis.fetch.bind(globalThis), storage: globalThis.sessionStorage,
    ...(typeof BroadcastChannel === 'undefined' ? {} : { channel: new BroadcastChannel('callie.browser.session.v1') }),
    navigate: url => { globalThis.location.assign(url); }, randomUUID: () => globalThis.crypto.randomUUID() });
}

export function BrowserApp({ client: suppliedClient }: { client?: BrowserClient } = {}): JSX.Element {
  const owned = useRef<BrowserClient | null>(null);
  if (owned.current === null) owned.current = suppliedClient ?? createBrowserClient();
  const client = owned.current;
  const [session, setSession] = useState(client.current);
  const [generation, setGeneration] = useState(client.epoch);
  const [today, setToday] = useState<Today | null>(null);
  const [firm, setFirm] = useState<PluralFirmPageResponse | null>(null);
  const [workspaceId, setWorkspaceId] = useState('');
  const [deviceLabel, setDeviceLabel] = useState('Local browser');
  const [notice, setNotice] = useState('Checking browser session…');
  const [busy, setBusy] = useState(false);
  const viewRequest = useRef(0);
  useEffect(() => {
    let live = true;
    let observedGeneration = client.epoch;
    const unsubscribe = client.subscribe(() => {
      if (!live) return;
      setSession(client.current);
      setGeneration(client.epoch);
      if (client.epoch !== observedGeneration) {
        observedGeneration = client.epoch;
        viewRequest.current += 1;
        setToday(null); setFirm(null); setBusy(false);
        setNotice('Session changed. Private views and drafts were cleared.');
      }
    });
    void client.refresh().then(() => { if (live) setNotice(''); }).catch(() => { if (live) setNotice('Session unavailable. Sign in again or refresh access.'); });
    return () => { live = false; unsubscribe(); if (suppliedClient === undefined) client.dispose(); };
    // The subscription follows the manager generation, not rendered closures.
  }, [client, suppliedClient]);
  const run = useCallback(async (work: () => Promise<void>): Promise<void> => {
    const epoch = client.epoch;
    setBusy(true);
    try { await work(); }
    catch { if (client.isCurrent(epoch)) setNotice('Request unavailable or refused. No action was automatically retried.'); }
    finally { if (client.isCurrent(epoch)) setBusy(false); }
  }, [client]);
  const loadToday = useCallback(async (): Promise<void> => {
    const epoch = client.epoch, request = ++viewRequest.current;
    setFirm(null); setNotice('Loading Today…');
    const result = await client.request('/today?include=tasks&include=meeting_tasks', todayListResponseSchema);
    if (!client.isCurrent(epoch) || viewRequest.current !== request) return;
    setToday(result); setNotice('');
  }, [client]);
  useEffect(() => {
    if (session?.status === 'signed_in' && today === null) void run(loadToday);
  }, [session?.status, generation, today, run, loadToday]);
  const openFirm = async (firmId: string): Promise<void> => {
    const epoch = client.epoch, request = ++viewRequest.current;
    setFirm(null); setNotice('Loading firm…');
    const result = await client.request('/crm/firm-page-v3', pluralFirmPageResponseSchema,
      { firmId, pageVersion: 2, include: ['stops', 'tasks', 'timeline', 'meeting_tasks'] });
    if (!client.isCurrent(epoch) || viewRequest.current !== request) return;
    if (result.read.firm.id !== firmId) throw new Error('Invalid firm response');
    setFirm(result); setNotice('');
  };
  const logout = async (): Promise<void> => {
    try { await client.signOut(); setNotice('Signed out.'); }
    catch { setNotice('Local private state cleared. Remote sign-out was not confirmed. Sign in again to check access.'); }
  };
  return <main className="mx-auto max-w-4xl space-y-6 p-6">
    <header className="flex items-center justify-between gap-4"><div><h1>Callie</h1><p>Local browser workspace</p></div>{session?.status === 'signed_in' ? <Button onClick={() => { void logout(); }}>Sign out</Button> : null}</header>
    <aside className="rounded-md border p-3">Calling, Gmail capture, LinkedIn outreach, provider setup and native features: OFF / unavailable in this browser. No outreach is performed.</aside>
    {notice ? <p role="status">{notice}</p> : null}
    <BrowserEmailCampaigns client={client} />
    <BrowserReplies client={client} />
    {session?.status !== 'signed_in' ? <section aria-label="Sign in" className="space-y-3"><h2>Sign in</h2>
      <label>Workspace ID<Input aria-label="Workspace ID" value={workspaceId} onChange={event => { setWorkspaceId(event.target.value); }} /></label>
      <label>Browser label<Input aria-label="Browser label" value={deviceLabel} onChange={event => { setDeviceLabel(event.target.value); }} /></label>
      <Button disabled={busy} onClick={() => { void run(async () => { await client.signIn(workspaceId, deviceLabel); }); }}>Sign in</Button>
      <Button disabled={busy} variant="outline" onClick={() => { void run(async () => { await client.refresh(); }); }}>Refresh access</Button>
    </section> : <div key={generation} className="space-y-5">
      <nav className="flex gap-3"><Button disabled={busy} onClick={() => { void run(loadToday); }}>Today</Button><span>{session.role} · Workspace {session.workspaceId}</span></nav>
      {firm === null ? <section aria-label="Today" className="space-y-3"><h2>Today</h2><BrowserCandidateInventory client={client} /><BrowserResearchQueue client={client} />{today !== null ? <p>{today.snapshotDate} · {today.businessTimeZone}</p> : null}
        {today?.cards.length === 0 ? <p>No firms need attention today.</p> : null}
        {today?.cards.map(card => <article key={card.firmId} className="rounded-md border p-4"><h3>{card.firmName}</h3><p>{card.lane.replaceAll('_', ' ')} · {countsLabel(card.counts)}</p><Button disabled={busy} onClick={() => { void run(async () => { await openFirm(card.firmId); }); }}>Open firm</Button></article>)}
      </section> : <section aria-label="Firm" className="space-y-4"><h2>{firm.read.firm.name}</h2><p>{firm.read.firm.timeZone ?? 'Time zone unknown'}</p>
        {firm.read.visibility === 'assigned_or_admin' ? <><h3>People at this firm</h3><ul>{firm.read.firm.contacts.map(contact => <li key={contact.id}>{contact.fullName}{contact.title ? ` · ${contact.title}` : ''}</li>)}</ul></> : <p>Firm detail is restricted to the assigned person or administrator.</p>}
        {firm.visibility === 'assigned_or_admin' ? <><h3>Opportunities</h3><ul>{firm.opportunities.map(entry => <li key={entry.opportunity.id}>{entry.displayName ?? 'Opportunity'} · {entry.opportunity.status}</li>)}</ul><BrowserMeetingPreparation key={`brief:${firm.read.firm.id}`} client={client} firmId={firm.read.firm.id} /><BrowserMeetingNotes key={firm.read.firm.id} client={client} firmId={firm.read.firm.id} /></> : null}
      </section>}
    </div>}
  </main>;
}

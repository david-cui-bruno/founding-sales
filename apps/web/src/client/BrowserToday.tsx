import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { pluralFirmPageResponseSchema, todayListResponseSchema, type PluralFirmPageResponse, type TodayCardDto } from '@fss/contracts';
import type { z } from 'zod';
import { countsLabel } from '../../../desktop/src/renderer/todayView.ts';
import { BrowserMeetingNotes } from './BrowserMeetingNotes.tsx';
import { BrowserMeetingPreparation } from './BrowserMeetingPreparation.tsx';
import type { WorkspaceScreenProps } from './workspaceNavigation.ts';

type Today = z.infer<typeof todayListResponseSchema>;
const lanes: Record<TodayCardDto['lane'], string> = { reply: 'Reply to review', callback: 'Callback', due_work: 'Follow-up', new_firm: 'New firm' };

function FirmContext({ firm, client, onBack, onOpenCalling }: WorkspaceScreenProps & { firm: PluralFirmPageResponse; onBack: () => void }): JSX.Element {
  const [tab, setTab] = useState<'context' | 'preparation' | 'notes'>('context');
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => { title.current?.focus(); }, []);
  const full = firm.visibility === 'assigned_or_admin';
  return <div className="workspace-firm">
    <button type="button" className="workspace-back" onClick={onBack}>← Back to Today</button>
    <div className="workspace-page-head"><div><p className="workspace-eyebrow">Firm context</p><h1 ref={title} tabIndex={-1}>{firm.read.firm.name}</h1><p>{firm.read.firm.timeZone ?? 'Time zone unknown'}</p></div>{onOpenCalling ? <button type="button" onClick={() => { onOpenCalling({ kind: 'firm', firmId: firm.read.firm.id }); }}>Open calling brief</button> : null}</div>
    <div className="workspace-tabs" role="group" aria-label="Firm view"><button aria-pressed={tab === 'context'} onClick={() => { setTab('context'); }}>Context</button>{full ? <><button aria-pressed={tab === 'preparation'} onClick={() => { setTab('preparation'); }}>Meeting preparation</button><button aria-pressed={tab === 'notes'} onClick={() => { setTab('notes'); }}>Meeting notes</button></> : null}</div>
    {tab === 'context' ? <section aria-label="Firm" className="workspace-glass workspace-context">
      {firm.read.visibility === 'assigned_or_admin' ? <><h2>People at this firm</h2>{firm.read.firm.contacts.length ? <ul>{firm.read.firm.contacts.map(contact => <li key={contact.id}>{contact.fullName}{contact.title ? ` · ${contact.title}` : ''}</li>)}</ul> : <p>No people recorded.</p>}</> : <p>Firm detail is restricted to the assigned person or administrator.</p>}
      {full ? <><h2>Opportunities</h2>{firm.opportunities.length ? <ul>{firm.opportunities.map(entry => <li key={entry.opportunity.id}>{entry.displayName ?? 'Opportunity'} · {entry.opportunity.status}</li>)}</ul> : <p>No opportunities recorded.</p>}</> : null}
    </section> : null}
    {tab === 'preparation' && full ? <BrowserMeetingPreparation client={client} firmId={firm.read.firm.id} /> : null}
    {tab === 'notes' && full ? <BrowserMeetingNotes client={client} firmId={firm.read.firm.id} /> : null}
  </div>;
}

/** Current session-memory Today, preserving the API's priority order and exact firm identity. */
export function BrowserToday({ client, onNavigate, onOpenCalling }: WorkspaceScreenProps): JSX.Element {
  const [today, setToday] = useState<Today | null>(null);
  const [firm, setFirm] = useState<PluralFirmPageResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [limit, setLimit] = useState(8);
  const operation = useRef(0), mounted = useRef(false), locked = useRef(false);
  const selectedFirm = useRef<{ firm: PluralFirmPageResponse; epoch: number } | null>(null);
  const title = useRef<HTMLHeadingElement>(null), restoreFocus = useRef(false);
  useEffect(() => { if (today && restoreFocus.current) { restoreFocus.current = false; title.current?.focus(); } }, [today]);
  const load = useCallback(async (firmId?: string): Promise<void> => {
    if (locked.current || client.current?.status !== 'signed_in') return;
    const epoch = client.epoch, mine = ++operation.current;
    const current = (): boolean => mounted.current && mine === operation.current && client.isCurrent(epoch);
    locked.current = true; selectedFirm.current = null; setBusy(true); setFirm(null); setToday(null); setLimit(8);
    setNotice(firmId ? 'Loading firm…' : 'Loading Today…');
    try {
      if (firmId) {
        const result = await client.request('/crm/firm-page-v3', pluralFirmPageResponseSchema,
          { firmId, pageVersion: 2, include: ['stops', 'tasks', 'timeline', 'meeting_tasks'] }, () => { if (!current()) throw new Error('View changed'); });
        if (!current()) return;
        if (result.read.firm.id !== firmId) throw new Error('Invalid firm response');
        selectedFirm.current = { firm: result, epoch }; setFirm(result);
      } else {
        const result = await client.request('/today?include=tasks&include=meeting_tasks', todayListResponseSchema, undefined,
          () => { if (!current()) throw new Error('View changed'); });
        if (!current()) return;
        if (result.workspaceId !== (client.current?.status === 'signed_in' ? client.current.workspaceId : null)) throw new Error('Invalid workspace');
        setToday(result);
      }
      setNotice('');
    } catch { if (current()) setNotice('Current view unavailable or refused. This is not an empty list. Refresh to try again.'); }
    finally { if (current()) { locked.current = false; setBusy(false); } }
  }, [client]);
  useEffect(() => {
    mounted.current = true;
    let epoch = client.epoch;
    const unsubscribe = client.subscribe(() => {
      if (epoch !== client.epoch || client.current?.status !== 'signed_in') {
        epoch = client.epoch; operation.current += 1; locked.current = false; selectedFirm.current = null;
        setToday(null); setFirm(null); setBusy(false); setNotice('');
      }
    });
    void load();
    return () => { mounted.current = false; operation.current += 1; locked.current = false; selectedFirm.current = null; unsubscribe(); };
  }, [client, load]);
  if (client.current?.status !== 'signed_in') return <></>;
  if (firm !== null) return <FirmContext key={firm.read.firm.id} client={client} firm={firm} onBack={() => { restoreFocus.current = true; void load(); }} {...(onOpenCalling ? { onOpenCalling: () => {
    const selected = selectedFirm.current;
    if (!mounted.current || locked.current || selected?.firm !== firm || client.current?.status !== 'signed_in' || !client.isCurrent(selected.epoch)) return;
    onOpenCalling({ kind: 'firm', firmId: selected.firm.read.firm.id });
  } } : {})} />;
  return <div className="workspace-today">
    <div className="workspace-page-head"><div><p className="workspace-eyebrow">Your workspace</p><h1 ref={title} tabIndex={-1}>Today</h1><p>A clear place to pick up the next conversation.</p></div><button type="button" disabled={busy} onClick={() => { void load(); }}>Refresh Today</button></div>
    <section className="workspace-glass workspace-call-banner" aria-label="Manual calling review"><div><p className="workspace-eyebrow">Calling workspace</p><h2>Keep the next conversation in focus.</h2><p>Review prepared context and record your manual call outcome. No call is placed or reserved here.</p></div><div className="workspace-banner-actions"><button className="workspace-primary" type="button" onClick={() => { onNavigate?.('calling'); }}>Review calling briefs →</button><button type="button" className="workspace-quiet" onClick={() => { onNavigate?.('prospects'); }}>Prospect supply</button></div></section>
    <div className="workspace-today-grid"><div><div className="workspace-section-head"><h2>Needs your attention</h2><span className="workspace-muted">{today ? `${today.cards.length} firms in this snapshot` : 'Current firm work'}</span></div>
      {notice ? <p role="status" className="workspace-state">{notice}</p> : null}
      {today?.cards.length === 0 ? <section className="workspace-glass workspace-empty"><h3>No firms need attention in this snapshot.</h3><p>This does not establish that prospect supply or outreach is ready.</p><button type="button" onClick={() => { onNavigate?.('prospects'); }}>Browse retained prospects</button></section> : null}
      {today && today.cards.length > 0 ? <div className="workspace-glass workspace-action-list">{today.cards.slice(0, limit).map(card => <article className="workspace-action-row" key={card.firmId}><span className="workspace-firm-mark" aria-hidden="true">{card.firmName.slice(0, 1)}</span><div><h3>{card.firmName}</h3><p>{lanes[card.lane]} · {countsLabel(card.counts)}</p>{card.blockers?.length ? <small>{card.blockers.map(value => value === 'no_phone' ? 'Phone unavailable' : 'Location unavailable').join(' · ')}</small> : null}</div><button disabled={busy} type="button" onClick={() => { void load(card.firmId); }}>Open firm</button></article>)}</div> : null}
      {today && today.cards.length > limit ? <button type="button" onClick={() => { setLimit(value => value + 8); }}>Show more firms</button> : null}
      {today ? <p className="workspace-snapshot">Snapshot {today.snapshotDate} · {today.businessTimeZone}{today.nextCursor ? ' · More results may exist beyond this snapshot.' : ''}</p> : null}
    </div><aside className="workspace-glass workspace-context-links" aria-label="Continue your work"><h2>Continue your work</h2><button type="button" onClick={() => { onNavigate?.('prospects'); }}><strong>Prospect supply</strong><span>Review retained observations. Readiness is not inferred.</span></button><button type="button" onClick={() => { onNavigate?.('email'); }}><strong>Email</strong><span>Review replies and existing outbound activity.</span></button><button type="button" onClick={() => { onNavigate?.('social'); }}><strong>Social</strong><span>Open private drafts and supported review tools.</span></button></aside></div>
  </div>;
}

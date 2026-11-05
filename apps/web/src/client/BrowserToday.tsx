import { callingPreparationDelay, expireCallingCard, expireCallingPage } from './CallingPreparationLease.ts';
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { pluralFirmPageResponseSchema, todayListResponseSchema, type PluralFirmPageResponse, type TodayCardDto } from '@fss/contracts';
import type { z } from 'zod';
import { BrowserMeetingNotes } from './BrowserMeetingNotes.tsx';
import { BrowserMeetingPreparation } from './BrowserMeetingPreparation.tsx';
import { WorkspaceIcon } from './WorkspaceIcon.tsx';
import { WorkspaceEmptyState, WorkspaceListDetail, WorkspaceNotice } from './WorkspacePatterns.tsx';
import { useWorkspaceNavigation } from './WorkspaceNavigationGuard.tsx';
import type { WorkspaceScreenProps } from './workspaceNavigation.ts';

type Today = z.infer<typeof todayListResponseSchema>;
const lanes: Record<TodayCardDto['lane'], string> = { reply: 'Reply to review', callback: 'Callback', due_work: 'Follow-up', new_firm: 'New company' };
const laneIcons = { reply: 'reply', callback: 'calling', due_work: 'clock', new_firm: 'prospects' } as const;

function countsLabel(counts: TodayCardDto['counts']): string {
  const plural = (count: number, one: string, many: string): string | null => count === 0 ? null : `${String(count)} ${count === 1 ? one : many}`;
  const parts = [plural(counts.replies, 'reply', 'replies'), plural(counts.emailsDue, 'email', 'emails'), plural(counts.callsDue, 'call', 'calls')].filter((part): part is string => part !== null);
  return parts.length === 0 ? 'Nothing outstanding' : parts.join(' · ');
}

function FirmContext({ firm, client, onOpenCalling, onNavigate }: WorkspaceScreenProps & { firm: PluralFirmPageResponse }): JSX.Element {
  const [tab, setTab] = useState<'context' | 'preparation' | 'notes'>('context');
  const canLeave = useWorkspaceNavigation();
  const selectTab = (next: typeof tab): void => { if (next !== tab && canLeave()) setTab(next); };
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => { title.current?.focus(); }, []);
  const full = firm.visibility === 'assigned_or_admin';
  return <div className="workspace-firm">
    <div className="workspace-page-head"><div><p className="workspace-eyebrow">Company context</p><h1 ref={title} tabIndex={-1}>{firm.read.firm.name}</h1><p>{firm.read.firm.timeZone ?? 'Time zone unknown'}</p></div></div>
    <div className="workspace-tabs" role="group" aria-label="Firm view"><button aria-pressed={tab === 'context'} onClick={() => { selectTab('context'); }}>Context</button>{full ? <><button aria-pressed={tab === 'preparation'} onClick={() => { selectTab('preparation'); }}>Meeting preparation</button><button aria-pressed={tab === 'notes'} onClick={() => { selectTab('notes'); }}>Meeting notes</button></> : null}</div>
    {tab === 'context' ? <>
      <section aria-label="Firm" className="workspace-glass workspace-context">
        {firm.read.visibility === 'assigned_or_admin' ? <><h2>People at this firm</h2>{firm.read.firm.contacts.length ? <ul>{firm.read.firm.contacts.map(contact => <li key={contact.id}><strong>{contact.fullName}</strong>{contact.title ? <small>{contact.title}</small> : null}</li>)}</ul> : <p>No people recorded.</p>}</> : <p>Firm detail is restricted to the assigned person or administrator.</p>}
        {full ? <><h2>Opportunities</h2>{firm.opportunities.length ? <ul>{firm.opportunities.map(entry => <li key={entry.opportunity.id}><strong>{entry.displayName ?? 'Opportunity'}</strong><small>{entry.opportunity.status}</small></li>)}</ul> : <p>No opportunity recorded.</p>}</> : null}
      </section>
      <div className="workspace-inline-actions">{onOpenCalling ? <button type="button" className="workspace-primary" onClick={() => { onOpenCalling({ kind: 'firm', firmId: firm.read.firm.id }); }}><WorkspaceIcon name="calling" />Open calling brief</button> : null}{onNavigate ? <button type="button" onClick={() => { onNavigate('email'); }}><WorkspaceIcon name="email" />Open Email</button> : null}</div>
    </> : null}
    {tab === 'preparation' && full ? <BrowserMeetingPreparation client={client} firmId={firm.read.firm.id} /> : null}
    {tab === 'notes' && full ? <BrowserMeetingNotes client={client} firmId={firm.read.firm.id} /> : null}
  </div>;
}

/** The current authorized queue remains alongside its exact selected Firm read. */
export function BrowserToday({ client, onNavigate, onOpenCalling }: WorkspaceScreenProps): JSX.Element {
  const canLeave = useWorkspaceNavigation();
  const [today, setToday] = useState<Today | null>(null);
  const [firm, setFirm] = useState<PluralFirmPageResponse | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const operation = useRef(0), mounted = useRef(false);
  const selectedFirm = useRef<{ firm: PluralFirmPageResponse; epoch: number } | null>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const load = useCallback(async (firmId?: string): Promise<void> => {
    if (client.current?.status !== 'signed_in' || !canLeave()) return;
    const epoch = client.epoch, mine = ++operation.current;
    const current = (): boolean => mounted.current && mine === operation.current && client.isCurrent(epoch);
    selectedFirm.current = null; setBusy(true); setFirm(null); setSelectedId(firmId ?? null);
    if (!firmId) setToday(null);
    setNotice(firmId ? 'Loading firm…' : 'Loading Today…');
    try {
      if (firmId) {
        const result = await client.request('/crm/firm-page-v3', pluralFirmPageResponseSchema,
          { firmId, pageVersion: 2, include: ['stops', 'tasks', 'timeline', 'meeting_tasks', 'callingPreparation'] }, () => { if (!current()) throw new Error('View changed'); });
        if (!current()) return;
        if (result.read.firm.id !== firmId) throw new Error('Invalid firm response');
        const currentPage = expireCallingPage(result); selectedFirm.current = { firm: currentPage, epoch }; setFirm(currentPage);
      } else {
        const result = await client.request('/today?include=tasks&include=meeting_tasks&include=callingPreparation', todayListResponseSchema, undefined,
          () => { if (!current()) throw new Error('View changed'); });
        if (!current()) return;
        if (result.workspaceId !== (client.current?.status === 'signed_in' ? client.current.workspaceId : null)) throw new Error('Invalid workspace');
        setToday({ ...result, cards: result.cards.map(card => expireCallingCard(card)) });
      }
      setNotice('');
    } catch { if (current()) setNotice('Current view unavailable or refused. This is not an empty list. Refresh to try again.'); }
    finally { if (current()) setBusy(false); }
  }, [client, canLeave]);
  const clearSelection = (): void => { if (!canLeave()) return; operation.current += 1; selectedFirm.current = null; setFirm(null); setSelectedId(null); setBusy(false); setNotice(''); };
  useEffect(() => { if (selectedId === null) title.current?.focus(); }, [selectedId]);
  useEffect(() => {
    mounted.current = true;
    let epoch = client.epoch;
    const unsubscribe = client.subscribe(() => {
      if (epoch !== client.epoch || client.current?.status !== 'signed_in') {
        epoch = client.epoch; operation.current += 1; selectedFirm.current = null;
        setToday(null); setFirm(null); setSelectedId(null); setBusy(false); setNotice('');
      }
    });
    void load();
    return () => { mounted.current = false; operation.current += 1; selectedFirm.current = null; unsubscribe(); };
  }, [client, load]);
  useEffect(() => {
    const delay = callingPreparationDelay([...(today?.cards ?? []), ...(firm ? [firm.read.firm] : [])]);
    if (delay === null) return;
    const timer = setTimeout(() => {
      setToday(value => value ? { ...value, cards: value.cards.map(card => expireCallingCard(card)) } : null);
      setFirm(value => { if (!value) return null; const next = expireCallingPage(value); if (selectedFirm.current?.firm === value) selectedFirm.current = { ...selectedFirm.current, firm: next }; return next; });
    }, Math.min(delay, 2_147_483_647));
    return () => { clearTimeout(timer); };
  }, [today, firm]);
  if (client.current?.status !== 'signed_in') return <></>;
  const list = <>
    <header className="workspace-list-head"><h1 ref={title} tabIndex={-1}>Today</h1>{today ? <p><time dateTime={today.snapshotDate}>{today.snapshotDate}</time> · {today.businessTimeZone}</p> : null}<div className="workspace-inline-actions"><span className="workspace-muted">{today ? `${today.cards.length} ${today.cards.length === 1 ? 'company' : 'companies'} in this snapshot` : 'Current company work'}</span><button type="button" disabled={busy} onClick={() => { void load(); }}>Refresh Today</button></div></header>
    <div className="workspace-list-scroll">
      {!selectedId && notice ? <WorkspaceNotice warning={!busy}>{notice}</WorkspaceNotice> : null}
      {today?.cards.length === 0 ? <WorkspaceNotice>No firms need attention in this snapshot.</WorkspaceNotice> : null}
      <ul className="workspace-work-list">{today?.cards.map(card => <li key={card.firmId}><button type="button" className="workspace-work-row" aria-label={`Open ${card.firmName}`} aria-current={selectedId === card.firmId ? 'true' : undefined} onClick={() => { void load(card.firmId); }}><span className="workspace-work-icon" data-lane={card.lane}><WorkspaceIcon name={laneIcons[card.lane]} /></span><span className="workspace-work-row-content"><strong>{card.firmName}</strong><span>{lanes[card.lane]} · {countsLabel(card.counts)}</span>{card.blockers?.length ? <small>{card.blockers.map(value => value === 'no_phone' ? 'Phone unavailable' : 'Location unavailable').join(' · ')}</small> : null}</span></button></li>)}</ul>
    </div>
    <footer className="workspace-list-footer"><p>{today?.nextCursor ? 'More work exists beyond this snapshot.' : 'Ordered by current work, not a contact-ready count.'}</p></footer>
  </>;
  let detail: JSX.Element;
  if (selectedId && firm) detail = <FirmContext key={firm.read.firm.id} client={client} firm={firm} {...(onNavigate ? { onNavigate } : {})} {...(onOpenCalling ? { onOpenCalling: () => {
    const selected = selectedFirm.current;
    if (!mounted.current || busy || selected?.firm !== firm || client.current?.status !== 'signed_in' || !client.isCurrent(selected.epoch)) return;
    onOpenCalling({ kind: 'firm', firmId: selected.firm.read.firm.id });
  } } : {})} />;
  else if (selectedId) detail = <WorkspaceNotice warning={!busy} action={!busy ? <button type="button" onClick={() => { void load(selectedId); }}>Retry selected company</button> : undefined}>{notice}</WorkspaceNotice>;
  else detail = <WorkspaceEmptyState title={today?.cards.length === 0 ? 'You’re clear for now' : 'Pick up the next conversation'} action={onNavigate ? <button type="button" className="workspace-primary" onClick={() => { onNavigate('prospects'); }}>Open prospects</button> : undefined}><p>{today?.cards.length === 0 ? 'Browse prospects when you want to start a new conversation.' : 'Choose a company from Today. Its context stays beside your work list.'}</p></WorkspaceEmptyState>;
  return <div className="workspace-today"><WorkspaceListDetail list={list} listLabel="Today work list" detailLabel="Selected company" detailOpen={selectedId !== null} onBack={clearSelection} backLabel="Back to Today">{detail}</WorkspaceListDetail></div>;
}

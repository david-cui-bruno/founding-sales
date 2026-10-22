import { useEffect, useRef, useState, type JSX } from 'react';
import { firmMeetingsResponseSchema, meetingPreparationResponseSchema, type FirmMeetingDto, type MeetingPreparationItem, type MeetingPreparationResponse } from '@fss/contracts';
import { type BrowserClient } from './BrowserClient.ts';

function safeSource(value: string | null): string | null {
  if (value === null) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
function BriefSection({ title, items, limit = 3 }: { title: string; items: MeetingPreparationItem[]; limit?: number }): JSX.Element {
  return <section aria-label={title}><h4>{title}</h4>{items.length === 0 ? <p>Unknown: no available evidence.</p> : <ul>{items.slice(0, limit).map((item, index) => {
    const href = safeSource(item.sourceUrl);
    return <li key={index}>{item.label ? <strong>{item.label}: </strong> : null}{item.text}<small className="block">{item.provenance} · Source: {item.source} · {item.at ?? 'Date unknown'}{href !== null ? <> · <a href={href} target="_blank" rel="noopener noreferrer">Source page</a></> : null}</small></li>;
  })}</ul>}{items.length > limit ? <p>Additional evidence not shown in this bounded preparation view.</p> : null}</section>;
}

/** Read-only, session-memory preparation. No model, booking or outreach action. */
export function BrowserMeetingPreparation({ client, firmId }: { client: BrowserClient; firmId: string }): JSX.Element {
  const [meetings, setMeetings] = useState<FirmMeetingDto[]>([]);
  const [brief, setBrief] = useState<MeetingPreparationResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('Load existing meetings to prepare. No booking or outreach is available.');
  const owner = useRef(0);
  const scope = useRef({ client, firmId });
  scope.current = { client, firmId };
  useEffect(() => {
    const clear = (): void => {
      owner.current += 1;
      setMeetings([]); setBrief(null); setBusy(false);
      setNotice('Load existing meetings to prepare. No booking or outreach is available.');
    };
    clear();
    const unsubscribe = client.subscribe(() => { if (client.current?.status !== 'signed_in') clear(); });
    return () => { owner.current += 1; unsubscribe(); };
  }, [client, firmId]);
  const read = async (meeting?: FirmMeetingDto): Promise<void> => {
    if (busy) return;
    const epoch = client.epoch, requestOwner = ++owner.current;
    const current = (): boolean => scope.current.client === client && scope.current.firmId === firmId && owner.current === requestOwner && client.isCurrent(epoch);
    setBusy(true); setBrief(null);
    if (meeting === undefined) setMeetings([]);
    setNotice(meeting === undefined ? 'Loading existing meetings…' : 'Opening preparation…');
    try {
      if (meeting === undefined) {
        const answer = await client.request(`/meetings/firm?firmId=${encodeURIComponent(firmId)}`, firmMeetingsResponseSchema, undefined, () => { if (!current()) throw new Error('Scope changed'); });
        if (!current()) return;
        setMeetings(answer.meetings);
        setNotice(answer.meetings.length === 0 ? 'No existing meetings available.' : 'Choose an existing meeting to open preparation.');
      } else {
        const answer = await client.request(`/meetings/brief?meetingId=${encodeURIComponent(meeting.meetingId)}&version=2&include=meeting_tasks`, meetingPreparationResponseSchema, undefined, () => { if (!current()) throw new Error('Scope changed'); });
        if (!current()) return;
        if (answer.firmId !== firmId || answer.meetingId !== meeting.meetingId) throw new Error('Identity mismatch');
        setBrief(answer); setNotice('Preparation from existing records. Inferred and unverified content is not confirmed fact.');
      }
    } catch { if (current()) setNotice('Meeting preparation unavailable. Check current access and retry explicitly.'); }
    finally { if (current()) setBusy(false); }
  };
  const sections = brief?.sections;
  const evidence = sections === undefined ? [] : [...sections.whyThisDemo.items, ...sections.firm.items, ...sections.conversations.items, ...sections.objections.items, ...sections.commitments.items, ...(sections.workflow?.items ?? [])];
  const facts = sections === undefined ? [] : [...sections.whyThisDemo.items, ...sections.firm.items, ...(sections.workflow?.items ?? [])].filter(item => item.provenance === 'observed' || item.provenance === 'stated');
  const hypotheses = evidence.filter(item => item.provenance === 'inferred' || item.provenance === 'unverified');
  return <section aria-label="Meeting preparation" className="space-y-3 rounded-md border p-4">
    <h3>Meeting preparation</h3><p>Firm ID: {firmId}</p>
    <button type="button" disabled={busy || client.current?.status !== 'signed_in'} onClick={() => { void read(); }}>Load existing meetings</button>
    <p role="status">{notice}</p>
    <ul>{meetings.slice(0, 12).map(meeting => <li key={meeting.meetingId}>{meeting.startsAt} · Meeting ID: {meeting.meetingId} <button type="button" disabled={busy} onClick={() => { void read(meeting); }}>Open preparation</button></li>)}</ul>
    {meetings.length > 12 ? <p>Showing the first 12 existing meetings.</p> : null}
    {brief !== null && sections !== undefined ? <article aria-label="Current meeting brief">
      <h4>{brief.meeting.title ?? 'Meeting title unknown'}</h4><p>Meeting ID: {brief.meetingId} · Firm ID: {brief.firmId}</p>
      <p>Person: {brief.meeting.attendeeName ?? 'Unknown'} · Starts: {brief.meeting.startsAt} · Ends: {brief.meeting.endsAt}</p><p>Read at: {brief.generatedAt}</p>
      <BriefSection title="Company and person facts" items={facts.filter(item => item.source !== 'call' && item.source !== 'email_thread')} />
      <BriefSection title="Prior interactions" items={sections.conversations.items.filter(item => item.provenance === 'observed' || item.provenance === 'stated')} />
      <BriefSection title="Inferred or unverified hypotheses" items={hypotheses} />
      <BriefSection title="Preparation questions" items={sections.openQuestions?.items ?? []} />
      <BriefSection title="Next-step objective" items={sections.objective?.items ?? []} limit={1} />
    </article> : null}
  </section>;
}

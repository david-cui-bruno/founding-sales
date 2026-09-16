import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CalliePreloadApi } from '../../../shared/preload';
import type { DailyAnswer } from '../../../shared/contracts/dailyContract';
import { accountPreparationReplySchema, type AccountPreparation } from '../../../shared/contracts/accountPreparationContract';
import { approveMeetingFromReplySchema, boundMeetingApprovalStatus, schedulingEvidence, type ApproveMeetingFromReply, type MeetingApprovalStatus } from '../../../shared/contracts/meetingContract';
import { captureDailySessionScope } from '../today/dailySessionScope';

export type MeetingApprovalApi = Pick<CalliePreloadApi['delegation'], 'approveMeeting' | 'getMeetingApproval' | 'getAccountPreparation'>;
type Reply = Extract<DailyAnswer, { kind: 'reply' }>;
const localInput = /^\d{4}-\d\d-\d\dT\d\d:\d\d$/;
const evidenceHold = {
  latest_message_ambiguous: 'The latest saved messages share one timestamp. Meeting approval is held until the saved thread is clearer.',
  sender_ambiguous: 'The latest saved message has more than one sender. Meeting approval is held.',
} as const;
const dateFormat = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' });

/** Explicit approval of one explicit slot quoted in the saved reply. The attendee is
 * the sender of the quoted message. Approval queues one owner command; this component
 * never books, sends, or infers agreement. Mixed replies always need this approval. */
export function MeetingApproval({ item, api, workspaceId, actionHold }: { item: Reply; api: Partial<MeetingApprovalApi>; workspaceId: string; actionHold?: string }) {
  const headingId = useId();
  const evidence = useMemo(() => schedulingEvidence(item.thread), [item.thread]);
  const thread = item.thread, accountId = item.accountId, threadId = thread.thread.providerThreadId;
  const [quote, setQuote] = useState<string | null>(null);
  const [preparation, setPreparation] = useState<{ result?: AccountPreparation; error?: boolean } | null>(null);
  const [status, setStatus] = useState<MeetingApprovalStatus | null>(null);
  const [retained, setRetained] = useState<ApproveMeetingFromReply | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'read' | 'approve' | null>(null);
  const [localStart, setLocalStart] = useState('');
  const [summary, setSummary] = useState('Callie meeting');
  const [invite, setInvite] = useState(true);
  const [confirmed, setConfirmed] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const readStatus = api.getMeetingApproval, available = evidence.kind === 'available';
  // The existing approval, if any, is a local read of the queued command and its receipt. It is never an owner call.
  useEffect(() => {
    if (!readStatus || !available || actionHold) return;
    let cancelled = false;
    void (async () => {
      try {
        const check = captureDailySessionScope(api, workspaceId);
        const result = await readStatus({ accountId, threadId });
        check();
        if (cancelled || !alive.current) return;
        setStatus(result);
        if (result && result.receipt.status !== 'rejected') setRetained(null);
      } catch { /* An unknown status stays unknown. Approval remains an explicit action. */ }
    })();
    return () => { cancelled = true; };
  }, [api, readStatus, workspaceId, accountId, threadId, actionHold, available]);
  if (evidence.kind !== 'available') {
    // No scheduling signal on the latest saved message: approval is not offered at all.
    if (evidence.reason === 'no_scheduling_signal') return null;
    return <section aria-labelledby={headingId}><h4 id={headingId}>Meeting approval</h4><p className="native-desk__hold">{evidenceHold[evidence.reason]}</p></section>;
  }
  if (!api.approveMeeting || !api.getAccountPreparation) {
    return <section aria-labelledby={headingId}><h4 id={headingId}>Meeting approval</h4><p className="native-desk__hold">Meeting approval is unavailable in this bridge. Nothing was queued.</p></section>;
  }
  const readPreparation = api.getAccountPreparation, approve = api.approveMeeting;
  const read = async () => {
    if (busy) return;
    setBusy('read'); setError(null);
    try {
      const check = captureDailySessionScope(api, workspaceId);
      const raw = await readPreparation({ accountId });
      check();
      const result = accountPreparationReplySchema({ workspaceId, accountId }).parse(raw);
      if (alive.current) setPreparation({ result });
    } catch { if (alive.current) setPreparation({ error: true }); }
    finally { if (alive.current) setBusy(null); }
  };
  const result = preparation?.result ?? null, config = result?.configuration ?? null, rules = result?.meetingRules;
  const calendarHold = !result ? null
    : !config || config.state !== 'active' ? 'Owner configuration is not active for this company. Approval held.'
    : config.calendarId === null ? 'No calendar is configured for this company. Approval held.'
    : config.mailboxSubject !== thread.thread.mailboxSubject ? 'The configured mailbox differs from this saved thread. Approval held.'
    : rules === undefined ? 'Scheduling rules are not readable from this app yet. Approval held.'
    : rules === null ? 'No confirmed scheduling rules are stored for this calendar. Approval held.'
    : null;
  const ready = result && config?.calendarId && rules && !calendarHold ? { calendarId: config.calendarId, rules, checkedAt: result.checkedAt } : null;
  const selectedQuote = quote && evidence.quotes.includes(quote) ? quote : evidence.quotes[0]!;
  const request = (() => {
    if (!ready || !localInput.test(localStart)) return null;
    const parsed = approveMeetingFromReplySchema.safeParse({ accountId, threadId, expectedThreadRevision: thread.revision, expectedContextRevision: thread.contextRevision,
      agreementEvidenceId: evidence.message.id, attendeeEmail: evidence.attendeeEmail, quote: selectedQuote, calendarId: ready.calendarId, rulesRevision: ready.rules.revision,
      timezone: ready.rules.timezone, durationMinutes: ready.rules.durationMinutes, localStart: `${localStart}:00`, summary: summary.trim(), inviteAttendees: invite });
    return parsed.success ? parsed.data : null;
  })();
  const settled = !!status && status.receipt.status !== 'rejected';
  const locked = settled || !!retained || !!busy;
  const canApprove = !!request && confirmed && !actionHold && !locked;
  const send = async (payload: ApproveMeetingFromReply) => {
    if (busy) return;
    setBusy('approve'); setError(null); setRetained(payload);
    try {
      const check = captureDailySessionScope(api, workspaceId);
      const outcome = boundMeetingApprovalStatus(payload).parse(await approve(payload));
      check();
      if (alive.current) { setStatus(outcome); setRetained(null); }
    } catch {
      if (alive.current) setError('Approval was not acknowledged. The exact request is retained; retrying the same approval never issues a second command. Nothing was booked or sent.');
    } finally { if (alive.current) setBusy(null); }
  };
  const endLocal = ready && localInput.test(localStart) ? new Date(Date.parse(`${localStart}:00Z`) + ready.rules.durationMinutes * 60000).toISOString().slice(11, 16) : null;
  return (
    <section aria-labelledby={headingId} className="native-desk__meeting-approval">
      <h4 id={headingId}>Meeting approval</h4>
      <p>Scheduling evidence from the latest saved message · <time dateTime={evidence.message.date}>{dateFormat.format(new Date(evidence.message.date))}</time></p>
      {evidence.quotes.length > 1 ? (
        <fieldset><legend>Quoted evidence</legend>
          {evidence.quotes.map(candidate => <label key={candidate} className="native-desk__check">
            <input type="radio" name={`${headingId}-quote`} checked={selectedQuote === candidate} disabled={locked} onChange={() => setQuote(candidate)} />
            <blockquote>{candidate}</blockquote>
          </label>)}
        </fieldset>
      ) : <blockquote>{selectedQuote}</blockquote>}
      <p>Attendee: {evidence.attendeeEmail} (sender of the quoted message).{evidence.mixed && ' This reply also contains other content; approval is required and never inferred.'}</p>
      <div className="native-desk__actions">
        <button type="button" disabled={!!busy || !!actionHold || settled} onClick={() => { void read(); }}>Check calendar and scheduling rules</button>
      </div>
      {busy === 'read' && <p>Reading calendar and scheduling rules…</p>}
      {preparation?.error && <p className="native-desk__hold">Calendar and scheduling rules could not be read. Check again to retry explicitly.</p>}
      {ready && <p>Calendar: {ready.calendarId} · Time zone: {ready.rules.timezone} · Duration: {ready.rules.durationMinutes} minutes · Rules revision {ready.rules.revision}. Observed <time dateTime={ready.checkedAt}>{ready.checkedAt}</time>; not a live availability check.</p>}
      {calendarHold && <p className="native-desk__hold">{calendarHold}</p>}
      <label>Meeting start<input type="datetime-local" aria-label="Meeting start" step={60} value={localStart} disabled={locked} onChange={e => setLocalStart(e.target.value)} /></label>
      {ready && <p>{endLocal ? `Ends at ${endLocal} (${ready.rules.timezone}).` : `Enter the start in ${ready.rules.timezone}. The end follows the ${ready.rules.durationMinutes} minute rule.`}</p>}
      <label>Calendar title<input aria-label="Calendar title" maxLength={240} value={summary} disabled={locked} onChange={e => setSummary(e.target.value)} /></label>
      <label className="native-desk__check"><input type="checkbox" checked={invite} disabled={locked} onChange={e => setInvite(e.target.checked)} />Send a calendar invitation to the attendee when the worker books</label>
      <label className="native-desk__check"><input type="checkbox" checked={confirmed} disabled={locked} onChange={e => setConfirmed(e.target.checked)} />I confirm this slot matches the quoted reply and the attendee address</label>
      <div className="native-desk__actions">
        <button type="button" className="native-desk__primary" disabled={!canApprove} onClick={() => { if (request) void send(request); }}>Approve meeting</button>
        {retained && !busy && <button type="button" disabled={!!actionHold} onClick={() => { void send(retained); }}>Retry same approval</button>}
      </div>
      <div className="native-desk__feedback" aria-live="polite">
        <p>Approval queues one owner command for the worker’s calendar poller. This app books nothing and sends nothing.</p>
        {actionHold && <p>{actionHold}</p>}
        {!ready && !calendarHold && !preparation?.error && <p>Check the calendar and scheduling rules before approving.</p>}
        {busy === 'approve' && <p>Approving…</p>}
        {error && <p role="alert">{error}</p>}
        {status && <p>Meeting approval receipt: {status.receipt.status}.</p>}
        {status?.receipt.reason && <p>{status.receipt.reason}</p>}
        {status && <p>{status.receipt.status === 'applied' ? 'The worker will reserve this slot. Check Upcoming meetings after a refresh; nothing is confirmed booked yet.'
          : status.receipt.status === 'rejected' ? 'This approval was rejected. A new approval requires your explicit action; nothing is re-issued automatically.'
          : 'Pending owner receipt. Nothing is booked.'}</p>}
        {status && <p>Approved slot: {status.localStart.slice(0, 16).replace('T', ' ')} ({status.timezone}) with {status.attendeeEmail} on {status.calendarId}.</p>}
      </div>
    </section>
  );
}

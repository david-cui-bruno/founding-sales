import { useEffect, useId, useRef, useState } from 'react';
import type { CalliePreloadApi } from '../../../shared/preload';
import type { AccountPreparation } from '../../../shared/contracts/accountPreparationContract';
import { remoteGoogleGrantStatusSchema, type RemoteGoogleGrantStatus } from '../../../shared/contracts/remoteGoogleGrantContract';
import { googleScopes } from '../../../shared/contracts/googleGrantCapabilities';
import { accountIntakeRetry, boundAccountIntakeConfigureStatus, type AccountIntakeConfigureStatus, type AccountIntakeHoldReason, type ConfigureAccountIntake } from '../../../shared/contracts/accountIntakeConfigureContract';
import { captureDailySessionScope } from '../today/dailySessionScope';

export type AccountIntakeConfigureApi = Pick<CalliePreloadApi['delegation'], 'configureIntake' | 'googleConnections'>;
const holdText: Record<AccountIntakeHoldReason, string> = {
  stale_source_configuration: 'The worker holds a different configuration revision than the one you read.',
  source_grant_unavailable: 'The connected grant is not ready for this mailbox with Gmail read scope.',
  selected_scope_incomplete: 'No complete mail scope exists for this mailbox yet.',
  no_mail_configuration_conflict: 'Without a mailbox, active intake cannot carry a calendar or a mail scope.',
  inactive_scope_change: 'A paused configuration cannot switch mail on.',
  intake_owner_inactive: 'The worker does not own this company, or its authority is revoked or stopping.',
  intake_owner_stale: 'The owner moved on since the local view was synchronized.',
  intake_command_pending: 'Another owner command for this company is still pending.',
  intake_configuration_conflict: 'A different intake change for this company is still pending. Nothing was re-issued.',
  intake_mailbox_mismatch: 'The requested mailbox differs from the configured one.',
  intake_calendar_unavailable: 'The requested calendar is not the connected grant’s owned calendar.',
};
const isoDate = /^\d{4}-\d\d-\d\d$/;
const today = () => new Date().toISOString().slice(0, 10);

/** Three explicit intake controls after a successful read: pause or resume, relevant mail on for the
 * first time with a start date, and the grant's owned calendar. Each submit queues one owner command
 * with the revision just read bound, shows the worker's receipt as is, and asks for a fresh read before
 * the next change. Configuration is not readiness; a mailbox on is not permission to send. */
export function AccountIntakeConfigure({ api, workspaceId, accountId, preparation, disabled }: {
  api: AccountIntakeConfigureApi; workspaceId: string; accountId: string; preparation: AccountPreparation; disabled: boolean;
}) {
  const headingId = useId();
  const [grant, setGrant] = useState<{ status?: RemoteGoogleGrantStatus; error?: boolean } | null>(null);
  const [status, setStatus] = useState<AccountIntakeConfigureStatus | null>(null);
  const [retained, setRetained] = useState<ConfigureAccountIntake | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [closed, setClosed] = useState(false);
  const [since, setSince] = useState('');
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const connections = api.googleConnections;
  // A fresh read reopens the controls and clears a settled receipt; a pending receipt or an unacknowledged
  // request survives so the identical change can still be retried. The grant is read from the owner's
  // stored record so the mail and calendar controls can be offered honestly; never a provider call, never permission.
  useEffect(() => {
    setClosed(false); setGrant(null);
    setStatus(current => current?.status === 'queued' && current.receipt.status === 'pending' ? current : null);
    if (!connections) return;
    let cancelled = false;
    void (async () => {
      try {
        const check = captureDailySessionScope(api, workspaceId);
        const result = remoteGoogleGrantStatusSchema.parse(await connections.status({ purpose: 'permitted_correspondence' }));
        check();
        if (!cancelled && alive.current) setGrant({ status: result });
      } catch { if (!cancelled && alive.current) setGrant({ error: true }); }
    })();
    return () => { cancelled = true; };
  }, [api, connections, workspaceId, accountId, preparation]);
  const configure = api.configureIntake;
  if (!configure) {
    return <section aria-labelledby={headingId}><h4 id={headingId}>Intake configuration</h4><p className="native-desk__hold">Intake configuration changes are unavailable in this bridge. Nothing was queued.</p></section>;
  }
  const config = preparation.configuration;
  const revision = config?.revision ?? 0, state = config?.state ?? null, mailbox = config?.mailboxSubject ?? null, calendar = config?.calendarId ?? null;
  const authorityHold = preparation.authority.owner !== 'worker' || !['active', 'paused'].includes(preparation.authority.state)
    ? 'The worker does not hold active or paused authority for this company. Intake configuration is held.' : null;
  const ready = grant?.status?.state === 'ready' ? grant.status.grant : null;
  const readable = !!ready && ready.grantedScopes.includes(googleScopes.relevant_read);
  const owned = ready?.purpose === 'permitted_correspondence' ? ready.calendars?.ownedCalendarId ?? null : null;
  const grantHold = !connections ? 'Grant status is unavailable in this bridge.'
    : grant === null ? 'Reading the connected grant…'
    : grant.error ? 'The connected grant could not be read. Read intake configuration again to retry.'
    : grant.status?.state === 'unconfigured' ? 'No Google grant is connected for this pairing.'
    : grant.status?.state === 'revoked' ? 'The connected Google grant is revoked.'
    : !readable ? 'The connected grant has no Gmail read scope.'
    : null;
  const pending = status?.status === 'queued' && status.receipt.status === 'pending';
  const locked = disabled || !!authorityHold || closed || busy || !!retained || pending;
  const base: Omit<ConfigureAccountIntake, 'state'> = { accountId, expectedConfigurationRevision: revision, mailboxSubject: mailbox, calendarId: calendar, mailSince: null };
  const toggle: ConfigureAccountIntake = { ...base, state: state === 'active' ? 'paused' : 'active' };
  const mailOn: ConfigureAccountIntake | null = ready && readable && mailbox === null && isoDate.test(since) && since <= today()
    ? { ...base, state: 'active', mailboxSubject: ready.subject, mailSince: `${since}T00:00:00.000Z` } : null;
  const useCalendar: ConfigureAccountIntake | null = mailbox !== null && state !== null && owned !== null && owned !== calendar ? { ...base, state, calendarId: owned } : null;
  const send = async (payload: ConfigureAccountIntake) => {
    if (busy) return;
    setBusy(true); setError(null); setRetained(payload);
    try {
      const check = captureDailySessionScope(api, workspaceId);
      const outcome = boundAccountIntakeConfigureStatus(payload).parse(await configure(payload));
      check();
      if (!alive.current) return;
      setStatus(outcome); setRetained(null);
      // Anything but a pending receipt settles this change: the next change starts from a fresh explicit read.
      if (outcome.status === 'held' || outcome.receipt.status !== 'pending') setClosed(true);
    } catch {
      if (alive.current) setError('The change was not acknowledged. The exact request is retained; retrying the same change never issues a second command. Nothing was read, sent or booked.');
    } finally { if (alive.current) setBusy(false); }
  };
  // A retained (unacknowledged) request or a pending receipt is the same lost-response case:
  // retrying re-sends the identical binding and the runtime reuses the live command identity.
  const retry = retained ?? (status?.status === 'queued' && status.receipt.status === 'pending' ? accountIntakeRetry(status) : null);
  return (
    <section aria-labelledby={headingId}>
      <h4 id={headingId}>Intake configuration</h4>
      {authorityHold && <p className="native-desk__hold">{authorityHold}</p>}
      <p>{config ? `Revision ${revision} as read. Each change binds this revision; the worker refuses anything older.` : 'No intake configuration exists yet. The first change creates revision 1.'}</p>
      <div className="native-desk__actions">
        <button type="button" disabled={locked} onClick={() => { void send(toggle); }}>{state === 'active' ? 'Pause intake' : 'Set intake active'}</button>
      </div>
      <p>{state === 'active' ? 'Pausing keeps the configured mailbox and calendar and stops intake for this company.'
        : mailbox !== null ? 'Setting intake active resumes intake from the configured mailbox. It does not send anything.'
        : 'Setting intake active without a mailbox is admitted only for a company the worker holds no business email routes or saved threads for.'}</p>
      {mailbox === null ? (grantHold ? <p className="native-desk__hold">{grantHold} Relevant mail is not offered.</p> : <>
        <p>Mailbox: {ready!.email}. Switching on relevant mail sets intake active and admits this company’s permitted business correspondence from that mailbox, from the date below. It is not permission to send.</p>
        <label>Read relevant mail since<input type="date" aria-label="Read relevant mail since" max={today()} value={since} disabled={locked} onChange={e => setSince(e.target.value)} /></label>
        <div className="native-desk__actions">
          <button type="button" disabled={locked || !mailOn} onClick={() => { if (mailOn) void send(mailOn); }}>Switch on relevant mail</button>
        </div>
      </>) : <p>Mail: configured. Relevant mail is already on for this company and cannot be switched on again from here.</p>}
      <div className="native-desk__actions">
        <button type="button" disabled={locked || !useCalendar} onClick={() => { if (useCalendar) void send(useCalendar); }}>{owned ? `Use calendar ${owned}` : 'Use calendar'}</button>
      </div>
      {mailbox === null ? <p className="native-desk__hold">A configured mailbox is required before a calendar can be used.</p>
        : grantHold ? <p className="native-desk__hold">{grantHold} A calendar is not offered.</p>
        : owned === null ? <p className="native-desk__hold">The connected grant names no owned calendar. A calendar is not offered.</p>
        : owned === calendar ? <p>This calendar is already configured: {owned}.</p>
        : <p>Uses the grant’s owned calendar for this company. This books nothing.</p>}
      <div className="native-desk__feedback" aria-live="polite">
        <p>Each change queues one owner command with the revision you read bound. Configuration is not readiness; a configured mailbox is not permission to send.</p>
        {busy && <p>Queuing the change…</p>}
        {error && <p role="alert">{error}</p>}
        {status?.status === 'held' && <><p>Intake change held: {status.reason}.</p><p>{holdText[status.reason]} Nothing was queued. Read intake configuration again before another change.</p></>}
        {status?.status === 'queued' && <>
          <p>Intake configuration receipt: {status.receipt.status}.</p>
          {status.receipt.reason && <p>{status.receipt.reason}</p>}
          <p>{status.receipt.status === 'applied' ? `The worker applied revision ${status.configuration.revision}. Read intake configuration again to see it; this is not a readiness check.`
            : status.receipt.status === 'rejected' ? 'This change was rejected. Nothing changed locally. Read intake configuration again before another change; nothing is re-issued automatically.'
            : 'Pending owner receipt. The command is queued locally; retry the same change or reconcile queued preparation.'}</p>
        </>}
        {retry && !busy && <div className="native-desk__actions"><button type="button" onClick={() => { void send(retry); }}>Retry same change</button></div>}
      </div>
    </section>
  );
}

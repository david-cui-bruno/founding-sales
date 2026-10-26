import { useEffect, useRef, useState, type JSX } from 'react';
import { emailCampaignPolicySchema, type EmailCampaignControl } from '@fss/contracts';
import { type BrowserClient } from './BrowserClient.ts';
import { EmailCampaignClient } from './EmailCampaignClient.ts';
import { type CampaignAction } from './CampaignPending.ts';
import './workspaceEmail.css';

export function BrowserEmailCampaigns({ client, compact = false }: { client: BrowserClient; compact?: boolean }): JSX.Element {
  const [manager] = useState(() => new EmailCampaignClient(client));
  const [control, setControl] = useState<EmailCampaignControl | null>(null);
  const [pending, setPending] = useState(manager.pending());
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false), live = useRef(true);
  const operation = useRef(0);
  const [mailboxId, setMailboxId] = useState('');
  const [sequenceVersionId, setSequenceVersionId] = useState('');
  const [regions, setRegions] = useState<('TX' | 'RI' | 'MA')[]>([]);
  const [daily, setDaily] = useState('1'), [lifetime, setLifetime] = useState('25');
  const [expiry, setExpiry] = useState('');
  useEffect(() => {
    live.current = true;
    let generation = client.epoch;
    const unsubscribe = client.subscribe(() => {
      if (generation !== client.epoch) {
        generation = client.epoch;
        operation.current += 1;
        lock.current = false;
        setControl(null); setMailboxId(''); setSequenceVersionId(''); setRegions([]); setExpiry('');
        setBusy(false); setNotice('');
      }
      setPending(manager.pending());
      if (client.current?.status !== 'signed_in') { setControl(null); setMailboxId(''); setSequenceVersionId(''); setRegions([]); setExpiry(''); }
    });
    return () => { live.current = false; operation.current += 1; unsubscribe(); manager.dispose(); };
  }, [client, manager]);
  useEffect(() => {
    if (pending === null) return;
    const timer = setTimeout(() => { setPending(manager.pending()); setControl(null); }, Math.max(0, Date.parse(pending.expiresAt) - Date.now()));
    return () => { clearTimeout(timer); };
  }, [manager, pending]);
  useEffect(() => {
    const expiries = control?.campaigns.filter(value => value.state === 'active').map(value => Date.parse(value.expiresAt)) ?? [];
    if (expiries.length === 0) return;
    const timer = setTimeout(() => { setControl(null); setNotice('Campaign policy freshness elapsed. Refresh campaigns for current state.'); }, Math.min(2_147_483_647, Math.max(0, Math.min(...expiries) - Date.now())));
    return () => { clearTimeout(timer); };
  }, [control]);
  const run = async (work: () => Promise<EmailCampaignControl>): Promise<void> => {
    if (lock.current) return;
    const owner = ++operation.current;
    lock.current = true; setBusy(true); setControl(null); setNotice('');
    const epoch = client.epoch;
    try {
      const value = await work();
      if (live.current && operation.current === owner && client.isCurrent(epoch)) { setControl(value); setNotice('Current campaign control loaded.'); }
    } catch {
      if (live.current && operation.current === owner && client.isCurrent(epoch)) setNotice('Campaign control unavailable or refused. No automatic retry. Retained commands require explicit same-payload retry.');
    } finally {
      if (live.current && operation.current === owner && client.isCurrent(epoch)) {
        lock.current = false;
        setBusy(false); setPending(manager.pending());
      }
    }
  };
  const command = (action: CampaignAction): void => { void run(async () => { manager.prepare(action); setPending(manager.pending()); return manager.retry(); }); };
  const approve = (): void => {
    const sender = control?.senders.find(value => value.id === mailboxId);
    const policy = emailCampaignPolicySchema.safeParse({ mailboxId, sequenceVersionId, authorizationRevision: sender?.authorizationRevision,
      regions, dailyAdmissionLimit: Number(daily), maxEnrollments: Number(lifetime), expiresAt: expiry ? new Date(expiry).toISOString() : '' });
    if (!policy.success || Date.parse(policy.data.expiresAt) <= Date.now() || Date.parse(policy.data.expiresAt) > Date.now() + 30 * 86400000) {
      setNotice('Select approved choices, regions, caps and an expiry within 30 days.'); return;
    }
    command({ kind: 'approve', policy: policy.data });
  };
  if (client.current?.status !== 'signed_in' || client.current.role !== 'admin') return <></>;
  return <section aria-label="Email campaigns" className="email-campaigns"><h2>Automatic outreach</h2>
    <p>Approve once to automatically admit qualified canonical Firms, including new qualified research Firms, without per-recipient approval. Enrollment is not delivery. Sending authority remains unchanged.</p>
    <p>Only verified residential property management companies qualify. Selected regions remain subject to the current stricter locality and geography policy. Ambiguous evidence stays internal.</p>
    <button disabled={busy} onClick={() => { void run(() => manager.control()); }}>Refresh campaigns</button>
    {notice ? <p role="status">{notice}</p> : null}
    {pending ? <aside aria-label="Pending campaign command"><p>Pending {pending.action.kind} command {pending.commandId}. {pending.accepted ? `Accepted campaign ${pending.accepted.campaignId} revision ${pending.accepted.revision}. Current read required.` : 'Outcome not confirmed. Reload never dispatches this command.'}</p>
      <button disabled={busy} onClick={() => { void run(() => manager.retry()); }}>Retry same campaign command</button></aside> : null}
    {control ? <><h3>Current campaigns</h3>{control.campaigns.length === 0 ? <p>No current campaigns.</p> : null}{control.campaigns.map(campaign => <article key={campaign.id}><p>Campaign {campaign.id} revision {campaign.revision} · {campaign.state} · {campaign.regions.join(', ')} · admitted {campaign.admittedCount}/{campaign.maxEnrollments} · daily limit {campaign.dailyAdmissionLimit} · expires {campaign.expiresAt}</p>
        <button aria-label={`Revoke campaign ${campaign.id}`} disabled={busy || pending !== null || campaign.revokedAt !== null} onClick={() => { command({ kind: 'revoke', id: campaign.id, expectedRevision: campaign.revision }); }}>Revoke campaign</button></article>)}
      <h3>Automatic admission activity</h3><p>Admissions are not sent-message history or confirmation of delivery.</p>{control.admissions.length === 0 ? <p>No current admissions.</p> : null}{control.admissions.map(admission => <details key={admission.enrollmentId}><summary>Firm {admission.firmId} · admitted {admission.admittedAt}</summary><p>Campaign {admission.campaignId} · Contact {admission.contactId} · Route {admission.routeId} · Plan {admission.planId} · Enrollment {admission.enrollmentId} · Candidate {admission.candidateId} · Qualification run {admission.qualificationRunId}</p></details>)}
      <details className="email-campaign-policy" open={!compact}><summary>Campaign policy and one-time approval</summary><p>Approve a bounded campaign, not each recipient. Existing sending controls remain authoritative.</p>
      <label>Approved sender<select aria-label="Approved sender" disabled={busy || pending !== null} value={mailboxId} onChange={event => { setMailboxId(event.target.value); }}><option value="">Select sender</option>{control.senders.map(sender => <option key={sender.id} value={sender.id}>{sender.label} · authorization revision {sender.authorizationRevision}</option>)}</select></label>
      <label>Approved email sequence<select aria-label="Approved email sequence" disabled={busy || pending !== null} value={sequenceVersionId} onChange={event => { setSequenceVersionId(event.target.value); }}><option value="">Select sequence</option>{control.sequences.map(sequence => <option key={sequence.id} value={sequence.id}>{sequence.label}</option>)}</select></label>
      <fieldset disabled={busy || pending !== null}><legend>Campaign regions</legend>{(['TX', 'RI', 'MA'] as const).map(region => <label key={region}><input type="checkbox" checked={regions.includes(region)} onChange={event => { setRegions(previous => event.target.checked ? [...previous, region] : previous.filter(value => value !== region)); }} />{region}</label>)}</fieldset>
      <label>Daily admission limit<input aria-label="Daily admission limit" type="number" min="1" max="5" value={daily} disabled={busy || pending !== null} onChange={event => { setDaily(event.target.value); }} /></label>
      <label>Lifetime enrollment cap<input aria-label="Lifetime enrollment cap" type="number" min="1" max="25" value={lifetime} disabled={busy || pending !== null} onChange={event => { setLifetime(event.target.value); }} /></label>
      <label>Campaign expiry<input aria-label="Campaign expiry" type="datetime-local" value={expiry} disabled={busy || pending !== null} onChange={event => { setExpiry(event.target.value); }} /></label>
      <button disabled={busy || pending !== null || control.campaigns.some(value => value.revokedAt === null)} onClick={approve}>Approve campaign once</button>
      </details>
    </> : null}
  </section>;
}

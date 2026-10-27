import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { campaignOpeningApproveInputSchema, type CampaignOpeningControl } from '@fss/contracts';
import type { BrowserClient } from './BrowserClient.ts';
import { CampaignOpeningDispatch, type CampaignOpeningReadback } from './CampaignOpeningDispatch.ts';
import { CAMPAIGN_OPENING_PENDING_PREFIX, type CampaignOpeningPending } from './CampaignOpeningPending.ts';

export function BrowserCampaignOpening({ client, campaignId }: { client: BrowserClient; campaignId: string }): JSX.Element {
  const manager = useMemo(() => new CampaignOpeningDispatch(client), [client]);
  const [control, setControl] = useState<CampaignOpeningControl | null>(null);
  const [lines, setLines] = useState(''), [expiry, setExpiry] = useState(''), [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState<CampaignOpeningPending | null>(null), [custodyBlocked, setCustodyBlocked] = useState(false);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const operation = useRef(0), mounted = useRef(true), lock = useRef(false);
  const clearCopy = useCallback((): void => { setLines(''); setExpiry(''); setConfirmed(false); }, []);
  const refreshPending = useCallback((): void => {
    try { setPending(manager.custody.read()); setCustodyBlocked(false); }
    catch { setPending(null); setCustodyBlocked(true); }
  }, [manager]);
  useEffect(() => {
    mounted.current = true;
    const reset = (): void => { operation.current += 1; lock.current = false; setBusy(false); setControl(null); clearCopy(); refreshPending(); };
    const storage = (event: StorageEvent): void => { if (event.key === null || event.key.startsWith(CAMPAIGN_OPENING_PENDING_PREFIX)) reset(); };
    const unsubscribe = client.subscribe(() => { if (client.current?.status !== 'signed_in' || !client.isCurrent(client.epoch)) reset(); else refreshPending(); });
    setControl(null); clearCopy(); setNotice(''); setBusy(false); lock.current = false;
    refreshPending();
    globalThis.addEventListener('storage', storage);
    return () => { mounted.current = false; operation.current += 1; unsubscribe(); globalThis.removeEventListener('storage', storage); };
  }, [client, manager, campaignId, clearCopy, refreshPending]);
  useEffect(() => {
    const session = client.current;
    const times = [control?.campaignExpiresAt, control?.policy?.value.expiresAt, session?.status === 'signed_in' ? session.expiresAt : null, pending?.expiresAt]
      .filter((value): value is string => !!value).map(Date.parse).filter(value => value > Date.now());
    if (!times.length) return;
    const timer = setTimeout(() => { operation.current += 1; lock.current = false; setBusy(false); setControl(null); clearCopy(); refreshPending(); setNotice('Policy or session lifetime elapsed. Read current policy again.'); }, Math.min(2_147_483_647, Math.max(0, Math.min(...times) - Date.now())));
    return () => { clearTimeout(timer); };
  }, [control, pending, client, clearCopy, refreshPending]);
  const run = async (work: (current: () => boolean) => Promise<CampaignOpeningReadback | CampaignOpeningControl>): Promise<void> => {
    if (lock.current) return;
    lock.current = true;
    const token = ++operation.current, epoch = client.epoch;
    const current = (): boolean => mounted.current && token === operation.current && client.isCurrent(epoch);
    setBusy(true); setNotice(''); setControl(null); clearCopy();
    try {
      const result = await work(current);
      if (!current()) return;
      if ('receipt' in result) {
        setControl(result.current?.campaignId === campaignId ? result.current : null);
        setNotice(result.receipt.state === 'unknown' ? 'Opening command outcome UNKNOWN. No replay or replacement is permitted.'
          : result.receipt.state === 'refused' ? `Opening command refused: ${result.receipt.reason}. Read current policy before another action.`
            : result.current?.campaignId === campaignId ? 'Opening command accepted. Separate current policy read loaded. Sending authority unchanged.'
              : 'Historical opening receipt recovered for another campaign. Select that campaign to read its current policy.');
      } else { setControl(result); setNotice('Exact current baseline and opening policy loaded. Selector readiness not established.'); }
    } catch {
      if (current()) setNotice('Opening control unavailable, refused or selection changed. Copy cleared. Reconcile any pending command by receipt only. No automatic retry.');
    } finally {
      if (current()) { lock.current = false; setBusy(false); refreshPending(); }
    }
  };
  const approve = (): void => {
    if (!control?.baseline || !confirmed) return;
    const instant = expiry ? new Date(expiry) : null;
    const parsed = campaignOpeningApproveInputSchema.safeParse({ campaignId, expectedCampaignRevision: control.campaignRevision,
      templateVersionId: control.baseline.templateVersionId, templateContentHash: control.baseline.templateContentHash,
      variants: lines.split(/\r?\n/u).map((text, index) => ({ id: `line_${index + 1}`, text })), expiresAt: instant && Number.isFinite(instant.getTime()) ? instant.toISOString() : '' });
    if (!parsed.success) { setNotice('Provide one to eight distinct-ID single lines, only supported placeholders, and an explicit expiry.'); return; }
    const viewed = control;
    void run(current => manager.approve(parsed.data, viewed, current));
  };
  if (client.current?.status !== 'signed_in' || client.current.role !== 'admin') return <></>;
  const held = pending !== null || custodyBlocked;
  return <section aria-label="First-email opening policy"><h3>First-email approved opening</h3>
    <p>Campaign {campaignId}. This is separate copy approval, not campaign admission, selector readiness or sending permission. Sending authority remains unchanged.</p>
    <p>One immutable policy per campaign. Revocation or expiry holds opening-enabled work, never replaces the policy or restores baseline mode. Existing prepared baseline messages are not rewritten.</p>
    <button disabled={busy} onClick={() => { void run(() => manager.control(campaignId)); }}>Read current opening policy</button>
    {notice ? <p role="status">{notice}</p> : null}
    {custodyBlocked ? <p role="alert">Opening command custody unavailable or bound to an earlier authority. Replacement commands remain held.</p> : null}
    {pending ? <aside aria-label="Pending opening command"><p>Pending {pending.action} command {pending.commandId} for campaign {pending.campaignId}. {pending.accepted ? 'Historical acceptance retained, current read still required.' : 'Outcome not confirmed.'}</p>
      <button disabled={busy} onClick={() => { void run(current => manager.reconcile(current)); }}>Reconcile opening receipt only</button></aside> : null}
    {control ? <><p>Campaign revision {control.campaignRevision}. Approval {control.approvalState}. Selector readiness: {control.selectorReadiness}.</p>
      {control.baseline ? <details open><summary>Exact approved first-email baseline</summary><p>Sequence {control.baseline.sequenceVersionId}, template {control.baseline.templateVersionId}, version {control.baseline.templateVersion}, hash {control.baseline.templateContentHash}, approved {control.baseline.approvedAt}.</p><h4>Subject</h4><pre>{control.baseline.subject}</pre><h4>Body</h4><pre>{control.baseline.body}</pre></details>
        : <p>Full approved baseline unavailable. Approval is not offered. No truncated substitute is used.</p>}
      {control.policy ? <article aria-label="Configured opening policy"><p>Policy {control.policy.value.id}, revision {control.policy.value.revision}, {control.policy.state}. Approved by {control.policy.value.ownerUserId} at {control.policy.value.approvedAt}, expires {control.policy.value.expiresAt}. {control.policy.revokedAt ? `Revoked ${control.policy.revokedAt}.` : ''}</p>
        {control.policy.value.variants.map(variant => <p key={variant.id}>{variant.id}: {variant.text}</p>)}
        <button disabled={busy || held || control.policy.revokedAt !== null} onClick={() => { const viewed = control; void run(current => manager.revoke(viewed, current)); }}>Revoke opening policy</button></article> : null}
      {control.approvalState === 'available' && control.baseline ? <fieldset disabled={busy || held}><legend>Explicit one-time opening approval</legend>
        <p>Enter one to eight approved lines, one per line. Supported placeholders: {'{{firm_name}}, {{firm_locality}}, {{firm_region}}'}. Only a selected line may prefix the unchanged baseline. No phrases are supplied for you.</p>
        <label>Approved opening lines<textarea aria-label="Approved opening lines" rows={8} maxLength={3207} value={lines} onChange={event => { setLines(event.target.value); setConfirmed(false); }} /></label>
        <label>Opening policy expiry<input aria-label="Opening policy expiry" type="datetime-local" value={expiry} onChange={event => { setExpiry(event.target.value); setConfirmed(false); }} /></label>
        <label><input type="checkbox" checked={confirmed} onChange={event => { setConfirmed(event.target.checked); }} />I reviewed the exact baseline and approve these opening lines and expiry.</label>
        <button disabled={!confirmed || !lines || !expiry} onClick={approve}>Approve opening policy once</button>
      </fieldset> : null}
    </> : null}
  </section>;
}

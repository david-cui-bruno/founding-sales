import { expect, it, vi } from 'vitest';
import { campaignOpeningPgFixture, openingPgHandoff } from './campaignOpeningPgFixture.ts';
import { allowAllEligibility } from '../../sequences/eligibility.ts';
import { selectCampaignOpeningBeforeTransaction, readCampaignOpeningAttempt, verifyCampaignOpeningFence, eraseCampaignOpening } from '../../outreach/campaignOpeningStore.ts';
import { runDueStepExecution } from '../../sequences/executions.ts';
import { readFenceByStepExecution, claimForDispatch, beginReconciling, markPreDispatchFenceSent, rewritePreparedBody } from '../../outbound/fence.ts';
import { reconcileFenceFooter } from '../../outbound/footer.ts';
import { lockSendGateForDispatch } from '../../policy/sendGate.ts';
import { updateSetting } from '../../settings/store.ts';
import { openingHash } from '../../outreach/campaignOpening.ts';

async function prepared(f: Awaited<ReturnType<typeof campaignOpeningPgFixture>>) {
  await selectCampaignOpeningBeforeTransaction(f.worker, f.db, { executionId: f.executionId, eligibility: allowAllEligibility(),
    selector: { select: async input => ({ kind: 'selected', choice: { variantId: 'local', citationIds: input.citationIds } }) } });
  const dispatch = vi.fn(async () => ({ ok: true as const }));
  await f.tx(() => runDueStepExecution(f.worker, { stepExecutionId: f.executionId, now: f.at, eligibility: allowAllEligibility(), sendHandoff: { ...openingPgHandoff(f.at), dispatch } }));
  const fence = await readFenceByStepExecution(f.worker, f.executionId);
  if (!fence) throw new Error('prepared opening fence missing');
  expect(fence.attemptToken).toBeNull(); expect(dispatch).not.toHaveBeenCalled();
  return fence;
}

it.each(['expiry', 'revoked', 'erased', 'verified-bytes'] as const)('risk R1 historical %s recovery records terminal SENT without fresh send authority', async change => {
  const f = await campaignOpeningPgFixture(true, change === 'expiry' ? new Date(Date.now() + 3_000).toISOString() : undefined);
  try {
    const before = await prepared(f), sentAt = new Date().toISOString();
    const attempt = await readCampaignOpeningAttempt(f.worker, f.executionId);
    if (change === 'expiry') await f.db.query('SELECT pg_sleep(greatest(0,extract(epoch FROM ($1::timestamptz-clock_timestamp())))+0.02)', [f.policy.expiresAt]);
    if (change === 'revoked') await f.db.query('UPDATE outreach_campaign_opening_policies SET revoked_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2', [f.w, f.policy.id]);
    if (change === 'erased') await f.tx(() => eraseCampaignOpening(f.worker, f.executionId));
    if (change !== 'verified-bytes') await expect(f.tx(() => claimForDispatch(f.worker, { outboundMessageId: before.id })))
      .rejects.toMatchObject({ code: '23514', constraint: 'campaign_opening_dispatch_current' });
    const verifiedBytes = { subject: before.subject, body: `${before.body}\nHistorical verified correspondence.` };
    const recovered = await f.tx(() => markPreDispatchFenceSent(f.worker, { outboundMessageId: before.id, providerMessageId: 'fictional-existing-message',
      providerThreadId: 'fictional-existing-thread', sentAt, verifiedBytes }));
    expect(recovered.ok).toBe(true);
    const after = await readFenceByStepExecution(f.worker, f.executionId);
    expect(after).toMatchObject({ state: 'sent', providerMessageId: 'fictional-existing-message', providerThreadId: 'fictional-existing-thread', sentAt,
      subject: verifiedBytes.subject, body: verifiedBytes.body });
    expect(after?.attemptToken).not.toBeNull();
    const retained = await readCampaignOpeningAttempt(f.worker, f.executionId);
    expect(retained?.attempt_id).toBe(attempt?.attempt_id);
    if (change === 'erased' || change === 'revoked') expect(retained).toMatchObject({ state: 'invalidated', content: null });
    expect((await f.db.query(`SELECT to_state FROM outbound_message_events WHERE workspace_id=$1 AND outbound_message_id=$2
      AND detail->>'reconciled_from'='sent_folder_pre_dispatch_fence' ORDER BY occurred_at,id`, [f.w, before.id])).rows.map(r => r['to_state']).sort()).toEqual(['dispatching', 'sent']);
    expect((await f.db.query("SELECT 1 FROM workspace_settings WHERE workspace_id=$1 AND setting_key='sending_enabled' AND value->>'enabled'='true'", [f.w])).rows).toEqual([]);
  } finally { await f.stop(); }
}, 60_000);

it.each(['dispatching', 'reconciling'] as const)('risk R1 historical witness cannot commit in intermediate %s state', async state => {
  const f = await campaignOpeningPgFixture();
  try {
    const before = await prepared(f);
    await expect(f.tx(async () => {
      await f.db.query(`UPDATE outbound_messages SET state='dispatching',attempt_token=gen_random_uuid(),dispatch_started_at=clock_timestamp(),
        provider_message_id='fictional-existing-message',provider_thread_id='fictional-existing-thread' WHERE workspace_id=$1 AND id=$2`, [f.w, before.id]);
      if (state === 'reconciling') expect((await beginReconciling(f.worker, { outboundMessageId: before.id, detail: 'fictional incomplete historical observation', windowHours: 1 })).ok).toBe(true);
    })).rejects.toMatchObject({ code: '23514', constraint: 'campaign_opening_historical_terminal' });
    expect(await readFenceByStepExecution(f.worker, f.executionId)).toMatchObject({ state: 'prepared', attemptToken: null });
  } finally { await f.stop(); }
}, 60_000);

it('risk R2 current postal owner rebinds only footer bytes before the existing atomic claim', async () => {
  const f = await campaignOpeningPgFixture();
  try {
    expect((await f.tx(() => updateSetting(f.admin, { settingKey: 'postal_address', value: { address: '100 Fictional First Street' } }))).ok).toBe(true);
    const before = await prepared(f), attempt = await readCampaignOpeningAttempt(f.worker, f.executionId);
    expect(before.body.endsWith('100 Fictional First Street')).toBe(true);
    expect((await f.tx(() => updateSetting(f.admin, { settingKey: 'postal_address', value: { address: '200 Fictional Second Street' } }))).ok).toBe(true);
    await f.tx(async () => {
      await lockSendGateForDispatch(f.worker);
      await f.db.query('SELECT 1 FROM outbound_messages WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [f.w, before.id]);
      const result = await reconcileFenceFooter(f.worker, before);
      expect(result.reconciled).toBe(true); if (!result.reconciled) throw new Error(result.detail);
      const expected = before.body.slice(0, -'100 Fictional First Street'.length) + '200 Fictional Second Street';
      expect(result.fence.body).toBe(expected); expect(result.fence.subject).toBe(before.subject);
      expect(await verifyCampaignOpeningFence(f.worker, result.fence)).toBe(true);
      expect(await readCampaignOpeningAttempt(f.worker, f.executionId)).toMatchObject({ attempt_id: attempt?.attempt_id, fence_id: before.id,
        subject_hash: attempt?.subject_hash, body_hash: openingHash(expected), binding: attempt?.binding, snapshot_hash: attempt?.snapshot_hash });
      expect((await claimForDispatch(f.worker, { outboundMessageId: before.id })).ok).toBe(true);
    });
    const after = await readFenceByStepExecution(f.worker, f.executionId);
    expect(after?.state).toBe('dispatching'); expect(after?.body.startsWith(`I noticed ${f.source.name} serves Dallas, TX.\n\n`)).toBe(true);
    // Claim-owner proof only, no provider invocation or enabled sending setting.
  } finally { await f.stop(); }
}, 60_000);

it('risk R2 SQL refuses non-footer body mutation and direct hash remint while preserving original frozen bytes', async () => {
  const f = await campaignOpeningPgFixture();
  try {
    const before = await prepared(f), attempt = await readCampaignOpeningAttempt(f.worker, f.executionId);
    await expect(f.tx(() => rewritePreparedBody(f.worker, { outboundMessageId: before.id, body: `Arbitrary new prose.\n\n${before.body}`, reason: 'footer_composed_at_send' })))
      .rejects.toMatchObject({ code: '23514', constraint: 'campaign_opening_footer_only' });
    await expect(f.tx(() => f.db.query('UPDATE outreach_campaign_opening_attempts SET body_hash=$3 WHERE workspace_id=$1 AND execution_id=$2', [f.w, f.executionId, openingHash('arbitrary')])) )
      .rejects.toMatchObject({ code: '23514', constraint: 'campaign_opening_attempt_immutable' });
    expect((await readFenceByStepExecution(f.worker, f.executionId))?.body).toBe(before.body);
    expect(await readCampaignOpeningAttempt(f.worker, f.executionId)).toMatchObject({ body_hash: attempt?.body_hash, attempt_id: attempt?.attempt_id });
    expect((await f.db.query('SELECT 1 FROM outreach_email_campaign_admissions WHERE workspace_id=$1 AND enrollment_id=$2', [f.w, f.enrollmentId])).rows).toHaveLength(1);
  } finally { await f.stop(); }
}, 60_000);

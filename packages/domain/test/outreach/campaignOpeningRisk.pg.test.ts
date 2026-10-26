import { expect, it } from 'vitest';
import { campaignOpeningPgFixture, openingPgHandoff } from './campaignOpeningPgFixture.ts';
import { allowAllEligibility } from '../../sequences/eligibility.ts';
import { selectCampaignOpeningBeforeTransaction, readCampaignOpeningAttempt, readyCampaignOpening } from '../../outreach/campaignOpeningStore.ts';
import { rememberExpiredManualSources } from '../../sourcing/manualProspectSourceLoss.ts';
import { sweepCampaignOpenings } from '../../outreach/campaignOpeningRetention.ts';
import { runDueStepExecution } from '../../sequences/executions.ts';
import { readFenceByStepExecution, claimForDispatch, beginReconciling } from '../../outbound/fence.ts';
import { lockSendGateForDispatch } from '../../policy/sendGate.ts';

async function ready(f: Awaited<ReturnType<typeof campaignOpeningPgFixture>>) {
  await selectCampaignOpeningBeforeTransaction(f.worker, f.db, { executionId: f.executionId, eligibility: allowAllEligibility(),
    selector: { select: async input => ({ kind: 'selected', choice: { variantId: 'local', citationIds: input.citationIds } }) } });
  const row = await readCampaignOpeningAttempt(f.worker, f.executionId);
  expect(row).toMatchObject({ state: 'ready', invalidated_at: null });
  return row;
}

it('risk R3 app_runtime marker-only invalidation refuses and subsequent source loss erases content', async () => {
  const f = await campaignOpeningPgFixture();
  try {
    const before = await ready(f), runtime = await f.fixture.database.appRuntimeSession();
    await expect(runtime.query('UPDATE outreach_campaign_opening_attempts SET invalidated_at=clock_timestamp() WHERE workspace_id=$1 AND execution_id=$2', [f.w, f.executionId]))
      .rejects.toMatchObject({ code: '23514', constraint: 'campaign_opening_invalidated' });
    expect(await readCampaignOpeningAttempt(f.worker, f.executionId)).toMatchObject({ state: 'ready', invalidated_at: null, attempt_id: before?.attempt_id });
    await f.tx(() => rememberExpiredManualSources(f.worker, [f.source.website]));
    expect(await readCampaignOpeningAttempt(f.worker, f.executionId)).toMatchObject({ state: 'invalidated', content: null, attempt_id: before?.attempt_id });
    expect(await readyCampaignOpening(f.worker, f.executionId)).toEqual({ kind: 'held' });
  } finally { await f.stop(); }
}, 60_000);

it.each(['denial', 'expiry', 'delete', 'reference', 'attempted'] as const)('risk SPEC-1 non-observation source evidence %s erases reusable content immediately', async change => {
  const f = await campaignOpeningPgFixture();
  try {
    const url = f.source.source.sourceUrl;
    expect(url).not.toBe(f.source.website);
    expect((await f.db.query(`SELECT 1 FROM sourcing_qualification_runs q,jsonb_array_elements(q.observations) o
      WHERE q.workspace_id=$1 AND q.id=$2 AND o->>'url'=$3`, [f.w, f.source.selection.runId, url])).rows).toEqual([]);
    const evidence = (await f.db.query<{ id: string }>(`INSERT INTO evidence_items(workspace_id,firm_id,provider,source_reference,content_hash,terms_allow_retention)
      VALUES($1,$2,'website',$3,$4,true) RETURNING id`, [f.w, f.firmId, url, 'e'.repeat(64)])).rows[0]!;
    const attempt = await ready(f);
    const handoff = { ...openingPgHandoff(f.at), dispatch: async () => ({ ok: true as const }) };
    const outcome = await f.tx(() => runDueStepExecution(f.worker, { stepExecutionId: f.executionId, now: f.at, eligibility: allowAllEligibility(), sendHandoff: handoff }));
    const before = await readFenceByStepExecution(f.worker, f.executionId); if (!before) throw new Error(`fence missing: ${JSON.stringify(outcome)}`);
    if (change === 'attempted') await f.tx(async () => {
      await lockSendGateForDispatch(f.worker);
      expect((await claimForDispatch(f.worker, { outboundMessageId: before.id })).ok).toBe(true);
      expect((await beginReconciling(f.worker, { outboundMessageId: before.id, detail: 'fictional unknown send', windowHours: 1 })).ok).toBe(true);
    });
    const args = [f.w, evidence.id];
    if (change === 'denial' || change === 'attempted') await f.db.query("UPDATE evidence_items SET terms_allow_retention=false,retention_expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1 AND id=$2", args);
    if (change === 'expiry') await f.db.query("UPDATE evidence_items SET retention_expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1 AND id=$2", args);
    if (change === 'delete') await f.db.query('DELETE FROM evidence_items WHERE workspace_id=$1 AND id=$2', args);
    if (change === 'reference') await f.db.query("UPDATE evidence_items SET source_reference='https://example.test/replaced-witness' WHERE workspace_id=$1 AND id=$2", args);
    // Inspect persisted state before a current-source read or retention sweep.
    expect(await readCampaignOpeningAttempt(f.worker, f.executionId)).toMatchObject({ state: 'invalidated', content: null, attempt_id: attempt?.attempt_id, fence_id: before.id });
    const after = await readFenceByStepExecution(f.worker, f.executionId); if (!after) throw new Error('fence removed');
    const prefix = `I noticed ${f.source.name} serves Dallas, TX.\n\n`;
    expect(before.body.startsWith(prefix)).toBe(true);
    expect(after.body).toBe(change === 'attempted' ? before.body : before.body.slice(prefix.length));
    expect(after.state).toBe(change === 'attempted' ? 'reconciling' : 'prepared');
    expect(after.attemptToken === null).toBe(change !== 'attempted');
    expect((await f.db.query('SELECT 1 FROM outreach_email_campaign_admissions WHERE workspace_id=$1 AND enrollment_id=$2', [f.w, f.enrollmentId])).rows).toHaveLength(1);
  } finally { await f.stop(); }
}, 60_000);

it.each(['source', 'sweep', 'read'] as const)('risk R3 %s owner repairs inconsistent legacy invalidated content without changing identity', async owner => {
  const f = await campaignOpeningPgFixture();
  try {
    const before = await ready(f);
    // Explicitly construct the pre-correction permitted state, only in this
    // disposable fixture. No legacy guard is disabled or production role widened.
    await f.tx(async () => {
      await f.db.query('ALTER TABLE outreach_campaign_opening_attempts DISABLE TRIGGER campaign_opening_attempt_fence');
      await f.db.query('ALTER TABLE outreach_campaign_opening_attempts DROP CONSTRAINT campaign_opening_invalidated');
      await f.db.query('UPDATE outreach_campaign_opening_attempts SET invalidated_at=clock_timestamp() WHERE workspace_id=$1 AND execution_id=$2', [f.w, f.executionId]);
      await f.db.query('ALTER TABLE outreach_campaign_opening_attempts ENABLE TRIGGER campaign_opening_attempt_fence');
      await f.db.query("ALTER TABLE outreach_campaign_opening_attempts ADD CONSTRAINT campaign_opening_invalidated CHECK(invalidated_at IS NULL OR (content IS NULL AND state<>'ready')) NOT VALID");
    });
    const inconsistent = await readCampaignOpeningAttempt(f.worker, f.executionId);
    expect(inconsistent?.content).not.toBeNull(); expect(inconsistent?.invalidated_at).not.toBeNull();
    if (owner === 'source') await f.tx(() => rememberExpiredManualSources(f.worker, [f.source.website]));
    if (owner === 'sweep') expect(await f.tx(() => sweepCampaignOpenings(f.worker, { limit: 10 }))).toBe(1);
    if (owner === 'read') expect(await f.tx(() => readyCampaignOpening(f.worker, f.executionId))).toEqual({ kind: 'held' });
    const after = await readCampaignOpeningAttempt(f.worker, f.executionId);
    expect(after).toMatchObject({ state: 'invalidated', content: null, attempt_id: before?.attempt_id, binding: before?.binding,
      invalidated_at: inconsistent?.invalidated_at, snapshot_hash: before?.snapshot_hash });
    await f.db.query('ALTER TABLE outreach_campaign_opening_attempts VALIDATE CONSTRAINT campaign_opening_invalidated');
    expect(await f.tx(() => sweepCampaignOpenings(f.worker, { limit: 10 }))).toBe(0);
  } finally { await f.stop(); }
}, 60_000);

it('risk R3 invalidated selection UNKNOWN stays UNKNOWN with the same attempt and cannot be replayed', async () => {
  const f = await campaignOpeningPgFixture();
  try {
    let calls = 0;
    const select = () => selectCampaignOpeningBeforeTransaction(f.worker, f.db, { executionId: f.executionId, eligibility: allowAllEligibility(),
      selector: { select: async () => { calls++; throw new Error('fictional lost selection'); } } });
    await select(); const before = await readCampaignOpeningAttempt(f.worker, f.executionId);
    const runtime = await f.fixture.database.appRuntimeSession();
    await runtime.query('UPDATE outreach_campaign_opening_attempts SET invalidated_at=clock_timestamp() WHERE workspace_id=$1 AND execution_id=$2', [f.w, f.executionId]);
    await f.tx(() => rememberExpiredManualSources(f.worker, [f.source.website])); await select();
    expect(calls).toBe(1);
    expect(await readCampaignOpeningAttempt(f.worker, f.executionId)).toMatchObject({ state: 'unknown', content: null, attempt_id: before?.attempt_id, binding: before?.binding });
    expect(await readyCampaignOpening(f.worker, f.executionId)).toEqual({ kind: 'held' });
  } finally { await f.stop(); }
}, 60_000);

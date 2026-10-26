import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { campaignOpeningPgFixture } from './campaignOpeningPgFixture.ts';
import { selectCampaignOpeningBeforeTransaction, readCampaignOpeningAttempt, verifyCampaignOpeningFence } from '../../outreach/campaignOpeningStore.ts';
import { allowAllEligibility } from '../../sequences/eligibility.ts';
import { runDueStepExecution } from '../../sequences/executions.ts';
import { outboundSendHandoff } from '../../../../apps/worker/src/handlers/outboundSendHandoff.ts';
import { readFenceByStepExecution, claimForDispatch } from '../../outbound/fence.ts';

/** Authored, not run. These exercise actual migration/role behavior after root's
 * isolated PostgreSQL grant, not a SQL string snapshot or mocked database. */
it('actual app role cannot rewrite policy/attempt identity, remint UNKNOWN or erase cap history', async () => {
  const f = await campaignOpeningPgFixture();
  try {
    const selector = { select: vi.fn(async () => { throw new Error('fictional response loss'); }) };
    const select = () => selectCampaignOpeningBeforeTransaction(f.worker, f.db, { executionId: f.executionId, selector, eligibility: allowAllEligibility() });
    await select(); const first = await readCampaignOpeningAttempt(f.worker, f.executionId); expect(first?.state).toBe('unknown');
    await select(); expect(selector.select).toHaveBeenCalledTimes(1);
    const runtime = await f.fixture.database.appRuntimeSession();
    await expect(runtime.query('UPDATE outreach_campaign_opening_policies SET policy=policy WHERE workspace_id=$1 AND id=$2', [f.w, f.policy.id])).rejects.toMatchObject({ code: '42501' });
    await expect(runtime.query('UPDATE outreach_campaign_opening_attempts SET attempt_id=$3 WHERE workspace_id=$1 AND execution_id=$2', [f.w, f.executionId, randomUUID()])).rejects.toMatchObject({ code: '42501' });
    await expect(runtime.query('DELETE FROM outreach_campaign_opening_attempts WHERE workspace_id=$1 AND execution_id=$2', [f.w, f.executionId])).rejects.toMatchObject({ code: '42501' });
    await expect(f.tx(() => f.db.query('UPDATE outreach_campaign_opening_attempts SET attempt_id=$3 WHERE workspace_id=$1 AND execution_id=$2', [f.w, f.executionId, randomUUID()]))).rejects.toMatchObject({ code: '23514', constraint: 'campaign_opening_attempt_immutable' });
    await expect(f.tx(() => f.db.query("UPDATE outreach_campaign_opening_attempts SET state='ready',finished_at=clock_timestamp(),content=$3::jsonb WHERE workspace_id=$1 AND execution_id=$2", [f.w, f.executionId, JSON.stringify({ opening: `I noticed ${f.source.name} serves Dallas, TX.`, choice: { variantId: 'local', citationIds: [`${randomUUID()}:foreign`] } })]))).rejects.toMatchObject({ code: '23514' });
    expect((await readCampaignOpeningAttempt(f.worker, f.executionId))?.attempt_id).toBe(first?.attempt_id);
    expect((await f.db.query('SELECT 1 FROM outreach_email_campaign_admissions WHERE workspace_id=$1 AND enrollment_id=$2', [f.w, f.enrollmentId])).rows).toHaveLength(1);
  } finally { await f.stop(); }
}, 60_000);
it('unclaimed prefix is physically stripped on source deletion, never silently sent as baseline, and actual claim refuses', async () => {
  const f = await campaignOpeningPgFixture();
  try {
    await selectCampaignOpeningBeforeTransaction(f.worker, f.db, { executionId: f.executionId, eligibility: allowAllEligibility(),
      selector: { select: async input => ({ kind: 'selected', choice: { variantId: 'local', citationIds: input.citationIds } }) } });
    await f.tx(() => runDueStepExecution(f.worker, { stepExecutionId: f.executionId, now: f.at, eligibility: allowAllEligibility(), sendHandoff: outboundSendHandoff() }));
    const before = await readFenceByStepExecution(f.worker, f.executionId); if (!before) throw new Error('fence missing');
    const prefix = `I noticed ${f.source.name} serves Dallas, TX.\n\n`; expect(before.body.startsWith(prefix)).toBe(true);
    const attemptId = (await readCampaignOpeningAttempt(f.worker, f.executionId))?.attempt_id;
    await f.db.query('DELETE FROM sourcing_candidate_discovery_origins WHERE workspace_id=$1 AND candidate_id=$2', [f.w, f.source.selection.discoveryCandidateId]);
    const after = await readFenceByStepExecution(f.worker, f.executionId); if (!after) throw new Error('fence removed');
    expect(after.body).toBe(before.body.slice(prefix.length)); expect(after.state).toBe('prepared');
    expect(await readCampaignOpeningAttempt(f.worker, f.executionId)).toMatchObject({ state: 'invalidated', content: null, attempt_id: attemptId, fence_id: before.id });
    expect(await verifyCampaignOpeningFence(f.worker, after)).toBe(false);
    await expect(f.tx(() => claimForDispatch(f.worker, { outboundMessageId: before.id }))).rejects.toMatchObject({ code: '23514', constraint: 'campaign_opening_dispatch_current' });
    expect((await readFenceByStepExecution(f.worker, f.executionId))?.attemptToken).toBeNull();
    expect((await f.db.query('SELECT 1 FROM outreach_email_campaign_admissions WHERE workspace_id=$1 AND enrollment_id=$2', [f.w, f.enrollmentId])).rows).toHaveLength(1);
  } finally { await f.stop(); }
}, 60_000);

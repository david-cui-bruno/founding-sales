import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { campaignOpeningPgFixture, openingPgHandoff } from './campaignOpeningPgFixture.ts';
import { selectCampaignOpeningBeforeTransaction, readCampaignOpeningAttempt, readyCampaignOpening, verifyCampaignOpeningFence } from '../../outreach/campaignOpeningStore.ts';
import { allowAllEligibility } from '../../sequences/eligibility.ts';
import { runDueStepExecution } from '../../sequences/executions.ts';
import { sequenceActionJobHandler } from '../../../../apps/worker/src/handlers/sequenceAction.ts';
import { readFenceByStepExecution, claimForDispatch, beginReconciling } from '../../outbound/fence.ts';
import { renderTemplateVersion } from '../../templates/templates.ts';
import { composeBodyForWorkspace } from '../../outbound/footer.ts';
import { repositoryContext, workspaceScope } from '../../db/workspaceScope.ts';
import { lockSendGateForDispatch } from '../../policy/sendGate.ts';
import type { CampaignOpeningSelector } from '../../outreach/campaignOpening.ts';
import { rememberExpiredManualSources } from '../../sourcing/manualProspectSourceLoss.ts';
import { retentionTargetFor } from '../../retention/targets.ts';
import { TABLE_RETENTION_COVERAGE } from '../../retention/coverage.ts';

/** Authored actual-PG checks. NOT included in no-PG config and NOT executed by
 * this source owner. Root must allocate the exclusive PG slot before running. */
it('admitted real first execution -> committed selection -> real frozen fence -> fake dispatch, exact baseline and OFF conserved', async () => {
  const f = await campaignOpeningPgFixture();
  try {
    const observer = await f.fixture.database.appRuntimeSession();
    const selector = { select: vi.fn(async (input) => {
      expect((await observer.query('SELECT state FROM outreach_campaign_opening_attempts WHERE workspace_id=$1 AND execution_id=$2', [f.w, f.executionId])).rows).toEqual([{ state: 'unknown' }]);
      expect((await f.db.query<{ xid: string | null }>('SELECT pg_current_xact_id_if_assigned()::text AS xid')).rows[0]?.xid).toBeNull();
      expect(JSON.stringify(input)).not.toContain('@'); expect(JSON.stringify(input)).not.toContain('https:');
      return { kind: 'selected' as const, choice: { variantId: 'local', citationIds: input.citationIds } };
    }) } satisfies CampaignOpeningSelector;
    const dispatch = vi.fn(async () => ({ ok: true as const }));
    const handoff = { ...openingPgHandoff(f.at), dispatch };
    const handler = sequenceActionJobHandler({ openingSelector: selector, eligibility: allowAllEligibility(), now: () => f.at, sendHandoff: handoff });
    await handler.handle({ session: f.db, scope: f.worker.scope,
      job: { id: randomUUID(), workspaceId: f.w, kind: 'sequence.action', payload: { stepExecutionId: f.executionId }, idempotencyKey: f.executionId,
        attempt: 1, maxAttempts: 4, fencingToken: '1', leaseOwner: 'fictional-opening', leaseExpiresAt: f.policy.expiresAt } });
    const fence = await readFenceByStepExecution(f.worker, f.executionId); expect(fence).not.toBeNull();
    const baseline = renderTemplateVersion(f.template, { firm_name: f.source.name }); expect(baseline.rendered).toBe(true);
    if (!baseline.rendered || !fence) throw new Error('fixture baseline/fence');
    const composed = await composeBodyForWorkspace(f.worker, { body: baseline.body, signOff: f.template.footerSignOff });
    if (!composed.composed) throw new Error(composed.reason);
    const prefix = `I noticed ${f.source.name} serves Dallas, TX.\n\n`;
    expect(fence.subject).toBe(baseline.subject); expect(fence.body.slice(0, prefix.length)).toBe(prefix);
    expect(Buffer.from(fence.body.slice(prefix.length))).toEqual(Buffer.from(composed.body));
    expect(dispatch).toHaveBeenCalledTimes(1); expect(selector.select).toHaveBeenCalledTimes(1);
    expect(await verifyCampaignOpeningFence(f.worker, fence)).toBe(true);
    const attempt = await readCampaignOpeningAttempt(f.worker, f.executionId);
    expect(attempt).toMatchObject({ state: 'ready', fence_id: fence.id });
    expect((await f.db.query('SELECT 1 FROM step_executions WHERE workspace_id=$1 AND enrollment_id=$2 AND ordinal=1', [f.w, f.enrollmentId])).rows).toHaveLength(1);
    expect((await f.db.query("SELECT 1 FROM workspace_settings WHERE workspace_id=$1 AND setting_key='sending_enabled' AND value->>'enabled'='true'", [f.w])).rows).toEqual([]);
    expect(fence.state).toBe('prepared'); expect(fence.attemptToken).toBeNull();
    const target = retentionTargetFor('research_evidence');
    expect(target?.tables).toContain('outreach_campaign_opening_attempts');
    expect(TABLE_RETENTION_COVERAGE['outreach_campaign_opening_attempts']?.dispositions).toContain('swept');
    expect(TABLE_RETENTION_COVERAGE['outreach_campaign_opening_policies']).toBeDefined();
    if (!target?.sweep) throw new Error('registered opening retention owner missing');
    const sweep = () => f.tx(() => target.sweep!(f.worker, { now: new Date().toISOString(), boundaryAt: null, limit: 20 }));
    expect((await sweep()).detail['outreach_campaign_opening_attempts']).toBe(0);
    await f.tx(() => rememberExpiredManualSources(f.worker, [f.source.website]));
    expect(await readCampaignOpeningAttempt(f.worker, f.executionId)).toMatchObject({ state: 'invalidated', content: null, attempt_id: attempt?.attempt_id, fence_id: fence.id });
    expect((await readFenceByStepExecution(f.worker, f.executionId))?.body).toBe(composed.body);
    expect(await verifyCampaignOpeningFence(f.worker, fence)).toBe(false);
    expect((await sweep()).detail['outreach_campaign_opening_attempts']).toBe(0);
    expect((await readCampaignOpeningAttempt(f.worker, f.executionId))?.attempt_id).toBe(attempt?.attempt_id);
    expect((await f.db.query('SELECT 1 FROM outreach_email_campaign_admissions WHERE workspace_id=$1 AND enrollment_id=$2', [f.w, f.enrollmentId])).rows).toHaveLength(1);
  } finally { await f.stop(); }
}, 60_000);
it.each(['source', 'owner', 'policy', 'template'] as const)('actual delayed %s change holds and conserves the immutable UNKNOWN identity', async change => {
  const f = await campaignOpeningPgFixture();
  try {
    const selector = { select: vi.fn(async (input) => {
      if (change === 'source') await f.db.query('UPDATE sourcing_candidates SET qualification_blocked=true WHERE workspace_id=$1 AND id=$2', [f.w, f.source.selection.candidateId]);
      if (change === 'owner') await f.db.query('UPDATE firms SET assigned_user_id=$3 WHERE workspace_id=$1 AND id=$2', [f.w, f.firmId, f.fixture.alpha.salesperson.userId]);
      if (change === 'policy') await f.db.query('UPDATE outreach_campaign_opening_policies SET revoked_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2', [f.w, f.policy.id]);
      if (change === 'template') await f.db.query('UPDATE template_versions SET retired_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2', [f.w, f.template.id]);
      return { kind: 'selected' as const, choice: { variantId: 'local', citationIds: input.citationIds } };
    }) } satisfies CampaignOpeningSelector;
    const select = () => selectCampaignOpeningBeforeTransaction(f.worker, f.db, { executionId: f.executionId, selector, eligibility: allowAllEligibility() });
    await select(); const attempt = await readCampaignOpeningAttempt(f.worker, f.executionId);
    expect(attempt).toMatchObject({ state: 'unknown', content: null }); expect(attempt?.invalidated_at).not.toBeNull();
    await select(); expect(selector.select).toHaveBeenCalledTimes(1);
    expect((await readCampaignOpeningAttempt(f.worker, f.executionId))?.attempt_id).toBe(attempt?.attempt_id);
    expect(await readyCampaignOpening(f.worker, f.executionId)).toEqual({ kind: 'held' });
    expect(await readFenceByStepExecution(f.worker, f.executionId)).toBeNull();
    expect((await f.db.query('SELECT 1 FROM outreach_email_campaign_admissions WHERE workspace_id=$1 AND enrollment_id=$2', [f.w, f.enrollmentId])).rows).toHaveLength(1);
  } finally { await f.stop(); }
}, 60_000);
it('real source erasure removes ready content/unclaimed prefix but cannot reset history or a separate send UNKNOWN', async () => {
  const f = await campaignOpeningPgFixture();
  try {
    await selectCampaignOpeningBeforeTransaction(f.worker, f.db, { executionId: f.executionId, eligibility: allowAllEligibility(),
      selector: { select: async input => ({ kind: 'selected', choice: { variantId: 'local', citationIds: input.citationIds } }) } });
    const handoff = { ...openingPgHandoff(f.at), dispatch: vi.fn(async () => ({ ok: true as const })) };
    await f.tx(() => runDueStepExecution(f.worker, { stepExecutionId: f.executionId, now: f.at, eligibility: allowAllEligibility(), sendHandoff: handoff }));
    const fence = await readFenceByStepExecution(f.worker, f.executionId); if (!fence) throw new Error('fence missing');
    const attemptId = (await readCampaignOpeningAttempt(f.worker, f.executionId))?.attempt_id;
    await f.tx(async () => {
      await lockSendGateForDispatch(f.worker);
      const claimed = await claimForDispatch(f.worker, { outboundMessageId: fence.id }); expect(claimed.ok).toBe(true);
      const reconciling = await beginReconciling(f.worker, { outboundMessageId: fence.id, detail: 'fictional unknown send', windowHours: 1 }); expect(reconciling.ok).toBe(true);
    });
    await f.db.query('UPDATE sourcing_candidates SET qualification_blocked=true WHERE workspace_id=$1 AND id=$2', [f.w, f.source.selection.candidateId]);
    expect(await readCampaignOpeningAttempt(f.worker, f.executionId)).toMatchObject({ state: 'invalidated', content: null, attempt_id: attemptId });
    const retained = await readFenceByStepExecution(f.worker, f.executionId); expect(retained?.state).toBe('reconciling'); expect(retained?.attemptToken).not.toBeNull();
    expect(retained?.body).toBe(fence.body); // Immutable attempted business envelope, not reusable opening content.
    const outcome = await f.tx(() => runDueStepExecution(f.worker, { stepExecutionId: f.executionId, now: f.at, eligibility: allowAllEligibility(), sendHandoff: handoff }));
    expect(outcome).toMatchObject({ kind: 'held', reasonCode: 'send_unknown_reconciling' });
  } finally { await f.stop(); }
}, 60_000);
it('actual policy absence leaves old exact-template preparation, while foreign-workspace execution cannot read an attempt', async () => {
  const f = await campaignOpeningPgFixture(false);
  try {
    const handoff = { ...openingPgHandoff(f.at), dispatch: vi.fn(async () => ({ ok: true as const })) };
    const outcome = await f.tx(() => runDueStepExecution(f.worker, { stepExecutionId: f.executionId, now: f.at, eligibility: allowAllEligibility(), sendHandoff: handoff }));
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ kind: 'handed_to_send' });
    const fence = await readFenceByStepExecution(f.worker, f.executionId); expect(fence).not.toBeNull(); expect(fence?.body).not.toContain('I noticed');
    expect(await readCampaignOpeningAttempt(f.worker, f.executionId)).toBeNull();
    const foreign = repositoryContext(workspaceScope(f.fixture.beta.workspaceId, { kind: 'system', component: 'worker' }), f.db);
    expect(await readCampaignOpeningAttempt(foreign, f.executionId)).toBeNull();
  } finally { await f.stop(); }
}, 60_000);

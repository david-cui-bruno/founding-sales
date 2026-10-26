import { randomUUID } from 'node:crypto';
import { campaignOpeningChoiceSchema, type CampaignOpeningBinding } from '@fss/contracts';
import { withTransaction, type SessionQueryable } from '../db/queryable.ts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { lockSendGateForStopFact } from '../policy/sendGate.ts';
import { readEnrollment, readStepExecution } from '../sequences/rows.ts';
import type { StepEligibility } from '../sequences/eligibility.ts';
import { campaignDatabaseNow } from './emailCampaignAuthority.ts';
import { readCurrentCampaignOpening } from './campaignOpeningSource.ts';
import { openingHash, openingSnapshotKey, resolveCampaignOpening, type CampaignOpeningSelector, type CampaignOpeningSnapshot } from './campaignOpening.ts';

export interface CampaignOpeningAttempt extends Record<string, unknown> {
  execution_id: string; attempt_id: string; binding: CampaignOpeningBinding; snapshot_hash: string;
  state: 'unknown' | 'ready' | 'refused' | 'invalidated';
  content: { opening: string; choice: unknown } | null;
  invalidated_at: Date | null;
  fence_id: string | null; subject_hash: string | null; body_hash: string | null;
}
export async function readCampaignOpeningAttempt(ctx: RepositoryContext, executionId: string) {
  return (await ctx.db.query<CampaignOpeningAttempt>('SELECT * FROM outreach_campaign_opening_attempts WHERE workspace_id=$1 AND execution_id=$2', [ctx.scope.workspaceId, executionId])).rows[0] ?? null;
}
export async function eraseCampaignOpening(ctx: RepositoryContext, executionId: string): Promise<void> {
  await ctx.db.query('SELECT erase_campaign_opening($1,$2)', [ctx.scope.workspaceId, executionId]);
}
async function executionEligible(ctx: RepositoryContext, executionId: string, eligibility: StepEligibility): Promise<boolean> {
  const execution = await readStepExecution(ctx, executionId);
  const enrollment = execution ? await readEnrollment(ctx, { enrollmentId: execution.enrollmentId }) : null;
  const now = await campaignDatabaseNow(ctx);
  if (!execution || !enrollment || enrollment.endedAt || !['pending', 'held'].includes(execution.state)
    || Date.parse(execution.notBefore) > Date.parse(now) || Date.parse(execution.dueAt) > Date.parse(now)) return false;
  return (await eligibility.evaluate(ctx, { execution, opportunityId: enrollment.opportunityId,
    firmId: enrollment.firmId, contactId: enrollment.contactId, ownerUserId: enrollment.assignedUserId,
    channel: 'email', actionKind: 'email_send', now })).ok;
}
/** Worker calls this OUTSIDE its normal preparation transaction. Claim commits
 * first. A thrown/lost/ambiguous selector result remains unknown forever without
 * automatic retry or a new attempt ID, including after job lease loss. */
export async function selectCampaignOpeningBeforeTransaction(
  ctx: RepositoryContext, session: SessionQueryable,
  input: { executionId: string; selector?: CampaignOpeningSelector | undefined; eligibility: StepEligibility },
): Promise<void> {
  if (!input.selector) return; // Production port unavailable. Preparation holds policy-enabled work.
  const claims: { snapshot: CampaignOpeningSnapshot; attemptId: string }[] = [];
  await withTransaction(session, async () => {
    await lockSendGateForStopFact(ctx);
    if (!await executionEligible(ctx, input.executionId, input.eligibility)) return;
    const current = await readCurrentCampaignOpening(ctx, input.executionId);
    if (current.kind !== 'current') {
      if (current.kind === 'held') await eraseCampaignOpening(ctx, input.executionId);
      return;
    }
    if (await readCampaignOpeningAttempt(ctx, input.executionId)) return;
    // No retroactive selection after a baseline fence already exists.
    if ((await ctx.db.query('SELECT 1 FROM outbound_messages WHERE workspace_id=$1 AND step_execution_id=$2', [ctx.scope.workspaceId, input.executionId])).rows.length) return;
    const fresh = await readCurrentCampaignOpening(ctx, input.executionId);
    if (fresh.kind !== 'current' || openingSnapshotKey(fresh.snapshot) !== openingSnapshotKey(current.snapshot)) return;
    const attemptId = randomUUID();
    const inserted = await ctx.db.query(`INSERT INTO outreach_campaign_opening_attempts(workspace_id,execution_id,attempt_id,binding,snapshot_hash)
      VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT(workspace_id,execution_id) DO NOTHING RETURNING attempt_id`,
    [ctx.scope.workspaceId, input.executionId, attemptId, JSON.stringify(fresh.snapshot.binding), openingSnapshotKey(fresh.snapshot)]);
    if (inserted.rows.length) claims.push({ snapshot: fresh.snapshot, attemptId });
  });
  const claim = claims[0];
  if (!claim) return;
  let result: Awaited<ReturnType<CampaignOpeningSelector['select']>>;
  try { result = await input.selector.select({ ...claim.snapshot, attemptId: claim.attemptId }); }
  catch { return; } // No exception/prompt/output prose in logs. Unknown remains durable.
  await withTransaction(session, async () => {
    await lockSendGateForStopFact(ctx);
    const row = await readCampaignOpeningAttempt(ctx, input.executionId);
    if (!row || row.attempt_id !== claim.attemptId || row.state !== 'unknown' || row.invalidated_at) return;
    if (!await executionEligible(ctx, input.executionId, input.eligibility)) { await eraseCampaignOpening(ctx, input.executionId); return; }
    const current = await readCurrentCampaignOpening(ctx, input.executionId);
    if (current.kind !== 'current' || row.snapshot_hash !== openingSnapshotKey(current.snapshot)) {
      await eraseCampaignOpening(ctx, input.executionId); return;
    }
    const opening = result.kind === 'selected' ? resolveCampaignOpening(current.snapshot, result.choice, await campaignDatabaseNow(ctx)) : null;
    await ctx.db.query(`UPDATE outreach_campaign_opening_attempts SET state=$4,content=$5::jsonb,finished_at=clock_timestamp()
      WHERE workspace_id=$1 AND execution_id=$2 AND attempt_id=$3 AND state='unknown'`,
    [ctx.scope.workspaceId, input.executionId, claim.attemptId, opening === null ? 'refused' : 'ready',
      opening === null ? null : JSON.stringify({ opening, choice: campaignOpeningChoiceSchema.parse(result.kind === 'selected' ? result.choice : null) })]);
  });
}

/** Preparation and dispatch use this same owner. A present policy never falls
 * back to the exact-template path, including erased/refused/unknown attempts. */
export async function readyCampaignOpening(ctx: RepositoryContext, executionId: string): Promise<
  { kind: 'exact_template' } | { kind: 'held' } | { kind: 'ready'; opening: string; attempt: CampaignOpeningAttempt }
> {
  const current = await readCurrentCampaignOpening(ctx, executionId);
  if (current.kind === 'exact_template') return current;
  const attempt = await readCampaignOpeningAttempt(ctx, executionId);
  if (current.kind !== 'current' || !attempt || attempt.snapshot_hash !== openingSnapshotKey(current.snapshot)) {
    if (attempt) await eraseCampaignOpening(ctx, executionId);
    return { kind: 'held' };
  }
  if (attempt.invalidated_at) { if (attempt.content) await eraseCampaignOpening(ctx, executionId); return { kind: 'held' }; }
  if (attempt.state !== 'ready' || !attempt.content) return { kind: 'held' };
  const opening = resolveCampaignOpening(current.snapshot, attempt.content.choice, await campaignDatabaseNow(ctx));
  if (opening !== attempt.content.opening) { await eraseCampaignOpening(ctx, executionId); return { kind: 'held' }; }
  return { kind: 'ready', opening, attempt };
}
export async function attachCampaignOpeningFence(ctx: RepositoryContext, input: { executionId: string; fenceId: string; subject: string; body: string }): Promise<void> {
  await ctx.db.query(`UPDATE outreach_campaign_opening_attempts SET fence_id=$3,subject_hash=$4,body_hash=$5
    WHERE workspace_id=$1 AND execution_id=$2 AND state='ready' AND fence_id IS NULL`,
  [ctx.scope.workspaceId, input.executionId, input.fenceId, openingHash(input.subject), openingHash(input.body)]);
}
export async function verifyCampaignOpeningFence(ctx: RepositoryContext, fence: { id: string; stepExecutionId: string | null; subject: string; body: string }): Promise<boolean> {
  if (!fence.stepExecutionId) return true;
  const ready = await readyCampaignOpening(ctx, fence.stepExecutionId);
  return ready.kind === 'exact_template' || (ready.kind === 'ready' && ready.attempt.fence_id === fence.id
    && ready.attempt.subject_hash === openingHash(fence.subject) && ready.attempt.body_hash === openingHash(fence.body));
}

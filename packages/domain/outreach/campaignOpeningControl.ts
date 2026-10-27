import { randomUUID } from 'node:crypto';
import { campaignOpeningApproveInputSchema, campaignOpeningRevokeInputSchema, campaignOpeningPolicySchema,
  type CampaignOpeningApproveInput, type CampaignOpeningRevokeInput, type CampaignOpeningCommandResult } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { lockSendGateForStopFact } from '../policy/sendGate.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import { campaignDatabaseNow } from './emailCampaignAuthority.ts';
import { openingAdmin, openingBaseline, openingPolicyRow, ownedOpeningCampaign, type OpeningAuthority } from './campaignOpeningControlRead.ts';
export { readCampaignOpeningControl } from './campaignOpeningControlRead.ts';
export type OpeningControlResult = { ok: true; value: CampaignOpeningCommandResult } | { ok: false; reason: string };
export class CampaignOpeningControlChanged extends Error {
  constructor(readonly reason: string) { super(reason); }
}
type Target = CampaignOpeningApproveInput | CampaignOpeningRevokeInput;
/** Caller owns the command transaction. This is also its after-receipt wait fence. */
export async function assertCampaignOpeningControlCommit(ctx: RepositoryContext, input: Target, authority: OpeningAuthority): Promise<void> {
  if (!await openingAdmin(ctx) || !await authority()) throw new CampaignOpeningControlChanged('authority_changed');
  const campaign = await ownedOpeningCampaign(ctx, input.campaignId);
  if (!campaign || campaign.revision !== input.expectedCampaignRevision) throw new CampaignOpeningControlChanged('campaign_changed');
  const row = await openingPolicyRow(ctx, campaign.id), policy = campaignOpeningPolicySchema.safeParse(row?.policy);
  if (!row || !policy.success || policy.data.ownerUserId !== campaign.owner_user_id || policy.data.workspaceId !== ctx.scope.workspaceId)
    throw new CampaignOpeningControlChanged('policy_unavailable');
  if ('variants' in input) {
    const baseline = await openingBaseline(ctx, campaign.sequence_version_id), p = policy.data;
    if (!baseline || campaign.revoked_at || row.revoked_at || baseline.templateVersionId !== input.templateVersionId
      || baseline.templateContentHash !== input.templateContentHash || p.campaignRevision !== campaign.revision
      || p.sequenceVersionId !== baseline.sequenceVersionId || p.templateVersionId !== baseline.templateVersionId
      || p.templateContentHash !== baseline.templateContentHash || p.expiresAt !== input.expiresAt || JSON.stringify(p.variants) !== JSON.stringify(input.variants))
      throw new CampaignOpeningControlChanged('binding_changed');
  } else if (row.id !== input.policyId || policy.data.revision !== input.policyRevision || !row.revoked_at) {
    throw new CampaignOpeningControlChanged('policy_changed');
  }
  if (!await authority()) throw new CampaignOpeningControlChanged('authority_changed');
  if ('variants' in input) {
    const now = Date.parse(await campaignDatabaseNow(ctx));
    if (Date.parse(input.expiresAt) <= now || campaign.expires_at.getTime() <= now || Date.parse(input.expiresAt) > campaign.expires_at.getTime())
      throw new CampaignOpeningControlChanged('expiry_invalid');
  }
}
async function atomicOpeningWrite(ctx: RepositoryContext, work: () => Promise<OpeningControlResult>): Promise<OpeningControlResult> {
  await ctx.db.query('SAVEPOINT campaign_opening_control');
  try {
    const result = await work();
    if (!result.ok) await ctx.db.query('ROLLBACK TO SAVEPOINT campaign_opening_control');
    await ctx.db.query('RELEASE SAVEPOINT campaign_opening_control');
    return result;
  } catch (error) {
    await ctx.db.query('ROLLBACK TO SAVEPOINT campaign_opening_control');
    await ctx.db.query('RELEASE SAVEPOINT campaign_opening_control');
    if (error instanceof CampaignOpeningControlChanged) return { ok: false, reason: error.reason };
    if (error && typeof error === 'object' && 'constraint' in error && typeof error.constraint === 'string'
      && ['campaign_opening_policy_binding', 'campaign_opening_stop_serialization'].includes(error.constraint)) return { ok: false, reason: 'policy_unavailable' };
    throw error;
  }
}
/** Separate from audience admission. Does not call selectors or any send/settings owner. */
export async function approveCampaignOpening(ctx: RepositoryContext, raw: CampaignOpeningApproveInput, authority: OpeningAuthority): Promise<OpeningControlResult> {
  const parsed = campaignOpeningApproveInputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'invalid_input' };
  const input = parsed.data;
  if (input.variants.some(variant => /[\p{Cc}\p{Cf}]/u.test(variant.text))) return { ok: false, reason: 'invalid_input' };
  await lockSendGateForStopFact(ctx);
  if (!await openingAdmin(ctx)) return { ok: false, reason: 'admin_required' };
  const campaign = await ownedOpeningCampaign(ctx, input.campaignId, true);
  if (!await authority()) return { ok: false, reason: 'authority_changed' };
  if (!campaign) return { ok: false, reason: 'campaign_unavailable' };
  if (campaign.revision !== input.expectedCampaignRevision) return { ok: false, reason: 'stale_campaign' };
  if (await openingPolicyRow(ctx, campaign.id)) return { ok: false, reason: 'already_configured' };
  const baseline = await openingBaseline(ctx, campaign.sequence_version_id, true);
  if (!baseline || baseline.templateVersionId !== input.templateVersionId || baseline.templateContentHash !== input.templateContentHash) return { ok: false, reason: 'baseline_unavailable' };
  return atomicOpeningWrite(ctx, async () => {
    const fresh = await ownedOpeningCampaign(ctx, campaign.id), currentBaseline = await openingBaseline(ctx, campaign.sequence_version_id);
    if (!fresh || fresh.revision !== input.expectedCampaignRevision || JSON.stringify(currentBaseline) !== JSON.stringify(baseline)) return { ok: false, reason: 'binding_changed' };
    if (!await openingAdmin(ctx) || !await authority()) return { ok: false, reason: 'authority_changed' };
    const approvedAt = await campaignDatabaseNow(ctx), expiry = Date.parse(input.expiresAt);
    if (fresh.revoked_at || fresh.expires_at.getTime() <= Date.parse(approvedAt) || expiry <= Date.parse(approvedAt) || expiry > fresh.expires_at.getTime()) return { ok: false, reason: 'expiry_invalid' };
    const policy = campaignOpeningPolicySchema.parse({ id: randomUUID(), workspaceId: ctx.scope.workspaceId, ownerUserId: fresh.owner_user_id,
      campaignId: fresh.id, campaignRevision: fresh.revision, sequenceVersionId: baseline.sequenceVersionId, templateVersionId: baseline.templateVersionId,
      templateContentHash: baseline.templateContentHash, revision: 1, mode: 'approved_variant_selection_v1', firstEmailOnly: true,
      variants: input.variants, approvedAt, expiresAt: input.expiresAt });
    const inserted = await ctx.db.query(`INSERT INTO outreach_campaign_opening_policies(workspace_id,id,campaign_id,policy)
      VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(workspace_id,campaign_id) DO NOTHING RETURNING id`, [ctx.scope.workspaceId, policy.id, campaign.id, JSON.stringify(policy)]);
    if (!inserted.rows.length) return { ok: false, reason: 'already_configured' };
    await recordCrmAuditEvent(ctx, { action: 'outreach.campaign_opening_approved', subjectKind: 'campaign_opening_policy', subjectId: policy.id,
      detail: { campaignId: campaign.id, campaignRevision: campaign.revision, policyRevision: 1, templateVersionId: baseline.templateVersionId, templateContentHash: baseline.templateContentHash } });
    await assertCampaignOpeningControlCommit(ctx, input, authority);
    return { ok: true, value: { campaignId: campaign.id, policyId: policy.id, policyRevision: 1 } };
  });
}
export async function revokeCampaignOpening(ctx: RepositoryContext, raw: CampaignOpeningRevokeInput, authority: OpeningAuthority): Promise<OpeningControlResult> {
  const parsed = campaignOpeningRevokeInputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'invalid_input' };
  const input = parsed.data;
  await lockSendGateForStopFact(ctx);
  if (!await openingAdmin(ctx)) return { ok: false, reason: 'admin_required' };
  const campaign = await ownedOpeningCampaign(ctx, input.campaignId, true);
  if (!await authority()) return { ok: false, reason: 'authority_changed' };
  if (!campaign) return { ok: false, reason: 'campaign_unavailable' };
  if (campaign.revision !== input.expectedCampaignRevision) return { ok: false, reason: 'stale_campaign' };
  const row = await openingPolicyRow(ctx, campaign.id), policy = campaignOpeningPolicySchema.safeParse(row?.policy);
  if (!row || !policy.success || row.id !== input.policyId || policy.data.ownerUserId !== campaign.owner_user_id || policy.data.revision !== input.policyRevision) return { ok: false, reason: 'policy_unavailable' };
  return atomicOpeningWrite(ctx, async () => {
    if (!row.revoked_at) {
      await ctx.db.query('UPDATE outreach_campaign_opening_policies SET revoked_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 AND revoked_at IS NULL', [ctx.scope.workspaceId, row.id]);
      await recordCrmAuditEvent(ctx, { action: 'outreach.campaign_opening_revoked', subjectKind: 'campaign_opening_policy', subjectId: row.id,
        detail: { campaignId: campaign.id, campaignRevision: campaign.revision, policyRevision: 1 } });
    }
    await assertCampaignOpeningControlCommit(ctx, input, authority);
    return { ok: true, value: { campaignId: campaign.id, policyId: row.id, policyRevision: 1 } };
  });
}

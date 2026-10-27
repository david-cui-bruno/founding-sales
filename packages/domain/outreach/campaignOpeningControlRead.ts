import { campaignOpeningBaselineSchema, campaignOpeningControlSchema, campaignOpeningPolicySchema, type CampaignOpeningControl } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { campaignDatabaseNow, type EmailCampaignRow } from './emailCampaignAuthority.ts';

export type OpeningAuthority = () => Promise<boolean>;
export interface OpeningPolicyRow extends Record<string, unknown> { id: string; policy: unknown; revoked_at: Date | null }
export async function openingAdmin(ctx: RepositoryContext): Promise<boolean> {
  const actor = ctx.scope.actor;
  return actor.kind === 'user' && actor.role === 'admin' && (await ctx.db.query(`SELECT 1 FROM workspace_memberships
    WHERE workspace_id=$1 AND user_id=$2 AND role='admin' AND status='active'`, [ctx.scope.workspaceId, actor.userId])).rows.length === 1;
}
export async function ownedOpeningCampaign(ctx: RepositoryContext, campaignId: string, lock = false): Promise<EmailCampaignRow | null> {
  const actor = ctx.scope.actor;
  if (actor.kind !== 'user' || actor.role !== 'admin') return null;
  return (await ctx.db.query<EmailCampaignRow>(`SELECT c.* FROM outreach_email_campaigns c JOIN workspace_memberships m
    ON m.workspace_id=c.workspace_id AND m.user_id=c.owner_user_id AND m.status='active' AND m.role='admin'
    WHERE c.workspace_id=$1 AND c.id=$2 AND c.owner_user_id=$3${lock ? ' FOR UPDATE OF c' : ''}`,
  [ctx.scope.workspaceId, campaignId, actor.userId])).rows[0] ?? null;
}
export async function openingPolicyRow(ctx: RepositoryContext, campaignId: string): Promise<OpeningPolicyRow | null> {
  return (await ctx.db.query<OpeningPolicyRow>(`SELECT id,policy,revoked_at FROM outreach_campaign_opening_policies
    WHERE workspace_id=$1 AND campaign_id=$2`, [ctx.scope.workspaceId, campaignId])).rows[0] ?? null;
}
export async function openingBaseline(ctx: RepositoryContext, sequenceVersionId: string, lock = false): Promise<CampaignOpeningControl['baseline']> {
  const row = (await ctx.db.query<{ sequence_version_id: string; template_version_id: string; version: number; content_hash: string; subject: string; body: string; approved_at: Date }>(`SELECT s.sequence_version_id,s.template_version_id,t.version,t.content_hash,t.subject,t.body,t.approved_at
    FROM sequence_versions v JOIN sequence_steps s ON s.workspace_id=v.workspace_id AND s.sequence_version_id=v.id
    JOIN template_versions t ON t.workspace_id=s.workspace_id AND t.id=s.template_version_id
    WHERE v.workspace_id=$1 AND v.id=$2 AND v.state='published' AND v.retired_at IS NULL AND s.channel='email'
    AND s.ordinal=(SELECT min(ordinal) FROM sequence_steps WHERE workspace_id=v.workspace_id AND sequence_version_id=v.id AND channel='email')
    AND t.approved_at IS NOT NULL AND t.retired_at IS NULL${lock ? ' FOR SHARE OF v,s,t' : ''}`, [ctx.scope.workspaceId, sequenceVersionId])).rows[0];
  if (!row) return null;
  const parsed = campaignOpeningBaselineSchema.safeParse({ sequenceVersionId: row.sequence_version_id, templateVersionId: row.template_version_id,
    templateVersion: row.version, templateContentHash: row.content_hash, subject: row.subject, body: row.body, approvedAt: row.approved_at.toISOString() });
  return parsed.success ? parsed.data : null;
}
export async function readCampaignOpeningControl(ctx: RepositoryContext, input: { campaignId: string }, authority: OpeningAuthority): Promise<CampaignOpeningControl | null> {
  if (!await openingAdmin(ctx) || !await authority()) return null;
  const campaign = await ownedOpeningCampaign(ctx, input.campaignId);
  if (!campaign) return null;
  const baseline = await openingBaseline(ctx, campaign.sequence_version_id), stored = await openingPolicyRow(ctx, campaign.id);
  const parsed = campaignOpeningPolicySchema.safeParse(stored?.policy);
  if (!await authority()) return null;
  const current = await ownedOpeningCampaign(ctx, campaign.id), freshBaseline = await openingBaseline(ctx, campaign.sequence_version_id), freshPolicy = await openingPolicyRow(ctx, campaign.id);
  if (!current || JSON.stringify(current) !== JSON.stringify(campaign) || JSON.stringify(freshBaseline) !== JSON.stringify(baseline)
    || JSON.stringify(freshPolicy) !== JSON.stringify(stored) || !await openingAdmin(ctx)) return null;
  const now = Date.parse(await campaignDatabaseNow(ctx));
  const policy = stored && parsed.success ? { value: parsed.data, revokedAt: stored.revoked_at?.toISOString() ?? null,
    state: stored.revoked_at ? 'revoked' as const : Date.parse(parsed.data.expiresAt) <= now ? 'expired' as const
      : !baseline || campaign.revoked_at || campaign.expires_at.getTime() <= now || parsed.data.ownerUserId !== campaign.owner_user_id
        || parsed.data.campaignRevision !== campaign.revision || parsed.data.sequenceVersionId !== baseline.sequenceVersionId
        || parsed.data.templateVersionId !== baseline.templateVersionId || parsed.data.templateContentHash !== baseline.templateContentHash ? 'held' as const : 'active' as const } : null;
  return campaignOpeningControlSchema.parse({ campaignId: campaign.id, campaignRevision: campaign.revision, campaignExpiresAt: campaign.expires_at.toISOString(),
    baseline, policy, approvalState: stored ? 'already_configured' : baseline && !campaign.revoked_at && campaign.expires_at.getTime() > now ? 'available' : 'unavailable',
    selectorReadiness: 'not_established', sendingAuthority: 'unchanged' });
}

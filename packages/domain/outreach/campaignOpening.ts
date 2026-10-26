import { createHash } from 'node:crypto';
import {
  campaignOpeningBindingSchema, campaignOpeningChoiceSchema, campaignOpeningPolicySchema,
  type CampaignOpeningBinding, type CampaignOpeningPolicy,
} from '@fss/contracts';

/** Selector sees approved choices and public business identity only. No notes,
 * replies, address, raw page text or caller-supplied evidence enters this port. */
export interface CampaignOpeningSnapshot {
  readonly policy: CampaignOpeningPolicy;
  readonly binding: CampaignOpeningBinding;
  readonly source: { readonly firmName: string; readonly locality: string; readonly region: string };
  readonly citationIds: readonly string[];
}
export interface CampaignOpeningSelector {
  select(input: CampaignOpeningSnapshot & { readonly attemptId: string }): Promise<
    { readonly kind: 'selected'; readonly choice: unknown } | { readonly kind: 'refused' }
  >;
}
export function openingHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
export function openingBindingKey(binding: CampaignOpeningBinding): string {
  return openingHash(JSON.stringify(campaignOpeningBindingSchema.parse(binding)));
}
export function openingSnapshotKey(snapshot: CampaignOpeningSnapshot): string {
  return openingHash(JSON.stringify({
    binding: campaignOpeningBindingSchema.parse(snapshot.binding),
    policy: campaignOpeningPolicySchema.parse(snapshot.policy),
    source: snapshot.source, citationIds: [...snapshot.citationIds].sort(),
  }));
}
export function openingSnapshotCurrent(snapshot: CampaignOpeningSnapshot, now: string): boolean {
  const policy = campaignOpeningPolicySchema.safeParse(snapshot.policy);
  const binding = campaignOpeningBindingSchema.safeParse(snapshot.binding);
  if (!policy.success || !binding.success || !Number.isFinite(Date.parse(now))) return false;
  const p = policy.data, b = binding.data;
  return p.id === b.policyId && p.workspaceId === b.workspaceId && p.ownerUserId === b.ownerUserId
    && p.campaignId === b.campaignId && p.campaignRevision === b.campaignRevision
    && p.sequenceVersionId === b.sequenceVersionId && p.templateVersionId === b.templateVersionId
    && p.templateContentHash === b.templateContentHash && Date.parse(p.approvedAt) <= Date.parse(now)
    && Date.parse(b.validUntil) <= Date.parse(p.expiresAt) && Date.parse(b.validUntil) > Date.parse(now)
    && snapshot.citationIds.length > 0 && new Set(snapshot.citationIds).size === snapshot.citationIds.length;
}
/** Return only an approved line, substituting from the exact current qualified
 * source. Model prose, foreign citations and control/HTML injection are refused. */
export function resolveCampaignOpening(snapshot: CampaignOpeningSnapshot, output: unknown, now: string): string | null {
  if (!openingSnapshotCurrent(snapshot, now)) return null;
  const parsed = campaignOpeningChoiceSchema.safeParse(output);
  if (!parsed.success || parsed.data.citationIds.some(id => !snapshot.citationIds.includes(id))) return null;
  const variant = snapshot.policy.variants.find(value => value.id === parsed.data.variantId);
  if (!variant) return null;
  const values = { firm_name: snapshot.source.firmName, firm_locality: snapshot.source.locality, firm_region: snapshot.source.region };
  const line = variant.text.replaceAll(/\{\{(firm_name|firm_locality|firm_region)\}\}/gu, (_match, key: keyof typeof values) => values[key]);
  return line.length <= 800 && line.trim().length > 0 && !/[\p{Cc}\p{Cf}{}<>]/u.test(line) ? line : null;
}
/** Prefix only. Do not trim, normalize or rewrite either baseline component. */
export function prefixCampaignOpening(baseline: { readonly subject: string; readonly body: string }, opening: string) {
  return { subject: baseline.subject, body: `${opening}\n\n${baseline.body}` };
}

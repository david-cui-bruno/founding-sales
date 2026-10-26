import type { CampaignOpeningSnapshot } from '../../outreach/campaignOpening.ts';
export const id = '00000000-0000-4000-8000-000000000001';
export const other = '00000000-0000-4000-8000-000000000002';
export const now = '2026-10-26T14:00:00.000Z';
export function openingFixture() {
  const expiry = '2026-10-27T14:00:00.000Z';
  return {
    policy: { id, workspaceId: id, ownerUserId: id, campaignId: id, campaignRevision: 1,
      sequenceVersionId: id, templateVersionId: id, templateContentHash: 'a'.repeat(64), revision: 1,
      mode: 'approved_variant_selection_v1', firstEmailOnly: true,
      variants: [{ id: 'local', text: 'I noticed {{firm_name}} serves {{firm_locality}}, {{firm_region}}.' }],
      approvedAt: '2026-10-26T12:00:00.000Z', expiresAt: expiry },
    binding: { workspaceId: id, ownerUserId: id, campaignId: id, campaignRevision: 1, policyId: id,
      sequenceVersionId: id, templateVersionId: id, templateContentHash: 'a'.repeat(64), enrollmentId: id,
      executionId: id, firmId: id, candidateId: id, candidateRevision: 1, qualificationRunId: id,
      sourceFingerprint: 'b'.repeat(64), validUntil: expiry },
    source: { firmName: 'Fictional Homes', locality: 'Dallas', region: 'TX' }, citationIds: [`${id}:native`],
  } satisfies CampaignOpeningSnapshot;
}

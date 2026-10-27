import { expect, it } from 'vitest';
import { campaignOpeningApproveInputSchema, campaignOpeningRevokeInputSchema,
  campaignOpeningReceiptInputSchema, campaignOpeningReceiptSchema } from '../src/index.ts';

const id = '00000000-0000-4000-8000-000000000001';
const approval = { campaignId: id, expectedCampaignRevision: 1, templateVersionId: id,
  templateContentHash: 'a'.repeat(64), variants: [{ id: 'office', text: 'For {{firm_name}}.' }],
  expiresAt: '2026-10-28T00:00:00Z' };

it('accepts only explicit bounded copy and exact current baseline binding', () => {
  expect(campaignOpeningApproveInputSchema.parse(approval)).toEqual(approval);
  for (const bad of [
    { ...approval, ownerUserId: id }, { ...approval, workspaceId: id }, { ...approval, id },
    { ...approval, approvedAt: approval.expiresAt }, { ...approval, sequenceVersionId: id },
    { ...approval, sendingEnabled: true }, { ...approval, provider: 'real' },
    { ...approval, expectedCampaignRevision: 0 }, { ...approval, templateContentHash: 'bad' },
    { ...approval, variants: [] }, { ...approval, variants: Array(9).fill(approval.variants[0]) },
    { ...approval, variants: [approval.variants[0], approval.variants[0]] },
    { ...approval, variants: [{ id: 'office', text: '{{contact_email}}' }] },
    { ...approval, variants: [{ id: 'office', text: 'one\ntwo' }] },
  ]) expect(campaignOpeningApproveInputSchema.safeParse(bad).success).toBe(false);
});

it('retains immutable policy identity on revocation and forbids replacement input', () => {
  const input = { campaignId: id, expectedCampaignRevision: 2, policyId: id, policyRevision: 1 };
  expect(campaignOpeningRevokeInputSchema.parse(input)).toEqual(input);
  expect(campaignOpeningRevokeInputSchema.safeParse({ ...input, policyRevision: 2 }).success).toBe(false);
  expect(campaignOpeningRevokeInputSchema.safeParse({ ...input, variants: approval.variants }).success).toBe(false);
});

it('keeps action-specific receipt queries exact and results free of copy', () => {
  const input = { commandId: id, payloadSHA256: 'b'.repeat(64), action: 'approve' };
  expect(campaignOpeningReceiptInputSchema.parse(input)).toEqual(input);
  for (const bad of [{ ...input, action: 'send' }, { ...input, payloadSHA256: 'bad' },
    { ...input, variants: approval.variants }])
    expect(campaignOpeningReceiptInputSchema.safeParse(bad).success).toBe(false);
  const result = { campaignId: id, policyId: id, policyRevision: 1 };
  for (const value of [{ state: 'accepted', result }, { state: 'unknown' },
    { state: 'refused', reason: 'policy_already_configured' }])
    expect(campaignOpeningReceiptSchema.safeParse(value).success).toBe(true);
  expect(campaignOpeningReceiptSchema.safeParse({ state: 'accepted', result: { ...result,
    variants: approval.variants } }).success).toBe(false);
});

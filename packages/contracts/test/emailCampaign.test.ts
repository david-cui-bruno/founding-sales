import { describe, expect, it } from 'vitest';
import { emailCampaignApproveCommandSchema, emailCampaignCommandResultSchema, emailCampaignRevokeCommandSchema } from '../src/emailCampaign.ts';

const id = '11111111-1111-4111-8111-111111111111';
const input = { mailboxId: id, sequenceVersionId: id, authorizationRevision: 1, regions: ['TX'], maxEnrollments: 5, dailyAdmissionLimit: 1, expiresAt: '2026-10-29T00:00:00.000Z', commandId: id, clientVersion: '1.0.56' };
describe('approved email campaign boundary', () => {
  it('accepts a bounded campaign approval, not a selected-recipient command', () => {
    expect(emailCampaignApproveCommandSchema.safeParse(input).success).toBe(true);
    expect(emailCampaignApproveCommandSchema.safeParse({ ...input, candidateIds: [id] }).success).toBe(false);
  });
  it('does not accept expanded geography, duplicate targets, higher limits or sending switches', () => {
    for (const change of [{ regions: ['CA'] }, { regions: ['TX', 'TX'] }, { maxEnrollments: 26 }, { dailyAdmissionLimit: 6 }, { sendingEnabled: true }, { reviewed: true }, { authorizationRevision: 0 }]) {
      expect(emailCampaignApproveCommandSchema.safeParse({ ...input, ...change }).success).toBe(false);
    }
  });
  it('keeps revocation revision-bound and receipts IDs-only', () => {
    expect(emailCampaignRevokeCommandSchema.safeParse({ id, expectedRevision: 1, commandId: id, clientVersion: '1.0.56' }).success).toBe(true);
    expect(emailCampaignRevokeCommandSchema.safeParse({ id, commandId: id, clientVersion: '1.0.56' }).success).toBe(false);
    expect(emailCampaignCommandResultSchema.safeParse({ campaignId: id, revision: 1 }).success).toBe(true);
    expect(emailCampaignCommandResultSchema.safeParse({ campaignId: id, revision: 1, recipients: ['private@example.test'] }).success).toBe(false);
  });
});

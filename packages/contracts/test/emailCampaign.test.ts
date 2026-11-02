import { describe, expect, it } from 'vitest';
import { emailCampaignApproveCommandSchema, emailCampaignCommandResultSchema, emailCampaignRevokeCommandSchema } from '../src/emailCampaign.ts';
import { US_BUSINESS_REGIONS } from '../src/usBusinessGeography.ts';

const id = '11111111-1111-4111-8111-111111111111';
const input = { mailboxId: id, sequenceVersionId: id, authorizationRevision: 1, regions: ['TX'], maxEnrollments: 5, dailyAdmissionLimit: 1, expiresAt: '2026-10-29T00:00:00.000Z', commandId: id, clientVersion: '1.0.56' };
describe('approved email campaign boundary', () => {
  it('accepts a bounded campaign approval, not a selected-recipient command', () => {
    expect(emailCampaignApproveCommandSchema.safeParse(input).success).toBe(true);
    expect(emailCampaignApproveCommandSchema.safeParse({ ...input, candidateIds: [id] }).success).toBe(false);
  });
  it('accepts any of the 50 states and DC, once each', () => {
    for (const regions of [['TX'], ['WA', 'DC'], [...US_BUSINESS_REGIONS]]) {
      expect(emailCampaignApproveCommandSchema.safeParse({ ...input, regions }).success, regions.join()).toBe(true);
    }
  });
  it('does not accept unknown or lower-case regions, duplicate targets, higher limits or sending switches', () => {
    for (const change of [{ regions: [] }, { regions: ['PR'] }, { regions: ['tx'] }, { regions: ['TX', 'TX'] }, { regions: [...US_BUSINESS_REGIONS, 'TX'] }, { maxEnrollments: 26 }, { dailyAdmissionLimit: 6 }, { sendingEnabled: true }, { reviewed: true }, { authorizationRevision: 0 }]) {
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

describe('named-person enrichment contracts (ADR0036)', () => {
  it('bounds the people_enrichment setting, off by default, and keeps it out of the settings page snapshot', async () => {
    const {DEFAULT_PEOPLE_ENRICHMENT, PEOPLE_ENRICHMENT_DAILY_CREDITS_MAX, SETTING_KEYS, STORED_SETTING_VALUE_SCHEMAS} = await import('../src/settings.ts');
    const schema = STORED_SETTING_VALUE_SCHEMAS.people_enrichment!;
    expect(DEFAULT_PEOPLE_ENRICHMENT).toEqual({ enabled: false, dailyCredits: 30 });
    expect(schema.safeParse(DEFAULT_PEOPLE_ENRICHMENT).success).toBe(true);
    expect(schema.safeParse({ enabled: true, dailyCredits: PEOPLE_ENRICHMENT_DAILY_CREDITS_MAX }).success).toBe(true);
    for (const bad of [{ enabled: true, dailyCredits: 201 }, { enabled: true, dailyCredits: 0.5 }, { enabled: true }, { dailyCredits: 5 }, { enabled: true, dailyCredits: 5, key: 'x' }]) expect(schema.safeParse(bad).success).toBe(false);
    expect(SETTING_KEYS).not.toContain('people_enrichment');
  });
});

import { describe, expect, it } from 'vitest';
import { createCallCampaignDraft, describeCallCampaignDraft, describeCallCampaignTemplate, describeOneCompanyCampaignTemplate, type CreateCallCampaignDraftInput } from '../../src/shared/contracts/callCampaignDraft';
import { campaignVersionSchema } from '../../src/shared/contracts/campaignContract';
import { sha256Utf8 } from '../../src/shared/crypto/sha256';

const input: CreateCallCampaignDraftInput = {
  campaignId: 'campaign-1', versionId: 'version-1', stepId: 'step-1', accountId: 'account-1', offer: ' Discuss a meeting ',
};

describe('manual initial call campaign draft', () => {
  it('describes the same exact template after approval without relabeling it as a draft', () => {
    const draft = createCallCampaignDraft(input);
    const approved = { ...draft, approvedAt: '2026-09-11T21:00:00.000Z' };
    expect(describeCallCampaignTemplate(draft)).toEqual(describeCallCampaignDraft(draft));
    expect(describeCallCampaignTemplate(approved)).toEqual(describeCallCampaignDraft(draft));
    expect(describeCallCampaignDraft(approved)).toBeNull();
    for (const version of [draft, approved]) {
      for (const change of [{ audienceHash: 'a'.repeat(64) }, { contentPolicyHash: 'b'.repeat(64) },
        { cohortAccountIds: ['other'] }, { version: 2 }, { channelCaps: { call: 2, email: 0, linkedin: 0 } },
        { steps: [{ ...draft.steps[0], delayHours: 1 }] }]) {
        expect(describeCallCampaignTemplate({ ...version, ...change })).toBeNull();
      }
    }
  });
  it('maps source identities and pins canonical UTF-8 hash inputs deterministically', () => {
    const draft = createCallCampaignDraft(input);
    expect(draft).toEqual(createCallCampaignDraft({ offer: input.offer, accountId: input.accountId,
      stepId: input.stepId, versionId: input.versionId, campaignId: input.campaignId }));
    expect(draft).toMatchObject({ id: input.versionId, campaignId: input.campaignId, offer: 'Discuss a meeting' });
    expect(draft.audienceHash).toBe(sha256Utf8('{"kind":"explicit_account_audience","version":1,"accountIds":["account-1"]}'));
    expect(draft.contentPolicyHash).toBe(sha256Utf8('manual initial call draft template v1'));
    const unicode = createCallCampaignDraft({ ...input, accountId: '会社-"é"' });
    expect(unicode.audienceHash).toBe(sha256Utf8('{"kind":"explicit_account_audience","version":1,"accountIds":["会社-\\"é\\""]}'));
    expect(describeCallCampaignDraft(unicode)?.accountId).toBe('会社-"é"');
  });

  it('changes only the audience binding for another account and never blends accounts', () => {
    const first = createCallCampaignDraft(input);
    const second = createCallCampaignDraft({ ...input, accountId: 'account-2' });
    expect(second.audienceHash).not.toBe(first.audienceHash);
    expect(second).toEqual({ ...first, audienceHash: second.audienceHash, cohortAccountIds: ['account-2'] });
    const otherOffer = createCallCampaignDraft({ ...input, offer: 'Another offer', campaignId: 'other', versionId: 'other-v', stepId: 'other-s' });
    expect(otherOffer.audienceHash).toBe(first.audienceHash);
    expect(otherOffer.contentPolicyHash).toBe(first.contentPolicyHash);
  });

  it('creates exactly one unapproved initial call with lifetime caps and descriptive info', () => {
    const draft = createCallCampaignDraft(input);
    expect(campaignVersionSchema.parse(draft)).toEqual(draft);
    expect(draft).toMatchObject({ version: 1, approvedAt: null, objective: 'meeting', cohortAccountIds: ['account-1'],
      steps: [{ id: 'step-1', channel: 'call', condition: 'initial', delayHours: 0 }],
      capScope: 'campaign_version_lifetime', channelCaps: { call: 1, email: 0, linkedin: 0 } });
    expect(describeCallCampaignDraft(draft)).toEqual({ accountId: 'account-1', audienceDescription: 'Single account: account-1',
      policyDescription: 'manual initial call draft template v1' });
  });

  it('validates offers using the existing schema', () => {
    for (const offer of ['', ' \n ', 'a'.repeat(4001)]) expect(() => createCallCampaignDraft({ ...input, offer })).toThrow();
    expect(createCallCampaignDraft({ ...input, offer: 'a'.repeat(4000) }).offer).toHaveLength(4000);
  });

  it('validates every identity through the existing schema', () => {
    for (const key of ['campaignId', 'versionId', 'stepId', 'accountId'] as const) {
      for (const value of ['', 'a'.repeat(201)]) expect(() => createCallCampaignDraft({ ...input, [key]: value })).toThrow();
    }
  });

  it('leaves tampered hashes, cross-account substitutions and opaque legacy versions unknown', () => {
    const draft = createCallCampaignDraft(input);
    for (const changed of [
      { audienceHash: sha256Utf8('legacy opaque audience') },
      { contentPolicyHash: sha256Utf8('legacy opaque policy') },
      { audienceHash: sha256Utf8('legacy audience'), contentPolicyHash: sha256Utf8('legacy policy') },
      { cohortAccountIds: ['account-2'] },
    ]) expect(describeCallCampaignDraft({ ...draft, ...changed })).toBeNull();
  });

  it('rejects every changed structural constraint and malformed versions', () => {
    const draft = createCallCampaignDraft(input);
    const step = draft.steps[0]!;
    for (const changed of [
      { version: 2 }, { approvedAt: '2026-09-11T21:00:00.000Z' }, { objective: 'sale' }, { capScope: 'daily' },
      { cohortAccountIds: [] }, { cohortAccountIds: ['account-1', 'account-2'] },
      { steps: [] }, { steps: [step, { ...step, id: 'step-2', condition: 'no_reply' }] },
      { steps: [{ ...step, channel: 'email' }] }, { steps: [{ ...step, channel: 'linkedin' }] },
      { steps: [{ ...step, condition: 'requested_info' }] }, { steps: [{ ...step, delayHours: 1 }] },
      ...[{ call: 0, email: 0, linkedin: 0 }, { call: 2, email: 0, linkedin: 0 },
        { call: 1, email: 1, linkedin: 0 }, { call: 1, email: 0, linkedin: 1 }].map(channelCaps => ({ channelCaps })),
      { offer: '' }, { id: '' }, { campaignId: '' }, { steps: [{ ...step, id: '' }] }, { authority: true },
    ]) expect(describeCallCampaignDraft({ ...draft, ...changed })).toBeNull();
    for (const malformed of [null, undefined, {}, 'unknown']) expect(describeCallCampaignDraft(malformed)).toBeNull();
  });

  it('names the call template as the only one-company template and keeps a saved LinkedIn-typed version opaque', () => {
    const draft = createCallCampaignDraft(input);
    expect(describeOneCompanyCampaignTemplate(draft)).toEqual({ channel: 'call', ...describeCallCampaignTemplate(draft) });
    // Exactly what the retired LinkedIn template produced. Since 18 September 2026 the desktop names no such template.
    const linkedInTyped = campaignVersionSchema.parse({ ...draft, steps: [{ ...draft.steps[0]!, channel: 'linkedin' }],
      channelCaps: { call: 0, email: 0, linkedin: 1 }, contentPolicyHash: sha256Utf8('manual initial linkedin draft template v1') });
    expect(describeOneCompanyCampaignTemplate(linkedInTyped)).toBeNull();
    expect(describeCallCampaignTemplate(linkedInTyped)).toBeNull();
    expect(describeCallCampaignDraft(linkedInTyped)).toBeNull();
  });
});


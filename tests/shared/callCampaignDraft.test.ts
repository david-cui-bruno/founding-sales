import { describe, expect, it } from 'vitest';
import { createCallCampaignDraft, createLinkedInCampaignDraft, describeCallCampaignDraft, describeCallCampaignTemplate, describeLinkedInCampaignDraft,
  describeLinkedInCampaignTemplate, describeOneCompanyCampaignTemplate, type CreateCallCampaignDraftInput, type CreateLinkedInCampaignDraftInput } from '../../src/shared/contracts/callCampaignDraft';
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
});

describe('manual initial LinkedIn campaign draft', () => {
  const linkedInInput: CreateLinkedInCampaignDraftInput = { ...input, campaignId: 'li-campaign-1', versionId: 'li-version-1', stepId: 'li-step-1' };
  const linkedInPolicy = 'manual initial linkedin draft template v1';

  it('creates exactly one unapproved initial LinkedIn step with lifetime caps linkedin 1, call 0, email 0', () => {
    const draft = createLinkedInCampaignDraft(linkedInInput);
    expect(campaignVersionSchema.parse(draft)).toEqual(draft);
    expect(draft).toMatchObject({ id: 'li-version-1', campaignId: 'li-campaign-1', version: 1, approvedAt: null, objective: 'meeting', offer: 'Discuss a meeting',
      cohortAccountIds: ['account-1'], steps: [{ id: 'li-step-1', channel: 'linkedin', condition: 'initial', delayHours: 0 }],
      capScope: 'campaign_version_lifetime', channelCaps: { call: 0, email: 0, linkedin: 1 } });
    expect(draft.contentPolicyHash).toBe(sha256Utf8(linkedInPolicy));
    expect(draft.contentPolicyHash).not.toBe(createCallCampaignDraft(input).contentPolicyHash);
    // The audience binding is channel independent: one explicit account, canonical JSON v1.
    expect(draft.audienceHash).toBe(createCallCampaignDraft(input).audienceHash);
    expect(describeLinkedInCampaignDraft(draft)).toEqual({ accountId: 'account-1', audienceDescription: 'Single account: account-1', policyDescription: linkedInPolicy });
  });

  it('describes the same exact LinkedIn template after approval without relabeling it as a draft', () => {
    const draft = createLinkedInCampaignDraft(linkedInInput);
    const approved = { ...draft, approvedAt: '2026-09-11T21:00:00.000Z' };
    expect(describeLinkedInCampaignTemplate(draft)).toEqual(describeLinkedInCampaignDraft(draft));
    expect(describeLinkedInCampaignTemplate(approved)).toEqual(describeLinkedInCampaignDraft(draft));
    expect(describeLinkedInCampaignDraft(approved)).toBeNull();
    expect(describeOneCompanyCampaignTemplate(approved)).toEqual({ channel: 'linkedin', ...describeLinkedInCampaignTemplate(draft) });
  });

  it('rejects mixed caps, extra steps, wrong channels, tampered hashes and malformed versions', () => {
    const draft = createLinkedInCampaignDraft(linkedInInput);
    const step = draft.steps[0]!;
    for (const changed of [
      ...[{ call: 1, email: 0, linkedin: 1 }, { call: 0, email: 1, linkedin: 1 }, { call: 0, email: 0, linkedin: 2 },
        { call: 0, email: 0, linkedin: 0 }, { call: 1, email: 0, linkedin: 0 }].map(channelCaps => ({ channelCaps })),
      { steps: [step, { ...step, id: 'li-step-2', condition: 'no_reply' }] }, { steps: [] },
      { steps: [{ ...step, channel: 'call' }] }, { steps: [{ ...step, channel: 'email' }] },
      { steps: [{ ...step, condition: 'requested_info' }] }, { steps: [{ ...step, delayHours: 1 }] },
      { version: 2 }, { objective: 'sale' }, { capScope: 'daily' }, { cohortAccountIds: [] }, { cohortAccountIds: ['account-1', 'account-2'] }, { cohortAccountIds: ['account-2'] },
      { audienceHash: 'a'.repeat(64) }, { contentPolicyHash: createCallCampaignDraft(input).contentPolicyHash }, { contentPolicyHash: sha256Utf8('legacy opaque policy') },
      { offer: '' }, { id: '' }, { authority: true },
    ]) {
      expect(describeLinkedInCampaignTemplate({ ...draft, ...changed })).toBeNull();
      expect(describeOneCompanyCampaignTemplate({ ...draft, ...changed })).toBeNull();
    }
    for (const malformed of [null, undefined, {}, 'unknown']) {
      expect(describeLinkedInCampaignTemplate(malformed)).toBeNull();
      expect(describeOneCompanyCampaignTemplate(malformed)).toBeNull();
    }
  });

  it('keeps the call helper strictly call-only and the LinkedIn helper strictly LinkedIn-only', () => {
    const call = createCallCampaignDraft(input);
    const linkedIn = createLinkedInCampaignDraft(linkedInInput);
    expect(describeCallCampaignTemplate(linkedIn)).toBeNull();
    expect(describeCallCampaignDraft(linkedIn)).toBeNull();
    expect(describeLinkedInCampaignTemplate(call)).toBeNull();
    expect(describeLinkedInCampaignDraft(call)).toBeNull();
    // A LinkedIn structure signed with the call policy, or vice versa, is neither template.
    expect(describeCallCampaignTemplate({ ...linkedIn, contentPolicyHash: call.contentPolicyHash })).toBeNull();
    expect(describeLinkedInCampaignTemplate({ ...call, contentPolicyHash: linkedIn.contentPolicyHash })).toBeNull();
    expect(describeOneCompanyCampaignTemplate({ ...linkedIn, contentPolicyHash: call.contentPolicyHash })).toBeNull();
    expect(describeOneCompanyCampaignTemplate(call)).toEqual({ channel: 'call', ...describeCallCampaignTemplate(call) });
    expect(describeOneCompanyCampaignTemplate(linkedIn)).toEqual({ channel: 'linkedin', ...describeLinkedInCampaignTemplate(linkedIn) });
    expect(describeOneCompanyCampaignTemplate({ ...call, channelCaps: { call: 2, email: 1, linkedin: 1 } })).toBeNull();
  });

  it('validates offers and identities for LinkedIn drafts through the existing schema', () => {
    for (const offer of ['', ' \n ', 'a'.repeat(4001)]) expect(() => createLinkedInCampaignDraft({ ...linkedInInput, offer })).toThrow();
    for (const key of ['campaignId', 'versionId', 'stepId', 'accountId'] as const) {
      for (const value of ['', 'a'.repeat(201)]) expect(() => createLinkedInCampaignDraft({ ...linkedInInput, [key]: value })).toThrow();
    }
  });
});

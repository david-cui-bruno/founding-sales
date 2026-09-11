import { sha256Utf8 } from '../crypto/sha256';
import { campaignVersionSchema, type CampaignVersion } from './campaignContract';

export type CreateCallCampaignDraftInput = {
  campaignId: string;
  versionId: string;
  stepId: string;
  accountId: string;
  offer: string;
};

// Hash the exact UTF-8 text below, without a trailing newline. This names a
// descriptive content policy only, not compliance, consent, send or call authority.
const policyDescription = 'manual initial call draft template v1';
const contentPolicyHash = sha256Utf8(policyDescription);

function audienceHash(accountId: string): string {
  // Canonical v1 JSON: fixed key order, no whitespace, one explicit account ID.
  // JSON escaping and sha256Utf8's TextEncoder semantics are portable to all hosts.
  return sha256Utf8(JSON.stringify({ kind: 'explicit_account_audience', version: 1, accountIds: [accountId] }));
}

export function createCallCampaignDraft(input: CreateCallCampaignDraftInput): CampaignVersion {
  return campaignVersionSchema.parse({
    id: input.versionId,
    campaignId: input.campaignId,
    version: 1,
    audienceHash: audienceHash(input.accountId),
    offer: input.offer,
    objective: 'meeting',
    cohortAccountIds: [input.accountId],
    approvedAt: null,
    steps: [{ id: input.stepId, channel: 'call', condition: 'initial', delayHours: 0 }],
    capScope: 'campaign_version_lifetime',
    channelCaps: { call: 1, email: 0, linkedin: 0 },
    contentPolicyHash,
  });
}

/** Recognize the exact template, with or without approval. Never grants authority. */
export function describeCallCampaignTemplate(version: unknown): {
  accountId: string;
  audienceDescription: string;
  policyDescription: string;
} | null {
  const parsed = campaignVersionSchema.safeParse(version);
  if (!parsed.success) return null;
  const draft = parsed.data;
  const accountId = draft.cohortAccountIds[0];
  const step = draft.steps[0];
  if (draft.version !== 1
    || draft.cohortAccountIds.length !== 1 || accountId === undefined
    || draft.steps.length !== 1 || !step || step.channel !== 'call'
    || step.condition !== 'initial' || step.delayHours !== 0
    || draft.channelCaps.call !== 1 || draft.channelCaps.email !== 0 || draft.channelCaps.linkedin !== 0
    || draft.audienceHash !== audienceHash(accountId) || draft.contentPolicyHash !== contentPolicyHash) return null;
  // objective and capScope are exact literals enforced by campaignVersionSchema.
  return { accountId, audienceDescription: `Single account: ${accountId}`, policyDescription };
}

/** Draft presentation must never relabel an approved version as unapproved. */
export function describeCallCampaignDraft(version: unknown): ReturnType<typeof describeCallCampaignTemplate> {
  const parsed = campaignVersionSchema.safeParse(version);
  return parsed.success && parsed.data.approvedAt === null ? describeCallCampaignTemplate(parsed.data) : null;
}

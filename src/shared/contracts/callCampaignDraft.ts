import { sha256Utf8 } from '../crypto/sha256';
import { campaignVersionSchema, type CampaignVersion } from './campaignContract';
import { describeTerritoryPolicyVersion, type TerritoryPolicyVersionDescription } from './territoryCallPolicyContract';

export type CreateCallCampaignDraftInput = {
  campaignId: string;
  versionId: string;
  stepId: string;
  accountId: string;
  offer: string;
};
export type CreateLinkedInCampaignDraftInput = CreateCallCampaignDraftInput;
/** The two exact one-company manual templates. Email is not a template here. */
export type OneCompanyCampaignChannel = 'call' | 'linkedin';

// Hash the exact UTF-8 text below, without a trailing newline. Each names a
// descriptive content policy only, not compliance, consent, send or call authority.
const templates = {
  call: { policyDescription: 'manual initial call draft template v1', channelCaps: { call: 1, email: 0, linkedin: 0 } },
  linkedin: { policyDescription: 'manual initial linkedin draft template v1', channelCaps: { call: 0, email: 0, linkedin: 1 } },
} as const;
const policyHashes = { call: sha256Utf8(templates.call.policyDescription), linkedin: sha256Utf8(templates.linkedin.policyDescription) };

function audienceHash(accountId: string): string {
  // Canonical v1 JSON: fixed key order, no whitespace, one explicit account ID.
  // JSON escaping and sha256Utf8's TextEncoder semantics are portable to all hosts.
  return sha256Utf8(JSON.stringify({ kind: 'explicit_account_audience', version: 1, accountIds: [accountId] }));
}

function createDraft(channel: OneCompanyCampaignChannel, input: CreateCallCampaignDraftInput): CampaignVersion {
  return campaignVersionSchema.parse({
    id: input.versionId,
    campaignId: input.campaignId,
    version: 1,
    audienceHash: audienceHash(input.accountId),
    offer: input.offer,
    objective: 'meeting',
    cohortAccountIds: [input.accountId],
    approvedAt: null,
    steps: [{ id: input.stepId, channel, condition: 'initial', delayHours: 0 }],
    capScope: 'campaign_version_lifetime',
    channelCaps: templates[channel].channelCaps,
    contentPolicyHash: policyHashes[channel],
  });
}

export function createCallCampaignDraft(input: CreateCallCampaignDraftInput): CampaignVersion {
  return createDraft('call', input);
}

/** Lifetime caps linkedin 1, call 0, email 0. Saving this never prepares, sends or connects. */
export function createLinkedInCampaignDraft(input: CreateLinkedInCampaignDraftInput): CampaignVersion {
  return createDraft('linkedin', input);
}

type TemplateDescription = {
  accountId: string;
  audienceDescription: string;
  policyDescription: string;
};

function describeTemplate(channel: OneCompanyCampaignChannel, version: unknown): TemplateDescription | null {
  const parsed = campaignVersionSchema.safeParse(version);
  if (!parsed.success) return null;
  const draft = parsed.data;
  const accountId = draft.cohortAccountIds[0];
  const step = draft.steps[0];
  const { channelCaps, policyDescription } = templates[channel];
  if (draft.version !== 1
    || draft.cohortAccountIds.length !== 1 || accountId === undefined
    || draft.steps.length !== 1 || !step || step.channel !== channel
    || step.condition !== 'initial' || step.delayHours !== 0
    || draft.channelCaps.call !== channelCaps.call || draft.channelCaps.email !== channelCaps.email || draft.channelCaps.linkedin !== channelCaps.linkedin
    || draft.audienceHash !== audienceHash(accountId) || draft.contentPolicyHash !== policyHashes[channel]) return null;
  // objective and capScope are exact literals enforced by campaignVersionSchema.
  return { accountId, audienceDescription: `Single account: ${accountId}`, policyDescription };
}

function describeDraft(channel: OneCompanyCampaignChannel, version: unknown): TemplateDescription | null {
  const parsed = campaignVersionSchema.safeParse(version);
  return parsed.success && parsed.data.approvedAt === null ? describeTemplate(channel, parsed.data) : null;
}

/** Recognize the exact call template, with or without approval. Never grants authority. */
export function describeCallCampaignTemplate(version: unknown): TemplateDescription | null {
  return describeTemplate('call', version);
}

/** Draft presentation must never relabel an approved version as unapproved. */
export function describeCallCampaignDraft(version: unknown): ReturnType<typeof describeCallCampaignTemplate> {
  return describeDraft('call', version);
}

/** Recognize the exact LinkedIn template, with or without approval. Never grants authority. */
export function describeLinkedInCampaignTemplate(version: unknown): TemplateDescription | null {
  return describeTemplate('linkedin', version);
}

/** Draft presentation must never relabel an approved version as unapproved. */
export function describeLinkedInCampaignDraft(version: unknown): ReturnType<typeof describeLinkedInCampaignTemplate> {
  return describeDraft('linkedin', version);
}

/** Exactly one of the two one-company templates, naming its channel. Anything else is opaque. */
export function describeOneCompanyCampaignTemplate(version: unknown): (TemplateDescription & { channel: OneCompanyCampaignChannel }) | null {
  const call = describeTemplate('call', version);
  if (call) return { channel: 'call', ...call };
  const linkedin = describeTemplate('linkedin', version);
  return linkedin ? { channel: 'linkedin', ...linkedin } : null;
}

export type CampaignTemplateDescription =
  | (TemplateDescription & { kind: 'one_company'; channel: OneCompanyCampaignChannel })
  | (TerritoryPolicyVersionDescription & { kind: 'territory_policy' });
/** Every version the renderer can name: the two exact one-company manual templates (Lenox's path, unchanged) or a
 * version the worker derived from the approved territory call policy, read-only. Anything else is opaque. */
export function describeCampaignTemplate(version: unknown): CampaignTemplateDescription | null {
  const manual = describeOneCompanyCampaignTemplate(version);
  if (manual) return { kind: 'one_company', ...manual };
  const territory = describeTerritoryPolicyVersion(version);
  return territory ? { kind: 'territory_policy', ...territory } : null;
}

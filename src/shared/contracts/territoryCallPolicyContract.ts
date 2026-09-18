import { z } from 'zod';
import { accountIdSchema as id, accountInstantSchema as instant } from './accountContract';
import { commandReceiptSchema } from './commandReceiptContract';
import { campaignVersionSchema, type CampaignVersion } from './campaignContract';
import { sha256Utf8 } from '../crypto/sha256';

/**
 * One standing territory call policy per workspace (design D1 and D13). Approving it once authorizes the worker to
 * grant itself authority over every firm the Places discovery creates and to enroll that firm on the sequence below.
 * The policy is revision-tracked and pausable; it never dials, sends or books, and it is read live from the worker.
 */
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** The workspace-level subject every territory policy command names where an account id would otherwise stand. */
export const TERRITORY_CALL_POLICY_SUBJECT = 'territory-call-policy';
/** Email steps exist in every derived version but hold with this reason until the mailbox ships (Batch 9). */
export const TERRITORY_EMAIL_HOLD_REASON = 'mailbox_not_connected';
export const territoryCallPolicyStepSchema = z.strictObject({
  dayOffset: z.number().int().min(0).max(365),
  channel: z.enum(['call', 'email']),
  templateKey: z.enum(['T1', 'T2', 'T3', 'T4', 'T5']).optional(),
}).refine(step => (step.channel === 'email') === (step.templateKey !== undefined), 'territory_step_template');
export type TerritoryCallPolicyStep = z.infer<typeof territoryCallPolicyStepSchema>;
export const territoryCallPolicyCapsSchema = z.strictObject({
  callsPerFirm: z.number().int().min(1).max(20),
  emailsPerFirm: z.number().int().min(0).max(20),
  /** Recorded here only; Today applies it when it builds the morning list. Enrollment is never refused by it. */
  newFirmsPerDay: z.number().int().min(1).max(1000),
});
const definitionShape = {
  audience: z.strictObject({ kind: z.literal('places_discovery') }),
  sequence: z.array(territoryCallPolicyStepSchema).min(1).max(20),
  caps: territoryCallPolicyCapsSchema,
  objective: z.literal('meeting'),
  offer: z.string().trim().min(1).max(4000),
};
type DefinitionLike = { sequence: TerritoryCallPolicyStep[]; caps: z.infer<typeof territoryCallPolicyCapsSchema> };
function validateDefinition(value: DefinitionLike, ctx: z.RefinementCtx): void {
  const first = value.sequence[0];
  if (!first || first.dayOffset !== 0 || first.channel !== 'call') ctx.addIssue({ code: 'custom', message: 'territory_sequence_starts_with_day_zero_call' });
  if (value.sequence.some((step, index) => index > 0 && step.dayOffset < value.sequence[index - 1]!.dayOffset)) ctx.addIssue({ code: 'custom', message: 'territory_sequence_order' });
  const calls = value.sequence.filter(step => step.channel === 'call').length;
  const emails = value.sequence.filter(step => step.channel === 'email').length;
  if (calls > value.caps.callsPerFirm || emails > value.caps.emailsPerFirm) ctx.addIssue({ code: 'custom', message: 'territory_sequence_exceeds_caps' });
}
export const territoryCallPolicyDefinitionSchema = z.strictObject(definitionShape).superRefine(validateDefinition);
export type TerritoryCallPolicyDefinition = z.infer<typeof territoryCallPolicyDefinitionSchema>;
export function territoryCallPolicyId(workspaceId: string): string {
  return `territory-policy-${sha256Utf8(JSON.stringify({ kind: 'territory_call_policy', version: 1, workspaceId: id.parse(workspaceId) }))}`;
}
export const territoryCallPolicySchema = z.strictObject({
  ...definitionShape,
  policyId: id, workspaceId: id,
  /** The desktop pairing that applied the latest revision; the worker binds each firm's owner source to it. */
  pairingId: id,
  revision: revision.min(1), state: z.enum(['active', 'paused']),
  approvedAt: instant, approvedRevision: revision.min(1), updatedAt: instant,
}).superRefine((value, ctx) => {
  validateDefinition(value, ctx);
  if (value.approvedRevision > value.revision) ctx.addIssue({ code: 'custom', message: 'territory_policy_revision' });
  if (value.policyId !== territoryCallPolicyId(value.workspaceId)) ctx.addIssue({ code: 'custom', message: 'territory_policy_identity' });
});
export type TerritoryCallPolicy = z.infer<typeof territoryCallPolicySchema>;
/** David's decision of 17 Sep 2026 (D13 v1): day 0 call, day 3 call, day 7 email T4, day 12 call, day 21 email T5; 3 calls and 3 emails per firm; 30 new firms a morning. */
export const DEFAULT_TERRITORY_CALL_POLICY_DEFINITION: TerritoryCallPolicyDefinition = territoryCallPolicyDefinitionSchema.parse({
  audience: { kind: 'places_discovery' },
  sequence: [
    { dayOffset: 0, channel: 'call' },
    { dayOffset: 3, channel: 'call' },
    { dayOffset: 7, channel: 'email', templateKey: 'T4' },
    { dayOffset: 12, channel: 'call' },
    { dayOffset: 21, channel: 'email', templateKey: 'T5' },
  ],
  caps: { callsPerFirm: 3, emailsPerFirm: 3, newFirmsPerDay: 30 },
  objective: 'meeting',
  offer: 'A short introductory call about how your firm handles resident maintenance requests, and whether a twenty-minute meeting is worth your time.',
});
/** Owner command payloads. `policy.read` is a pure read that stores nothing; approve and set-state are CAS on the revision. */
export const territoryCallPolicyCommandPayloadSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('policy.read') }),
  z.strictObject({ kind: z.literal('policy.approve'), expectedRevision: revision, definition: territoryCallPolicyDefinitionSchema }),
  z.strictObject({ kind: z.literal('policy.set-state'), expectedRevision: revision.min(1), state: z.enum(['active', 'paused']) }),
]);
export type TerritoryCallPolicyCommandPayload = z.infer<typeof territoryCallPolicyCommandPayloadSchema>;
/** The worker's answer to a territory policy command: the command's receipt plus the policy as it stands afterwards. */
export const territoryCallPolicyReceiptSchema = z.strictObject({ receipt: commandReceiptSchema, policy: territoryCallPolicySchema.nullable() });
export type TerritoryCallPolicyReceipt = z.infer<typeof territoryCallPolicyReceiptSchema>;
/** Renderer to main. The renderer names the command identity so a retry resends the same command; main supplies the definition. */
export const territoryCallPolicyRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('read') }),
  z.strictObject({ kind: z.literal('approve'), commandId: z.uuid(), expectedRevision: revision }),
  z.strictObject({ kind: z.literal('set-state'), commandId: z.uuid(), expectedRevision: revision.min(1), state: z.enum(['active', 'paused']) }),
]);
export type TerritoryCallPolicyRequest = z.infer<typeof territoryCallPolicyRequestSchema>;
export const territoryCallPolicyStatusSchema = z.strictObject({
  workspaceId: id, policy: territoryCallPolicySchema.nullable(),
  /** What an approval would apply: the fixed default in this batch. */
  definition: territoryCallPolicyDefinitionSchema,
  receipt: commandReceiptSchema.nullable(),
}).refine(value => value.policy === null || value.policy.workspaceId === value.workspaceId, 'territory_policy_workspace');
export type TerritoryCallPolicyStatus = z.infer<typeof territoryCallPolicyStatusSchema>;

/** Derivations shared by the worker (which writes them) and the desktop (which recognizes them). All ids come from (policyId, revision, accountId). */
type PolicyIdentity = Pick<TerritoryCallPolicy, 'policyId' | 'revision'>;
const derived = (kind: string, policy: PolicyIdentity, accountId: string) => sha256Utf8(JSON.stringify({ kind, policyId: policy.policyId, revision: policy.revision, accountId }));
export function territoryAudienceHash(policy: PolicyIdentity, accountId: string): string {
  return sha256Utf8(JSON.stringify({ kind: 'territory_policy_audience', policyId: policy.policyId, revision: policy.revision, accountId }));
}
export function territoryContentPolicyHash(policy: PolicyIdentity & Pick<TerritoryCallPolicy, 'sequence' | 'caps' | 'objective' | 'offer'>): string {
  return sha256Utf8(JSON.stringify({ kind: 'territory_call_policy_content', version: 1, policyId: policy.policyId, revision: policy.revision,
    sequence: policy.sequence.map(step => ({ dayOffset: step.dayOffset, channel: step.channel, ...(step.templateKey ? { templateKey: step.templateKey } : {}) })),
    caps: { callsPerFirm: policy.caps.callsPerFirm, emailsPerFirm: policy.caps.emailsPerFirm, newFirmsPerDay: policy.caps.newFirmsPerDay }, objective: policy.objective, offer: policy.offer }));
}
export function territoryCampaignId(policy: PolicyIdentity, accountId: string): string { return `territory:${policy.policyId}:${policy.revision}:${accountId}`; }
export function territoryCampaignVersionId(policy: PolicyIdentity, accountId: string): string { return `territory-version-${derived('territory_policy_version', policy, accountId)}`; }
export function territoryEnrollmentId(policy: PolicyIdentity, accountId: string): string { return `territory-enrollment-${derived('territory_policy_enrollment', policy, accountId)}`; }
export function territoryExecutionContextId(policy: PolicyIdentity, accountId: string): string { return `territory-context-${derived('territory_policy_context', policy, accountId)}`; }
/** A UUID-shaped command id derived from the identity, so a replayed create never mints a second enrollment. */
export function territoryEnrollmentCommandId(policy: PolicyIdentity, accountId: string): string {
  const hash = derived('territory_policy_command', policy, accountId);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
const stepId = (versionId: string, index: number) => `${versionId}-step-${index}`;
/** One single-firm campaign version, version 1, unapproved (the worker records the approval beside it). */
export function deriveTerritoryCampaignVersion(policy: PolicyIdentity & Pick<TerritoryCallPolicy, 'sequence' | 'caps' | 'objective' | 'offer'>, accountId: string): CampaignVersion {
  id.parse(accountId);
  const versionId = territoryCampaignVersionId(policy, accountId);
  return campaignVersionSchema.parse({
    id: versionId, campaignId: territoryCampaignId(policy, accountId), version: 1,
    audienceHash: territoryAudienceHash(policy, accountId), offer: policy.offer, objective: 'meeting',
    cohortAccountIds: [accountId], approvedAt: null,
    // Day offsets are calendar days from enrollment; business-day timing is Today's concern when it lists due firms.
    steps: policy.sequence.map((step, index) => ({ id: stepId(versionId, index), channel: step.channel, condition: index === 0 ? 'initial' : 'no_reply', delayHours: step.dayOffset * 24 })),
    capScope: 'campaign_version_lifetime', channelCaps: { call: policy.caps.callsPerFirm, email: policy.caps.emailsPerFirm, linkedin: 0 },
    contentPolicyHash: territoryContentPolicyHash(policy),
  });
}
export type TerritoryHeldStep = { stepId: string; channel: 'email'; reason: typeof TERRITORY_EMAIL_HOLD_REASON };
/** Every email step of a derived version is held until the mailbox ships; call steps are due on schedule. */
export function territoryHeldSteps(version: Pick<CampaignVersion, 'steps'>): TerritoryHeldStep[] {
  return version.steps.filter(step => step.channel === 'email').map(step => ({ stepId: step.id, channel: 'email' as const, reason: TERRITORY_EMAIL_HOLD_REASON }));
}
export type TerritoryPolicyVersionDescription = { accountId: string; policyId: string; revision: number; audienceDescription: string; policyDescription: string };
const campaignIdPattern = /^territory:(territory-policy-[a-f0-9]{64}):([1-9][0-9]{0,15}):(.+)$/;
/** Recognize a version the worker derived from a territory policy, with or without approval. Content is verified where the
 * version alone allows it (ids, audience hash, cohort, step shape); the content hash needs the policy text. Never grants anything. */
export function describeTerritoryPolicyVersion(value: unknown): TerritoryPolicyVersionDescription | null {
  const parsed = campaignVersionSchema.safeParse(value);
  if (!parsed.success) return null;
  const version = parsed.data;
  const match = campaignIdPattern.exec(version.campaignId);
  if (!match) return null;
  const policy = { policyId: match[1]!, revision: Number(match[2]) };
  const accountId = match[3]!;
  if (!Number.isSafeInteger(policy.revision) || version.version !== 1 || version.cohortAccountIds.length !== 1 || version.cohortAccountIds[0] !== accountId
    || version.id !== territoryCampaignVersionId(policy, accountId) || version.audienceHash !== territoryAudienceHash(policy, accountId)
    || version.channelCaps.linkedin !== 0 || version.channelCaps.call < 1
    || version.steps.some((step, index) => step.id !== stepId(version.id, index) || step.channel === 'linkedin' || step.delayHours % 24 !== 0
      || step.condition !== (index === 0 ? 'initial' : 'no_reply'))) return null;
  return { accountId, ...policy, audienceDescription: 'Territory policy audience: every firm the Places discovery creates in this workspace.', policyDescription: `Territory policy v${policy.revision}` };
}

import { z } from 'zod';
import { accountIdSchema as id, accountInstantSchema as instant } from './accountContract';
import { commandReceiptSchema } from './commandReceiptContract';
import { campaignVersionSchema, type CampaignVersion } from './campaignContract';
import { sha256Utf8 } from '../crypto/sha256';
import { territoryStateSchema, territoryTimeZoneSchema, TERRITORY_RULES_REVISION, US_STATE_CODES } from './territoryClearanceContract';

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

/**
 * A state David added to the territory on top of the built-in map (design section 8). The built-in
 * map in `territoryClearanceContract.ts` stays frozen; an addition is a stored, revisioned record the
 * worker keeps beside the policy. An added state carries the fixed IANA zone the contract records for
 * it and nothing else: no statute text is drafted here, the state shows as unconfirmed in Territory
 * clearance, and nothing dials for it until David confirms its clearance.
 */
export const territoryAddedStateSchema = z.strictObject({
  state: territoryStateSchema,
  timezone: territoryTimeZoneSchema,
  addedAt: instant,
  /** The owner command that added the state, so a replayed add is recognized instead of recorded twice. */
  commandId: z.uuid(),
});
export type TerritoryAddedState = z.infer<typeof territoryAddedStateSchema>;
/** The one stored addition record of a workspace. `revision` increases on every accepted addition. */
export const territoryAddedStatesSchema = z.strictObject({
  version: z.literal(1),
  workspaceId: id,
  revision: revision.min(1),
  rulesRevision: z.literal(TERRITORY_RULES_REVISION),
  states: z.array(territoryAddedStateSchema).max(US_STATE_CODES.length)
    .refine(states => new Set(states.map(entry => entry.state)).size === states.length, 'One row per added state.'),
  updatedAt: instant,
});
export type TerritoryAddedStates = z.infer<typeof territoryAddedStatesSchema>;
/** What the desktop tells David to do himself after adding a state: the Places regions stay his operator decision. */
export const TERRITORY_ADD_STATE_NEXT_STEP = 'Add the state\'s regions in Cloud research and press Replace configuration. Adding a state changes no Places region on its own.';
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
  /** Add one state to the territory. CAS on the addition record's own revision, not the policy's. Grants nothing and dials nothing. */
  z.strictObject({ kind: z.literal('policy.add-state'), expectedAddedRevision: revision, state: territoryStateSchema, rulesRevision: z.literal(TERRITORY_RULES_REVISION) }),
]);
export type TerritoryCallPolicyCommandPayload = z.infer<typeof territoryCallPolicyCommandPayloadSchema>;
/** The worker's answer to a territory policy command: the command's receipt plus the policy as it stands afterwards. */
export const territoryCallPolicyReceiptSchema = z.strictObject({ receipt: commandReceiptSchema, policy: territoryCallPolicySchema.nullable(),
  /** The addition record as it stands after the command. Absent on a worker predating "Add a state". */
  added: territoryAddedStatesSchema.nullable().optional() });
export type TerritoryCallPolicyReceipt = z.infer<typeof territoryCallPolicyReceiptSchema>;
/** Renderer to main. The renderer names the command identity so a retry resends the same command; main supplies the definition. */
export const territoryCallPolicyRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('read') }),
  z.strictObject({ kind: z.literal('approve'), commandId: z.uuid(), expectedRevision: revision }),
  z.strictObject({ kind: z.literal('set-state'), commandId: z.uuid(), expectedRevision: revision.min(1), state: z.enum(['active', 'paused']) }),
]);
export type TerritoryCallPolicyRequest = z.infer<typeof territoryCallPolicyRequestSchema>;
/**
 * Renderer to main for "Add a state" (design section 8). Deliberately a schema of its own rather than a
 * fourth member of the request union above: the main-process bridge maps that union positionally, so a
 * new member would be routed to `policy.set-state` until the bridge names this kind. Until then Settings
 * validates the state against the fixed maps and reports the addition as held, which is why nothing can
 * reach the worker by accident. The worker side (`policy.add-state`) is complete.
 */
export const territoryAddStateRequestSchema = z.strictObject({ kind: z.literal('add-state'), commandId: z.uuid(), expectedAddedRevision: revision, state: territoryStateSchema });
export type TerritoryAddStateRequest = z.infer<typeof territoryAddStateRequestSchema>;
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
/** The first step of a derived version, derivable from the version id alone so a count never has to read the version. */
export const territoryFirstStepId = (versionId: string): string => stepId(versionId, 0);
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

/**
 * D13 sequence v1: how an applied call outcome moves the firm through its derived sequence.
 * Pure. It decides only the enrollment's next step, state and timing; it never dials, sends,
 * books, suppresses or retires a route, and it never reads or writes anything.
 *
 * Business days are counted on the UTC date. The firm's own zone decides which morning Today
 * lists the firm, not which day the worker computes; a callback David promised overrides this
 * timing entirely, because the callback lane leads the morning list on its own day.
 */
export const TERRITORY_INTERESTED_BUSINESS_DAYS = 5;
export const TERRITORY_GATEKEEPER_BUSINESS_DAYS = 2;
export const TERRITORY_NOT_INTERESTED_REST_DAYS = 180;
export const TERRITORY_SEQUENCE_COMPLETE_REST_DAYS = 90;
/** D13 re-entry: a firm runs the sequence at most twice. The second completed run rests this long and never re-enters. */
export const TERRITORY_FINAL_REST_DAYS = 180;
/** How many runs of the sequence one firm may receive. The worker's enrollment record counts them. */
export const TERRITORY_MAX_ENTRIES = 2;
export const territoryEntriesSchema = z.union([z.literal(1), z.literal(2)]);
export type TerritoryEntries = z.infer<typeof territoryEntriesSchema>;
export type TerritorySequenceAdvance = Readonly<{
  currentStepId: string | null;
  state: 'active' | 'paused' | 'stopped';
  nextDueAt: string | null;
  restingUntil: string | null;
  /** Email steps skipped on the way to the next call step; each one is held, never drafted or sent. */
  heldStepIds: readonly string[];
  reason: 'continue' | 'interested' | 'gatekeeper' | 'rest_not_interested' | 'rest_wrong_number' | 'rest_sequence_complete' | 'rest_final' | 'opt_out';
}>;
const TERRITORY_DAY_MS = 86400000;
const businessDaysFrom = (instant: string, days: number): string => {
  const parsed = Date.parse(instant);
  if (!Number.isFinite(parsed)) throw new Error('territory_sequence_instant');
  const date = new Date(parsed);
  const weekend = () => date.getUTCDay() === 0 || date.getUTCDay() === 6;
  for (let remaining = days; remaining > 0;) { date.setUTCDate(date.getUTCDate() + 1); if (!weekend()) remaining -= 1; }
  while (weekend()) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString();
};
const calendarDaysFrom = (instant: string, days: number): string => {
  const parsed = Date.parse(instant);
  if (!Number.isFinite(parsed)) throw new Error('territory_sequence_instant');
  return new Date(parsed + days * TERRITORY_DAY_MS).toISOString();
};
export function advanceTerritorySequence(input: {
  version: Pick<CampaignVersion, 'steps'>;
  enrollment: { currentStepId: string | null; startedAt: string };
  outcome: string;
  observedAt: string;
  /** Which run of the sequence this is. Absent means the first run, which is what every enrollment written before D13's counter carries. */
  entries?: TerritoryEntries;
}): TerritorySequenceAdvance {
  const steps = input.version.steps;
  const index = steps.findIndex(step => step.id === input.enrollment.currentStepId);
  if (index < 0) throw new Error('territory_sequence_step_unknown');
  const rest = (days: number, reason: TerritorySequenceAdvance['reason']): TerritorySequenceAdvance =>
    ({ currentStepId: input.enrollment.currentStepId, state: 'paused', nextDueAt: null, restingUntil: calendarDaysFrom(input.observedAt, days), heldStepIds: [], reason });
  if (input.outcome === 'opt_out') return { currentStepId: null, state: 'stopped', nextDueAt: null, restingUntil: null, heldStepIds: [], reason: 'opt_out' };
  if (input.outcome === 'not_interested') return rest(TERRITORY_NOT_INTERESTED_REST_DAYS, 'rest_not_interested');
  // The route the worker dialed is not a route this sequence may reuse. Selecting another published
  // phone is the account repository's decision, not this function's; with no other route the firm rests.
  if (input.outcome === 'wrong_number') return rest(TERRITORY_NOT_INTERESTED_REST_DAYS, 'rest_wrong_number');
  if (input.outcome === 'interested') return { currentStepId: input.enrollment.currentStepId, state: 'active',
    nextDueAt: businessDaysFrom(input.observedAt, TERRITORY_INTERESTED_BUSINESS_DAYS), restingUntil: null, heldStepIds: [], reason: 'interested' };
  if (input.outcome === 'gatekeeper') return { currentStepId: input.enrollment.currentStepId, state: 'active',
    nextDueAt: businessDaysFrom(input.observedAt, TERRITORY_GATEKEEPER_BUSINESS_DAYS), restingUntil: null, heldStepIds: [], reason: 'gatekeeper' };
  // connected, voicemail, no_answer and busy all continue: the next call step of the cadence.
  // Email steps on the way are held with `mailbox_not_connected` (Batch 9 drafts them), never drafted or sent here.
  const held: string[] = [];
  for (let next = index + 1; next < steps.length; next++) {
    const step = steps[next]!;
    if (step.channel !== 'call') { held.push(step.id); continue; }
    return { currentStepId: step.id, state: 'active', nextDueAt: new Date(Date.parse(input.enrollment.startedAt) + step.delayHours * 3600000).toISOString(),
      restingUntil: null, heldStepIds: held, reason: 'continue' };
  }
  // The first completed run rests 90 days and may re-enter once; the second rests 180 days and never re-enters.
  const final = (input.entries ?? 1) >= TERRITORY_MAX_ENTRIES;
  return { ...rest(final ? TERRITORY_FINAL_REST_DAYS : TERRITORY_SEQUENCE_COMPLETE_REST_DAYS, final ? 'rest_final' : 'rest_sequence_complete'), currentStepId: null, heldStepIds: held };
}

/**
 * D13 single re-entry. Whether a rested firm may start the sequence again, given the worker's own
 * entry counter. Pure: it decides only the restart, never dials, sends, enrolls or writes anything.
 * `resting` and `final_rest` are honest holds David can read, not silent skips.
 */
export type TerritoryReentryDecision =
  | { kind: 'reenter'; entries: 2; currentStepId: string; startedAt: string }
  | { kind: 'resting'; until: string }
  | { kind: 'final_rest'; until: string }
  | { kind: 'not_resting' };
export function decideTerritoryReentry(input: {
  /** The first step of the firm's derived version, which `territoryFirstStepId` derives from the version id alone. */
  firstStepId: string;
  enrollment: { state: string; restingUntil?: string | null };
  entries?: TerritoryEntries;
  now: string;
}): TerritoryReentryDecision {
  const until = input.enrollment.restingUntil ?? null;
  if (input.enrollment.state !== 'paused' || until === null) return { kind: 'not_resting' };
  if (until > input.now) return { kind: 'resting', until };
  if ((input.entries ?? 1) >= TERRITORY_MAX_ENTRIES) return { kind: 'final_rest', until };
  if (input.firstStepId.length < 1) throw new Error('territory_sequence_step_unknown');
  // Day offsets are calendar days from `startedAt`, so a re-entry re-bases the whole cadence on today.
  return { kind: 'reenter', entries: 2, currentStepId: input.firstStepId, startedAt: input.now };
}

/**
 * D13 wrong number. The verifications a replacement business phone may carry: a number the firm
 * publishes on its own page, or the one its directory listing carries. Never an unverified number.
 */
export const TERRITORY_REPLACEMENT_VERIFICATIONS = ['published', 'listed'] as const;
export type TerritoryRouteCandidate = Readonly<{ id: string; channel: string; purpose: string; verification: string; version: number }>;
/**
 * Pure. The next business phone the firm itself publishes, after the dialed route was retired for a
 * wrong number. A retired route is never selected again and never deleted. Deterministic: the highest
 * stored version of each route id, a number from the firm's own page before a directory listing, then
 * route id order, so a replayed outcome selects exactly the same route. Selecting is not dialing.
 */
export function selectTerritoryReplacementRoute(input: { routes: readonly TerritoryRouteCandidate[]; retiredRouteIds: readonly string[] }): TerritoryRouteCandidate | null {
  const retired = new Set(input.retiredRouteIds);
  const newest = new Map<string, TerritoryRouteCandidate>();
  for (const route of input.routes) {
    if (route.channel !== 'phone' || route.purpose !== 'business' || retired.has(route.id)) continue;
    if (!(TERRITORY_REPLACEMENT_VERIFICATIONS as readonly string[]).includes(route.verification)) continue;
    const held = newest.get(route.id);
    if (!held || held.version < route.version) newest.set(route.id, route);
  }
  const rank = (route: TerritoryRouteCandidate) => route.verification === 'published' ? 0 : 1;
  return [...newest.values()].sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0] ?? null;
}

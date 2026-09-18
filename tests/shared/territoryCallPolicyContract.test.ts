import { describe, expect, it } from 'vitest';
import { DEFAULT_TERRITORY_CALL_POLICY_DEFINITION as DEFAULT, TERRITORY_CALL_POLICY_SUBJECT, deriveTerritoryCampaignVersion, describeTerritoryPolicyVersion,
  territoryCallPolicyDefinitionSchema, territoryCallPolicyId, territoryCallPolicySchema, territoryEnrollmentCommandId, territoryHeldSteps, territoryMailScopeCommandId } from '../../src/shared/contracts/territoryCallPolicyContract';
import { createCallCampaignDraft, describeCampaignTemplate } from '../../src/shared/contracts/callCampaignDraft';
import { ownerCommandSchema, territoryPolicyCommandSchema } from '../../src/shared/contracts/ownerCommandContract';
import { publicDelegationCommandSchema, workerEventSchema } from '../../src/shared/contracts/delegationContract';
import { sha256Utf8 } from '../../src/shared/crypto/sha256';

const now = '2026-09-18T12:00:00.000Z';
const policy = territoryCallPolicySchema.parse({ ...DEFAULT, policyId: territoryCallPolicyId('ws'), workspaceId: 'ws', pairingId: 'pair', revision: 2, state: 'active', approvedAt: now, approvedRevision: 1, updatedAt: now });
const parses = (definition: unknown) => territoryCallPolicyDefinitionSchema.safeParse(definition).success;

describe('territory call policy contract', () => {
  it('fixes the 17 Sep sequence and caps and refuses sequences that break them', () => {
    expect(DEFAULT.sequence.map(step => [step.dayOffset, step.channel, step.templateKey ?? null])).toEqual([[0, 'call', null], [3, 'call', null], [7, 'email', 'T4'], [12, 'call', null], [21, 'email', 'T5']]);
    expect(DEFAULT.caps).toEqual({ callsPerFirm: 3, emailsPerFirm: 3, newFirmsPerDay: 30 });
    expect(DEFAULT).toMatchObject({ audience: { kind: 'places_discovery' }, objective: 'meeting' });
    expect(parses(DEFAULT)).toBe(true);
    expect(parses({ ...DEFAULT, sequence: [{ dayOffset: 1, channel: 'call' }] })).toBe(false);
    expect(parses({ ...DEFAULT, sequence: [{ dayOffset: 0, channel: 'email', templateKey: 'T2' }] })).toBe(false);
    expect(parses({ ...DEFAULT, sequence: [0, 0, 0, 0].map(dayOffset => ({ dayOffset, channel: 'call' })) })).toBe(false);
    expect(parses({ ...DEFAULT, sequence: [{ dayOffset: 0, channel: 'call' }, { dayOffset: 5, channel: 'call' }, { dayOffset: 3, channel: 'call' }] })).toBe(false);
    expect(parses({ ...DEFAULT, sequence: [{ dayOffset: 0, channel: 'call' }, { dayOffset: 7, channel: 'email' }] })).toBe(false);
    expect(parses({ ...DEFAULT, objective: 'pilot' })).toBe(false);
    expect(parses({ ...DEFAULT, caps: { ...DEFAULT.caps, newFirmsPerDay: 0 } })).toBe(false);
  });
  it('binds the policy identity to the workspace and the approval revision to the revision', () => {
    expect(territoryCallPolicySchema.safeParse({ ...policy, policyId: 'territory-policy-other' }).success).toBe(false);
    expect(territoryCallPolicySchema.safeParse({ ...policy, approvedRevision: 3 }).success).toBe(false);
    expect(territoryCallPolicySchema.safeParse({ ...policy, state: 'paused' }).success).toBe(true);
    expect(territoryCallPolicyId('ws')).toBe(`territory-policy-${sha256Utf8(JSON.stringify({ kind: 'territory_call_policy', version: 1, workspaceId: 'ws' }))}`);
  });
  it('derives one single-firm version from (policyId, revision, accountId) and recognizes it read-only beside the manual template', () => {
    const version = deriveTerritoryCampaignVersion(policy, 'account-1');
    expect(version).toMatchObject({ version: 1, cohortAccountIds: ['account-1'], approvedAt: null, objective: 'meeting', capScope: 'campaign_version_lifetime',
      channelCaps: { call: 3, email: 3, linkedin: 0 }, offer: DEFAULT.offer, campaignId: `territory:${policy.policyId}:2:account-1` });
    expect(version.audienceHash).toBe(sha256Utf8(JSON.stringify({ kind: 'territory_policy_audience', policyId: policy.policyId, revision: 2, accountId: 'account-1' })));
    expect(version.steps.map(step => [step.channel, step.condition, step.delayHours])).toEqual([['call', 'initial', 0], ['call', 'no_reply', 72], ['email', 'no_reply', 168], ['call', 'no_reply', 288], ['email', 'no_reply', 504]]);
    expect(deriveTerritoryCampaignVersion(policy, 'account-1')).toEqual(version);
    expect(deriveTerritoryCampaignVersion({ ...policy, revision: 3 }, 'account-1').id).not.toBe(version.id);
    expect(deriveTerritoryCampaignVersion(policy, 'account-2').id).not.toBe(version.id);
    expect(territoryEnrollmentCommandId(policy, 'account-1')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(territoryEnrollmentCommandId(policy, 'account-1')).toBe(territoryEnrollmentCommandId(policy, 'account-1'));
    // Without the policy's own sequence the steps carry no template, which is what every record written before
    // lane 41 carries; with it each email step names the template the policy froze on it at enrollment.
    expect(territoryHeldSteps(version)).toEqual([{ stepId: version.steps[2]!.id, channel: 'email', reason: 'mailbox_not_connected' }, { stepId: version.steps[4]!.id, channel: 'email', reason: 'mailbox_not_connected' }]);
    expect(territoryHeldSteps(version, policy.sequence)).toEqual([
      { stepId: version.steps[2]!.id, channel: 'email', reason: 'mailbox_not_connected', templateId: 'T4' },
      { stepId: version.steps[4]!.id, channel: 'email', reason: 'mailbox_not_connected', templateId: 'T5' }]);
    // A sequence whose entries no longer line up with the version's steps names no template for a step it does
    // not describe, rather than lending it the template of whatever now stands at that position.
    expect(territoryHeldSteps(version, [{ channel: 'call' }, { channel: 'call' }, { channel: 'call' }, { channel: 'call' }, { channel: 'call' }]))
      .toEqual([{ stepId: version.steps[2]!.id, channel: 'email', reason: 'mailbox_not_connected' }, { stepId: version.steps[4]!.id, channel: 'email', reason: 'mailbox_not_connected' }]);
    expect(territoryMailScopeCommandId('account-1', 'mailbox')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(territoryMailScopeCommandId('account-1', 'mailbox')).toBe(territoryMailScopeCommandId('account-1', 'mailbox'));
    expect(territoryMailScopeCommandId('account-2', 'mailbox')).not.toBe(territoryMailScopeCommandId('account-1', 'mailbox'));
    expect(territoryMailScopeCommandId('account-1', 'other')).not.toBe(territoryMailScopeCommandId('account-1', 'mailbox'));
    expect(territoryMailScopeCommandId('account-1', 'mailbox')).not.toBe(territoryEnrollmentCommandId(policy, 'account-1'));
    const description = describeTerritoryPolicyVersion({ ...version, approvedAt: now });
    expect(description).toEqual({ accountId: 'account-1', policyId: policy.policyId, revision: 2, audienceDescription: expect.stringContaining('Places discovery'), policyDescription: 'Territory policy v2' });
    expect(describeCampaignTemplate(version)).toEqual({ kind: 'territory_policy', ...description });
    for (const change of [{ audienceHash: 'a'.repeat(64) }, { cohortAccountIds: ['other'] }, { version: 2 }, { id: 'other' }, { channelCaps: { call: 3, email: 3, linkedin: 1 } },
      { steps: version.steps.map((step, index) => index === 1 ? { ...step, delayHours: 1 } : step) }, { steps: version.steps.map((step, index) => index === 0 ? step : { ...step, condition: 'requested_info' as const }) },
      { steps: version.steps.map((step, index) => index === 1 ? { ...step, id: 'other' } : step) }]) {
      expect(describeTerritoryPolicyVersion({ ...version, ...change })).toBeNull();
    }
    const manual = createCallCampaignDraft({ campaignId: 'campaign-1', versionId: 'version-1', stepId: 'step-1', accountId: 'account-1', offer: 'Discuss a meeting' });
    expect(describeTerritoryPolicyVersion(manual)).toBeNull();
    expect(describeCampaignTemplate(manual)).toMatchObject({ kind: 'one_company', channel: 'call', accountId: 'account-1' });
  });
  it('names the fixed policy subject with no authority CAS and never travels the public account outbox', () => {
    const command = { commandId: '11111111-1111-4111-8111-111111111111', workspaceId: 'ws', accountId: TERRITORY_CALL_POLICY_SUBJECT, expectedAuthorityGeneration: 0, expectedVersion: 0,
      kind: 'territory-policy', payload: { kind: 'policy.approve', expectedRevision: 0, definition: DEFAULT } };
    expect(territoryPolicyCommandSchema.safeParse(command).success).toBe(true);
    expect(ownerCommandSchema.safeParse(command).success).toBe(true);
    expect(publicDelegationCommandSchema.safeParse(command).success).toBe(false);
    expect(territoryPolicyCommandSchema.safeParse({ ...command, accountId: 'account-1' }).success).toBe(false);
    expect(territoryPolicyCommandSchema.safeParse({ ...command, expectedVersion: 1 }).success).toBe(false);
    expect(territoryPolicyCommandSchema.safeParse({ ...command, payload: { kind: 'policy.set-state', expectedRevision: 0, state: 'paused' } }).success).toBe(false);
    expect(territoryPolicyCommandSchema.safeParse({ ...command, payload: { kind: 'policy.set-state', expectedRevision: 1, state: 'paused' } }).success).toBe(true);
    expect(territoryPolicyCommandSchema.safeParse({ ...command, payload: { kind: 'policy.read' } }).success).toBe(true);
    expect(territoryPolicyCommandSchema.safeParse({ ...command, payload: { ...command.payload, grant: true } }).success).toBe(false);
  });
  it('authority.granted carries worker/active generation 1 with the approved derived version and its active enrollment', () => {
    const version = { ...deriveTerritoryCampaignVersion(policy, 'account-1'), approvedAt: now };
    const commandId = territoryEnrollmentCommandId(policy, 'account-1');
    const enrollment = { id: 'enrollment', accountId: 'account-1', selectedRouteId: 'route', selectedRouteVersion: 1, personId: null as null, campaignVersionId: version.id, currentStepId: version.steps[0]!.id,
      version: 1, state: 'active', executionContextId: 'context', contextRevision: 1, startedAt: now };
    const receipt = { commandId, status: 'applied', authorityGeneration: 1, aggregateVersion: 1, reason: null as null };
    const event = { id: 'grant', workspaceId: 'ws', accountId: 'account-1', authorityGeneration: 1, aggregateVersion: 1, kind: 'authority.granted',
      payload: { authority: { accountId: 'account-1', owner: 'worker', generation: 1, state: 'active' }, policyId: policy.policyId, revision: 2, receipt }, campaign: { commandId, version, enrollment, evidence: null as null } };
    expect(workerEventSchema.safeParse(event).success).toBe(true);
    for (const broken of [
      { payload: { ...event.payload, authority: { ...event.payload.authority, owner: 'local', state: 'local' } } },
      { payload: { ...event.payload, authority: { ...event.payload.authority, state: 'paused' } } },
      { authorityGeneration: 0, payload: { ...event.payload, authority: { ...event.payload.authority, generation: 0 }, receipt: { ...receipt, authorityGeneration: 0 } } },
      { campaign: { ...event.campaign, version: { ...version, approvedAt: null } } },
      { campaign: { ...event.campaign, enrollment: null } },
      { campaign: { ...event.campaign, enrollment: { ...enrollment, state: 'held' } } },
      { campaign: { ...event.campaign, commandId: '22222222-2222-4222-8222-222222222222' } },
      { payload: { ...event.payload, receipt: { ...receipt, status: 'rejected', reason: 'held' } } },
      { accountId: 'other' },
      { campaign: undefined },
    ]) expect(workerEventSchema.safeParse({ ...event, ...broken }).success).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { WorkerCampaignRepository, campaignVersionKey, campaignEnrollmentKey, campaignSlotKey } from '../src/workerCampaignRepository';
import { CampaignExecution } from '../src/campaignExecution';
import { DynamoStore, fingerprint } from '../src/dynamoStore';
import { ConditionalCommandHarness } from './sdkHarness';
import type { CampaignVersion, CampaignCommandPayload } from '../../../../src/shared/contracts/campaignContract';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = '2026-09-09T12:00:00.000Z';
async function fixture(multichannel = false, firstChannel: 'call' | 'linkedin' = 'call', stepCount = 0) {
  const dynamo = new ConditionalCommandHarness(); let time = now;
  const options = { dynamo, tableName: 'fictional-campaigns', workspaceId: id(1), clock: { now: () => time } };
  const store = new DynamoStore(options); const repo = new WorkerCampaignRepository(options); let command = 100;
  const version: CampaignVersion = { id: id(2), campaignId: id(3), version: 1, audienceHash: 'a'.repeat(64), offer: 'Fictional offer', objective: 'meeting', cohortAccountIds: [id(4)], approvedAt: null, steps: [{ id: id(5), channel: 'call', condition: 'initial', delayHours: 0 }], capScope: 'campaign_version_lifetime', channelCaps: { call: 2, email: 1, linkedin: 1 }, contentPolicyHash: 'b'.repeat(64) };
  version.steps[0]!.channel = firstChannel;
  if (multichannel) version.steps.push({ id: id(50), channel: 'linkedin', condition: 'no_reply', delayHours: 0 });
  while (version.steps.length < stepCount) version.steps.push({ id: id(200 + version.steps.length), channel: 'linkedin', condition: 'no_reply', delayHours: 0 });
  const account = { id: id(4), name: 'Fictional PM', domain: 'example.invalid', version: 1 };
  const routes = [{ id: id(6), accountId: id(4), personId: null, channel: 'phone', value: '+12025550101', purpose: 'business', evidenceIds: [id(7)], verification: 'published', version: 1 }];
  if (firstChannel === 'linkedin') { routes[0]!.channel = 'linkedin'; routes[0]!.value = 'https://www.linkedin.com/in/fictional-person'; }
  if (multichannel) routes.push({ ...routes[0]!, id: id(51), channel: 'linkedin', value: 'https://www.linkedin.com/in/fictional-person' });
  await store.transact([store.put(`ACCOUNT#${id(4)}`, { account, routes, claims: [], sources: [], researchRevision: 1, history: [{ at: now, account, routes, claims: [] }] }, null)]);
  async function apply(payload: CampaignCommandPayload) {
    const plan = await repo.planCommand({ commandId: id(command++), accountId: id(4), payload });
    await store.transact(plan.items); return plan.payload;
  }
  await apply({ kind: 'campaign.version', version });
  await apply({ kind: 'campaign.approve', campaignVersionId: version.id, snapshotHash: fingerprint(version), approvedAt: now });
  return { store, repo, dynamo, options, version, apply, advance: (value: string) => { time = value; } };
}

describe('real SDK campaign transactional plans', () => {
  async function connected(multichannel = true, stepCount = 0) {
    const f = await fixture(multichannel, 'call', stepCount);
    await f.apply({ kind: 'campaign.enroll', enrollmentId: id(8), campaignVersionId: id(2), selectedRouteId: id(6), executionContextId: 'call-context', contextRevision: 1 });
    const binding = { workspaceId: id(1), accountId: id(4), campaignId: id(3), campaignRevision: 1, enrollmentId: id(8), enrollmentRevision: 1, stepId: id(5), actionId: id(10), channel: 'call' as const, authorityGeneration: 1, selectedRouteId: id(6), contextRevision: 'call-context', contentHash: 'c'.repeat(64), targetHash: 'd'.repeat(64) };
    await f.store.transact((await new CampaignExecution(f.repo).prepareManualChecks(binding)).finalize());
    const result = await f.apply({ kind: 'campaign.outcome', enrollmentId: id(8), expectedEnrollmentVersion: 1, evidence: { enrollmentId: id(8), accountId: id(4), campaignVersionId: id(2), stepId: id(5), routeId: id(6), routeVersion: 1, executionContextId: 'call-context', contextRevision: 1, observedAt: now, observation: 'unknown', source: 'human', actionId: id(10), channel: 'call', state: 'human_reported_sent', outcome: 'connected' } });
    return { ...f, binding, outcomeCommandId: result.commandId };
  }
  it('preparation checks preserve active origin and do not authorize final reservation', async () => {
    const f = await connected();
    const input = { accountId: id(4), originalActionId: id(10), originalOutcomeCommandId: f.outcomeCommandId };
    const before = f.dynamo.inspect(campaignEnrollmentKey(id(8)));
    const plan = await f.repo.requestedFollowupPreparationChecks(input);
    expect(plan.items.every(item => item.ConditionCheck)).toBe(true);
    expect(plan.origin).toMatchObject({ actionId: id(10), originalOutcomeCommandId: f.outcomeCommandId });
    await f.store.transact([...plan.items, f.store.put('FICTIONAL_DRAFT#one', { originalCall: input }, null)]);
    expect(f.dynamo.inspect(campaignEnrollmentKey(id(8)))).toEqual(before);
    expect(f.dynamo.inspect(`CAMPAIGN_CAP#${id(2)}#call`)).toEqual({ reserved: 0, sent: 1 });
    await expect(f.repo.requestedFollowupChecks(input)).rejects.toThrow('campaign_requested_followup_held');
  });
  it.each([true, false])('preparation blocks late not_called and stale draft CAS for active=%s', async active => {
    const f = await connected(active);
    const input = { accountId: id(4), originalActionId: id(10), originalOutcomeCommandId: f.outcomeCommandId };
    const plan = await f.repo.requestedFollowupPreparationChecks(input);
    const reservationBefore = await f.store.get(`CAMPAIGN_RESERVATION#${id(4)}#${id(10)}`);
    const original = (await f.repo.evidence(id(8)))[0]!;
    const fact = await f.apply({ kind: 'campaign.outcome', enrollmentId: id(8), expectedEnrollmentVersion: 2, evidence: { ...original, state: 'cancelled', outcome: 'not_called' } });
    expect(fact.evidence?.conflict).toBe('contradictory_finalized_outcome');
    expect(await f.store.get(`CAMPAIGN_RESERVATION#${id(4)}#${id(10)}`)).toEqual(reservationBefore);
    expect((await f.repo.evidence(id(8))).some(e => e.outcome === 'connected' && !e.conflict)).toBe(true);
    await expect(f.store.transact([...plan.items, f.store.put('FICTIONAL_DRAFT#race', { originalCall: input }, null)])).rejects.toThrow('TransactionCanceledException');
    expect(f.dynamo.inspect('FICTIONAL_DRAFT#race')).toBeUndefined();
    await expect(f.repo.requestedFollowupPreparationChecks(input)).rejects.toThrow('campaign_requested_followup_held');
  });
  it.each([true, false])('plans requested correspondence for multichannel=%s without consuming campaign capacity', async multichannel => {
    const f = await connected(multichannel);
    const plan = await f.repo.prepareRequestedFollowupPlan({ commandId: id(900), accountId: id(4), originalActionId: id(10), originalOutcomeCommandId: f.outcomeCommandId });
    expect(plan.origin).toMatchObject({ accountId: id(4), campaignVersionId: id(2), enrollmentId: id(8), actionId: id(10), originalOutcomeCommandId: f.outcomeCommandId, executionContextId: 'call-context' });
    expect(plan.items.some(item => item.Put?.Item?.sk?.S?.startsWith('CAMPAIGN_CAP#'))).toBe(false);
    const targets = plan.items.map(item => JSON.stringify(item.ConditionCheck?.Key ?? { pk: item.Put!.Item!.pk, sk: item.Put!.Item!.sk }));
    expect(new Set(targets).size).toBe(plan.items.length);
    if (!multichannel) expect(plan.items.every(item => item.ConditionCheck)).toBe(true);
    await f.store.transact(plan.items);
    expect(f.dynamo.inspect(campaignEnrollmentKey(id(8)))).toMatchObject({ state: multichannel ? 'conversation' : 'completed', currentStepId: multichannel ? id(50) : null });
    expect(f.dynamo.inspect(`CAMPAIGN_CAP#${id(2)}#call`)).toEqual({ reserved: 0, sent: 1 });
    const final = await f.repo.requestedFollowupChecks({ accountId: id(4), originalActionId: id(10), originalOutcomeCommandId: f.outcomeCommandId });
    expect(final.items.every(item => item.ConditionCheck)).toBe(true);
    await f.store.transact(final.items);
    expect(final.origin).toEqual(plan.origin);
  });
  it('does not bypass a newer active campaign on a completed original account', async () => {
    const f = await connected(false);
    const input = { accountId: id(4), originalActionId: id(10), originalOutcomeCommandId: f.outcomeCommandId };
    const final = await f.repo.requestedFollowupChecks(input);
    await f.apply({ kind: 'campaign.enroll', enrollmentId: id(9), campaignVersionId: id(2), selectedRouteId: id(6), executionContextId: 'new-campaign-context', contextRevision: 2 });
    await expect(f.store.transact(final.items)).rejects.toThrow('TransactionCanceledException');
    await expect(f.repo.requestedFollowupChecks(input)).rejects.toThrow('campaign_requested_followup_held');
    expect(f.dynamo.inspect(campaignEnrollmentKey(id(8)))).toMatchObject({ state: 'completed' });
  });
  it('fails closed when bounded campaign fences exceed Dynamo transaction capacity', async () => {
    const f = await connected(true, 100);
    await expect(f.repo.prepareRequestedFollowupPlan({ commandId: id(900), accountId: id(4), originalActionId: id(10), originalOutcomeCommandId: f.outcomeCommandId })).rejects.toThrow('transaction_capacity_exceeded');
    expect(f.dynamo.inspect(campaignEnrollmentKey(id(8)))).toMatchObject({ state: 'active' });
  });
  it.each(['conflict', 'opt_out'] as const)('refuses completed original call with later %s evidence', async kind => {
    const f = await connected(false); const evidence = (await f.repo.evidence(id(8)))[0]!;
    const input = { accountId: id(4), originalActionId: id(10), originalOutcomeCommandId: f.outcomeCommandId };
    const final = await f.repo.requestedFollowupChecks(input);
    await f.apply({ kind: 'campaign.outcome', enrollmentId: id(8), expectedEnrollmentVersion: 2, evidence: kind === 'conflict'
      ? { ...evidence, state: 'cancelled', outcome: 'not_called' }
      : { ...evidence, outcome: 'opt_out', observation: 'replied' } });
    await expect(f.store.transact(final.items)).rejects.toThrow('TransactionCanceledException');
    await expect(f.repo.requestedFollowupChecks(input)).rejects.toThrow('campaign_requested_followup_held');
    expect(f.dynamo.inspect(`CAMPAIGN_CAP#${id(2)}#call`)).toEqual({ reserved: 0, sent: 1 });
  });
  it('refuses an alternate outcome command instead of choosing current connected history', async () => {
    const f = await connected(); const evidence = (await f.repo.evidence(id(8)))[0]!;
    const later = await f.apply({ kind: 'campaign.outcome', enrollmentId: id(8), expectedEnrollmentVersion: 2, evidence: { ...evidence, outcome: 'no_reply', observation: 'no_reply' } });
    await expect(f.repo.prepareRequestedFollowupPlan({ commandId: id(900), accountId: id(4), originalActionId: id(10), originalOutcomeCommandId: later.commandId })).rejects.toThrow('campaign_requested_followup_origin');
    await expect(f.repo.prepareRequestedFollowupPlan({ commandId: id(900), accountId: id(4), originalActionId: id(10), originalOutcomeCommandId: id(991) })).rejects.toThrow('campaign_record_missing');
  });
  it('refuses foreign original receipt, paused/held/stopped origin and active final reserve', async () => {
    const f = await connected();
    await expect(f.repo.prepareRequestedFollowupPlan({ commandId: id(900), accountId: id(90), originalActionId: id(10), originalOutcomeCommandId: f.outcomeCommandId })).rejects.toThrow();
    await expect(f.repo.requestedFollowupChecks({ accountId: id(4), originalActionId: id(10), originalOutcomeCommandId: f.outcomeCommandId })).rejects.toThrow('campaign_requested_followup_held');
    for (const [index, state] of (['paused', 'held', 'stopped'] as const).entries()) {
      await f.apply({ kind: 'campaign.state', enrollmentId: id(8), expectedEnrollmentVersion: index + 2, state, reason: 'hold remains' });
      await expect(f.repo.prepareRequestedFollowupPlan({ commandId: id(900), accountId: id(4), originalActionId: id(10), originalOutcomeCommandId: f.outcomeCommandId })).rejects.toThrow('campaign_requested_followup_held');
    }
  });
  it('fences an absent next-step reservation and rejects already unknown next work', async () => {
    const f = await connected();
    await f.apply({ kind: 'campaign.route', enrollmentId: id(8), expectedEnrollmentVersion: 2, selectedRouteId: id(51), executionContextId: 'linkedin-context', contextRevision: 2 });
    // A positive observation is required for this approved next step.
    const original = (await f.repo.evidence(id(8)))[0]!;
    const later = '2026-09-09T12:01:00.000Z'; f.advance(later);
    await f.apply({ kind: 'campaign.outcome', enrollmentId: id(8), expectedEnrollmentVersion: 3, evidence: { ...original, observedAt: later, outcome: 'no_reply', observation: 'no_reply' } });
    const plan = await f.repo.prepareRequestedFollowupPlan({ commandId: id(900), accountId: id(4), originalActionId: id(10), originalOutcomeCommandId: f.outcomeCommandId });
    const next = { ...f.binding, enrollmentRevision: 4, stepId: id(50), actionId: id(11), channel: 'linkedin' as const, selectedRouteId: id(51), contextRevision: 'linkedin-context' };
    await f.store.transact((await new CampaignExecution(f.repo).prepareManualChecks(next)).finalize());
    await expect(f.store.transact(plan.items)).rejects.toThrow('TransactionCanceledException');
    expect(f.dynamo.inspect(campaignEnrollmentKey(id(8)))).toMatchObject({ state: 'active' });
    await expect(f.repo.prepareRequestedFollowupPlan({ commandId: id(900), accountId: id(4), originalActionId: id(10), originalOutcomeCommandId: f.outcomeCommandId })).rejects.toThrow('campaign_requested_followup_unresolved');
    await f.apply({ kind: 'campaign.outcome', enrollmentId: id(8), expectedEnrollmentVersion: 4, evidence: { ...original, stepId: id(50), routeId: id(51), executionContextId: 'linkedin-context', contextRevision: 2, actionId: id(11), channel: 'linkedin', state: 'unknown', outcome: 'unknown' } });
    await expect(f.repo.prepareRequestedFollowupPlan({ commandId: id(900), accountId: id(4), originalActionId: id(10), originalOutcomeCommandId: f.outcomeCommandId })).rejects.toThrow('campaign_requested_followup_unresolved');
    expect(f.dynamo.inspect(`CAMPAIGN_CAP#${id(2)}#linkedin`)).toEqual({ reserved: 1, sent: 0 });
  });
  it('final checks reject a concurrent departure from conversation without mutating it', async () => {
    const f = await connected();
    await f.store.transact((await f.repo.prepareRequestedFollowupPlan({ commandId: id(900), accountId: id(4), originalActionId: id(10), originalOutcomeCommandId: f.outcomeCommandId })).items);
    const final = await f.repo.requestedFollowupChecks({ accountId: id(4), originalActionId: id(10), originalOutcomeCommandId: f.outcomeCommandId });
    await f.apply({ kind: 'campaign.state', enrollmentId: id(8), expectedEnrollmentVersion: 3, state: 'paused', reason: 'owner pause' });
    await f.apply({ kind: 'campaign.state', enrollmentId: id(8), expectedEnrollmentVersion: 4, state: 'active', reason: 'owner resume' });
    await expect(f.store.transact(final.items)).rejects.toThrow('TransactionCanceledException');
    await expect(f.repo.requestedFollowupChecks({ accountId: id(4), originalActionId: id(10), originalOutcomeCommandId: f.outcomeCommandId })).rejects.toThrow('campaign_requested_followup_held');
  });

  it.each(['active', 'paused', 'unknown'] as const)('continues %s call through approved LinkedIn without per-action reapproval', async mode => {
    const f = await fixture(true);
    await f.apply({ kind: 'campaign.enroll', enrollmentId: id(8), campaignVersionId: f.version.id, selectedRouteId: id(6), executionContextId: 'call-context', contextRevision: 1 });
    const execution = new CampaignExecution(f.repo);
    const call = { workspaceId: id(1), accountId: id(4), campaignId: id(3), campaignRevision: 1, enrollmentId: id(8), enrollmentRevision: 1, stepId: id(5), actionId: id(10), channel: 'call' as const, authorityGeneration: 1, selectedRouteId: id(6), contextRevision: 'call-context', contentHash: 'c'.repeat(64), targetHash: 'd'.repeat(64) };
    await f.store.transact((await execution.prepareManualChecks(call)).finalize());
    const evidence = { enrollmentId: id(8), accountId: id(4), campaignVersionId: id(2), stepId: id(5), routeId: id(6), routeVersion: 1, executionContextId: 'call-context', contextRevision: 1, observedAt: now, observation: 'no_reply' as const, source: 'human' as const, actionId: id(10), channel: 'call' as const, state: 'human_reported_sent' as const, outcome: 'no_answer' };
    await expect(f.apply({ kind: 'campaign.outcome', enrollmentId: id(8), expectedEnrollmentVersion: 1, evidence: { ...evidence, enrollmentId: id(90) } })).rejects.toThrow('campaign_evidence_binding');
    await expect(f.apply({ kind: 'campaign.outcome', enrollmentId: id(8), expectedEnrollmentVersion: 1, evidence: { ...evidence, routeId: id(51), executionContextId: 'linkedin-context' } })).rejects.toThrow('campaign_evidence_binding');
    if (mode !== 'active') await f.apply({ kind: 'campaign.state', enrollmentId: id(8), expectedEnrollmentVersion: 1, state: 'paused', reason: 'explicit pause' });
    await f.apply({ kind: 'campaign.outcome', enrollmentId: id(8), expectedEnrollmentVersion: mode === 'active' ? 1 : 2, evidence: mode === 'unknown' ? { ...evidence, state: 'unknown', observation: 'unknown' } : evidence });
    if (mode !== 'active') {
      expect(f.dynamo.inspect(campaignEnrollmentKey(id(8)))).toMatchObject({ currentStepId: id(5), state: 'paused' });
      await expect(execution.prepareManualChecks({ ...call, enrollmentRevision: 3 })).rejects.toThrow('campaign_binding_mismatch');
      const resume = await f.repo.planCommand({ commandId: id(900), accountId: id(4), payload: { kind: 'campaign.state', enrollmentId: id(8), expectedEnrollmentVersion: 3, state: 'active', reason: 'explicit resume' } });
      if (mode === 'paused') {
        expect(resume.items.some(item => item.ConditionCheck?.Key?.sk?.S?.startsWith('CAMPAIGN_EVIDENCE#'))).toBe(true);
        expect(resume.items.some(item => item.ConditionCheck?.Key?.sk?.S?.startsWith('CAMPAIGN_RESERVATION#'))).toBe(true);
      }
      expect(f.dynamo.inspect(campaignEnrollmentKey(id(8)))).toMatchObject({ currentStepId: id(5), state: 'paused' });
      await f.store.transact(resume.items);
    }
    expect(f.dynamo.inspect(campaignEnrollmentKey(id(8)))).toMatchObject({ currentStepId: mode === 'unknown' ? id(5) : id(50), state: 'active' });
    await f.apply({ kind: 'campaign.route', enrollmentId: id(8), expectedEnrollmentVersion: mode === 'active' ? 2 : 4, selectedRouteId: id(51), executionContextId: 'linkedin-context', contextRevision: 2 });
    const linkedin = { ...call, enrollmentRevision: mode === 'active' ? 3 : 5, stepId: id(50), actionId: id(11), channel: 'linkedin' as const, selectedRouteId: id(51), contextRevision: 'linkedin-context' };
    if (mode === 'unknown') {
      await expect(execution.prepareManualChecks(linkedin)).rejects.toThrow('campaign_step_ineligible');
      expect(f.dynamo.inspect(`CAMPAIGN_CAP#${id(2)}#call`)).toEqual({ reserved: 1, sent: 0 });
      return;
    }
    const plan = await execution.prepareManualChecks(linkedin);
    await f.store.transact(plan.finalize());
    expect(await f.repo.evidence(id(8))).toEqual([evidence]);
    expect(f.dynamo.inspect(`CAMPAIGN_CAP#${id(2)}#call`)).toEqual({ reserved: 0, sent: 1 });
    expect(f.dynamo.inspect(`CAMPAIGN_CAP#${id(2)}#linkedin`)).toEqual({ reserved: 1, sent: 0 });
  });
  it.each([
    { initial: 'reserved', channel: 'call', outcome: 'not_called' },
    { initial: 'unknown', channel: 'call', outcome: 'not_called' },
    { initial: 'reserved', channel: 'linkedin', outcome: 'not_sent' },
    { initial: 'unknown', channel: 'linkedin', outcome: 'not_sent' },
  ] as const)('releases $initial $channel capacity on $outcome and remains terminal', async ({ initial, channel, outcome }) => {
    const f = await fixture(false, channel);
    await f.apply({ kind: 'campaign.enroll', enrollmentId: id(8), campaignVersionId: f.version.id, selectedRouteId: id(6), executionContextId: 'context-one', contextRevision: 1 });
    const binding = { workspaceId: id(1), accountId: id(4), campaignId: id(3), campaignRevision: 1, enrollmentId: id(8), enrollmentRevision: 1, stepId: id(5), actionId: id(10), channel, authorityGeneration: 1, selectedRouteId: id(6), contextRevision: 'context-one', contentHash: 'c'.repeat(64), targetHash: 'd'.repeat(64) };
    await f.store.transact((await new CampaignExecution(f.repo).prepareManualChecks(binding)).finalize());
    const evidence = { enrollmentId: id(8), accountId: id(4), campaignVersionId: id(2), stepId: id(5), routeId: id(6), routeVersion: 1, executionContextId: 'context-one', contextRevision: 1, observedAt: now, observation: 'unknown' as const, source: 'human' as const, actionId: id(10), channel, state: 'cancelled' as const, outcome };
    const ambiguous = await f.repo.planCommand({ commandId: id(999), accountId: id(4), payload: { kind: 'campaign.outcome', enrollmentId: id(8), expectedEnrollmentVersion: 1, evidence: { ...evidence, outcome: 'cancelled' } } });
    expect(ambiguous.payload.cap).toMatchObject({ reserved: 1, sent: 0, revision: 2 });
    expect(ambiguous.items.filter(item => item.Put?.Item?.sk?.S?.startsWith('CAMPAIGN_CAP#'))).toHaveLength(0);
    if (initial === 'unknown') await f.apply({ kind: 'campaign.outcome', enrollmentId: id(8), expectedEnrollmentVersion: 1, evidence: { ...evidence, state: 'unknown', outcome: 'unknown' } });
    const result = await f.apply({ kind: 'campaign.outcome', enrollmentId: id(8), expectedEnrollmentVersion: initial === 'unknown' ? 2 : 1, evidence });
    expect(result.cap).toMatchObject({ reserved: 0, sent: 0, revision: 3 });
    expect(f.dynamo.inspect(`CAMPAIGN_RESERVATION#${id(4)}#${id(10)}`)).toMatchObject({ state: 'cancelled' });
    expect(f.dynamo.inspect(campaignEnrollmentKey(id(8)))).toMatchObject({ state: 'active', currentStepId: id(5) });
    for (const state of ['cancelled', 'unknown'] as const) await expect(f.apply({ kind: 'campaign.outcome', enrollmentId: id(8), expectedEnrollmentVersion: initial === 'unknown' ? 3 : 2, evidence: { ...evidence, state } })).rejects.toThrow('campaign_outcome_conflict');
    expect(f.dynamo.inspect(`CAMPAIGN_CAP#${id(2)}#${channel}`)).toEqual({ reserved: 0, sent: 0 });
    const late = await f.apply({ kind: 'campaign.outcome', enrollmentId: id(8), expectedEnrollmentVersion: initial === 'unknown' ? 3 : 2, evidence: { ...evidence, state: 'human_reported_sent', outcome: 'sent' } });
    expect(late.evidence).toMatchObject({ outcome: 'sent', conflict: 'contradictory_finalized_outcome' });
    expect(late.enrollment).toMatchObject({ state: 'held', currentStepId: id(5) });
    expect(late.cap).toMatchObject({ reserved: 0, sent: 0, revision: 3 });
    expect(f.dynamo.inspect(`CAMPAIGN_RESERVATION#${id(4)}#${id(10)}`)).toMatchObject({ state: 'cancelled' });
    expect((await f.repo.evidence(id(8))).some(item => item.outcome === outcome && !item.conflict)).toBe(true);
    await expect(f.apply({ kind: 'campaign.state', enrollmentId: id(8), expectedEnrollmentVersion: late.enrollment!.version, state: 'active', reason: 'cannot erase conflict' })).rejects.toThrow('campaign_conflict_requires_review');

  });
  it('retains sent capacity and appends a held conflict for later explicit not-called', async () => {
    const f = await fixture(true);
    await f.apply({ kind: 'campaign.enroll', enrollmentId: id(8), campaignVersionId: f.version.id, selectedRouteId: id(6), executionContextId: 'context-one', contextRevision: 1 });
    const binding = { workspaceId: id(1), accountId: id(4), campaignId: id(3), campaignRevision: 1, enrollmentId: id(8), enrollmentRevision: 1, stepId: id(5), actionId: id(10), channel: 'call' as const, authorityGeneration: 1, selectedRouteId: id(6), contextRevision: 'context-one', contentHash: 'c'.repeat(64), targetHash: 'd'.repeat(64) };
    await f.store.transact((await new CampaignExecution(f.repo).prepareManualChecks(binding)).finalize());
    const evidence = { enrollmentId: id(8), accountId: id(4), campaignVersionId: id(2), stepId: id(5), routeId: id(6), routeVersion: 1, executionContextId: 'context-one', contextRevision: 1, observedAt: now, observation: 'unknown' as const, source: 'human' as const, actionId: id(10), channel: 'call' as const, state: 'human_reported_sent' as const, outcome: 'called' };
    await f.apply({ kind: 'campaign.outcome', enrollmentId: id(8), expectedEnrollmentVersion: 1, evidence });
    const conflict = await f.apply({ kind: 'campaign.outcome', enrollmentId: id(8), expectedEnrollmentVersion: 2, evidence: { ...evidence, state: 'cancelled', outcome: 'not_called' } });
    expect(conflict.evidence).toMatchObject({ outcome: 'not_called', conflict: 'contradictory_finalized_outcome' });
    expect(conflict.enrollment).toMatchObject({ currentStepId: id(50), state: 'held' });
    expect(conflict.cap).toMatchObject({ revision: 3, reserved: 0, sent: 1 });
    expect(f.dynamo.inspect(`CAMPAIGN_RESERVATION#${id(4)}#${id(10)}`)).toMatchObject({ state: 'sent' });
    expect(await f.repo.evidence(id(8))).toHaveLength(2);
    await expect(f.apply({ kind: 'campaign.state', enrollmentId: id(8), expectedEnrollmentVersion: 3, state: 'active', reason: 'cannot erase conflict' })).rejects.toThrow('campaign_conflict_requires_review');
  });
  it('freezes strategy and refuses approval with edited content', async () => {
    const f = await fixture();
    await expect(f.apply({ kind: 'campaign.version', version: { ...f.version, offer: 'Changed' } })).rejects.toThrow();
    await expect(f.apply({ kind: 'campaign.approve', campaignVersionId: f.version.id, snapshotHash: 'c'.repeat(64), approvedAt: now })).rejects.toThrow();
    expect(f.dynamo.inspect(campaignVersionKey(f.version.id))).toEqual(f.version);
  });
  it('emits account-wide conditional slot claim so concurrent enrollment has one winner', async () => {
    const f = await fixture();
    const payload = { kind: 'campaign.enroll' as const, enrollmentId: id(8), campaignVersionId: f.version.id, selectedRouteId: id(6), executionContextId: 'context-one', contextRevision: 1 };
    const a = await f.repo.planCommand({ commandId: id(1010), accountId: id(4), payload });
    const b = await f.repo.planCommand({ commandId: id(1011), accountId: id(4), payload: { ...payload, enrollmentId: id(9) } });
    await f.store.transact(a.items);
    await expect(f.store.transact(b.items)).rejects.toThrow('TransactionCanceledException');
    expect(f.dynamo.inspect(campaignSlotKey(id(4)))).toMatchObject({ enrollmentId: id(8), state: 'active' });
  });
  it.each(['held', 'paused', 'conversation'] as const)('%s retains account slot and state updates require CAS', async state => {
    const f = await fixture();
    await f.apply({ kind: 'campaign.enroll', enrollmentId: id(8), campaignVersionId: f.version.id, selectedRouteId: id(6), executionContextId: 'context-one', contextRevision: 1 });
    await f.apply({ kind: 'campaign.state', enrollmentId: id(8), expectedEnrollmentVersion: 1, state, reason: 'Fictional interruption' });
    await expect(f.apply({ kind: 'campaign.enroll', enrollmentId: id(9), campaignVersionId: f.version.id, selectedRouteId: id(6), executionContextId: 'context-one', contextRevision: 1 })).rejects.toThrow('account_already_enrolled');
    await expect(f.apply({ kind: 'campaign.state', enrollmentId: id(8), expectedEnrollmentVersion: 1, state: 'active', reason: 'stale' })).rejects.toThrow('stale_enrollment');
  });
  it('unknown outcome holds the step, reply moves into conversation and terminal cannot resume', async () => {
    const f = await fixture();
    await f.apply({ kind: 'campaign.enroll', enrollmentId: id(8), campaignVersionId: f.version.id, selectedRouteId: id(6), executionContextId: 'context-one', contextRevision: 1 });
    const execution = new CampaignExecution(f.repo);
    const binding = { workspaceId: id(1), accountId: id(4), campaignId: id(3), campaignRevision: 1, enrollmentId: id(8), enrollmentRevision: 1, stepId: id(5), actionId: id(10), channel: 'call' as const, authorityGeneration: 1, selectedRouteId: id(6), contextRevision: 'context-one', contentHash: 'c'.repeat(64), targetHash: 'd'.repeat(64) };
    await f.store.transact((await execution.prepareManualChecks(binding)).finalize());
    const evidence = { enrollmentId: id(8), accountId: id(4), campaignVersionId: id(2), stepId: id(5), routeId: id(6), routeVersion: 1, executionContextId: 'context-one', contextRevision: 1, observedAt: now, observation: 'unknown' as const, source: 'human' as const, actionId: id(10), channel: 'call' as const, state: 'unknown' as const, outcome: 'unknown' };
    await f.apply({ kind: 'campaign.outcome', enrollmentId: id(8), expectedEnrollmentVersion: 1, evidence });
    expect(f.dynamo.inspect(campaignEnrollmentKey(id(8)))).toMatchObject({ currentStepId: id(5) });
    await f.apply({ kind: 'campaign.outcome', enrollmentId: id(8), expectedEnrollmentVersion: 2, evidence: { ...evidence, observation: 'replied', outcome: 'reply' } });
    expect(f.dynamo.inspect(campaignEnrollmentKey(id(8)))).toMatchObject({ state: 'conversation' });
    await f.apply({ kind: 'campaign.state', enrollmentId: id(8), expectedEnrollmentVersion: 3, state: 'stopped', reason: 'stop' });
    await expect(f.apply({ kind: 'campaign.state', enrollmentId: id(8), expectedEnrollmentVersion: 4, state: 'active', reason: 'resume' })).rejects.toThrow('terminal_enrollment');
  });
  it.each(['active', 'paused', 'conversation', 'held', 'stopped', 'switched'] as const)('settles actual attempts without advancing %s interruption', async state => {
    const f = await fixture();
    await f.apply({ kind: 'campaign.enroll', enrollmentId: id(8), campaignVersionId: f.version.id, selectedRouteId: id(6), executionContextId: 'context-one', contextRevision: 1 });
    const evidence = { enrollmentId: id(8), accountId: id(4), campaignVersionId: id(2), stepId: id(5), routeId: id(6), routeVersion: 1, executionContextId: 'context-one', contextRevision: 1, observedAt: now, observation: 'unknown' as const, source: 'human' as const, actionId: id(10), channel: 'call' as const, state: 'human_reported_sent' as const, outcome: 'no_answer' };
    await expect(f.apply({ kind: 'campaign.outcome', enrollmentId: id(8), expectedEnrollmentVersion: 1, evidence })).rejects.toThrow('campaign_reservation_missing');
    const execution = new CampaignExecution(f.repo);
    const binding = { workspaceId: id(1), accountId: id(4), campaignId: id(3), campaignRevision: 1, enrollmentId: id(8), enrollmentRevision: 1, stepId: id(5), actionId: id(10), channel: 'call' as const, authorityGeneration: 1, selectedRouteId: id(6), contextRevision: 'context-one', contentHash: 'c'.repeat(64), targetHash: 'd'.repeat(64) };
    await f.store.transact((await execution.prepareManualChecks(binding)).finalize());
    if (state === 'switched') await f.apply({ kind: 'campaign.route', enrollmentId: id(8), expectedEnrollmentVersion: 1, selectedRouteId: id(6), contextRevision: 2, executionContextId: 'context-two' });
    else if (state !== 'active') await f.apply({ kind: 'campaign.state', enrollmentId: id(8), expectedEnrollmentVersion: 1, state, reason: 'late interruption' });
    const accepted = await f.apply({ kind: 'campaign.outcome', enrollmentId: id(8), expectedEnrollmentVersion: state === 'active' ? 1 : 2, evidence });
    expect(accepted.cap).toEqual({ campaignVersionId: id(2), channel: 'call', revision: 3, reserved: 0, sent: 1 });
    expect(f.dynamo.inspect(`CAMPAIGN_CAP#${id(2)}#call`)).toEqual({ reserved: 0, sent: 1 });
    expect(f.dynamo.inspect(campaignEnrollmentKey(id(8)))).toMatchObject({ state: state === 'active' ? 'completed' : state === 'switched' ? 'active' : state, currentStepId: state === 'active' ? null : id(5) });
    await f.apply({ kind: 'campaign.outcome', enrollmentId: id(8), expectedEnrollmentVersion: state === 'active' ? 2 : 3, evidence: { ...evidence, observation: 'no_reply', outcome: 'no_reply' } });
    expect(f.dynamo.inspect(`CAMPAIGN_CAP#${id(2)}#call`)).toEqual({ reserved: 0, sent: 1 });
    await expect(f.apply({ kind: 'campaign.outcome', enrollmentId: id(8), expectedEnrollmentVersion: state === 'active' ? 3 : 4, evidence: { ...evidence, state: 'unknown', observation: 'unknown', outcome: 'unknown' } })).rejects.toThrow('campaign_outcome_conflict');
  });
  it('manual eligibility adds exact campaign conditions and consumes capacity but never sent count', async () => {
    const f = await fixture();
    await f.apply({ kind: 'campaign.enroll', enrollmentId: id(8), campaignVersionId: f.version.id, selectedRouteId: id(6), executionContextId: 'context-one', contextRevision: 1 });
    const execution = new CampaignExecution(f.repo);
    const input = { workspaceId: id(1), accountId: id(4), campaignId: id(3), campaignRevision: 1, enrollmentId: id(8), enrollmentRevision: 1, stepId: id(5), actionId: id(10), channel: 'call' as const, authorityGeneration: 1, selectedRouteId: id(6), contextRevision: 'context-one', contentHash: 'c'.repeat(64), targetHash: 'd'.repeat(64) };
    await expect(execution.prepareDispatchChecks(input)).rejects.toThrow('campaign_content_unapproved');
    const plan = await execution.prepareManualChecks(input);
    expect(plan.cap).toEqual({ campaignVersionId: id(2), channel: 'call', revision: 2, reserved: 1, sent: 0 });
    const keys = plan.finalize().map(item => item.Put?.Item?.sk?.S ?? item.ConditionCheck?.Key?.sk?.S);
    expect(keys).toContain(campaignEnrollmentKey(id(8)));
    expect(keys.some(key => key?.startsWith('CAMPAIGN_CAP#'))).toBe(true);
    expect(keys.some(key => key?.startsWith('AUTH#'))).toBe(false);
    expect(keys.some(key => key?.startsWith('CAMPAIGN_ACTION_APPROVAL#'))).toBe(false);
    expect(new Set(keys).size).toBe(keys.length);
    await f.store.transact(plan.finalize());
    expect(f.dynamo.inspect(`CAMPAIGN_CAP#${id(2)}#call`)).toMatchObject({ reserved: 1, sent: 0 });
    expect(f.dynamo.inspect(`CAMPAIGN_RESERVATION#${id(4)}#${id(10)}`)).toMatchObject({ input, routeVersion: 1, numericContextRevision: 1, state: 'reserved' });
    await expect(f.store.transact(plan.finalize())).rejects.toThrow();
    const second = { ...input, actionId: id(11) };
    await expect(execution.prepareManualChecks(second).then(next => f.store.transact(next.finalize()))).rejects.toThrow();

    const outcome = await f.repo.prepareOutcomePlan({ commandId: id(20), accountId: id(4), actionId: id(10), state: 'unknown', observedAt: now });
    expect(outcome.payload.cap).toEqual({ campaignVersionId: id(2), channel: 'call', revision: 2, reserved: 1, sent: 0 });
    expect(outcome.items.some(item => item.ConditionCheck?.Key?.sk?.S === `CAMPAIGN_CAP#${id(2)}#call`)).toBe(true);
    await f.store.transact(outcome.items);
    expect(f.dynamo.inspect(`CAMPAIGN_CAP#${id(2)}#call`)).toMatchObject({ reserved: 1, sent: 0 });
    f.advance('2026-09-09T12:05:00.000Z');
    expect(() => plan.finalize()).toThrow('campaign_evidence_expired');
  });
});

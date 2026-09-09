import { describe, expect, it } from 'vitest';
import { WorkerCampaignRepository, campaignVersionKey, campaignEnrollmentKey, campaignSlotKey } from '../src/workerCampaignRepository';
import { CampaignExecution } from '../src/campaignExecution';
import { DynamoStore, fingerprint } from '../src/dynamoStore';
import { ConditionalCommandHarness } from './sdkHarness';
import type { CampaignVersion, CampaignCommandPayload } from '../../../../src/shared/contracts/campaignContract';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = '2026-09-09T12:00:00.000Z';
async function fixture() {
  const dynamo = new ConditionalCommandHarness(); let time = now;
  const options = { dynamo, tableName: 'fictional-campaigns', workspaceId: id(1), clock: { now: () => time } };
  const store = new DynamoStore(options); const repo = new WorkerCampaignRepository(options); let command = 100;
  const version: CampaignVersion = { id: id(2), campaignId: id(3), version: 1, audienceHash: 'a'.repeat(64), offer: 'Fictional offer', objective: 'meeting', cohortAccountIds: [id(4)], approvedAt: null, steps: [{ id: id(5), channel: 'call', condition: 'initial', delayHours: 0 }], capScope: 'campaign_version_lifetime', channelCaps: { call: 2, email: 1, linkedin: 1 }, contentPolicyHash: 'b'.repeat(64) };
  const account = { id: id(4), name: 'Fictional PM', domain: 'example.invalid', version: 1 };
  const routes = [{ id: id(6), accountId: id(4), personId: null, channel: 'phone', value: '+12025550101', purpose: 'business', evidenceIds: [id(7)], verification: 'published', version: 1 }];
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
    await f.repo.admitActionApproval({ ...binding, expiresAt: '2026-09-09T12:05:00.000Z', approvedAt: now });
    await f.store.transact((await execution.prepareManualChecks(binding)).finalize());
    const evidence = { stepId: id(5), routeId: id(6), routeVersion: 1, executionContextId: 'context-one', contextRevision: 1, observedAt: now, observation: 'unknown' as const, source: 'human' as const, actionId: id(10), channel: 'call' as const, state: 'unknown' as const, outcome: 'unknown' };
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
    const evidence = { stepId: id(5), routeId: id(6), routeVersion: 1, executionContextId: 'context-one', contextRevision: 1, observedAt: now, observation: 'unknown' as const, source: 'human' as const, actionId: id(10), channel: 'call' as const, state: 'human_reported_sent' as const, outcome: 'no_answer' };
    await expect(f.apply({ kind: 'campaign.outcome', enrollmentId: id(8), expectedEnrollmentVersion: 1, evidence })).rejects.toThrow('campaign_reservation_missing');
    const execution = new CampaignExecution(f.repo);
    const binding = { workspaceId: id(1), accountId: id(4), campaignId: id(3), campaignRevision: 1, enrollmentId: id(8), enrollmentRevision: 1, stepId: id(5), actionId: id(10), channel: 'call' as const, authorityGeneration: 1, selectedRouteId: id(6), contextRevision: 'context-one', contentHash: 'c'.repeat(64), targetHash: 'd'.repeat(64) };
    await f.repo.admitActionApproval({ ...binding, expiresAt: '2026-09-09T12:05:00.000Z', approvedAt: now });
    await f.store.transact((await execution.prepareManualChecks(binding)).finalize());
    if (state === 'switched') await f.apply({ kind: 'campaign.route', enrollmentId: id(8), expectedEnrollmentVersion: 1, selectedRouteId: id(6), contextRevision: 2, executionContextId: 'context-two' });
    else if (state !== 'active') await f.apply({ kind: 'campaign.state', enrollmentId: id(8), expectedEnrollmentVersion: 1, state, reason: 'late interruption' });
    await f.apply({ kind: 'campaign.outcome', enrollmentId: id(8), expectedEnrollmentVersion: state === 'active' ? 1 : 2, evidence });
    expect(f.dynamo.inspect(`CAMPAIGN_CAP#${id(2)}#call`)).toEqual({ reserved: 0, sent: 1 });
    expect(f.dynamo.inspect(campaignEnrollmentKey(id(8)))).toMatchObject({ state: state === 'active' ? 'completed' : state === 'switched' ? 'active' : state, currentStepId: state === 'active' ? null : id(5) });
    await f.apply({ kind: 'campaign.outcome', enrollmentId: id(8), expectedEnrollmentVersion: state === 'active' ? 2 : 3, evidence: { ...evidence, observation: 'no_reply', outcome: 'no_reply' } });
    expect(f.dynamo.inspect(`CAMPAIGN_CAP#${id(2)}#call`)).toEqual({ reserved: 0, sent: 1 });
  });
  it('manual eligibility adds exact campaign conditions and consumes capacity but never sent count', async () => {
    const f = await fixture();
    await f.apply({ kind: 'campaign.enroll', enrollmentId: id(8), campaignVersionId: f.version.id, selectedRouteId: id(6), executionContextId: 'context-one', contextRevision: 1 });
    const execution = new CampaignExecution(f.repo);
    const input = { workspaceId: id(1), accountId: id(4), campaignId: id(3), campaignRevision: 1, enrollmentId: id(8), enrollmentRevision: 1, stepId: id(5), actionId: id(10), channel: 'call' as const, authorityGeneration: 1, selectedRouteId: id(6), contextRevision: 'context-one', contentHash: 'c'.repeat(64), targetHash: 'd'.repeat(64) };
    await expect(execution.prepareManualChecks(input)).rejects.toThrow('campaign_content_unapproved');
    await f.repo.admitActionApproval({ ...input, expiresAt: '2026-09-09T12:05:00.000Z', approvedAt: now });
    const plan = await execution.prepareManualChecks(input);
    const keys = plan.finalize().map(item => item.Put?.Item?.sk?.S ?? item.ConditionCheck?.Key?.sk?.S);
    expect(keys).toContain(campaignEnrollmentKey(id(8)));
    expect(keys.some(key => key?.startsWith('CAMPAIGN_CAP#'))).toBe(true);
    expect(keys.some(key => key?.startsWith('AUTH#'))).toBe(false);
    expect(new Set(keys).size).toBe(keys.length);
    await f.store.transact(plan.finalize());
    expect(f.dynamo.inspect(`CAMPAIGN_CAP#${id(2)}#call`)).toMatchObject({ reserved: 1, sent: 0 });
    await expect(f.store.transact(plan.finalize())).rejects.toThrow();
    const second = { ...input, actionId: id(11) };
    await f.repo.admitActionApproval({ ...second, expiresAt: '2026-09-09T12:05:00.000Z', approvedAt: now });
    await expect(execution.prepareManualChecks(second).then(next => f.store.transact(next.finalize()))).rejects.toThrow();

    const outcome = await f.repo.prepareOutcomePlan({ commandId: id(20), accountId: id(4), actionId: id(10), state: 'unknown', observedAt: now });
    await f.store.transact(outcome.items);
    expect(f.dynamo.inspect(`CAMPAIGN_CAP#${id(2)}#call`)).toMatchObject({ reserved: 1, sent: 0 });
    f.advance('2026-09-09T12:05:00.000Z');
    expect(() => plan.finalize()).toThrow('campaign_evidence_expired');
  });
});

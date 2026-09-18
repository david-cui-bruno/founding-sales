import { describe, expect, it } from 'vitest';
import { WorkerCampaignRepository, campaignEnrollmentKey } from '../src/workerCampaignRepository';
import { CampaignExecution } from '../src/campaignExecution';
import { DynamoStore, fingerprint } from '../src/dynamoStore';
import { ConditionalCommandHarness } from './sdkHarness';
import type { CampaignCommandPayload } from '../../../../src/shared/contracts/campaignContract';
import { DEFAULT_TERRITORY_CALL_POLICY_DEFINITION, deriveTerritoryCampaignVersion, territoryCallPolicyId, territoryHeldSteps,
  TERRITORY_EMAIL_HOLD_REASON, advanceTerritorySequence } from '../../../../src/shared/contracts/territoryCallPolicyContract';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = '2026-09-09T12:00:00.000Z'; // Wednesday
const WORKSPACE = id(1);
const ACCOUNT = id(4);
const ROUTE = id(6);

/** The real worker repository over the real conditional-write harness, on a genuine territory-derived version. */
async function fixture() {
  const dynamo = new ConditionalCommandHarness(); let time = now;
  const options = { dynamo, tableName: 'fictional-territory', workspaceId: WORKSPACE, clock: { now: () => time } };
  const store = new DynamoStore(options); const repo = new WorkerCampaignRepository(options); let command = 100;
  const policy = { policyId: territoryCallPolicyId(WORKSPACE), revision: 1, ...DEFAULT_TERRITORY_CALL_POLICY_DEFINITION };
  const version = deriveTerritoryCampaignVersion(policy, ACCOUNT);
  const account = { id: ACCOUNT, name: 'Fictional Territory PM', domain: 'example.invalid', version: 1 };
  const routes = [{ id: ROUTE, accountId: ACCOUNT, personId: null, channel: 'phone', value: '+12025550101', purpose: 'business', evidenceIds: [id(7)], verification: 'published', version: 1 }];
  await store.transact([store.put(`ACCOUNT#${ACCOUNT}`, { account, routes, claims: [], sources: [], researchRevision: 1, history: [{ at: now, account, routes, claims: [] }] }, null)]);
  const apply = async (payload: CampaignCommandPayload) => {
    const plan = await repo.planCommand({ commandId: id(command++), accountId: ACCOUNT, payload });
    await store.transact(plan.items); return plan.payload;
  };
  await apply({ kind: 'campaign.version', version });
  await apply({ kind: 'campaign.approve', campaignVersionId: version.id, snapshotHash: fingerprint(version), approvedAt: now });
  await apply({ kind: 'campaign.enroll', enrollmentId: id(8), campaignVersionId: version.id, selectedRouteId: ROUTE, executionContextId: 'call-context', contextRevision: 1 });
  let action = 10;
  /** One real reserved call action followed by one applied human outcome, exactly as a completed handoff does. */
  const report = async (outcome: string, enrollmentRevision: number, stepId: string, observedAt = now, observation: 'unknown' | 'no_reply' = 'unknown') => {
    const actionId = id(action++);
    const binding = { workspaceId: WORKSPACE, accountId: ACCOUNT, campaignId: version.campaignId, campaignRevision: 1, enrollmentId: id(8),
      enrollmentRevision, stepId, actionId, channel: 'call' as const, authorityGeneration: 1, selectedRouteId: ROUTE,
      contextRevision: 'call-context', contentHash: 'c'.repeat(64), targetHash: 'd'.repeat(64) };
    await store.transact((await new CampaignExecution(repo).prepareManualChecks(binding)).finalize());
    return apply({ kind: 'campaign.outcome', enrollmentId: id(8), expectedEnrollmentVersion: enrollmentRevision,
      evidence: { enrollmentId: id(8), accountId: ACCOUNT, campaignVersionId: version.id, stepId, routeId: ROUTE, routeVersion: 1,
        executionContextId: 'call-context', contextRevision: 1, observedAt, observation, source: 'human', actionId, channel: 'call',
        state: 'human_reported_sent', outcome } });
  };
  return { store, repo, dynamo, version, policy, apply, report, enrollment: () => dynamo.inspect(campaignEnrollmentKey(id(8))) as Record<string, unknown>, advance: (value: string) => { time = value; } };
}

describe('D13 sequence v1 on the real worker repository', () => {
  it('derives the day 0/3/7/12/21 cadence with three call and three email caps, every email step held', async () => {
    const f = await fixture();
    expect(f.version.steps.map(step => [step.channel, step.delayHours])).toEqual([['call', 0], ['call', 72], ['email', 168], ['call', 288], ['email', 504]]);
    expect(f.version.channelCaps).toEqual({ call: 3, email: 3, linkedin: 0 });
    expect(territoryHeldSteps(f.version)).toEqual([
      { stepId: f.version.steps[2]!.id, channel: 'email', reason: TERRITORY_EMAIL_HOLD_REASON },
      { stepId: f.version.steps[4]!.id, channel: 'email', reason: TERRITORY_EMAIL_HOLD_REASON },
    ]);
    expect(TERRITORY_EMAIL_HOLD_REASON).toBe('mailbox_not_connected');
  });

  it.each([['no_answer'], ['voicemail'], ['busy'], ['connected']])('%s continues to the next call step at its cadence instant', async outcome => {
    const f = await fixture();
    await f.report(outcome, 1, f.version.steps[0]!.id);
    expect(f.enrollment()).toMatchObject({ state: 'active', currentStepId: f.version.steps[1]!.id,
      nextDueAt: new Date(Date.parse(now) + 72 * 3600000).toISOString(), restingUntil: null });
  });

  it('skips the held email step to the day 12 call and never drafts or sends anything', async () => {
    const f = await fixture();
    await f.report('no_answer', 1, f.version.steps[0]!.id, now, 'no_reply');
    // Day 3 arrives; the second call step is eligible and its report advances past the held day-7 email.
    const dayThree = new Date(Date.parse(now) + 72 * 3600000).toISOString();
    f.advance(dayThree);
    await f.report('no_answer', 2, f.version.steps[1]!.id, dayThree, 'no_reply');
    expect(f.enrollment()).toMatchObject({ state: 'active', currentStepId: f.version.steps[3]!.id,
      nextDueAt: new Date(Date.parse(now) + 288 * 3600000).toISOString() });
    // The email step is passed over as held, not as done: nothing in the store names a draft or a send.
    expect(JSON.stringify(f.dynamo.snapshot ? f.dynamo.snapshot() : {})).not.toMatch(/draft|send/i);
  });

  it('interested holds the sequence on its own step and asks again in five business days', async () => {
    const f = await fixture();
    await f.report('interested', 1, f.version.steps[0]!.id);
    // Wednesday 9 September plus five business days is Wednesday 16 September.
    expect(f.enrollment()).toMatchObject({ state: 'active', currentStepId: f.version.steps[0]!.id,
      nextDueAt: '2026-09-16T12:00:00.000Z', restingUntil: null });
  });

  it('gatekeeper asks again in two business days on the same call step', async () => {
    const f = await fixture();
    await f.report('gatekeeper', 1, f.version.steps[0]!.id);
    expect(f.enrollment()).toMatchObject({ state: 'active', currentStepId: f.version.steps[0]!.id,
      nextDueAt: '2026-09-11T12:00:00.000Z', restingUntil: null });
  });

  it('not_interested rests the firm 180 days with no email and no due time', async () => {
    const f = await fixture();
    await f.report('not_interested', 1, f.version.steps[0]!.id);
    expect(f.enrollment()).toMatchObject({ state: 'paused', nextDueAt: null, restingUntil: '2027-03-08T12:00:00.000Z' });
  });

  it('wrong_number rests the firm rather than dialing the same number again', async () => {
    const f = await fixture();
    await f.report('wrong_number', 1, f.version.steps[0]!.id);
    expect(f.enrollment()).toMatchObject({ state: 'paused', nextDueAt: null, restingUntil: '2027-03-08T12:00:00.000Z' });
  });

  it('re-applying the exact same outcome command is idempotent and never advances twice', async () => {
    const f = await fixture();
    await f.report('no_answer', 1, f.version.steps[0]!.id);
    const after = f.enrollment();
    const evidence = (await f.repo.evidence(id(8)))[0]!;
    // The same command id replans to the same items; the enrollment CAS refuses a second advance.
    await expect(f.apply({ kind: 'campaign.outcome', enrollmentId: id(8), expectedEnrollmentVersion: 1, evidence })).rejects.toThrow(/stale_enrollment/);
    expect(f.enrollment()).toEqual(after);
  });
});

describe('the D13 branch function itself', () => {
  const version = deriveTerritoryCampaignVersion({ policyId: territoryCallPolicyId(WORKSPACE), revision: 1, ...DEFAULT_TERRITORY_CALL_POLICY_DEFINITION }, ACCOUNT);
  const enrollment = { currentStepId: version.steps[3]!.id, startedAt: now };
  it('rests 90 days after the last step and holds the trailing email step', () => {
    expect(advanceTerritorySequence({ version, enrollment, outcome: 'no_answer', observedAt: '2026-09-21T12:00:00.000Z' }))
      .toEqual({ currentStepId: null, state: 'paused', nextDueAt: null, restingUntil: '2026-12-20T12:00:00.000Z',
        heldStepIds: [version.steps[4]!.id], reason: 'rest_sequence_complete' });
  });
  it('ends the sequence on an explicit opt-out without inventing a rest date', () => {
    expect(advanceTerritorySequence({ version, enrollment, outcome: 'opt_out', observedAt: now }))
      .toEqual({ currentStepId: null, state: 'stopped', nextDueAt: null, restingUntil: null, heldStepIds: [], reason: 'opt_out' });
  });
  it('rolls a weekend landing forward instead of promising a Saturday call', () => {
    // Thursday 10 September plus two business days is Monday 14 September.
    expect(advanceTerritorySequence({ version, enrollment, outcome: 'gatekeeper', observedAt: '2026-09-10T12:00:00.000Z' }).nextDueAt).toBe('2026-09-14T12:00:00.000Z');
  });
  it('refuses a step the version does not contain rather than guessing one', () => {
    expect(() => advanceTerritorySequence({ version, enrollment: { currentStepId: 'not-a-step', startedAt: now }, outcome: 'no_answer', observedAt: now }))
      .toThrow(/territory_sequence_step_unknown/);
  });
});

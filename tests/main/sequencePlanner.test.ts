import { describe, expect, it } from 'vitest';
import { campaignVersionSchema, campaignCommandPayloadSchema, type CampaignVersion, type Enrollment, type StepEvidence } from '../../src/shared/contracts/campaignContract';
import { evaluateNoReply, planNext } from '../../src/main/domain/campaign/sequencePlanner';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = '2026-09-09T12:00:00.000Z';
const version: CampaignVersion = { id: id(1), campaignId: id(2), version: 1, audienceHash: 'a'.repeat(64), offer: 'Fictional maintenance pilot', objective: 'meeting', cohortAccountIds: [id(3)], approvedAt: '2026-09-08T00:00:00.000Z', steps: [{ id: id(4), channel: 'call', condition: 'initial', delayHours: 0 }, { id: id(5), channel: 'linkedin', condition: 'no_reply', delayHours: 24 }], capScope: 'campaign_version_lifetime', channelCaps: { call: 1, email: 1, linkedin: 1 }, contentPolicyHash: 'b'.repeat(64) };
const enrollment: Enrollment = { id: id(6), accountId: id(3), selectedRouteId: id(7), selectedRouteVersion: 1, personId: null, campaignVersionId: id(1), currentStepId: id(4), version: 1, state: 'active', executionContextId: 'context-one', contextRevision: 1, startedAt: '2026-09-08T00:00:00.000Z' };
const evidence: StepEvidence = { enrollmentId: id(6), accountId: id(3), campaignVersionId: id(1), stepId: id(4), routeId: id(7), routeVersion: 1, outcome: 'no_answer', observedAt: '2026-09-08T10:00:00.000Z', observation: 'no_reply', source: 'human', executionContextId: 'context-one', contextRevision: 1, state: 'human_reported_sent', actionId: id(8), channel: 'call' };

describe('truthful campaign sequence', () => {
  it('requires explicit no reply, never inferring an unread inbox', () => {
    expect(evaluateNoReply({ channel: 'linkedin', observation: 'unknown' })).toBe('wait');
    expect(evaluateNoReply({ channel: 'linkedin', observation: 'replied' })).toBe('stop');
    expect(evaluateNoReply({ channel: 'email', observation: 'no_reply' })).toBe('eligible');
  });
  it('prepares only the first approved step, without mutating enrollment', () => {
    const before = structuredClone(enrollment);
    expect(planNext(version, enrollment, [], now)).toMatchObject({ kind: 'prepare', stepId: id(4) });
    expect(enrollment).toEqual(before);
  });
  it.each(['prepared', 'queued', 'dispatching', 'unknown'] as const)('does not advance %s as a send', state => {
    expect(planNext(version, enrollment, [{ ...evidence, state }], now)).toMatchObject({ kind: 'wait', stepId: id(4) });
  });
  it('advances only actual outcome with exact route/context and elapsed delay', () => {
    expect(planNext(version, enrollment, [evidence], now)).toMatchObject({ kind: 'prepare', stepId: id(5) });
    expect(planNext(version, enrollment, [evidence], '2026-09-09T09:59:59.999Z')).toMatchObject({ kind: 'wait', reason: 'delay_not_elapsed' });
    expect(planNext(version, enrollment, [evidence], '2026-09-09T10:00:00.000Z')).toMatchObject({ kind: 'prepare' });
    expect(planNext(version, enrollment, [{ ...evidence, routeId: id(99) }], now).kind).toBe('wait');
    expect(planNext(version, enrollment, [{ ...evidence, contextRevision: 0 }], now).kind).toBe('wait');
    expect(planNext(version, enrollment, [{ ...evidence, observedAt: '2026-09-10T00:00:00.000Z' }], now).kind).toBe('wait');
  });
  it('uses immutable predecessor only after pointer advanced, never foreign receipts', () => {
    const next = { ...enrollment, currentStepId: id(5), selectedRouteId: id(20), executionContextId: 'linkedin-context', contextRevision: 2 };
    expect(planNext(version, next, [evidence], now).kind).toBe('prepare');
    for (const field of ['enrollmentId', 'accountId', 'campaignVersionId'] as const) expect(planNext(version, next, [{ ...evidence, [field]: id(99) }], now).kind).toBe('wait');
    expect(planNext(version, next, [{ ...evidence, state: 'unknown' }], now).kind).toBe('wait');
    expect(planNext(version, { ...next, currentStepId: id(4) }, [evidence], now).kind).toBe('wait');
  });
  it('unknown, stale or missing no-reply observations wait', () => {
    expect(planNext(version, enrollment, [{ ...evidence, observation: 'unknown' }], now).kind).toBe('wait');
    expect(planNext(version, enrollment, [{ ...evidence, observedAt: '2026-09-07T00:00:00.000Z' }], now).kind).toBe('wait');
  });
  it.each(['paused', 'held', 'conversation', 'completed', 'stopped'] as const)('does not schedule %s enrollment', state => {
    expect(planNext(version, { ...enrollment, state }, [], now).kind).toBe('wait');
  });
  it('unapproved, wrong cohort and wrong campaign fail closed', () => {
    expect(planNext({ ...version, approvedAt: null }, enrollment, [], now).reason).toBe('campaign_unapproved');
    expect(planNext({ ...version, cohortAccountIds: [id(99)] }, enrollment, [], now).kind).toBe('wait');
    expect(planNext(version, { ...enrollment, campaignVersionId: id(99) }, [], now).kind).toBe('wait');
  });
  it.each(['reply', 'booked', 'opt_out'])('interrupts on %s even after contact switch', outcome => {
    expect(planNext(version, enrollment, [{ ...evidence, outcome, observation: outcome === 'reply' ? 'replied' : 'unknown', routeId: id(99) }], now).kind).toBe('stop');
  });
  it('requires requested-info evidence rather than a generic send', () => {
    const requested: CampaignVersion = { ...version, steps: [version.steps[0], { ...version.steps[1], condition: 'requested_info' }] };
    expect(planNext(requested, enrollment, [evidence], now).kind).toBe('wait');
    expect(planNext(requested, enrollment, [{ ...evidence, outcome: 'requested_info' }], now).kind).toBe('prepare');
  });
  it('caps actual attempts, does not count duplicate receipts twice', () => {
    const capped: CampaignVersion = { ...version, steps: [version.steps[0], { ...version.steps[1], channel: 'call' }] };
    expect(planNext(capped, enrollment, [evidence], now).reason).toBe('channel_cap_reached');
    expect(planNext({ ...capped, capScope: 'campaign_version_lifetime', channelCaps: { ...capped.channelCaps, call: 2 } }, enrollment, [evidence, evidence], now).kind).toBe('prepare');
  });
  it('strictly rejects unknown payloads and malformed approved snapshots', () => {
    expect(campaignVersionSchema.safeParse({ ...version, capScope: 'campaign_version_lifetime', channelCaps: { ...version.channelCaps, email: -1 } }).success).toBe(false);
    expect(campaignVersionSchema.safeParse({ ...version, steps: [version.steps[0], version.steps[0]] }).success).toBe(false);
    expect(campaignCommandPayloadSchema.safeParse({ kind: 'campaign.enroll', enrollmentId: id(6), campaignVersionId: id(1), selectedRouteId: id(7), arbitrary: true }).success).toBe(false);
  });
});

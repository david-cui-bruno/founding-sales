import { describe, expect, it } from 'vitest';
import { dailySnapshotSchema } from '../../../shared/contracts/dailyContract';
import { dailyFixture, nativeDeskFixture, fixtureNow } from './nativeDesk.fixture';
import { createCallCampaignDraft } from '../../../shared/contracts/callCampaignDraft';
import { localCompanyDetailSchema } from '../../../shared/contracts/localWorkspaceContract';
import { delegatedPhoneStateReplySchema } from '../../../shared/contracts/delegatedPhoneStateContract';
import { sha256Utf8 } from '../../../shared/crypto/sha256';
import { companyPhoneSession, freezePhoneValue, makePhoneReview, phoneFreshBinding, phoneHistoryScope, parsePhoneHistory, type PhoneConfig } from './companyPhoneSession';

function fixture() {
  const snapshot = dailyFixture({ answers: [] });
  const account = snapshot.accounts[0];
  account.routes = [{ id: 'phone', version: 4, accountId: 'a', personId: null, channel: 'phone', value: '+14015550123', purpose: 'business', verification: 'published', evidenceIds: ['source'] }];
  const version = { ...createCallCampaignDraft({ campaignId: 'campaign', versionId: 'version', accountId: 'a', stepId: 'call', offer: 'Exact saved purpose é.' }), approvedAt: fixtureNow };
  snapshot.campaigns = [{ version, snapshotHash: 'b'.repeat(64), caps: [{ campaignVersionId: 'version', channel: 'call', revision: 3, reserved: 0, sent: 0 }], enrollments: [{ id: 'enrollment', accountId: 'a', campaignVersionId: 'version', selectedRouteId: 'phone', selectedRouteVersion: 4, personId: null, currentStepId: 'call', version: 8, state: 'active', executionContextId: 'context', contextRevision: 2, startedAt: fixtureNow }] }];
  snapshot.ownerStatus = [{ accountId: 'a', authority: { accountId: 'a', owner: 'worker', generation: 9, state: 'active' }, executionVersion: 41, pendingCommands: [], status: 'owner_applied' }];
  const config: PhoneConfig = { state: 'active', workspaceId: 'ws', endpoint: 'https://worker.invalid', configuration: { revision: 2, configuration: { version: 1, state: 'active', research: null }, updatedAt: fixtureNow } };
  const selector = { accountId: 'a', enrollmentId: 'enrollment', stepId: 'call' };
  const detail = localCompanyDetailSchema.parse({ scope: 'local_database', generatedAt: fixtureNow, snapshot: account, sources: [{ id: 'source', url: 'https://company.invalid/contact', fetchedAt: fixtureNow, sha256: 'c'.repeat(64), permitted: true, excerpt: 'Business phone +14015550123.' }], links: [] });
  const setup = { state: 'configured' as const, candidateFingerprint: 'helper', confirmedAt: fixtureNow };
  const history = delegatedPhoneStateReplySchema(selector).parse({ ...selector, workspaceId: 'ws', campaign: { campaignId: 'campaign', campaignRevision: 1, campaignVersionId: 'version' }, generatedAt: fixtureNow, remote: 'unknown', completeness: 'complete', issue: null, attempts: [], completions: [] });
  return { snapshot: dailySnapshotSchema.parse(snapshot), config, selector, detail, setup, history };
}
describe('bounded company phone session', () => {
  it('uses exact bridge-pair and workspace/account/enrollment/step identity, sharing one begin latch', () => {
    const api = nativeDeskFixture().api;
    const selector = { accountId: 'a', enrollmentId: 'e', stepId: 's' };
    const first = companyPhoneSession(api, 'ws', selector)!;
    expect(companyPhoneSession(api, 'ws', { ...selector })).toBe(first);
    const next = companyPhoneSession(api, 'ws', { ...selector, stepId: 'other' })!;
    expect(next).not.toBe(first);
    expect(next.bridge).toBe(first.bridge);
    first.bridge.beginning = true;
    expect(next.bridge.beginning).toBe(true);
    const changedDaily = companyPhoneSession({ ...api, daily: { ...api.daily } }, 'ws', selector)!;
    expect(changedDaily).not.toBe(first);
    expect(changedDaily.bridge).toBe(first.bridge);
    expect(companyPhoneSession({ ...api, delegation: { ...api.delegation } }, 'ws', selector)).not.toBe(first);
    expect(companyPhoneSession(api, 'different-workspace', selector)).not.toBe(first);
  });
  it('holds at32 mounted entries instead of evicting and only reclaims an idle unmounted entry', () => {
    const api = nativeDeskFixture().api;
    const entries = Array.from({ length: 32 }, (_, index) => companyPhoneSession(api, 'ws', { accountId: 'a', enrollmentId: `e${index}`, stepId: 's' })!);
    entries.forEach(entry => entry.listeners.add(() => undefined));
    expect(companyPhoneSession(api, 'ws', { accountId: 'a', enrollmentId: 'overflow', stepId: 's' })).toBeNull();
    entries[0].listeners.clear();
    expect(companyPhoneSession(api, 'ws', { accountId: 'a', enrollmentId: 'overflow', stepId: 's' })).not.toBeNull();
    expect(companyPhoneSession(api, 'ws', { accountId: 'a', enrollmentId: 'e1', stepId: 's' })).toBe(entries[1]);
  });
  it('never evicts an unmounted uncertain begin and preserves its exact request identity', () => {
    const api = nativeDeskFixture().api, f = fixture();
    const review = makePhoneReview(f.snapshot, f.config, f.selector, f.detail, f.setup, f.history, 'ws');
    const entries = Array.from({ length: 32 }, (_, index) => companyPhoneSession(api, 'ws', { ...f.selector, enrollmentId: `e${index}` })!);
    entries.forEach(entry => { entry.begin = { request: review.request, result: null }; });
    expect(companyPhoneSession(api, 'ws', { ...f.selector, enrollmentId: 'overflow' })).toBeNull();
    expect(companyPhoneSession(api, 'ws', { ...f.selector, enrollmentId: 'e0' })!.begin!.request).toBe(review.request);
  });
});
describe('strict current phone review bindings', () => {
  it('uses current owner generation/version and exact saved route/offer hashes without a fake person', () => {
    const f = fixture();
    const review = makePhoneReview(f.snapshot, f.config, f.selector, f.detail, f.setup, f.history, 'ws');
    expect(review.request.command).toMatchObject({ workspaceId: 'ws', accountId: 'a', expectedAuthorityGeneration: 9, expectedVersion: 41, kind: 'prepare-manual', payload: { channel: 'call', routeId: 'phone', routeVersion: 4, targetHash: sha256Utf8('+14015550123'), contentHash: sha256Utf8('Exact saved purpose é.'), contextRevision: 'context', campaign: { campaignId: 'campaign', campaignRevision: 1, enrollmentId: 'enrollment', enrollmentRevision: 8, stepId: 'call' } } });
    expect(review.request.expectedEvidenceFingerprint).toBe(f.snapshot.accounts[0].fingerprint);
    expect(Object.isFrozen(review.request.command.payload.campaign)).toBe(true);
    expect(() => { review.request.command.payload.campaign.stepId = 'changed'; }).toThrow();
    expect(f.snapshot.campaigns[0].enrollments[0].personId).toBeNull();
  });
  it('ignores incidental generatedAt but detects changed actual review bindings', () => {
    const f = fixture();
    const binding = phoneFreshBinding(f.snapshot, f.config, f.selector, f.detail, f.setup, f.history, 'ws').binding;
    f.snapshot.freshness.generatedAt = '2026-09-10T12:00:00.000Z'; f.detail.generatedAt = f.snapshot.freshness.generatedAt;
    expect(phoneFreshBinding(f.snapshot, f.config, f.selector, f.detail, f.setup, f.history, 'ws').binding).toBe(binding);
    f.snapshot.ownerStatus[0].executionVersion++;
    expect(phoneFreshBinding(f.snapshot, f.config, f.selector, f.detail, f.setup, f.history, 'ws').binding).not.toBe(binding);
  });
  it.each(['paused', 'revoked'] as const)('keeps historical scope with %s owner and missing current route/setup while fresh work holds', state => {
    const f = fixture();
    f.config.state = 'paused'; f.config.configuration!.configuration.state = 'paused';
    f.snapshot.ownerStatus[0].authority!.state = state;
    f.snapshot.accounts[0].routes = [];
    expect(phoneHistoryScope(f.snapshot, f.config, 'ws')).toBe(true);
    expect(parsePhoneHistory(f.history, f.selector, f.snapshot, 'ws')).toEqual(f.history);
    expect(() => makePhoneReview(f.snapshot, f.config, f.selector, f.detail, f.setup, f.history, 'ws')).toThrow();
  });
  it('rejects a foreign workspace graph and preserves a source-limit HOLD rather than salvaging empty history', () => {
    const f = fixture();
    expect(() => parsePhoneHistory({ ...f.history, workspaceId: 'other' }, f.selector, f.snapshot, 'ws')).toThrow();
    const limited = parsePhoneHistory({ ...f.history, completeness: 'incomplete', issue: 'source_limit' }, f.selector, f.snapshot, 'ws');
    expect(limited.completeness).toBe('incomplete');
    expect(() => makePhoneReview(f.snapshot, f.config, f.selector, f.detail, f.setup, limited, 'ws')).toThrow();
  });
  it('deep-freezes captured data without changing its literal bytes', () => {
    const data = { route: { target: '+14015550123' }, values: [' exact '] };
    expect(freezePhoneValue(data)).toBe(data);
    expect(Object.isFrozen(data.values)).toBe(true);
    expect(data.values[0]).toBe(' exact ');
  });
});

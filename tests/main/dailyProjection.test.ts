import { describe, expect, it } from 'vitest';
import { buildDailySnapshot, type DailyProjectionInput } from '../../src/main/domain/today/dailyProjection';
import { dailySnapshotSchema } from '../../src/shared/contracts/dailyContract';
import { requestedFollowupFixture } from '../fixtures/requestedFollowup';

const now = '2026-09-09T12:00:00.000Z';
const base = (): DailyProjectionInput => ({ workspaceId: 'ws', generatedAt: now, accounts: [], calls: { accountIds: [], workloadConflict: false }, approvals: [], ownerStatus: [], issues: [], campaigns: [], callSettings: { newCallSlots: null, totalCallCapacity: null }, transport: [] });
describe('daily local projection', () => {
  it('does not convert research failures into answers and bounds aggregated issues', () => {
    const snapshot = buildDailySnapshot({ ...base(), issues: Array.from({ length: 100 }, () => ({ code: 'research_failed' as const, count: 1 })) });
    expect(snapshot.answers).toEqual([]);
    expect(snapshot.issues).toEqual([{ code: 'research_failed', count: 100 }]);
    expect(snapshot.freshness.kind).toBe('incomplete');
  });
  it('uses supplied B3 allocation unchanged rather than a fixed quota', () => {
    const result = buildDailySnapshot(base());
    expect(result.calls).toEqual({ accountIds: [], workloadConflict: false });
    expect(result.callSettings.newCallSlots).toBeNull();
  });
  it('is strict and reports local-only freshness, with stable revision across read time', () => {
    const a = buildDailySnapshot(base());
    const b = buildDailySnapshot({ ...base(), generatedAt: '2026-09-09T12:01:00.000Z' });
    expect(a.revision).toBe(b.revision);
    expect(a.freshness.remote).toBe('unknown');
    expect(dailySnapshotSchema.safeParse({ ...a, fabricated: true }).success).toBe(false);
  });
});

it('rejects nested answer/owner identities that do not bind their account', () => {
  const fixture = requestedFollowupFixture('account');
  const account: DailyProjectionInput['accounts'][number] = { account: fixture.record.account, claims: [], routes: [], portfolio: [], unknowns: [], conflicts: [], fingerprint: 'a'.repeat(64) };
  expect(() => buildDailySnapshot({ ...base(), accounts: [account], approvals: [{ kind: 'requested_followup', accountId: 'account', draft: { ...fixture.draft, accountId: 'foreign' }, approval: null, capability: 'held', reason: 'requires_owner_preflight' }] })).toThrow();
});

it('rejects mismatched route, campaign, and owner bindings at the public response boundary', () => {
  const f = requestedFollowupFixture('account');
  const account: DailyProjectionInput['accounts'][number] = { account: f.record.account, claims: [], routes: [], portfolio: [], unknowns: [], conflicts: [], fingerprint: 'a'.repeat(64) };
  const snapshot = buildDailySnapshot({ ...base(), accounts: [account] });
  expect(dailySnapshotSchema.safeParse({ ...snapshot, ownerStatus: [{ accountId: 'account', authority: { accountId: 'other', owner: 'local', generation: 0, state: 'local' }, executionVersion: 0, pendingCommands: [], status: 'unknown' }] }).success).toBe(false);
  expect(dailySnapshotSchema.safeParse({ ...snapshot, campaigns: [{ version: f.version, snapshotHash: 'a'.repeat(64), caps: [], enrollments: [{ ...f.enrollment, campaignVersionId: 'wrong' }] }] }).success).toBe(false);
  expect(dailySnapshotSchema.safeParse({ ...snapshot, calls: { accountIds: ['foreign'], workloadConflict: false } }).success).toBe(false);
});

import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createCampaignFixture } from '../fixtures/campaignWorkspace';

describe('real SQL campaign ownership', () => {
  it.each(['active', 'held', 'paused', 'conversation'] as const)('one account slot remains unique while %s', async state => {
    const f = await createCampaignFixture();
    try {
      const first = f.repo.enroll({ commandId: randomUUID(), accountId: f.account.id, selectedRouteId: f.routes[0].id, campaignVersionId: f.versions[0].id, executionContextId: 'fictional-context', contextRevision: 1 });
      if (state !== 'active') f.repo.changeState({ commandId: randomUUID(), enrollmentId: first.id, expectedVersion: first.version, state, reason: 'fixture pause' });
      expect(() => f.repo.enroll({ commandId: randomUUID(), accountId: f.account.id, selectedRouteId: f.routes[1].id, campaignVersionId: f.versions[1].id, executionContextId: 'fictional-context', contextRevision: 1 })).toThrow('account_already_enrolled');
    } finally { f.close(); }
  });
  it('idempotent enrollment replay conflicts on changed strategy or route', async () => {
    const f = await createCampaignFixture();
    try {
      const command = { commandId: randomUUID(), accountId: f.account.id, selectedRouteId: f.routes[0].id, campaignVersionId: f.versions[0].id, executionContextId: 'fictional-context', contextRevision: 1 };
      const enrollment = f.repo.enroll(command);
      expect(f.repo.enroll(command)).toEqual(enrollment);
      expect(() => f.repo.enroll({ ...command, selectedRouteId: f.routes[1].id })).toThrow('campaign_command_conflict');
      expect(() => f.db.raw.prepare('UPDATE campaign_versions SET snapshot_hash=?').run('c'.repeat(64))).toThrow(/immutable/);
      expect(() => f.db.raw.prepare('DELETE FROM campaign_approvals').run()).toThrow(/immutable/);
      expect(f.db.raw.pragma('foreign_key_check')).toEqual([]);
    } finally { f.close(); }
  });
  it('local direct mutation is denied when delegated, never creating a second owner', async () => {
    const f = await createCampaignFixture();
    try {
      f.db.raw.prepare("INSERT INTO delegated_authorities VALUES(?,?,'worker',1,'active',1,?)").run(f.account.id, f.workspaceId, f.now);
      expect(() => f.repo.enroll({ commandId: randomUUID(), accountId: f.account.id, selectedRouteId: f.routes[0].id, campaignVersionId: f.versions[0].id, executionContextId: 'fictional-context', contextRevision: 1 })).toThrow('campaign_owner_not_local');
    } finally { f.close(); }
  });
  it('switch route preserves enrollment and account slot with renewed exact context', async () => {
    const f = await createCampaignFixture();
    try {
      const first = f.repo.enroll({ commandId: randomUUID(), accountId: f.account.id, selectedRouteId: f.routes[0].id, campaignVersionId: f.versions[0].id, executionContextId: 'fictional-context', contextRevision: 1 });
      const second = f.repo.switchRoute({ commandId: randomUUID(), enrollmentId: first.id, expectedVersion: 1, selectedRouteId: f.routes[1].id, executionContextId: 'new-context', contextRevision: 2 });
      expect(second).toMatchObject({ id: first.id, accountId: first.accountId, version: 2, selectedRouteId: f.routes[1].id });
      expect(() => f.repo.switchRoute({ commandId: randomUUID(), enrollmentId: first.id, expectedVersion: 1, selectedRouteId: f.routes[0].id, executionContextId: 'old-context', contextRevision: 1 })).toThrow('stale_enrollment');
    } finally { f.close(); }
  });
  it('refuses fractional and unsafe revision/counts rather than trusting SQLite affinity', async () => {
    const f = await createCampaignFixture();
    try {
      for (const value of [1.5, -1, 9007199254740992]) {
        expect(() => f.db.raw.prepare('UPDATE campaign_caps SET revision=?').run(value)).toThrow();
        expect(() => f.db.raw.prepare('UPDATE campaign_caps SET reserved=?').run(value)).toThrow();
        expect(() => f.db.raw.prepare("INSERT INTO delegated_local_configuration VALUES(?,?,?,'{}',?)").run(f.workspaceId, randomUUID(), value, f.now)).toThrow();
        expect(() => f.db.raw.prepare("INSERT INTO delegated_transport_state VALUES(?,?,?,NULL,NULL,?,?,'pending')").run(f.workspaceId, randomUUID(), value, randomUUID(), f.now)).toThrow();
      }
    } finally { f.close(); }
  });

  it('joins authenticated projection transaction and refuses gaps or route/account mismatch', async () => {
    const f = await createCampaignFixture();
    try {
      const enrollment = f.repo.enroll({ commandId: randomUUID(), accountId: f.account.id, selectedRouteId: f.routes[0].id, campaignVersionId: f.versions[0].id, executionContextId: 'ctx', contextRevision: 1 });
      const payload = { commandId: randomUUID(), version: null as import("../../src/shared/contracts/campaignContract").CampaignVersion | null, enrollment: { ...enrollment, version: 2, state: 'paused' as const }, evidence: null as import("../../src/shared/contracts/campaignContract").StepEvidence | null };
      expect(() => f.repo.applyProjection(f.account.id, payload)).toThrow('campaign_projection_scope');
      f.db.raw.transaction(() => f.repo.applyProjection(f.account.id, payload)).immediate();
      expect(f.repo.getEnrollment(enrollment.id).state).toBe('paused');
      expect(() => f.db.raw.transaction(() => f.repo.applyProjection(f.account.id, { ...payload, enrollment: { ...payload.enrollment, version: 4 } })).immediate()).toThrow('campaign_projection_gap');
    } finally { f.close(); }
  });

});

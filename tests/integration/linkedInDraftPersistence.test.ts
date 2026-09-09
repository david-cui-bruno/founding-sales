import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openDatabase, closeDatabase } from '../../src/main/db/database';
import { LinkedInRepository } from '../../src/main/linkedin/linkedInRepository';
import { createLinkedInFixture } from '../fixtures/linkedInWorkspace';

describe('durable scoped LinkedIn drafts', () => {
  it('preserves exact edits on another encrypted SQL connection and rejects stale writes', async () => {
    const f = await createLinkedInFixture();
    try {
      const context = f.drafts.requireStep(f.version.steps[0]!.id, 1);
      const draft = f.drafts.create(context, 'Initial');
      const edited = f.drafts.save({ draftId: draft.id, expectedRevision: 1, body: '  Exact human edit\n' });
      const db = openDatabase({ path: f.path, key: f.key });
      try {
        const reopened = new LinkedInRepository({ ...f.deps, database: db });
        expect(reopened.requireRevision(draft.id, 2)).toEqual(edited);
        expect(() => reopened.save({ draftId: draft.id, expectedRevision: 1, body: 'late' })).toThrow('stale_draft');
        expect(() => new LinkedInRepository({ ...f.deps, workspaceId: randomUUID() }).requireRevision(draft.id, 2)).toThrow();
        expect(() => new LinkedInRepository({ ...f.deps, enrollmentId: randomUUID() }).requireRevision(draft.id, 2)).toThrow();
      } finally { closeDatabase(db); }
      expect(edited.body).toBe('  Exact human edit\n');
      expect(edited.personId).toBe(f.personId);
      expect(edited.state).toBe('draft');
    } finally { f.close(); }
  });
  it('keeps one draft per step context and fences route changes without losing old edits', async () => {
    const f = await createLinkedInFixture();
    try {
      const context = f.drafts.requireStep(f.version.steps[0]!.id, 1);
      const draft = f.drafts.create(context, 'Human text');
      expect(f.drafts.create(context, 'Do not overwrite')).toEqual(draft);
      f.repo.switchRoute({ commandId: randomUUID(), enrollmentId: f.enrollment.id, expectedVersion: 1, selectedRouteId: f.routes[1]!.id, executionContextId: randomUUID(), contextRevision: 1 });
      expect(() => f.drafts.requireAction(draft.id, 1)).toThrow('stale_context');
      expect(f.drafts.requireRevision(draft.id, 1).body).toBe('Human text');
      expect(() => f.drafts.save({ draftId: draft.id, expectedRevision: 1, body: 'late' })).toThrow('stale_context');
    } finally { f.close(); }
  });
});
it('pins immutable approvals to exact body/target and both context revisions, edits require fresh approval', async () => {
  const f = await createLinkedInFixture();
  try {
    const draft = f.drafts.create(f.drafts.requireStep(f.version.steps[0]!.id, 1), 'Reviewed');
    const commandId = randomUUID();
    const approved = f.drafts.approve({ draftId: draft.id, expectedRevision: 1, commandId });
    expect(approved.commandId).toBe(commandId);
    expect(approved.binding).toMatchObject({ contentHash: draft.contentHash, targetHash: draft.targetHash, contextRevision: draft.executionContextId,
      campaign: { campaignId: f.version.campaignId, enrollmentId: draft.enrollmentId, stepId: draft.stepId, enrollmentRevision: 1 } });
    expect(f.drafts.approve({ draftId: draft.id, expectedRevision: 1, commandId })).toEqual(approved);
    expect(() => f.drafts.approve({ draftId: draft.id, expectedRevision: 1, commandId: randomUUID() })).toThrow('approval_command_conflict');
    f.drafts.save({ draftId: draft.id, expectedRevision: 1, body: 'Changed' });
    expect(() => f.drafts.approve({ draftId: draft.id, expectedRevision: 2, commandId })).toThrow();
    const second = f.drafts.approve({ draftId: draft.id, expectedRevision: 2, commandId: randomUUID() });
    expect(second.binding.actionId).not.toBe(approved.binding.actionId);
    expect(second.binding.contentHash).not.toBe(approved.binding.contentHash);
    expect(f.db.raw.prepare('SELECT count(*) AS n FROM manual_linkedin_draft_approvals').get()).toEqual({ n: 2 });
    expect(() => f.db.raw.prepare('DELETE FROM manual_linkedin_draft_approvals').run()).toThrow('immutable');
  } finally { f.close(); }
});
it('recovers latest edits after process-style database reopen without model configuration', async () => {
  const f = await createLinkedInFixture();
  let reopened: ReturnType<typeof openDatabase> | undefined;
  try {
    const draft = f.drafts.create(f.drafts.requireStep(f.version.steps[0]!.id, 1), 'Initial');
    f.drafts.save({ draftId: draft.id, expectedRevision: 1, body: 'Saved before lost IPC response' });
    closeDatabase(f.db);
    reopened = openDatabase({ path: f.path, key: f.key });
    const { LinkedInService } = await import('../../src/main/linkedin/linkedInService');
    const service = new LinkedInService({ repository: new LinkedInRepository({ ...f.deps, database: reopened }) });
    expect((await service.prepare({ stepId: f.version.steps[0]!.id, expectedVersion: 1 })).body).toBe('Saved before lost IPC response');
  } finally { if (reopened) closeDatabase(reopened); f.close(); }
});
it('switches to a separately admitted real person route without leaking the prior editable draft', async () => {
  const f = await createLinkedInFixture();
  try {
    const old = f.drafts.create(f.drafts.requireStep(f.version.steps[0]!.id, 1), 'Person one private edit');
    const { AccountRepository } = await import('../../src/main/domain/accounts/accountRepository');
    const accounts = new AccountRepository({ database: f.db, clock: f.clock, ids: { next: randomUUID } });
    const snapshot = accounts.snapshot(f.account.id, f.now);
    const personId = randomUUID(); const routeId = randomUUID();
    f.db.raw.prepare('INSERT INTO persons(id,display_name,created_at,updated_at) VALUES(?,?,?,?)').run(personId, 'Fictional second person', f.now, f.now);
    accounts.admitEvidence({ commandId: randomUUID(), accountId: f.account.id, expectedVersion: snapshot.account.version, sources: [], claims: [],
      routes: [{ id: routeId, accountId: f.account.id, personId, channel: 'linkedin', value: 'https://linkedin.com/in/fictional-second-person', purpose: 'business', verification: 'published', evidenceIds: snapshot.routes.find(route => route.id === f.routeId)!.evidenceIds }] });
    f.repo.switchRoute({ commandId: randomUUID(), enrollmentId: f.enrollment.id, expectedVersion: 1, selectedRouteId: routeId, contextRevision: 1, executionContextId: randomUUID() });
    const context = f.drafts.requireStep(f.version.steps[0]!.id, 2);
    expect(f.drafts.find(context)).toBeNull();
    const next = f.drafts.create(context, 'Separate new person draft');
    expect(next.personId).toBe(personId); expect(next.id).not.toBe(old.id);
    expect(next.body).not.toContain('private');
    expect(f.drafts.requireRevision(old.id, 1).body).toBe('Person one private edit');
    expect(() => f.drafts.requireAction(old.id, 1)).toThrow('stale_context');
  } finally { f.close(); }
});

import { expect, it } from 'vitest';
import { withTransaction } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope } from '../../db/workspaceScope.ts';
import { meetingFollowThroughFixture, RECAP_AT } from './support/meetingFollowThroughFixture.ts';
it('keeps a meeting draft private and detects a source change on the read', async () => {
  const { prepareMeetingRecap, readMeetingFollowThrough } = await import('../../meetings/followThrough.ts');
  const f = await meetingFollowThroughFixture();
  try {
    const p = await f.ready();
    expect(await readMeetingFollowThrough(f.context, { meetingId: p.meetingId })).toMatchObject({ planId: null, currentDraft: null });
    await withTransaction(f.db.session, () => prepareMeetingRecap(f.context, { ...p, at: RECAP_AT }));
    const other = repositoryContext(workspaceScope(f.seeded.beta.workspaceId, { kind: 'user', userId: f.seeded.beta.admin.userId, role: 'admin' }), f.db.session);
    expect(await readMeetingFollowThrough(other, { meetingId: p.meetingId })).toBeNull();
    const unassigned = repositoryContext(workspaceScope(f.workspace, { kind: 'user', userId: f.seeded.alpha.admin.userId, role: 'salesperson' }), f.db.session);
    expect(await readMeetingFollowThrough(unassigned, { meetingId: p.meetingId })).toBeNull();
    await f.save(p.meetingId, 'Corrected context.', 1);
    expect(await readMeetingFollowThrough(f.context, { meetingId: p.meetingId })).toMatchObject({ status: 'needs_review', blockers: expect.arrayContaining(['source_changed']) });
  } finally { await f.db.drop(); }
});

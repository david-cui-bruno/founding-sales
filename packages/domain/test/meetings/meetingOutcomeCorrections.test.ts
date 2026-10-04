import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { repositoryContext } from '../../db/workspaceScope.ts';
import { withTransaction } from '../../db/queryable.ts';
import { meetingTasksFixture } from './support/meetingTasksFixture.ts';
import { readCurrentMeetingNotes } from '../../meetings/outcomes.ts';
describe('human corrections to meeting promises', () => {
  let f: Awaited<ReturnType<typeof meetingTasksFixture>>;
  beforeEach(async () => { f = await meetingTasksFixture(); });
  afterEach(async () => { await f.db.drop(); });
  it('cancels only untouched, explicitly dismissed tasks; preserves a human-edited task', async () => {
    const { reconcileMeetingTasks, changeMeetingTask } = await import('../../meetings/tasks.ts');
    const { saveMeetingOutcomeCorrections } = await import('../../meetings/outcomeCorrections.ts');
    for (const edit of [false, true]) {
      const p = await f.promise('I will send the guide tomorrow.');
      await withTransaction(f.db.session, () => reconcileMeetingTasks(f.context, p));
      const task = (await f.tasks(p.meetingId))[0]!;
      if (edit) await withTransaction(f.db.session, () => changeMeetingTask(f.context, { taskId: String(task['id']), expectedVersion: 1, action: 'edit', label: 'My chosen task', deadline: { precision: 'date', localDate: '2026-10-09', zone: 'America/New_York' } }));
      const notes = await readCurrentMeetingNotes(f.context, p.meetingId);
      const result = await withTransaction(f.db.session, () => saveMeetingOutcomeCorrections(f.context, { meetingId: p.meetingId, expectedRevision: notes.revision,
        debrief: notes.debrief, speakerMappings: notes.speakerMappings, sufficient: true, itemOverrides: [{ itemId: p.items[0]!.id, decision: 'dismissed', text: 'Not my promise', owner: 'prospect', deadline: null }] }));
      expect(result.ok).toBe(true);
      expect(await f.tasks(p.meetingId)).toMatchObject([{ status: edit ? 'open' : 'cancelled', user_edited: edit }]);
    }
  });
  it('serializes correction against completion without overwriting a completed task', async () => {
    const { reconcileMeetingTasks, changeMeetingTask } = await import('../../meetings/tasks.ts');
    const { saveMeetingOutcomeCorrections } = await import('../../meetings/outcomeCorrections.ts');
    const p = await f.promise('I will send the guide tomorrow.');
    await withTransaction(f.db.session, () => reconcileMeetingTasks(f.context, p));
    const task = (await f.tasks(p.meetingId))[0]!;
    const session = await f.db.appRuntimeSession(), other = repositoryContext(f.context.scope, session);
    const notes = await readCurrentMeetingNotes(f.context, p.meetingId);
    await f.db.session.query('BEGIN');
    await changeMeetingTask(f.context, { taskId: String(task['id']), expectedVersion: 1, action: 'complete' });
    const correction = withTransaction(session, () => saveMeetingOutcomeCorrections(other, { meetingId: p.meetingId, expectedRevision: notes.revision,
      debrief: notes.debrief, speakerMappings: notes.speakerMappings, sufficient: true,
      itemOverrides: [{ itemId: p.items[0]!.id, decision: 'dismissed', text: 'Not a promise', owner: 'prospect', deadline: null }] }));
    await f.db.session.query('COMMIT');
    expect((await correction).ok).toBe(true);
    expect(await f.tasks(p.meetingId)).toMatchObject([{ status: 'done', user_edited: true }]);
  });
  it('moves open tasks to the new firm owner while preserving task edits', async () => {
    const { reconcileMeetingTasks, changeMeetingTask } = await import('../../meetings/tasks.ts');
    const { reassignFirm } = await import('../../crm/firms.ts');
    const p = await f.promise('I will send the guide tomorrow.');
    await withTransaction(f.db.session, () => reconcileMeetingTasks(f.context, p));
    const task = (await f.tasks(p.meetingId))[0]!;
    await withTransaction(f.db.session, () => changeMeetingTask(f.context, { taskId: String(task['id']), expectedVersion: 1, action: 'edit', label: 'Keep my edit', deadline: { precision: 'date', localDate: '2026-10-09', zone: 'America/New_York' } }));
    await withTransaction(f.db.session, () => reassignFirm(f.context, { firmId: f.firmId, toUserId: f.seeded.alpha.admin.userId }));
    expect(await f.tasks(p.meetingId)).toMatchObject([{ owner_user_id: f.seeded.alpha.admin.userId, label: 'Keep my edit', user_edited: true }]);
  });

});

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { meetingNoteItemSchema } from '@fss/contracts';
import { repositoryContext } from '../../db/workspaceScope.ts';
import { withTransaction } from '../../db/queryable.ts';
import { meetingTasksFixture } from './support/meetingTasksFixture.ts';
import { readCurrentMeetingNotes } from '../../meetings/outcomes.ts';
describe('human corrections to meeting promises', () => {
  let f: Awaited<ReturnType<typeof meetingTasksFixture>>;
  beforeEach(async () => { f = await meetingTasksFixture(); });
  afterEach(async () => { await f.db.drop(); });
  it('preserves a debrief correction and its task identity across the correction save and unrelated added notes', async () => {
    const { sampleAnswer } = await import('./fixtures/outcomes/sample.ts');
    const { reconcileMeetingTasks } = await import('../../meetings/tasks.ts');
    const { saveMeetingOutcomeCorrections } = await import('../../meetings/outcomeCorrections.ts');
    const meetingId = await f.meeting(), quote = 'I will send the guide tomorrow.';
    await f.save(meetingId, quote);
    const item = meetingNoteItemSchema.parse({ ...sampleAnswer().items[0]!, evidence: [{ kind: 'debrief', revision: 1, quote, startOffset: 0, endOffset: quote.length }] });
    const first = await f.publish(meetingId, [item]);
    await withTransaction(f.db.session, () => reconcileMeetingTasks(f.context, first));
    const taskId = (await f.tasks(meetingId))[0]!['id'];
    const override = { itemId: first.items[0]!.id, decision: 'confirmed' as const, text: 'Send the corrected price sheet', owner: 'you' as const,
      deadline: { precision: 'date' as const, localDate: '2026-10-20', zone: 'America/New_York' } };
    for (const prefix of ['', 'The demo went well. ']) {
      const notes = await readCurrentMeetingNotes(f.context, meetingId);
      expect((await withTransaction(f.db.session, () => saveMeetingOutcomeCorrections(f.context, { meetingId, expectedRevision: notes.revision,
        debrief: prefix + quote, speakerMappings: [], sufficient: true, itemOverrides: [override] }))).ok).toBe(true);
      const next = await f.publish(meetingId, [{ ...item, evidence: [{ kind: 'debrief', quote, revision: notes.revision + 1, startOffset: prefix.length, endOffset: prefix.length + quote.length }] }]);
      expect(next.items[0]).toMatchObject({ id: override.itemId, text: override.text, deadline: override.deadline });
      await withTransaction(f.db.session, () => reconcileMeetingTasks(f.context, next));
      expect(await f.tasks(meetingId)).toMatchObject([{ id: taskId, label: override.text, deadline: override.deadline }]);
      expect(await f.tasks(meetingId)).toHaveLength(1);
    }
  });
  it('cancels untouched tasks when a speaker is corrected, preserving edited and completed tasks', async () => {
    const { reconcileMeetingTasks, changeMeetingTask } = await import('../../meetings/tasks.ts');
    const { saveMeetingOutcomeCorrections } = await import('../../meetings/outcomeCorrections.ts');
    for (const action of ['untouched', 'edit', 'complete'] as const) {
      const p = await f.promise('I will send the guide tomorrow.');
      await withTransaction(f.db.session, () => reconcileMeetingTasks(f.context, p));
      const taskId = String((await f.tasks(p.meetingId))[0]!['id']);
      if (action !== 'untouched') await withTransaction(f.db.session, () => changeMeetingTask(f.context, action === 'edit'
        ? { taskId, expectedVersion: 1, action, label: 'My chosen task', deadline: { precision: 'date', localDate: '2026-10-09', zone: 'America/New_York' } }
        : { taskId, expectedVersion: 1, action }));
      const notes = await readCurrentMeetingNotes(f.context, p.meetingId);
      expect((await withTransaction(f.db.session, () => saveMeetingOutcomeCorrections(f.context, { meetingId: p.meetingId, expectedRevision: notes.revision,
        debrief: notes.debrief, speakerMappings: notes.speakerMappings.map(m => ({ ...m, owner: 'prospect' })), sufficient: true, itemOverrides: [] }))).ok).toBe(true);
      expect(await f.tasks(p.meetingId)).toMatchObject([{ status: action === 'untouched' ? 'cancelled' : action === 'complete' ? 'done' : 'open' }]);
      const next = await f.publish(p.meetingId, [{ ...p.item, owner: 'prospect' }]);
      await withTransaction(f.db.session, () => reconcileMeetingTasks(f.context, next));
      expect(await f.tasks(p.meetingId)).toHaveLength(1);
      const audit = await f.db.session.query("SELECT id FROM audit_events WHERE subject_id=$1 AND action='meeting.task_invalidated'", [taskId]);
      expect(audit.rows).toHaveLength(action === 'untouched' ? 1 : 0);
    }
  });
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

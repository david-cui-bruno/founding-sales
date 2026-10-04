import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { withTransaction } from '../../db/queryable.ts';
import { meetingTasksFixture } from './support/meetingTasksFixture.ts';
describe('meeting promises become tasks', () => {
  let f: Awaited<ReturnType<typeof meetingTasksFixture>>;
  beforeEach(async () => { f = await meetingTasksFixture(); });
  afterEach(async () => { await f.db.drop(); });
  it('creates one dated task, preserves completion, and never moves a deal', async () => {
    const { reconcileMeetingTasks, changeMeetingTask } = await import('../../meetings/tasks.ts');
    const p = await f.promise('I will send the guide tomorrow.');
    expect(await withTransaction(f.db.session, () => reconcileMeetingTasks(f.context, p))).toMatchObject({ ok: true, value: { created: 1 } });
    const task = (await f.tasks(p.meetingId))[0]!;
    expect(task['deadline']).toEqual({ precision: 'date', localDate: '2026-10-04', zone: 'America/New_York' });
    expect(await withTransaction(f.db.session, () => changeMeetingTask(f.context, { taskId: String(task['id']), expectedVersion: 1, action: 'complete' }))).toMatchObject({ ok: true, value: { status: 'done' } });
    await withTransaction(f.db.session, () => reconcileMeetingTasks(f.context, p));
    expect(await f.tasks(p.meetingId)).toMatchObject([{ id: task['id'], status: 'done', version: 2 }]);
    expect((await f.db.session.query('SELECT id FROM opportunities')).rows).toHaveLength(0);
  });
  it('reviews uncertain claims instead of scheduling them', async () => {
    const { reconcileMeetingTasks } = await import('../../meetings/tasks.ts');
    for (const [quote, owner, date] of [
      ['I might send the guide tomorrow.', 'you', 'tomorrow'],
      ['I will not send the guide tomorrow.', 'you', 'tomorrow'],
      ['If you buy it, I will send the guide tomorrow.', 'you', 'tomorrow'],
      ['I will send the guide tomorrow.', 'prospect', 'tomorrow'],
      ['I will send the guide tomorrow.', 'unknown', 'tomorrow'],
      ['I will send the guide soon.', 'you', 'soon'],
    ] as const) {
      const p = await f.promise(quote, owner, date);
      await withTransaction(f.db.session, () => reconcileMeetingTasks(f.context, p));
      expect(await f.tasks(p.meetingId), quote + owner).toHaveLength(0);
    }
  });
  it('holds a duplicate promise when a later debrief repeats a transcript', async () => {
    const { reconcileMeetingTasks } = await import('../../meetings/tasks.ts');
    const { saveMeetingNotes } = await import('../../meetings/notes.ts');
    const p = await f.promise('I will send the guide tomorrow.');
    await withTransaction(f.db.session, () => reconcileMeetingTasks(f.context, p));
    await withTransaction(f.db.session, () => saveMeetingNotes(f.context, { meetingId: p.meetingId, expectedRevision: 1, debrief: 'I will send the guide tomorrow.', sufficient: true,
      speakerMappings: [{ recordingId: p.source.recordingId, speaker: null, owner: 'you', label: 'David', zone: 'America/New_York' }], itemOverrides: [] }));
    const analysis = await f.publish(p.meetingId, [p.item, { ...p.item, evidence: [{ kind: 'debrief', revision: 2, quote: 'I will send the guide tomorrow.', startOffset: 0, endOffset: 31 }] }]);
    expect(await withTransaction(f.db.session, () => reconcileMeetingTasks(f.context, analysis))).toMatchObject({ ok: true, value: { review: 1 } });
    expect(await f.tasks(p.meetingId)).toHaveLength(1);
  });
});

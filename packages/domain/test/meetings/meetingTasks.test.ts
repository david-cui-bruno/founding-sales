import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { meetingNoteItemSchema } from '@fss/contracts';
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
it('retains date uncertainty even when the isolated date phrase parses', async () => {
  const f = await meetingTasksFixture();
  try {
    const { reconcileMeetingTasks } = await import('../../meetings/tasks.ts');
    const p = await f.promise('I will send the guide tomorrow.');
    const analysis = await f.publish(p.meetingId, [{ ...p.item, reviewReasons: ['deadline_unclear'] }]);
    expect(await withTransaction(f.db.session, () => reconcileMeetingTasks(f.context, analysis))).toMatchObject({ ok: true, value: { created: 0, review: 1 } });
  } finally { await f.db.drop(); }
});
it('holds analysis-level conflicts until an explicit item correction resolves the promise', async () => {
  const f = await meetingTasksFixture();
  try {
    const { reconcileMeetingTasks } = await import('../../meetings/tasks.ts');
    const p = await f.promise('I will send the guide tomorrow.');
    await f.db.session.query("UPDATE meeting_analyses SET review_reasons='[\"source_conflict\"]' WHERE id=$1", [p.analysisId]);
    expect(await withTransaction(f.db.session, () => reconcileMeetingTasks(f.context, p))).toMatchObject({ ok: true, value: { created: 0, review: 1 } });
    expect(await f.tasks(p.meetingId)).toHaveLength(0);
    const { readCurrentMeetingNotes } = await import('../../meetings/outcomes.ts');
    const { saveMeetingOutcomeCorrections } = await import('../../meetings/outcomeCorrections.ts');
    const notes = await readCurrentMeetingNotes(f.context, p.meetingId);
    await withTransaction(f.db.session, () => saveMeetingOutcomeCorrections(f.context, { meetingId: p.meetingId, expectedRevision: notes.revision,
      debrief: notes.debrief, sufficient: true, speakerMappings: notes.speakerMappings,
      itemOverrides: [{ itemId: p.items[0]!.id, decision: 'confirmed', text: 'Send the guide', owner: 'you', deadline: { precision: 'date', localDate: '2026-10-06', zone: 'America/New_York' } }] }));
    const next = await f.publish(p.meetingId, [p.item]);
    await f.db.session.query("UPDATE meeting_analyses SET review_reasons='[\"source_conflict\"]' WHERE id=$1", [next.analysisId]);
    expect(await withTransaction(f.db.session, () => reconcileMeetingTasks(f.context, next))).toMatchObject({ ok: true, value: { created: 1, review: 0 } });
  } finally { await f.db.drop(); }
});
it('does not anchor a quoted historical debrief promise to the date the notes were saved', async () => {
  const f = await meetingTasksFixture();
  try {
    const { reconcileMeetingTasks } = await import('../../meetings/tasks.ts');
    const { sampleAnswer } = await import('./fixtures/outcomes/sample.ts');
    const meetingId = await f.meeting(), quote = "At yesterday's demo, I promised to send the guide tomorrow.";
    await f.save(meetingId, quote);
    await f.db.session.query("UPDATE meeting_note_revisions SET created_at='2026-10-03T12:00:00Z' WHERE meeting_id=$1", [meetingId]);
    const p = await f.publish(meetingId, [meetingNoteItemSchema.parse({ ...sampleAnswer().items[0]!, reviewReasons: ['deadline_unclear'], evidence: [{ kind: 'debrief', revision: 1, quote, startOffset: 0, endOffset: quote.length }] })]);
    expect(await withTransaction(f.db.session, () => reconcileMeetingTasks(f.context, p))).toMatchObject({ ok: true, value: { created: 0, review: 1 } });
    expect(await f.tasks(meetingId)).toHaveLength(0);
  } finally { await f.db.drop(); }
});
it('keeps a known prospect promise as a note without asking David to resolve its owner', async () => {
  const f = await meetingTasksFixture();
  try {
    const { reconcileMeetingTasks } = await import('../../meetings/tasks.ts');
    const p = await f.promise('I will send the vendor list tomorrow.', 'prospect');
    expect(await withTransaction(f.db.session, () => reconcileMeetingTasks(f.context, p))).toMatchObject({ ok: true, value: { created: 0, review: 0 } });
  } finally { await f.db.drop(); }
});

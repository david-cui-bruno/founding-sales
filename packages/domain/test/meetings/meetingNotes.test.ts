import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { meetingTranscriptionFixture } from './support/meetingTranscriptionFixture.ts';
import { withTransaction } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope } from '../../db/workspaceScope.ts';

describe('meeting notes durable revisions', () => {
  let f: Awaited<ReturnType<typeof meetingTranscriptionFixture>>;
  beforeAll(async () => { f = await meetingTranscriptionFixture(); });
  afterAll(async () => { await f.db.drop(); });
  it('adds isolated notes storage without enabling paid work', async () => {
    const tables = (await f.db.session.query<{ name: string }>("SELECT table_name AS name FROM information_schema.tables WHERE table_schema='public'")).rows.map(r => r.name);
    expect(tables).toContain('meeting_note_revisions');
    expect(tables).toContain('meeting_analysis_requests');
    const { readMeetingAnalysisSetting } = await import('../../meetings/analysisSettings.ts');
    expect(await readMeetingAnalysisSetting(f.context)).toEqual({ enabled: false, dailyCeilingCents: 0, creditCoverage: null });
  });
  it('rejects stale edits, preserves revisions and never confirms attendance', async () => {
    const { saveMeetingNotes } = await import('../../meetings/notes.ts');
    const { readMeetingOutcomes } = await import('../../meetings/outcomes.ts');
    const meetingId = await f.meeting();
    const input = { meetingId, expectedRevision: 0, debrief: 'I promised a guide tomorrow.', speakerMappings: [], itemOverrides: [], sufficient: true };
    const saved = await withTransaction(f.db.session, () => saveMeetingNotes(f.context, input));
    expect(saved).toMatchObject({ ok: true, value: { revision: 1, debrief: input.debrief } });
    expect(await withTransaction(f.db.session, () => saveMeetingNotes(f.context, input))).toEqual({ ok: false, reason: 'notes_changed' });
    expect(await withTransaction(f.db.session, () => saveMeetingNotes(f.context, { ...input, expectedRevision: 1, debrief: 'Corrected notes' }))).toMatchObject({ ok: true, value: { revision: 2 } });
    const view = await readMeetingOutcomes(f.context, { meetingId });
    expect(view).toMatchObject({ notes: { revision: 2, debrief: 'Corrected notes' }, attendance: 'unconfirmed', tasks: [], analysisId: null });
    expect((await f.db.session.query('SELECT revision FROM meeting_note_revisions WHERE meeting_id=$1 ORDER BY revision', [meetingId])).rows).toEqual([{ revision: 1 }, { revision: 2 }]);
    expect((await f.db.session.query('SELECT id FROM meeting_analysis_requests')).rows).toHaveLength(0);
  });
  it('deletes cached analysis content with its meeting while preserving attempt accounting', async () => {
    const meetingId = await f.meeting();
    await f.db.session.query(`INSERT INTO meeting_analysis_requests(workspace_id,meeting_id,original_meeting_id,request_hash,prompt_version,model_name,purpose,paid_attempts,result)
      VALUES($1,$2,$2,$3,1,'claude-haiku-4-5','extract',1,'{"overview":"Private words"}'::jsonb)`, [f.workspace, meetingId, 'a'.repeat(64)]);
    await f.db.session.query('DELETE FROM meetings WHERE workspace_id=$1 AND id=$2', [f.workspace, meetingId]);
    expect((await f.db.session.query('SELECT meeting_id,paid_attempts,result FROM meeting_analysis_requests WHERE original_meeting_id=$1', [meetingId])).rows).toEqual([{ meeting_id: null, paid_attempts: 1, result: null }]);
  });
  it('does not reveal or mutate notes to another workspace or an unassigned salesperson', async () => {
    const { saveMeetingNotes } = await import('../../meetings/notes.ts');
    const { readMeetingOutcomes } = await import('../../meetings/outcomes.ts');
    const meetingId = await f.meeting();
    const input = { meetingId, expectedRevision: 0, debrief: 'Private details', speakerMappings: [], itemOverrides: [], sufficient: false };
    await withTransaction(f.db.session, () => saveMeetingNotes(f.context, input));
    const other = repositoryContext(workspaceScope(f.seeded.beta.workspaceId, { kind: 'user', userId: f.seeded.beta.admin.userId, role: 'admin' }), f.db.session);
    expect(await readMeetingOutcomes(other, { meetingId })).toBeNull();
    expect(await withTransaction(f.db.session, () => saveMeetingNotes(other, input))).toMatchObject({ ok: false });
    const unassigned = repositoryContext(workspaceScope(f.workspace, { kind: 'user', userId: f.seeded.alpha.admin.userId, role: 'salesperson' }), f.db.session);
    expect(await readMeetingOutcomes(unassigned, { meetingId })).toBeNull();
    expect(await withTransaction(f.db.session, () => saveMeetingNotes(unassigned, input))).toMatchObject({ ok: false });
  });
});

describe('notes schema upgrade', () => {
  it('preserves schema-42 meeting rows and rejects evidence belonging to another firm', async () => {
    const { createTestDatabase } = await import('../../db/testing/testDatabase.ts');
    const { seedTwoWorkspaces } = await import('../db/support/fixtures.ts');
    const { applyMigrations } = await import('../../db/migrationRunner.ts');
    const db = await createTestDatabase({ throughVersion: 42 });
    try {
      const seeded = await seedTwoWorkspaces(db.session);
      const workspace = seeded.alpha.workspaceId;
      const firm = (await db.session.query<{ id: string }>("INSERT INTO firms(workspace_id,name) VALUES($1,'Upgrade fixture') RETURNING id", [workspace])).rows[0]?.id;
      const other = (await db.session.query<{ id: string }>("INSERT INTO firms(workspace_id,name) VALUES($1,'Other fixture') RETURNING id", [workspace])).rows[0]?.id;
      const meeting = (await db.session.query<{ id: string }>("INSERT INTO meetings(workspace_id,firm_id,booking_uid,current_booking_uid,state,starts_at,ends_at,last_event_at) VALUES($1,$2,'upgrade43','upgrade43','booked',now(),now(),now()) RETURNING id", [workspace, firm])).rows[0]?.id;
      await applyMigrations(db.session);
      expect((await db.session.query('SELECT firm_id,state,notes_revision FROM meetings WHERE id=$1', [meeting])).rows).toEqual([{ firm_id: firm, state: 'booked', notes_revision: 0 }]);
      await expect(db.session.query("INSERT INTO meeting_note_revisions(workspace_id,meeting_id,firm_id,revision,debrief,created_by_user_id) VALUES($1,$2,$3,1,'foreign note',$4)", [workspace, meeting, other, seeded.alpha.admin.userId])).rejects.toMatchObject({ code: '23503' });
    } finally { await db.drop(); }
  });
});
